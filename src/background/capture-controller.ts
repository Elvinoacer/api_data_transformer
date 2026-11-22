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
  mergePaginationState,
} from "../extraction/pagination-detector";
import {
  AutoPaginateConfig,
  AutoPaginateState,
  CaptureSession,
  CaptureStatus,
  GlobalSettings,
  RawResponse,
  ScopeMode,
} from "../shared/types";
import { DEFAULT_SETTINGS } from "../shared/constants";
import { BandaGoNormalizer } from "../extraction/bandago-normalizer";
import { SphereSyncClient } from "../sync/sphere-client";
import { BandaGoActivePoller } from "./bandago-poller";

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

  private cachedSettings: GlobalSettings = { ...DEFAULT_SETTINGS };
  private settingsListenerRegistered = false;
  private requestChains = new Map<string, Promise<void>>();
  private extractionChains = new Map<string, Promise<void>>();
  private recentCapturedHashes = new Map<string, number>();

  private autoPaginateState: AutoPaginateState = {
    ...DEFAULT_AUTO_PAGINATE_STATE,
  };
  private stopAutoPaginateRequested = false;
  private lastClearedAtBySession = new Map<string, number>();
  private loggedNonBandaEndpoints = new Set<string>();
  private mutationPollTimer: ReturnType<typeof setTimeout> | null = null;
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
   * Resets in-memory controller state (used by unit tests for clean session simulation).
   */
  public resetForTesting(): void {
    this.activeTabId = null;
    this.currentSession = null;
    this.trackedRequests.clear();
    this.pendingRequests.clear();
    this.initPromise = null;
    this.isStartingOrStopping = false;
    this.cachedSettings = { ...DEFAULT_SETTINGS };
    this.requestChains.clear();
    this.extractionChains.clear();
    this.recentCapturedHashes.clear();
    this.lastClearedAtBySession.clear();
    this.loggedNonBandaEndpoints.clear();
    this.globalClearedAt = 0;
    this.autoPaginateState = { ...DEFAULT_AUTO_PAGINATE_STATE };
  }

  private getSessionOrigin(): string | null {
    if (!this.currentSession?.originalUrl) return null;
    try {
      const parsed = new URL(this.currentSession.originalUrl);
      if (parsed.protocol === "http:" || parsed.protocol === "https:") {
        return parsed.origin;
      }
    } catch {}
    return null;
  }

  private async refreshCachedSettings(): Promise<GlobalSettings> {
    if (
      !this.settingsListenerRegistered &&
      typeof chrome !== "undefined" &&
      chrome.storage?.onChanged?.addListener
    ) {
      this.settingsListenerRegistered = true;
      chrome.storage.onChanged.addListener((changes, areaName) => {
        if (areaName === "local" && changes.lndc_global_settings_v1?.newValue) {
          this.cachedSettings = {
            ...DEFAULT_SETTINGS,
            ...changes.lndc_global_settings_v1.newValue,
          };
        }
      });
    }
    try {
      this.cachedSettings = await settingsRepo.getSettings();
    } catch {
      this.cachedSettings = { ...DEFAULT_SETTINGS };
    }
    return this.cachedSettings;
  }

  private async isDebuggerAttachedToTab(
    tabId: number,
  ): Promise<boolean | null> {
    try {
      if (
        typeof chrome === "undefined" ||
        typeof chrome.debugger?.getTargets !== "function"
      ) {
        return null;
      }
      const targets = await new Promise<chrome.debugger.TargetInfo[]>(
        (resolve, reject) => {
          try {
            const maybePromise = (
              chrome.debugger.getTargets as unknown as (
                cb?: (res: chrome.debugger.TargetInfo[]) => void,
              ) => Promise<chrome.debugger.TargetInfo[]> | undefined
            )((res) => resolve(Array.isArray(res) ? res : []));
            if (
              maybePromise &&
              typeof (maybePromise as Promise<unknown>).then === "function"
            ) {
              maybePromise
                .then((res) => resolve(Array.isArray(res) ? res : []))
                .catch(reject);
            }
          } catch (err) {
            reject(err);
          }
        },
      );
      return targets.some((t) => t.tabId === tabId && Boolean(t.attached));
    } catch {
      return null;
    }
  }

  /**
   * Recovers active session state from IndexedDB on service worker spin-up,
   * automatically marking stale sessions detached if Chrome debugger is no longer attached.
   */
  public async init(): Promise<void> {
    if (!this.initPromise) {
      this.initPromise = (async () => {
        await this.refreshCachedSettings();
        const session = await sessionRepo.getActiveSession();
        if (session) {
          const attached = session.targetTabId
            ? await this.isDebuggerAttachedToTab(session.targetTabId)
            : false;
          if (attached === false) {
            const detachReason =
              "Debugger detached after extension reload — click Start Capture to re-attach";
            await sessionRepo
              .updateStatus(session.id, "detached", detachReason)
              .catch(() => {});
            session.status = "detached";
            session.errorReason = detachReason;
            this.currentSession = session;
            this.activeTabId = null;
            await this.syncBadge("detached");
          } else {
            this.currentSession = session;
            this.activeTabId = session.targetTabId;
            await this.syncBadge(session.status);
          }
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
      const attached = this.activeTabId
        ? await this.isDebuggerAttachedToTab(this.activeTabId)
        : false;
      if (attached === false) {
        const staleReason =
          "Debugger detached from previous session — starting new capture";
        await sessionRepo
          .updateStatus(this.currentSession.id, "detached", staleReason)
          .catch(() => {});
        this.currentSession.status = "detached";
        this.activeTabId = null;
        this.trackedRequests.clear();
        this.pendingRequests.clear();
        this.recentCapturedHashes.clear();
      } else {
        throw new Error(
          "A capture session is already recording. Stop it before starting a new one.",
        );
      }
    }

    this.isStartingOrStopping = true;
    try {
      const settings = await this.refreshCachedSettings();
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
      this.recentCapturedHashes.clear();
      this.autoPaginateState = { ...DEFAULT_AUTO_PAGINATE_STATE };

      try {
        await cdpAdapter.attach(params.tabId);
        await cdpAdapter.enableNetwork(params.tabId);
        session.status = "recording";
        await sessionRepo.updateStatus(session.id, "recording");
        await this.syncBadge("recording");

        // Best-effort passive bridge injection so already-open BandaGo tabs capture seamlessly without reload
        if (
          typeof chrome !== "undefined" &&
          chrome.scripting?.executeScript &&
          /bandahealth\.org/i.test(params.originalUrl || "")
        ) {
          Promise.resolve(
            chrome.scripting.executeScript({
              target: { tabId: params.tabId },
              files: ["isolated-bridge.js"],
              world: "ISOLATED",
            }),
          ).catch(() => {});
          Promise.resolve(
            chrome.scripting.executeScript({
              target: { tabId: params.tabId },
              files: ["main-interceptor.js"],
              world: "MAIN",
            }),
          ).catch(() => {});
        }

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
    this.recentCapturedHashes.clear();
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
      this.recentCapturedHashes.clear();
      await this.syncBadge("detached");
    }
  }

  public async handleTabRemoved(tabId: number): Promise<void> {
    await this.init();
    if (this.activeTabId === tabId) {
      await this.handleDebuggerDetach(tabId, "Target browser tab was closed");
    }
  }

  /**
   * Serializes CDP events per requestId so rapid Network.responseReceived and
   * Network.loadingFinished events execute strictly in arrival order without dropping responses.
   */
  public onCdpEvent(
    debuggee: chrome.debugger.Debuggee,
    method: string,
    params?: any,
  ): Promise<void> {
    const requestId: string | undefined = params?.requestId;
    if (!requestId) {
      return this.handleCdpEventInternal(debuggee, method, params);
    }
    const previous = this.requestChains.get(requestId) || Promise.resolve();
    const next = previous
      .catch(() => {})
      .then(() => this.handleCdpEventInternal(debuggee, method, params));
    this.requestChains.set(requestId, next);
    next.finally(() => {
      if (this.requestChains.get(requestId) === next) {
        this.requestChains.delete(requestId);
      }
    });
    return next;
  }

  private async handleCdpEventInternal(
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
        const resolvedPostData =
          typeof req.postData === "string"
            ? req.postData.slice(0, 1048576)
            : Array.isArray(req.postDataEntries)
              ? req.postDataEntries
                  .map((e: any) => (typeof e?.bytes === "string" ? e.bytes : ""))
                  .join("")
                  .slice(0, 1048576) || undefined
              : undefined;

        this.trackedRequests.set(requestId, {
          httpMethod: (req.method || "GET").toUpperCase(),
          postData: resolvedPostData,
          timestamp: Date.now(),
        });

        const url = req.url || "";
        if (/(?:^|\/)graphql(?:\/|\?|$)/i.test(url)) {
          try {
            const reqOrigin = new URL(url, this.getSessionOrigin() || "https://go.bandahealth.org").origin;
            const sessionOrigin = this.getSessionOrigin();
            const isBatched = resolvedPostData
              ? resolvedPostData.trim().startsWith("[") || undefined
              : undefined;
            cdpAdapter
              .setGraphqlEndpoint(reqOrigin, url, isBatched)
              .catch(() => {});
            if (sessionOrigin && sessionOrigin !== reqOrigin) {
              cdpAdapter
                .setGraphqlEndpoint(sessionOrigin, url, isBatched)
                .catch(() => {});
            }
            const auth = req.headers?.Authorization || req.headers?.authorization;
            if (auth && typeof auth === "string") {
              cdpAdapter.setAuthHeader(reqOrigin, auth).catch(() => {});
              if (sessionOrigin && sessionOrigin !== reqOrigin) {
                cdpAdapter.setAuthHeader(sessionOrigin, auth).catch(() => {});
              }
            }
          } catch {}
        }
      }
      return;
    }

    if (method === "Network.responseReceived") {
      const response = params?.response;
      const requestId = params?.requestId;
      if (!response || !requestId) return;

      const resourceType = params.type || "";
      const url = response.url || "";
      const mimeType = response.mimeType || "";
      const httpStatus = response.status ?? 200;

      const tracked = this.trackedRequests.get(requestId);
      const httpMethod = (
        tracked?.httpMethod ||
        response.requestHeaders?.[":method"] ||
        "GET"
      ).toUpperCase();

      // Skip CORS preflight and intentionally empty responses before entering pending map
      if (httpMethod === "OPTIONS" || httpStatus === 204 || httpStatus === 205) {
        this.trackedRequests.delete(requestId);
        return;
      }

      const settings = this.cachedSettings || DEFAULT_SETTINGS;
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
      const requestId = params?.requestId;
      if (!requestId) return;
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
      const requestId = params?.requestId;
      if (!requestId) return;
      this.pendingRequests.delete(requestId);
      this.trackedRequests.delete(requestId);
    }
  }

  private recordRecentHash(
    sessionId: string,
    contentHash: string,
    envelope?: any,
  ): void {
    const now = Date.now();
    for (const [k, ts] of Array.from(this.recentCapturedHashes.entries())) {
      if (now - ts > 10_000) {
        this.recentCapturedHashes.delete(k);
      }
    }
    this.recentCapturedHashes.set(`${sessionId}:${contentHash}`, now);
    if (
      envelope &&
      typeof envelope === "object" &&
      envelope.data &&
      typeof envelope.data === "object" &&
      !Array.isArray(envelope.data)
    ) {
      for (const rootKey of Object.keys(envelope.data)) {
        const rootHash = generateStableContentHash(envelope.data[rootKey]);
        this.recentCapturedHashes.set(
          `${sessionId}:root:${rootKey}:${rootHash}`,
          now,
        );
      }
    }
  }

  private hasRecentHash(
    sessionId: string,
    contentHash: string,
    rootKey?: string,
    rootVal?: unknown,
  ): boolean {
    const now = Date.now();
    const directTs = this.recentCapturedHashes.get(`${sessionId}:${contentHash}`);
    if (directTs !== undefined && now - directTs <= 10_000) {
      return true;
    }
    if (rootKey !== undefined && rootVal !== undefined) {
      const rootHash = generateStableContentHash(rootVal);
      const rootTs = this.recentCapturedHashes.get(
        `${sessionId}:root:${rootKey}:${rootHash}`,
      );
      if (rootTs !== undefined && now - rootTs <= 10_000) {
        return true;
      }
    }
    return false;
  }

  private runSerializedExtraction<T>(
    sessionId: string,
    task: () => Promise<T>,
  ): Promise<T> {
    const prev = this.extractionChains.get(sessionId) || Promise.resolve();
    const resultPromise = prev.catch(() => {}).then(task);
    const tail = resultPromise.then(
      () => undefined,
      () => undefined,
    );
    this.extractionChains.set(sessionId, tail);
    tail.finally(() => {
      if (this.extractionChains.get(sessionId) === tail) {
        this.extractionChains.delete(sessionId);
      }
    });
    return resultPromise;
  }

  private async getResponseBodyWithRetry(
    tabId: number,
    requestId: string,
  ): Promise<string> {
    try {
      return await cdpAdapter.getResponseBody(tabId, requestId);
    } catch (firstErr) {
      await sleep(120);
      try {
        return await cdpAdapter.getResponseBody(tabId, requestId);
      } catch {
        throw firstErr;
      }
    }
  }

  private async processFinishedResponse(
    pending: PendingRequest,
  ): Promise<void> {
    if (!this.currentSession) return;
    const sessionId = this.currentSession.id;

    const sessionClearTime = this.lastClearedAtBySession.get(sessionId) || 0;
    const discardThreshold = Math.max(sessionClearTime, this.globalClearedAt);
    if (pending.timestamp <= discardThreshold) {
      return;
    }

    const settings = this.cachedSettings || DEFAULT_SETTINGS;

    let bodyText = "";
    try {
      bodyText = await this.getResponseBodyWithRetry(
        pending.tabId,
        pending.requestId,
      );
    } catch (err: any) {
      // Re-check discard threshold in case clear was triggered while awaiting body
      const currentThreshold = Math.max(
        this.lastClearedAtBySession.get(sessionId) || 0,
        this.globalClearedAt,
      );
      if (pending.timestamp <= currentThreshold) return;

      await errorRepo.logError({
        sessionId,
        kind: "body_retrieval",
        url: redactSensitiveUrl(pending.url, settings.sensitiveUrlParams),
        message: err.message || "Could not retrieve response body",
      });
      return;
    }

    // Re-check discard threshold in case clear occurred during body retrieval
    const currentThreshold = Math.max(
      this.lastClearedAtBySession.get(sessionId) || 0,
      this.globalClearedAt,
    );
    if (pending.timestamp <= currentThreshold) {
      return;
    }

    const responseBytes = new Blob([bodyText]).size;
    if (responseBytes > settings.maxResponseBodyBytes) {
      await errorRepo.logError({
        sessionId,
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
        sessionId,
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
    const isBatchedArray =
      Array.isArray(parsed) &&
      parsed.length > 0 &&
      parsed.every(
        (el) =>
          el && typeof el === "object" && ("data" in el || "errors" in el),
      );
    const envelopes = isBatchedArray ? parsed : [parsed];

    // Record hashes synchronously before async extraction so passive bridge won't double-insert
    const envelopeHashes = envelopes.map((env) => {
      const h = generateStableContentHash(env);
      this.recordRecentHash(sessionId, h, env);
      return h;
    });

    // Record discovered GraphQL endpoint URL + batch mode for active poller & writeback under both origins
    if (pending.url.toLowerCase().includes("/graphql")) {
      try {
        const reqOrigin = new URL(
          pending.url,
          this.getSessionOrigin() || "https://go.bandahealth.org",
        ).origin;
        const sessionOrigin = this.getSessionOrigin();
        cdpAdapter
          .setGraphqlEndpoint(reqOrigin, pending.url, isBatchedArray)
          .catch(() => {});
        if (sessionOrigin && sessionOrigin !== reqOrigin) {
          cdpAdapter
            .setGraphqlEndpoint(sessionOrigin, pending.url, isBatchedArray)
            .catch(() => {});
        }
      } catch {}
    }

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

    // Invoke BandaGo catalog handler ONCE on the entire parsed batch so M_ProductGet + M_StorageOnHandGet merge properly
    await this.handleBandaGoPayload(
      pending.url,
      pending.postData,
      parsed,
      "CDP_INTERCEPT",
    );

    for (const [idx, envelope] of envelopes.entries()) {
      let envelopeOpName = envelopes.length === 1 ? operationName : undefined;
      let envelopePostData = pending.postData;

      if (postDataBatch && postDataBatch[idx]) {
        const opItem = postDataBatch[idx];
        envelopePostData = JSON.stringify(opItem);
        envelopeOpName =
          opItem.operationName ||
          (typeof opItem.query === "string"
            ? opItem.query.match(/\b(?:query|mutation)\s+([A-Za-z0-9_]+)/)?.[1]
            : undefined) ||
          (envelopes.length === 1 ? operationName : undefined);
      }

      const envelopeDataKeys =
        envelope &&
        typeof envelope === "object" &&
        envelope.data &&
        typeof envelope.data === "object" &&
        !Array.isArray(envelope.data)
          ? Object.keys(envelope.data)
          : [];

      if (!envelopeOpName && envelopeDataKeys.length === 1) {
        envelopeOpName = envelopeDataKeys[0];
      }

      // Separate count-only GraphQL queries (e.g. { PagingInfo: { TotalCount: 24 } } without Results)
      // so badge counts never clobber the main dataset's recordPath or 1,349-row pagination!
      if (envelopeDataKeys.length === 1) {
        const rootKey = envelopeDataKeys[0];
        const rootVal = envelope.data[rootKey];
        if (
          rootVal &&
          typeof rootVal === "object" &&
          !Array.isArray(rootVal) &&
          !("Results" in rootVal) &&
          !("results" in rootVal) &&
          ("PagingInfo" in rootVal || "pageInfo" in rootVal)
        ) {
          envelopeOpName = `${envelopeOpName || rootKey}:count`;
        }
      }

      const contentHash = envelopeHashes[idx];
      const responseId = `resp_${Date.now()}_${idx}_${Math.random().toString(36).slice(2, 6)}`;
      const redactedUrl = redactSensitiveUrl(
        pending.url,
        settings.sensitiveUrlParams,
      );

      const extraction = await this.runSerializedExtraction(sessionId, () =>
        this.extractAndConsolidate({
          sessionId,
          responseId,
          url: pending.url,
          httpMethod: pending.httpMethod,
          operationName: envelopeOpName,
          requestBody: envelopePostData,
          parsedData: envelope,
        }),
      );

      const rawResponse: RawResponse = {
        id: responseId,
        sessionId,
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
   * Deduplicated fallback ingestion from passive MAIN-world BandaGo fetch/XHR hooks
   * into the active recording session when CDP missed an event or DevTools interfered.
   */
  public async ingestPassiveBandaGoCatalog(params: {
    tabId?: number;
    endpointUrl?: string;
    operationName?: string;
    payload: unknown;
  }): Promise<{ captured: boolean; extractedCount: number }> {
    await this.init();

    if (!this.currentSession || this.currentSession.status !== "recording") {
      return { captured: false, extractedCount: 0 };
    }
    if (
      typeof params.tabId === "number" &&
      this.activeTabId &&
      params.tabId !== this.activeTabId
    ) {
      return { captured: false, extractedCount: 0 };
    }

    const sessionId = this.currentSession.id;
    const settings = this.cachedSettings || DEFAULT_SETTINGS;
    const endpointUrl =
      params.endpointUrl ||
      `${this.getSessionOrigin() || "https://go.bandahealth.org"}/graphql/`;

    const rawPayloads = Array.isArray(params.payload)
      ? params.payload
      : [params.payload];
    const envelopesToProcess: Array<{
      envelope: Record<string, any>;
      rootKey?: string;
      rootVal?: unknown;
      opName?: string;
    }> = [];

    for (const item of rawPayloads) {
      if (!item || typeof item !== "object") continue;
      const dataObj = (item as any).data;
      if (dataObj && typeof dataObj === "object" && !Array.isArray(dataObj)) {
        const rootKeys = Object.keys(dataObj);
        for (const rootKey of rootKeys) {
          const val = dataObj[rootKey];
          if (!val || typeof val !== "object") continue;
          const envelope = { data: { [rootKey]: val } };
          envelopesToProcess.push({
            envelope,
            rootKey,
            rootVal: val,
            opName:
              rootKeys.length === 1 && params.operationName
                ? params.operationName
                : rootKey,
          });
        }
      }
    }

    let totalExtracted = 0;
    let capturedAny = false;

    for (const [idx, entry] of envelopesToProcess.entries()) {
      const contentHash = generateStableContentHash(entry.envelope);
      if (
        this.hasRecentHash(
          sessionId,
          contentHash,
          entry.rootKey,
          entry.rootVal,
        )
      ) {
        continue;
      }
      this.recordRecentHash(sessionId, contentHash, entry.envelope);

      const responseId = `passive_${Date.now()}_${idx}_${Math.random().toString(36).slice(2, 6)}`;
      const bodyStr = JSON.stringify(entry.envelope);
      const extraction = await this.runSerializedExtraction(sessionId, () =>
        this.extractAndConsolidate({
          sessionId,
          responseId,
          url: endpointUrl,
          httpMethod: "POST",
          operationName: entry.opName,
          parsedData: entry.envelope,
        }),
      );

      const rawResponse: RawResponse = {
        id: responseId,
        sessionId,
        capturedAt: new Date().toISOString(),
        url: redactSensitiveUrl(endpointUrl, settings.sensitiveUrlParams),
        normalizedEndpoint: normalizeEndpoint(endpointUrl, entry.opName),
        httpStatus: 200,
        httpMethod: "POST",
        resourceType: "Fetch",
        mimeType: "application/json",
        responseBody: bodyStr,
        parseStatus: "parsed",
        responseBytes: new Blob([bodyStr]).size,
        contentHash,
        operationName: entry.opName,
        extractedCount: extraction.extractedCount,
        paginationMeta: extraction.paginationMeta,
      };

      await rawResponseRepo.addResponse(rawResponse);
      capturedAny = true;
      totalExtracted += extraction.extractedCount;
    }

    return { captured: capturedAny, extractedCount: totalExtracted };
  }

  /**
   * Detects BandaGo POS payloads and normalizes them for outbound Sphere sync.
   */
  public async handleBandaGoPayload(
    sourceUrl: string,
    _postData: string | undefined,
    dataNode: unknown,
    trigger?: string,
  ): Promise<void> {
    if (!dataNode || typeof dataNode !== "object") return;

    const lowerUrl = (sourceUrl || "").toLowerCase();
    const isBandaCandidate =
      lowerUrl.includes("/graphql") ||
      lowerUrl.includes("bandahealth") ||
      lowerUrl.includes("bandago") ||
      lowerUrl.includes("idempiere");

    if (!isBandaCandidate) {
      // Silently dropping here made it look like sync "never tried". Log once per
      // endpoint when a non-BandaGo response nevertheless looks like a product list.
      try {
        const endpointKey = sourceUrl.split("?")[0];
        if (!this.loggedNonBandaEndpoints.has(endpointKey)) {
          const lookalikes =
            BandaGoNormalizer.extractProductsFromPayload(dataNode).length;
          if (lookalikes > 0) {
            this.loggedNonBandaEndpoints.add(endpointKey);
            console.info(
              `[BandaGo POS] Skipped Sphere sync for ${lookalikes} product-like records from ${endpointKey}: ` +
                `only URLs containing /graphql, bandahealth, bandago or idempiere are synced.`,
            );
          }
        }
      } catch {}
      return;
    }

    try {
      const normalizedProducts =
        BandaGoNormalizer.extractProductsFromPayload(dataNode);

      if (normalizedProducts.length > 0) {
        const detectedTenantUU =
          BandaGoNormalizer.extractTenantUU(dataNode) ||
          normalizedProducts.find((item) => Boolean(item.tenantUU))?.tenantUU ||
          null;
        const sphereCfg = await SphereSyncClient.getConfig();
        if (
          sphereCfg.expectedTenantUU?.trim() &&
          detectedTenantUU &&
          sphereCfg.expectedTenantUU.trim() !== detectedTenantUU
        ) {
          const mismatchMsg = `Blocked CDP payload from unexpected BandaGo tenant ${detectedTenantUU} (expected ${sphereCfg.expectedTenantUU.trim()})`;
          console.warn(`[BandaGo POS] ${mismatchMsg}`);
          await SphereSyncClient.recordError({
            source: "SYNC_FLUSH",
            message: mismatchMsg,
          }).catch(() => {});
          await SphereSyncClient.reportTelemetry({
            errors: [
              {
                direction: "INBOUND",
                source: "CDP_INTERCEPT",
                severity: "CRITICAL",
                code: "TENANT_MISMATCH",
                message: mismatchMsg,
              },
            ],
          }).catch(() => {});
          return;
        }

        console.log(
          `[BandaGo POS] Intercepted ${normalizedProducts.length} medications from ${sourceUrl}. Queueing Sphere sync...`,
        );
        if (trigger && detectedTenantUU) {
          await SphereSyncClient.enqueue(
            normalizedProducts,
            trigger,
            detectedTenantUU,
          );
        } else if (trigger) {
          await SphereSyncClient.enqueue(normalizedProducts, trigger);
        } else if (detectedTenantUU) {
          await SphereSyncClient.enqueue(
            normalizedProducts,
            "CDP_INTERCEPT",
            detectedTenantUU,
          );
        } else {
          await SphereSyncClient.enqueue(normalizedProducts);
        }

        if (this.currentSession) {
          await activityRepo.logEvent({
            sessionId: this.currentSession.id,
            actor: "system",
            category: "session",
            message: `[BandaGo POS] Intercepted ${normalizedProducts.length} medications. Queued for Sphere Pharmacy sync.`,
          });
        }
      } else if (
        _postData &&
        /\bmutation\b/i.test(_postData) &&
        /(C_Order|M_InOut|M_Inventory|M_Movement|Process|Complete|Save|Bill|Dispense|Receive)/i.test(
          _postData,
        )
      ) {
        // When a counter sale (C_Order), stock receipt (M_InOut), or physical adjustment (M_Inventory)
        // GraphQL mutation completes without returning full M_StorageOnHand rows in the mutation response,
        // trigger a debounced active tab poll 1.5s later so Sphere Pharmacy receives updated stock immediately.
        if (this.mutationPollTimer) {
          clearTimeout(this.mutationPollTimer);
        }
        this.mutationPollTimer = setTimeout(() => {
          this.mutationPollTimer = null;
          BandaGoActivePoller.pollActiveTabs().catch((pollErr) => {
            console.warn(
              "[BandaGo POS] Post-mutation stock refresh poll failed:",
              pollErr,
            );
          });
        }, 1500);
      }
    } catch (err: any) {
      console.error("[BandaGo POS] Error handling payload sync:", err);
      await SphereSyncClient.recordError({
        source: "SYNC_FLUSH",
        message: `Payload extraction error: ${err?.message || "Unknown error"}`,
      }).catch(() => {});
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

  private async waitForPendingRequests(maxWaitMs = 3000): Promise<void> {
    const start = Date.now();
    while (this.pendingRequests.size > 0 && Date.now() - start < maxWaitMs) {
      await sleep(150);
    }
    // Brief extra buffer for IndexedDB write completion
    await sleep(150);
  }

  private async runAutoPaginateLoop(
    tabId: number,
    sessionId: string,
    config: AutoPaginateConfig,
    delayMs: number,
    maxPages: number,
  ): Promise<void> {
    let stalledSteps = 0;

    // 1. Auto-bootstrap: if no API sources have been captured yet in this session,
    // reload the target tab so Page 1 is captured before stepping through pages.
    let sessionSources = await sourceRepo.getSourcesBySession(sessionId);
    if (sessionSources.length === 0 && !this.stopAutoPaginateRequested) {
      this.autoPaginateState = {
        ...this.autoPaginateState,
        message: "Reloading target tab to capture initial API page...",
        updatedAt: new Date().toISOString(),
      };
      try {
        await chrome.tabs.reload(tabId);
      } catch {
        // Fallback if chrome.tabs.reload is unavailable
      }
      const bootStart = Date.now();
      while (Date.now() - bootStart < 4000 && !this.stopAutoPaginateRequested) {
        await sleep(300);
        await this.waitForPendingRequests(1500);
        sessionSources = await sourceRepo.getSourcesBySession(sessionId);
        if (sessionSources.length > 0) break;
      }
      const postBootMetrics = await calculateSessionMetrics(sessionId);
      this.autoPaginateState = {
        ...this.autoPaginateState,
        currentUniqueRecords: postBootMetrics.uniqueRecords,
        updatedAt: new Date().toISOString(),
      };
    }

    // Resolve target source (explicitly selected or primary paginated GET source)
    const resolvedSourceId =
      (config.sourceId &&
        sessionSources.find((s) => s.id === config.sourceId)?.id) ||
      sessionSources.find((s) => s.pagination && s.pagination.totalPages && s.pagination.totalPages > 1)?.id ||
      sessionSources[0]?.id;

    const runDirectUrlFetch = async (sourceId: string): Promise<boolean> => {
      const src = await sourceRepo.getSource(sourceId);
      if (!src?.pagination) return false;

      const prebuiltUrls = buildPageUrlsForSource(src.pagination, maxPages);
      if (prebuiltUrls.length === 0 && !src.pagination.nextUrl) return false;

      let step = 0;
      while (step < maxPages && !this.stopAutoPaginateRequested) {
        if (
          !this.currentSession ||
          this.currentSession.status !== "recording" ||
          !this.activeTabId
        ) {
          break;
        }

        let targetUrl = prebuiltUrls[step];
        if (!targetUrl) {
          const refreshedSource = await sourceRepo.getSource(sourceId);
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
        await this.waitForPendingRequests();

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

        if (prebuiltUrls.length > 0 && step >= prebuiltUrls.length) {
          this.autoPaginateState = {
            ...this.autoPaginateState,
            status: "completed",
            message: `Fetched all ${prebuiltUrls.length} remaining page(s) for "${src.label}"!`,
            updatedAt: new Date().toISOString(),
          };
          break;
        }
      }
      return step > 0;
    };

    if (config.mode === "api_fetch") {
      if (!resolvedSourceId) {
        throw new Error(
          "No API dataset discovered yet. Refresh the target tab once while recording, then click Fetch Pages.",
        );
      }
      const ran = await runDirectUrlFetch(resolvedSourceId);
      if (!ran) {
        throw new Error(
          "Selected API source does not have URL pagination metadata yet. Try Auto-Click Next Page mode.",
        );
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
            // If DOM Next button is disabled (e.g. tab was already on final page)
            // but our source still has missing URL pages, fetch them directly!
            if (resolvedSourceId) {
              const fallbackRan = await runDirectUrlFetch(resolvedSourceId);
              if (fallbackRan) break;
            }
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

        // Wait user-configured interval + any in-flight network bodies
        await sleep(delayMs);
        await this.waitForPendingRequests();

        const afterMetrics = await calculateSessionMetrics(sessionId);
        this.autoPaginateState = {
          ...this.autoPaginateState,
          currentUniqueRecords: afterMetrics.uniqueRecords,
          updatedAt: new Date().toISOString(),
        };

        // Check if target source reports all pages collected
        if (resolvedSourceId) {
          const updatedSource = await sourceRepo.getSource(resolvedSourceId);
          if (
            updatedSource?.pagination &&
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
            // Try direct URL fetch for any remaining missing pages before giving up
            if (resolvedSourceId) {
              const fallbackRan = await runDirectUrlFetch(resolvedSourceId);
              if (fallbackRan) break;
            }
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
      this.recentCapturedHashes.clear();

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
    this.recentCapturedHashes.clear();

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
