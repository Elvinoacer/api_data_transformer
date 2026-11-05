import { cdpAdapter } from "./cdp-adapter";
import {
  activityRepo,
  calculateSessionMetrics,
  errorRepo,
  rawResponseRepo,
  recordRepo,
  schemaRepo,
  sessionRepo,
  settingsRepo,
  sourceRepo,
} from "../data/repositories";
import {
  checkResponseEligibility,
  parseApiJsonBody,
} from "../privacy/source-policy";
import {
  extractOperationName,
  normalizeEndpoint,
  redactSensitiveUrl,
} from "../privacy/url-redaction";
import { extractItemsByPath } from "../extraction/path-selector";
import {
  consolidateRecords,
  generateStableContentHash,
} from "../extraction/deduplicate";
import { inferSchemaFromRecords } from "../extraction/schema-inference";
import {
  buildPageUrlsForSource,
  detectPaginationFromResponse,
} from "../extraction/pagination-detector";
import {
  AutoPaginateConfig,
  AutoPaginateState,
  CaptureSession,
  CaptureStatus,
  RawResponse,
  ScopeMode,
} from "../shared/types";
import { BandaGoNormalizer } from "../extraction/bandago-normalizer";
import { SphereSyncClient } from "../sync/sphere-client";

interface TrackedRequestMeta {
  httpMethod: string;
  postData?: string;
  timestamp: number;
}

interface PendingRequest {
  tabId: number;
  requestId: string;
  url: string;
  httpMethod: string;
  postData?: string;
  httpStatus: number;
  mimeType: string;
  resourceType: string;
  timestamp: number;
}

