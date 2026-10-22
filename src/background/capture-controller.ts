import { cdpAdapter } from './cdp-adapter';
import {
  errorRepo,
  rawResponseRepo,
  recordRepo,
  schemaRepo,
  sessionRepo,
  sourceRepo,
} from '../data/repositories';
import { checkResponseEligibility } from '../privacy/source-policy';
import { normalizeEndpoint, redactSensitiveUrl } from '../privacy/url-redaction';
import { extractItemsByPath } from '../extraction/path-selector';
import { consolidateRecords, generateStableContentHash } from '../extraction/deduplicate';
import { inferSchemaFromRecords } from '../extraction/schema-inference';
import { CaptureSession, CaptureStatus, RawResponse } from '../shared/types';
import { DEFAULT_SETTINGS } from '../shared/constants';

interface PendingRequest {
  tabId: number;
  requestId: string;
  url: string;
  httpMethod: string;
  httpStatus: number;
  mimeType: string;
  resourceType: string;
  timestamp: number;
}

class CaptureController {
  private activeTabId: number | null = null;
  private currentSession: CaptureSession | null = null;
  private pendingRequests = new Map<string, PendingRequest>();

  public getStatus(): CaptureStatus {
    return this.currentSession?.status || 'idle';
  }

  public getActiveSession(): CaptureSession | null {
    return this.currentSession;
  }

  /**
   * Recovers active session state from database on service worker spin-up.
   */
  public async init(): Promise<void> {
    const session = await sessionRepo.getActiveSession();
    if (session) {
      this.currentSession = session;
      this.activeTabId = session.targetTabId;
    }
  }

  public async startCapture(params: {
    tabId: number;
    originalUrl: string;
    allowedHostnames: string[];
    label?: string;
  }): Promise<CaptureSession> {
    if (this.currentSession && (this.currentSession.status === 'recording' || this.currentSession.status === 'starting')) {
      throw new Error('A capture session is already in progress.');
    }

    const session = await sessionRepo.createSession({
      targetTabId: params.tabId,
      originalUrl: params.originalUrl,
      allowedHostnames: params.allowedHostnames,
      label: params.label,
    });
    this.currentSession = session;
    this.activeTabId = params.tabId;
    this.pendingRequests.clear();

    try {
      await cdpAdapter.attach(params.tabId);
      await cdpAdapter.enableNetwork(params.tabId);
      await sessionRepo.updateStatus(session.id, 'recording');
      session.status = 'recording';
      return session;
    } catch (err: any) {
      await cdpAdapter.detach(params.tabId);
      await sessionRepo.updateStatus(session.id, 'error', err.message || 'Debugger attach failed');
      session.status = 'error';
      session.errorReason = err.message;
      await errorRepo.logError({
        sessionId: session.id,
        kind: 'debugger_attach',
        message: err.message || 'Failed to attach debugger to tab',
        details: err,
      });
      throw err;
    }
  }

  public async pauseCapture(sessionId?: string): Promise<void> {
    const targetSessionId = sessionId || this.currentSession?.id;
    if (!targetSessionId || !this.currentSession) return;

    await sessionRepo.updateStatus(targetSessionId, 'paused');
    this.currentSession.status = 'paused';
  }

  public async resumeCapture(sessionId?: string): Promise<void> {
    const targetSessionId = sessionId || this.currentSession?.id;
    if (!targetSessionId || !this.currentSession) return;

    await sessionRepo.updateStatus(targetSessionId, 'recording');
    this.currentSession.status = 'recording';
  }

  public async stopCapture(sessionId?: string): Promise<void> {
    const targetSessionId = sessionId || this.currentSession?.id;
    if (this.activeTabId) {
      await cdpAdapter.detach(this.activeTabId);
    }

    if (targetSessionId) {
      await sessionRepo.updateStatus(targetSessionId, 'stopped');
    }

    if (this.currentSession) {
      this.currentSession.status = 'stopped';
      this.currentSession.endedAt = new Date().toISOString();
    }

    this.activeTabId = null;
    this.pendingRequests.clear();
  }

  public async handleDebuggerDetach(tabId: number, reason: string): Promise<void> {
    if (this.activeTabId === tabId && this.currentSession) {
      await sessionRepo.updateStatus(this.currentSession.id, 'detached', reason);
      this.currentSession.status = 'detached';
      this.activeTabId = null;
      this.pendingRequests.clear();
    }
  }

  public async handleTabRemoved(tabId: number): Promise<void> {
    if (this.activeTabId === tabId) {
      await this.handleDebuggerDetach(tabId, 'Target browser tab was closed');
    }
  }

  public async onCdpEvent(
    debuggee: chrome.debugger.Debuggee,
    method: string,
    params?: any
  ): Promise<void> {
    if (!this.currentSession || !this.activeTabId || debuggee.tabId !== this.activeTabId) {
      return;
    }

    // Prune stale pending requests older than 90s
    this.pruneStaleRequests();

    if (method === 'Network.responseReceived') {
      const response = params.response;
      const requestId = params.requestId;
      const resourceType = params.type || '';
      const url = response.url || '';
      const mimeType = response.mimeType || '';
      const httpStatus = response.status || 200;

      const eligibility = checkResponseEligibility({
        url,
        allowedHostnames: this.currentSession.allowedHostnames,
        mimeType,
        resourceType,
      });

      if (eligibility.isEligible) {
        this.pendingRequests.set(requestId, {
          tabId: debuggee.tabId,
          requestId,
          url,
          httpMethod: response.requestHeaders?.[':method'] || 'GET',
          httpStatus,
          mimeType,
          resourceType,
          timestamp: Date.now(),
        });
      }
    } else if (method === 'Network.loadingFinished') {
      const requestId = params.requestId;
      const pending = this.pendingRequests.get(requestId);
      if (!pending) return;

      this.pendingRequests.delete(requestId);

      // Only persist if currently recording
      if (this.currentSession.status !== 'recording') {
        return;
      }

      await this.processFinishedResponse(pending);
    } else if (method === 'Network.loadingFailed') {
      const requestId = params.requestId;
      this.pendingRequests.delete(requestId);
    }
  }