const DEFAULT_AUTO_PAGINATE_STATE: AutoPaginateState = {
  status: "idle",
  pagesAttempted: 0,
  maxPages: 0,
  initialUniqueRecords: 0,
  currentUniqueRecords: 0,
  message: "Ready",
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

class CaptureController {
  private activeTabId: number | null = null;
  private currentSession: CaptureSession | null = null;
  private trackedRequests = new Map<string, TrackedRequestMeta>();
  private pendingRequests = new Map<string, PendingRequest>();
  private initPromise: Promise<void> | null = null;
  private isStartingOrStopping = false;

  private autoPaginateState: AutoPaginateState = {
    ...DEFAULT_AUTO_PAGINATE_STATE,
  };
  private stopAutoPaginateRequested = false;
  private lastClearedAtBySession = new Map<string, number>();
  private globalClearedAt = 0;

  public getStatus(): CaptureStatus {
    return this.currentSession?.status || "idle";
  }

  public getActiveSession(): CaptureSession | null {
    return this.currentSession;
  }

  public getAutoPaginateState(): AutoPaginateState {
    return { ...this.autoPaginateState };
  }

  /**
   * Recovers active session state from IndexedDB on service worker spin-up.
   */
  public async init(): Promise<void> {
    if (!this.initPromise) {
      this.initPromise = (async () => {
        const session = await sessionRepo.getActiveSession();
        if (session) {
          this.currentSession = session;
          this.activeTabId = session.targetTabId;
          await this.syncBadge(session.status);
        } else {
          await this.syncBadge("idle");
        }
      })();
    }
    return this.initPromise;
  }

  private async syncBadge(status: CaptureStatus): Promise<void> {
    try {
      if (typeof chrome === "undefined" || !chrome.action?.setBadgeText) return;
      if (status === "recording") {
        await chrome.action.setBadgeText({ text: "REC" });
        await chrome.action.setBadgeBackgroundColor({ color: "#4d7c0f" });
      } else if (status === "paused") {
        await chrome.action.setBadgeText({ text: "PAU" });
        await chrome.action.setBadgeBackgroundColor({ color: "#d97706" });
      } else {
        await chrome.action.setBadgeText({ text: "" });
      }
    } catch {
      // Ignore badge update failures in non-extension contexts
    }
  }

  public async startCapture(params: {
    tabId: number;
    originalUrl: string;
    allowedHostnames: string[];
    scopeMode?: ScopeMode;
    label?: string;
  }): Promise<CaptureSession> {
    await this.init();

    if (this.isStartingOrStopping) {
      throw new Error(
        "Capture transition is already in progress. Please wait a moment.",
      );
    }

    if (
      this.currentSession &&
      (this.currentSession.status === "recording" ||
        this.currentSession.status === "starting")
    ) {
      throw new Error(
        "A capture session is already recording. Stop it before starting a new one.",
      );
    }

    this.isStartingOrStopping = true;
    try {
      const settings = await settingsRepo.getSettings();
      const session = await sessionRepo.createSession({
        targetTabId: params.tabId,
        originalUrl: params.originalUrl,
        allowedHostnames: params.allowedHostnames,
        scopeMode:
          params.scopeMode || settings.defaultScopeMode || "all_tab_apis",
        label: params.label,
      });

      this.currentSession = session;
      this.activeTabId = params.tabId;
      this.trackedRequests.clear();
      this.pendingRequests.clear();
      this.autoPaginateState = { ...DEFAULT_AUTO_PAGINATE_STATE };

      try {
        await cdpAdapter.attach(params.tabId);
        await cdpAdapter.enableNetwork(params.tabId);
        await sessionRepo.updateStatus(session.id, "recording");
        session.status = "recording";
        await this.syncBadge("recording");

        await activityRepo.logEvent({
          sessionId: session.id,
          actor: "user",
          category: "capture",
          message: `Started capturing JSON APIs on ${params.allowedHostnames[0] || "selected tab"}`,
          detail: `Scope: ${session.scopeMode === "all_tab_apis" ? "All APIs called by tab" : "Domain scoped"}`,
        });

        return session;
      } catch (err: any) {
        await cdpAdapter.detach(params.tabId);
        const errMsg = err.message || "Debugger attach failed";
        await sessionRepo.updateStatus(session.id, "error", errMsg);
        session.status = "error";
        session.errorReason = errMsg;
        await this.syncBadge("error");
        await errorRepo.logError({
          sessionId: session.id,
          kind: "debugger_attach",
          message: errMsg,
          details: err,
        });
        throw err;
      }
    } finally {
      this.isStartingOrStopping = false;
    }
  }

  public async pauseCapture(sessionId?: string): Promise<void> {
    await this.init();
    const targetSessionId = sessionId || this.currentSession?.id;
    if (!targetSessionId || !this.currentSession) return;

    await sessionRepo.updateStatus(targetSessionId, "paused");
    this.currentSession.status = "paused";
    await this.syncBadge("paused");
    await activityRepo.logEvent({
      sessionId: targetSessionId,
      actor: "user",
      category: "capture",
      message: "Paused network recording",
    });
  }

  public async resumeCapture(sessionId?: string): Promise<void> {
    await this.init();
    const targetSessionId = sessionId || this.currentSession?.id;
    if (!targetSessionId || !this.currentSession) return;

    await sessionRepo.updateStatus(targetSessionId, "recording");
    this.currentSession.status = "recording";
    await this.syncBadge("recording");
    await activityRepo.logEvent({
      sessionId: targetSessionId,
      actor: "user",
      category: "capture",
      message: "Resumed network recording",
    });
  }

  public async stopCapture(sessionId?: string): Promise<void> {
    await this.init();
    this.stopAutoPaginateRequested = true;
    const targetSessionId = sessionId || this.currentSession?.id;

    if (this.activeTabId) {
      await cdpAdapter.detach(this.activeTabId);
    }

    if (targetSessionId) {
      await sessionRepo.updateStatus(targetSessionId, "stopped");
      await activityRepo.logEvent({
        sessionId: targetSessionId,
        actor: "user",
        category: "capture",
        message: "Stopped capture session and detached debugger cleanly",
      });
    }

    if (this.currentSession) {
      this.currentSession.status = "stopped";
      this.currentSession.endedAt = new Date().toISOString();
    }

    await this.syncBadge("stopped");
    this.activeTabId = null;
    this.trackedRequests.clear();
    this.pendingRequests.clear();
    if (this.autoPaginateState.status === "running") {
      this.autoPaginateState = {
        ...this.autoPaginateState,
        status: "completed",
        message: "Stopped because capture session ended",
      };
    }
  }

  public async handleDebuggerDetach(
    tabId: number,
    reason: string,
  ): Promise<void> {
    await this.init();
    if (this.activeTabId === tabId && this.currentSession) {
      this.stopAutoPaginateRequested = true;
      await sessionRepo.updateStatus(
        this.currentSession.id,
        "detached",
        reason,
      );
      await activityRepo.logEvent({
        sessionId: this.currentSession.id,
        actor: "system",
        category: "warning",
        message:
          "Debugger detached from target tab — saved data remains intact",
        detail: reason,
      });
      this.currentSession.status = "detached";
      this.activeTabId = null;
      this.trackedRequests.clear();
      this.pendingRequests.clear();
      await this.syncBadge("detached");
    }
  }

  public async handleTabRemoved(tabId: number): Promise<void> {
    await this.init();
    if (this.activeTabId === tabId) {
      await this.handleDebuggerDetach(tabId, "Target browser tab was closed");
    }
  }

  public async onCdpEvent(
    debuggee: chrome.debugger.Debuggee,
    method: string,
    params?: any,
  ): Promise<void> {
    await this.init();

    if (
      !this.currentSession ||
      !this.activeTabId ||
      debuggee.tabId !== this.activeTabId
    ) {
      return;
    }

    this.pruneStaleRequests();

    if (method === "Network.requestWillBeSent") {
      const requestId = params?.requestId;
      const req = params?.request;
      if (requestId && req) {
        this.trackedRequests.set(requestId, {
          httpMethod: (req.method || "GET").toUpperCase(),
          postData:
            typeof req.postData === "string"
              ? req.postData.slice(0, 1048576)
              : undefined,
          timestamp: Date.now(),
        });

        const url = req.url || "";
        if (url.includes("/graphql")) {
          const auth = req.headers?.Authorization || req.headers?.authorization;
          if (auth && typeof auth === "string") {
            try {
              const origin = new URL(url).origin;
              cdpAdapter.setAuthHeader(origin, auth).catch(() => {});
            } catch {}
          }
        }
      }
      return;
    }

    if (method === "Network.responseReceived") {
      const response = params.response;
      const requestId = params.requestId;
      const resourceType = params.type || "";
      const url = response.url || "";
      const mimeType = response.mimeType || "";
      const httpStatus = response.status || 200;

      const tracked = this.trackedRequests.get(requestId);
      const httpMethod =
        tracked?.httpMethod || response.requestHeaders?.[":method"] || "GET";

      const settings = await settingsRepo.getSettings();
      const eligibility = checkResponseEligibility({
        url,
        allowedHostnames: this.currentSession.allowedHostnames,
        scopeMode: this.currentSession.scopeMode || "all_tab_apis",
        mimeType,
        resourceType,
        sensitiveKeywords: settings.sensitiveEndpointKeywords,
      });

      if (eligibility.isEligible) {
        this.pendingRequests.set(requestId, {
          tabId: debuggee.tabId,
          requestId,
          url,
          httpMethod,
          postData: tracked?.postData,
          httpStatus,
          mimeType,
          resourceType,
          timestamp: Date.now(),
        });
      }
      this.trackedRequests.delete(requestId);
    } else if (method === "Network.loadingFinished") {
      const requestId = params.requestId;
      const pending = this.pendingRequests.get(requestId);
      this.trackedRequests.delete(requestId);
      if (!pending) return;

      this.pendingRequests.delete(requestId);

      // Only persist if currently recording
      if (this.currentSession.status !== "recording") {
        return;
      }

      await this.processFinishedResponse(pending);
    } else if (method === "Network.loadingFailed") {
      const requestId = params.requestId;
      this.pendingRequests.delete(requestId);
      this.trackedRequests.delete(requestId);
    }
  }

  private async processFinishedResponse(
    pending: PendingRequest,
  ): Promise<void> {
    if (!this.currentSession) return;

    const sessionClearTime =
      this.lastClearedAtBySession.get(this.currentSession.id) || 0;
    const discardThreshold = Math.max(sessionClearTime, this.globalClearedAt);
    if (pending.timestamp <= discardThreshold) {
      return;
    }

    const settings = await settingsRepo.getSettings();

    let bodyText = "";
    try {
      bodyText = await cdpAdapter.getResponseBody(
        pending.tabId,
        pending.requestId,
      );
    } catch (err: any) {
      // Re-check discard threshold in case clear was triggered while awaiting body
      const currentThreshold = Math.max(
        this.lastClearedAtBySession.get(this.currentSession.id) || 0,
        this.globalClearedAt,
      );
      if (pending.timestamp <= currentThreshold) return;

      await errorRepo.logError({
        sessionId: this.currentSession.id,
        kind: "body_retrieval",
        url: redactSensitiveUrl(pending.url, settings.sensitiveUrlParams),
        message: err.message || "Could not retrieve response body",
      });
      return;
    }

    // Re-check discard threshold in case clear occurred during body retrieval
    const currentThreshold = Math.max(
      this.lastClearedAtBySession.get(this.currentSession.id) || 0,
      this.globalClearedAt,
    );
    if (pending.timestamp <= currentThreshold) {
      return;
    }

    const responseBytes = new Blob([bodyText]).size;
    if (responseBytes > settings.maxResponseBodyBytes) {
      await errorRepo.logError({
        sessionId: this.currentSession.id,
        kind: "storage_limit",
        url: redactSensitiveUrl(pending.url, settings.sensitiveUrlParams),
        message: `Response size (${(responseBytes / (1024 * 1024)).toFixed(2)} MB) exceeded limit (${(
          settings.maxResponseBodyBytes /
          (1024 * 1024)
        ).toFixed(2)} MB)`,
      });
      return;
    }

    const operationName = extractOperationName(pending.url, pending.postData);
    const parseResult = parseApiJsonBody(bodyText);

    if (!parseResult.ok) {
      // If MIME was permissive (e.g. text/plain or empty) and body isn't JSON at all, quietly skip non-JSON text
      const lowerMime = pending.mimeType.toLowerCase();
      if (!lowerMime.includes("json")) {
        return;
      }

      const rawResponse: RawResponse = {
        id: `resp_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
        sessionId: this.currentSession.id,
        capturedAt: new Date().toISOString(),
        url: redactSensitiveUrl(pending.url, settings.sensitiveUrlParams),
        normalizedEndpoint: normalizeEndpoint(pending.url, operationName),
        httpStatus: pending.httpStatus,
        httpMethod: pending.httpMethod,
        resourceType: pending.resourceType,
        mimeType: pending.mimeType,
        responseBody: bodyText,
        parseStatus: "invalid_json",
        responseBytes,
        operationName,
        errorMessage: parseResult.error,
      };
      await rawResponseRepo.addResponse(rawResponse);
      return;
    }

    const parsed = parseResult.data;

    // Fix 4: Support Batched Apollo GraphQL Responses (top-level arrays)
    const envelopes =
      Array.isArray(parsed) &&
      parsed.length > 0 &&
      parsed.every(
        (el) =>
          el && typeof el === "object" && ("data" in el || "errors" in el),
      )
        ? parsed
        : [parsed];

    // Attempt to match batched GraphQL request operations if pending.postData was an array
    let postDataBatch: any[] | null = null;
    if (pending.postData && pending.postData.trim().startsWith("[")) {
      try {
        const parsedPost = JSON.parse(pending.postData);
        if (Array.isArray(parsedPost)) {
          postDataBatch = parsedPost;
        }
      } catch {}
    }

    for (const [idx, envelope] of envelopes.entries()) {
      await this.handleBandaGoPayload(pending.url, pending.postData, envelope);

      let envelopeOpName = operationName;
      let envelopePostData = pending.postData;

      if (postDataBatch && postDataBatch[idx]) {
        const opItem = postDataBatch[idx];
        envelopePostData = JSON.stringify(opItem);
        envelopeOpName =
          opItem.operationName ||
          (typeof opItem.query === "string"
            ? opItem.query.match(/\b(?:query|mutation)\s+([A-Za-z0-9_]+)/)?.[1]
            : undefined) ||
          operationName;
      }

      if (
        !envelopeOpName &&
        envelope &&
        typeof envelope === "object" &&
        envelope.data &&
        typeof envelope.data === "object"
      ) {
        const dataKeys = Object.keys(envelope.data);
        if (dataKeys.length === 1) {
          envelopeOpName = dataKeys[0];
        }
      }

      const contentHash = generateStableContentHash(envelope);
      const responseId = `resp_${Date.now()}_${idx}_${Math.random().toString(36).slice(2, 6)}`;
      const redactedUrl = redactSensitiveUrl(
        pending.url,
        settings.sensitiveUrlParams,
      );

      const extraction = await this.extractAndConsolidate({
        sessionId: this.currentSession.id,
        responseId,
        url: pending.url,
        httpMethod: pending.httpMethod,
        operationName: envelopeOpName,
        requestBody: envelopePostData,
        parsedData: envelope,
      });

      const rawResponse: RawResponse = {
        id: responseId,
        sessionId: this.currentSession.id,
        capturedAt: new Date().toISOString(),
        url: redactedUrl,
        normalizedEndpoint: normalizeEndpoint(pending.url, envelopeOpName),
        httpStatus: pending.httpStatus,
        httpMethod: pending.httpMethod,
        resourceType: pending.resourceType,
        mimeType: pending.mimeType,
        responseBody:
          envelopes.length === 1 ? bodyText : JSON.stringify(envelope),
        parseStatus: "parsed",
        responseBytes:
          envelopes.length === 1
            ? responseBytes
            : new Blob([JSON.stringify(envelope)]).size,
        contentHash,
        operationName: envelopeOpName,
        extractedCount: extraction.extractedCount,
        paginationMeta: extraction.paginationMeta,
      };

      await rawResponseRepo.addResponse(rawResponse);
    }
  }

  /**
   * Detects BandaGo POS payloads and normalizes them for outbound Sphere sync.
   */
  public async handleBandaGoPayload(
    sourceUrl: string,
    _postData: string | undefined,
    dataNode: unknown,
  ): Promise<void> {
    if (!dataNode || typeof dataNode !== "object") return;

    const lowerUrl = (sourceUrl || "").toLowerCase();
    const isBandaCandidate =
      lowerUrl.includes("/graphql") ||
      lowerUrl.includes("bandahealth") ||
      lowerUrl.includes("bandago") ||
      lowerUrl.includes("idempiere");

    if (!isBandaCandidate) return;

    try {
      const normalizedProducts =
        BandaGoNormalizer.extractProductsFromPayload(dataNode);

      if (normalizedProducts.length > 0) {
        console.log(
          `[BandaGo POS] Intercepted ${normalizedProducts.length} medications from ${sourceUrl}. Queueing Sphere sync...`,
        );
        await SphereSyncClient.enqueue(normalizedProducts);

        if (this.currentSession) {
          await activityRepo.logEvent({
            sessionId: this.currentSession.id,
            actor: "system",
            category: "session",
            message: `[BandaGo POS] Intercepted ${normalizedProducts.length} medications. Queued for Sphere Pharmacy sync.`,
          });
        }
      }
    } catch (err) {
      console.error("[BandaGo POS] Error handling payload sync:", err);
    }
  }

  private async extractAndConsolidate(params: {
    sessionId: string;
    responseId: string;
    url: string;
    httpMethod: string;
    operationName?: string;
    requestBody?: string;
    parsedData: unknown;
  }): Promise<{ extractedCount: number; paginationMeta: any }> {
    const {
      sessionId,
      responseId,
      url,
      httpMethod,
      operationName,
      requestBody,
      parsedData,
    } = params;

    // First get or create source so we know recordPath
    const initialSourceRes = await sourceRepo.getOrCreateSource({
      sessionId,
      url,
      httpMethod,
      parsedBody: parsedData,
      operationName,
    });

    const source = initialSourceRes.source;
    const items = extractItemsByPath(parsedData, source.recordPath);

    // Detect pagination with actual extracted count
    const paginationMeta = detectPaginationFromResponse({
      url,
      parsedBody: parsedData,
      requestBody,
      extractedCount: items.length,
    });

    // Persist merged pagination metadata on the source
    if (
      paginationMeta.strategy !== "none" ||
      paginationMeta.totalRecords !== undefined ||
      paginationMeta.totalPages !== undefined
    ) {
      const { mergePaginationState } =
        await import("../extraction/pagination-detector");
      const mergedPag = mergePaginationState(
        source.pagination,
        paginationMeta,
        url,
      );
      if (mergedPag) {
        source.pagination = mergedPag;
        await sourceRepo.updateSource(source.id, { pagination: mergedPag });
      }
    }

    if (initialSourceRes.isNew) {
      await activityRepo.logEvent({
        sessionId,
        actor: "system",
        category: "discovery",
        message: `Discovered API dataset "${source.label}"`,
        detail: `${httpMethod} ${source.normalizedEndpoint} (${items.length} items on path "${source.recordPath}")`,
      });
    } else if (paginationMeta.currentPage && paginationMeta.totalPages) {
      await activityRepo.logEvent({
        sessionId,
        actor: "system",
        category: "pagination",
        message: `Captured page ${paginationMeta.currentPage} of ${paginationMeta.totalPages} for "${source.label}"`,
        detail: `${items.length} items parsed`,
      });
    }

    if (!source.included || !items || items.length === 0) {
      return { extractedCount: 0, paginationMeta };
    }

    // Load existing records for deduplication
    const existingRecords = await recordRepo.getRecordsBySource(
      sessionId,
      source.id,
    );

    const consolidation = consolidateRecords({
      sessionId,
      sourceId: source.id,
      responseId,
      rawItems: items,
      existingRecords,
      identityKeyField: source.identityKeyField,
      policy: source.consolidationPolicy,
    });

    await recordRepo.upsertRecords(
      consolidation.toInsert,
      consolidation.toUpdate,
    );

    // Update inferred schema
    const existingSchema = await schemaRepo.getSchema(source.id);
    const updatedSchema = inferSchemaFromRecords({
      sourceId: source.id,
      sessionId,
      inferredRecordPath: source.recordPath,
      records: items,
      existingSchema,
    });
    await schemaRepo.saveSchema(updatedSchema);

    return { extractedCount: items.length, paginationMeta };
  }

  /**
   * Helps the user automatically step through multiple pages of an API safely inside the attached tab.
   */
  public async startAutoPaginate(
    config: AutoPaginateConfig,
  ): Promise<AutoPaginateState> {
    await this.init();

    if (
      !this.currentSession ||
      this.currentSession.status !== "recording" ||
      !this.activeTabId
    ) {
      throw new Error(
        "Start or resume capture on the target tab before running Auto-Paginate.",
      );
    }

    if (this.autoPaginateState.status === "running") {
      throw new Error("Auto-pagination is already running.");
    }

    const tabId = this.activeTabId;
    const sessionId = this.currentSession.id;
    const delayMs = Math.max(600, Math.min(config.delayMs || 1800, 15_000));
    const maxPages = Math.max(1, Math.min(config.maxPages || 20, 200));

    const startMetrics = await calculateSessionMetrics(sessionId);
    this.stopAutoPaginateRequested = false;
    this.autoPaginateState = {
      status: "running",
      mode: config.mode,
      sourceId: config.sourceId,
      pagesAttempted: 0,
      maxPages,
      initialUniqueRecords: startMetrics.uniqueRecords,
      currentUniqueRecords: startMetrics.uniqueRecords,
      message: "Starting multi-page collection assistant...",
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    await activityRepo.logEvent({
      sessionId,
      actor: "user",
      category: "pagination",
      message: `Started Auto-Pagination (${
        config.mode === "dom_click"
          ? "Auto-Click Next Page"
          : config.mode === "api_fetch"
            ? "In-Tab Page URL Fetcher"
            : "Infinite Scroll"
      })`,
      detail: `Max ${maxPages} pages, ${(delayMs / 1000).toFixed(1)}s interval`,
    });

    // Run pagination loop asynchronously so the UI receives immediate confirmation
    this.runAutoPaginateLoop(tabId, sessionId, config, delayMs, maxPages).catch(
      async (err) => {
        this.autoPaginateState = {
          ...this.autoPaginateState,
          status: "error",
          message: err?.message || "Auto-pagination stopped due to an error",
          updatedAt: new Date().toISOString(),
        };
        await activityRepo.logEvent({
          sessionId,
          actor: "system",
          category: "warning",
          message: `Auto-pagination error: ${err?.message || "Unknown error"}`,
        });
      },
    );

    return this.getAutoPaginateState();
  }

  public async stopAutoPaginate(): Promise<AutoPaginateState> {
    this.stopAutoPaginateRequested = true;
    if (this.autoPaginateState.status === "running") {
      this.autoPaginateState = {
        ...this.autoPaginateState,
        status: "stopping",
        message: "Stopping after current page completes...",
        updatedAt: new Date().toISOString(),
      };
    }
    return this.getAutoPaginateState();
  }

  private async runAutoPaginateLoop(
    tabId: number,
    sessionId: string,
    config: AutoPaginateConfig,
    delayMs: number,
    maxPages: number,
  ): Promise<void> {
    let stalledSteps = 0;

    if (config.mode === "api_fetch" && config.sourceId) {
      const initialSource = await sourceRepo.getSource(config.sourceId);
      if (!initialSource?.pagination) {
        throw new Error(
          "Selected API source does not have URL pagination metadata yet. Try Auto-Click Next Page mode.",
        );
      }

      const prebuiltUrls = buildPageUrlsForSource(
        initialSource.pagination,
        maxPages,
      );
      let step = 0;

      while (step < maxPages && !this.stopAutoPaginateRequested) {
        if (
          !this.currentSession ||
          this.currentSession.status !== "recording" ||
          !this.activeTabId
        ) {
          break;
        }

        // Determine URL to fetch: either prebuilt page URL or dynamically updated `nextUrl`
        let targetUrl = prebuiltUrls[step];
        if (!targetUrl) {
          const refreshedSource = await sourceRepo.getSource(config.sourceId);
          if (
            refreshedSource?.pagination?.hasNextPage &&
            refreshedSource.pagination.nextUrl
          ) {
            targetUrl = refreshedSource.pagination.nextUrl;
          } else {
            break;
          }
        }

        step++;
        this.autoPaginateState = {
          ...this.autoPaginateState,
          pagesAttempted: step,
          message: `Fetching API page ${step} of ${Math.min(maxPages, prebuiltUrls.length || maxPages)}...`,
          updatedAt: new Date().toISOString(),
        };

        const fetchRes = await cdpAdapter.fetchUrlInTab(tabId, targetUrl);
        await sleep(Math.max(400, delayMs));

        const latestMetrics = await calculateSessionMetrics(sessionId);
        this.autoPaginateState = {
          ...this.autoPaginateState,
          currentUniqueRecords: latestMetrics.uniqueRecords,
          updatedAt: new Date().toISOString(),
        };

        if (!fetchRes.ok) {
          this.autoPaginateState.message = `Stopped: API returned status ${fetchRes.status || fetchRes.error}`;
          break;
        }

        // If we exhausted prebuilt missing pages, check if all known pages are complete
        if (prebuiltUrls.length > 0 && step >= prebuiltUrls.length) {
          break;
        }
      }
    } else {
      // DOM Click or Infinite Scroll loop
      for (let step = 1; step <= maxPages; step++) {
        if (
          this.stopAutoPaginateRequested ||
          !this.currentSession ||
          this.currentSession.status !== "recording" ||
          !this.activeTabId
        ) {
          break;
        }

        const beforeMetrics = await calculateSessionMetrics(sessionId);

        if (config.mode === "dom_click") {
          this.autoPaginateState = {
            ...this.autoPaginateState,
            pagesAttempted: step,
            message: `Advancing to next page (step ${step} of ${maxPages})...`,
            updatedAt: new Date().toISOString(),
          };

          const clickRes = await cdpAdapter.clickNextPageInTab(
            tabId,
            config.customSelector,
          );
          if (!clickRes.clicked) {
            this.autoPaginateState = {
              ...this.autoPaginateState,
              status: "completed",
              message:
                clickRes.reason ||
                "Reached final page (no enabled Next button remaining).",
              updatedAt: new Date().toISOString(),
            };
            break;
          }
        } else {
          this.autoPaginateState = {
            ...this.autoPaginateState,
            pagesAttempted: step,
            message: `Scrolling page to load more items (step ${step} of ${maxPages})...`,
            updatedAt: new Date().toISOString(),
          };

          const scrollRes = await cdpAdapter.scrollPageInTab(tabId);
          if (!scrollRes.scrolled) {
            this.autoPaginateState = {
              ...this.autoPaginateState,
              status: "completed",
              message: "Page is not scrollable.",
              updatedAt: new Date().toISOString(),
            };
            break;
          }
        }

        // Wait user-configured interval + brief buffer if requests are still inflight
        await sleep(delayMs);
        if (this.pendingRequests.size > 0) {
          await sleep(800);
        }

        const afterMetrics = await calculateSessionMetrics(sessionId);
        this.autoPaginateState = {
          ...this.autoPaginateState,
          currentUniqueRecords: afterMetrics.uniqueRecords,
          updatedAt: new Date().toISOString(),
        };

        // Check if target source reports no more pages
        if (config.sourceId) {
          const updatedSource = await sourceRepo.getSource(config.sourceId);
          if (
            updatedSource?.pagination &&
            updatedSource.pagination.hasNextPage === false &&
            updatedSource.pagination.totalPages &&
            updatedSource.pagination.observedPages.length >=
              updatedSource.pagination.totalPages
          ) {
            this.autoPaginateState = {
              ...this.autoPaginateState,
              status: "completed",
              message: `Collected all ${updatedSource.pagination.totalPages} pages for "${updatedSource.label}"!`,
              updatedAt: new Date().toISOString(),
            };
            break;
          }
        }

        if (
          afterMetrics.responsesObserved === beforeMetrics.responsesObserved
        ) {
          stalledSteps++;
          if (stalledSteps >= 2) {
            this.autoPaginateState = {
              ...this.autoPaginateState,
              status: "completed",
              message:
                "Stopped automatically: no new API responses triggered on the last 2 steps.",
              updatedAt: new Date().toISOString(),
            };
            break;
          }
        } else {
          stalledSteps = 0;
        }
      }
    }

    const finalMetrics = await calculateSessionMetrics(sessionId);
    const added = Math.max(
      0,
      finalMetrics.uniqueRecords - this.autoPaginateState.initialUniqueRecords,
    );
    const wasStoppedByUser = this.stopAutoPaginateRequested;

    this.autoPaginateState = {
      ...this.autoPaginateState,
      status: "completed",
      currentUniqueRecords: finalMetrics.uniqueRecords,
      message: wasStoppedByUser
        ? `Stopped by user after ${this.autoPaginateState.pagesAttempted} step(s) (+${added} unique records).`
        : this.autoPaginateState.status === "completed" &&
            this.autoPaginateState.message
          ? `${this.autoPaginateState.message} (+${added} new unique records)`
          : `Completed ${this.autoPaginateState.pagesAttempted} page step(s) — +${added} unique records added.`,
      updatedAt: new Date().toISOString(),
    };

    await activityRepo.logEvent({
      sessionId,
      actor: wasStoppedByUser ? "user" : "system",
      category: "pagination",
      message: this.autoPaginateState.message,
    });
  }

  public async reprocessSession(sessionId: string): Promise<void> {
    await this.init();
    const [rawResponses, sources] = await Promise.all([
      rawResponseRepo.getAllBySession(sessionId),
      sourceRepo.getSourcesBySession(sessionId),
    ]);

    const sourceMap = new Map(sources.map((s) => [s.id, s]));

    await sessionRepo.clearSessionRecords(sessionId);
    // Reset schemas for clean rebuild
    for (const src of sources) {
      const existingSchema = await schemaRepo.getSchema(src.id);
      if (existingSchema) {
        await schemaRepo.saveSchema({
          ...existingSchema,
          fields: {},
          inferredRecordPath: src.recordPath,
          detectedCount: 0,
          updatedAt: new Date().toISOString(),
        });
      }
    }

    for (const raw of rawResponses) {
      if (raw.parseStatus !== "parsed") continue;
      const parsedRes = parseApiJsonBody(raw.responseBody);
      if (!parsedRes.ok) continue;
      const parsed = parsedRes.data;

      const envelopes =
        Array.isArray(parsed) &&
        parsed.length > 0 &&
        parsed.every(
          (el) =>
            el && typeof el === "object" && ("data" in el || "errors" in el),
        )
          ? parsed
          : [parsed];

      for (const envelope of envelopes) {
        const { source } = await sourceRepo.getOrCreateSource({
          sessionId,
          url: raw.url,
          httpMethod: raw.httpMethod,
          parsedBody: envelope,
          operationName: raw.operationName,
        });

        const updatedSource = sourceMap.get(source.id) || source;
        if (!updatedSource.included) continue;

        const items = extractItemsByPath(envelope, updatedSource.recordPath);
        if (!items || items.length === 0) continue;

        const existingRecords = await recordRepo.getRecordsBySource(
          sessionId,
          updatedSource.id,
        );
        const consolidation = consolidateRecords({
          sessionId,
          sourceId: updatedSource.id,
          responseId: raw.id,
          rawItems: items,
          existingRecords,
          identityKeyField: updatedSource.identityKeyField,
          policy: updatedSource.consolidationPolicy,
        });

        await recordRepo.upsertRecords(
          consolidation.toInsert,
          consolidation.toUpdate,
        );

        const existingSchema = await schemaRepo.getSchema(updatedSource.id);
        const updatedSchema = inferSchemaFromRecords({
          sourceId: updatedSource.id,
          sessionId,
          inferredRecordPath: updatedSource.recordPath,
          records: items,
          existingSchema,
        });
        await schemaRepo.saveSchema(updatedSchema);
      }
    }

    const metrics = await calculateSessionMetrics(sessionId);
    await activityRepo.logEvent({
      sessionId,
      actor: "user",
      category: "extraction",
      message: `Reprocessed ${rawResponses.length} stored responses → ${metrics.uniqueRecords} unique records`,
    });
  }

  public async clearTabData(
    sessionId?: string,
    clearSyncQueue = true,
  ): Promise<{
    clearedResponses: number;
    clearedRecords: number;
    clearedSources: number;
    clearedSchemas: number;
    clearedErrors: number;
    targetSessionId?: string;
  }> {
    await this.init();
    const targetSessionId =
      sessionId ||
      this.currentSession?.id ||
      (await sessionRepo.getActiveSession())?.id ||
      (await sessionRepo.getAllSessions())[0]?.id;

    const isActiveSession =
      !targetSessionId ||
      !this.currentSession ||
      this.currentSession.id === targetSessionId;

    if (targetSessionId) {
      this.lastClearedAtBySession.set(targetSessionId, Date.now());
    }

    if (isActiveSession) {
      this.trackedRequests.clear();
      this.pendingRequests.clear();

      if (this.autoPaginateState.status === "running") {
        this.stopAutoPaginateRequested = true;
        this.autoPaginateState = {
          ...DEFAULT_AUTO_PAGINATE_STATE,
          status: "idle",
          message: "Reset because tab data was cleared",
        };
      }
    }

    if (!targetSessionId) {
      if (clearSyncQueue) {
        await SphereSyncClient.clearQueue();
      }
      return {
        clearedResponses: 0,
        clearedRecords: 0,
        clearedSources: 0,
        clearedSchemas: 0,
        clearedErrors: 0,
      };
    }

    // Only clear sync queue if clearing active tab or if no other session is active
    const effectiveClearSyncQueue = isActiveSession ? clearSyncQueue : false;

    const result = await sessionRepo.clearSessionData(targetSessionId, {
      clearSyncQueue: effectiveClearSyncQueue,
    });

    if (this.currentSession && this.currentSession.id === targetSessionId) {
      this.currentSession.lastResponseAt = undefined;
    }

    return {
      ...result,
      targetSessionId,
    };
  }

  public async clearAllData(options?: {
    clearSessions?: boolean;
    clearSyncQueue?: boolean;
  }): Promise<void> {
    await this.init();
    this.globalClearedAt = Date.now();
    this.lastClearedAtBySession.clear();
    this.trackedRequests.clear();
    this.pendingRequests.clear();

    if (this.autoPaginateState.status === "running") {
      this.stopAutoPaginateRequested = true;
    }
    this.autoPaginateState = { ...DEFAULT_AUTO_PAGINATE_STATE };

    await sessionRepo.clearAllCapturedData(options);

    if (options?.clearSessions) {
      if (this.activeTabId) {
        try {
          await cdpAdapter.detach(this.activeTabId);
        } catch {}
      }
      this.activeTabId = null;
      this.currentSession = null;
      await this.syncBadge("idle");
    } else if (this.currentSession) {
      this.currentSession.lastResponseAt = undefined;
    }
  }

  private pruneStaleRequests(): void {
    const now = Date.now();
    for (const [key, req] of Array.from(this.pendingRequests.entries())) {
      if (now - req.timestamp > 60_000) {
        this.pendingRequests.delete(key);
      }
    }
    for (const [key, meta] of Array.from(this.trackedRequests.entries())) {
      if (now - meta.timestamp > 60_000) {
        this.trackedRequests.delete(key);
      }
    }
  }
}

export const captureController = new CaptureController();