  private async processFinishedResponse(pending: PendingRequest): Promise<void> {
    if (!this.currentSession) return;

    let bodyText = '';
    try {
      bodyText = await cdpAdapter.getResponseBody(pending.tabId, pending.requestId);
    } catch (err: any) {
      await errorRepo.logError({
        sessionId: this.currentSession.id,
        kind: 'body_retrieval',
        url: redactSensitiveUrl(pending.url),
        message: err.message || 'Could not retrieve response body',
      });
      return;
    }

    const responseBytes = new Blob([bodyText]).size;
    if (responseBytes > DEFAULT_SETTINGS.maxResponseBodyBytes) {
      await errorRepo.logError({
        sessionId: this.currentSession.id,
        kind: 'storage_limit',
        url: redactSensitiveUrl(pending.url),
        message: `Response size (${(responseBytes / (1024 * 1024)).toFixed(2)} MB) exceeded limit (${(DEFAULT_SETTINGS.maxResponseBodyBytes / (1024 * 1024)).toFixed(2)} MB)`,
      });
      return;
    }

    let parsed: unknown = null;
    try {
      parsed = JSON.parse(bodyText);
    } catch (err: any) {
      // Invalid JSON
      const rawResponse: RawResponse = {
        id: `resp_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
        sessionId: this.currentSession.id,
        capturedAt: new Date().toISOString(),
        url: redactSensitiveUrl(pending.url),
        normalizedEndpoint: normalizeEndpoint(pending.url),
        httpStatus: pending.httpStatus,
        httpMethod: pending.httpMethod,
        resourceType: pending.resourceType,
        mimeType: pending.mimeType,
        responseBody: bodyText,
        parseStatus: 'invalid_json',
        responseBytes,
        errorMessage: err.message,
      };
      await rawResponseRepo.addResponse(rawResponse);
      return;
    }

    const contentHash = generateStableContentHash(parsed);
    const responseId = `resp_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    const rawResponse: RawResponse = {
      id: responseId,
      sessionId: this.currentSession.id,
      capturedAt: new Date().toISOString(),
      url: redactSensitiveUrl(pending.url),
      normalizedEndpoint: normalizeEndpoint(pending.url),
      httpStatus: pending.httpStatus,
      httpMethod: pending.httpMethod,
      resourceType: pending.resourceType,
      mimeType: pending.mimeType,
      responseBody: bodyText,
      parseStatus: 'parsed',
      responseBytes,
      contentHash,
    };

    // Save raw response first
    await rawResponseRepo.addResponse(rawResponse);

    // Extract records and update schema
    await this.extractAndConsolidate({
      sessionId: this.currentSession.id,
      responseId,
      url: pending.url,
      httpMethod: pending.httpMethod,
      parsedData: parsed,
    });
  }

  private async extractAndConsolidate(params: {
    sessionId: string;
    responseId: string;
    url: string;
    httpMethod: string;
    parsedData: unknown;
  }): Promise<void> {
    const { sessionId, responseId, url, httpMethod, parsedData } = params;

    // Get or create endpoint source configuration
    const source = await sourceRepo.getOrCreateSource({
      sessionId,
      url,
      httpMethod,
      parsedBody: parsedData,
    });

    if (!source.included) {
      return;
    }

    // Extract items using source record path
    const items = extractItemsByPath(parsedData, source.recordPath);
    if (!items || items.length === 0) {
      return;
    }

    // Load existing records for deduplication
    const existingRecords = await recordRepo.getRecordsBySource(sessionId, source.id);

    const consolidation = consolidateRecords({
      sessionId,
      sourceId: source.id,
      responseId,
      rawItems: items,
      existingRecords,
      identityKeyField: source.identityKeyField,
      policy: source.consolidationPolicy,
    });

    await recordRepo.upsertRecords(consolidation.toInsert, consolidation.toUpdate);

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
  }

  public async reprocessSession(sessionId: string): Promise<void> {
    const [rawResponses, sources] = await Promise.all([
      rawResponseRepo.getAllBySession(sessionId),
      sourceRepo.getSourcesBySession(sessionId),
    ]);

    const sourceMap = new Map(sources.map((s) => [s.id, s]));

    // Clear existing extracted records for a fresh reprocess
    await sessionRepo.clearSessionRecords(sessionId);

    for (const raw of rawResponses) {
      if (raw.parseStatus !== 'parsed') continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw.responseBody);
      } catch {
        continue;
      }

      const source = await sourceRepo.getOrCreateSource({
        sessionId,
        url: raw.url,
        httpMethod: raw.httpMethod,
        parsedBody: parsed,
      });

      const updatedSource = sourceMap.get(source.id) || source;
      if (!updatedSource.included) continue;

      const items = extractItemsByPath(parsed, updatedSource.recordPath);
      if (!items || items.length === 0) continue;

      const existingRecords = await recordRepo.getRecordsBySource(sessionId, updatedSource.id);
      const consolidation = consolidateRecords({
        sessionId,
        sourceId: updatedSource.id,
        responseId: raw.id,
        rawItems: items,
        existingRecords,
        identityKeyField: updatedSource.identityKeyField,
        policy: updatedSource.consolidationPolicy,
      });

      await recordRepo.upsertRecords(consolidation.toInsert, consolidation.toUpdate);

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

  private pruneStaleRequests(): void {
    const now = Date.now();
    for (const [key, req] of Array.from(this.pendingRequests.entries())) {
      if (now - req.timestamp > 90_000) {
        this.pendingRequests.delete(key);
      }
    }
  }
}

export const captureController = new CaptureController();
