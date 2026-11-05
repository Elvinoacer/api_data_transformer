import { db } from "./db";
import {
  ActivityEvent,
  CaptureError,
  CaptureSession,
  CaptureStatus,
  DetectedPagination,
  EndpointSchema,
  EndpointSource,
  ExtractedRecord,
  GlobalSettings,
  RawResponse,
  ScopeMode,
  SessionMetrics,
} from "../shared/types";
import { DEFAULT_SETTINGS } from "../shared/constants";
import { normalizeEndpoint } from "../privacy/url-redaction";
import {
  extractItemsByPath,
  inferBestIdentityKey,
  inferBestRecordPath,
} from "../extraction/path-selector";
import { inferDatasetLabel } from "../extraction/label-inference";
import { mergePaginationState } from "../extraction/pagination-detector";

const SETTINGS_STORAGE_KEY = "lndc_global_settings_v1";

export const settingsRepo = {
  async getSettings(): Promise<GlobalSettings> {
    try {
      if (typeof chrome !== "undefined" && chrome.storage?.local) {
        const stored = await chrome.storage.local.get(SETTINGS_STORAGE_KEY);
        if (stored?.[SETTINGS_STORAGE_KEY]) {
          return { ...DEFAULT_SETTINGS, ...stored[SETTINGS_STORAGE_KEY] };
        }
      } else if (typeof localStorage !== "undefined") {
        const raw = localStorage.getItem(SETTINGS_STORAGE_KEY);
        if (raw) {
          return { ...DEFAULT_SETTINGS, ...JSON.parse(raw) };
        }
      }
    } catch {
      // Fallback to defaults
    }
    return { ...DEFAULT_SETTINGS };
  },

  async saveSettings(
    updates: Partial<GlobalSettings>,
  ): Promise<GlobalSettings> {
    const current = await this.getSettings();
    const merged: GlobalSettings = { ...current, ...updates };
    try {
      if (typeof chrome !== "undefined" && chrome.storage?.local) {
        await chrome.storage.local.set({ [SETTINGS_STORAGE_KEY]: merged });
      } else if (typeof localStorage !== "undefined") {
        localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(merged));
      }
    } catch (err) {
      console.warn("Could not persist settings:", err);
    }
    return merged;
  },
};

export const sessionRepo = {
  async createSession(params: {
    targetTabId: number | null;
    originalUrl: string;
    allowedHostnames: string[];
    scopeMode?: ScopeMode;
    label?: string;
  }): Promise<CaptureSession> {
    const id = `session_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    let hostLabel = "Website";
    try {
      const urlObj = new URL(params.originalUrl || "http://localhost");
      hostLabel = urlObj.hostname;
    } catch {
      // Fallback
    }
    const label = params.label?.trim() || `${hostLabel} capture`;

    const session: CaptureSession = {
      id,
      label,
      targetTabId: params.targetTabId,
      originalUrl: params.originalUrl,
      allowedHostnames: params.allowedHostnames,
      scopeMode: params.scopeMode || "all_tab_apis",
      status: "starting",
      startedAt: new Date().toISOString(),
    };

    await db.capture_sessions.put(session);
    return session;
  },

  async updateStatus(
    sessionId: string,
    status: CaptureStatus,
    reason?: string,
  ): Promise<void> {
    const updates: Partial<CaptureSession> = { status };
    if (reason !== undefined) updates.errorReason = reason;
    if (status === "stopped" || status === "detached") {
      updates.endedAt = new Date().toISOString();
    }
    await db.capture_sessions.update(sessionId, updates);
  },

  async renameSession(sessionId: string, label: string): Promise<void> {
    const trimmed = label.trim();
    if (!trimmed) return;
    await db.capture_sessions.update(sessionId, { label: trimmed });
  },

  async getSession(sessionId: string): Promise<CaptureSession | undefined> {
    return db.capture_sessions.get(sessionId);
  },

  async getActiveSession(): Promise<CaptureSession | undefined> {
    return db.capture_sessions
      .where("status")
      .anyOf(["recording", "starting", "paused"])
      .first();
  },

  async getAllSessions(): Promise<CaptureSession[]> {
    return db.capture_sessions.orderBy("startedAt").reverse().toArray();
  },

  async deleteSession(sessionId: string): Promise<void> {
    await db.transaction(
      "rw",
      [
        db.capture_sessions,
        db.raw_responses,
        db.extracted_records,
        db.sources,
        db.capture_errors,
        db.schemas,
        db.activity_events,
      ],
      async () => {
        await db.capture_sessions.delete(sessionId);
        await db.raw_responses.where("sessionId").equals(sessionId).delete();
        await db.extracted_records
          .where("sessionId")
          .equals(sessionId)
          .delete();
        await db.sources.where("sessionId").equals(sessionId).delete();
        await db.capture_errors.where("sessionId").equals(sessionId).delete();
        await db.schemas.where("sessionId").equals(sessionId).delete();
        await db.activity_events.where("sessionId").equals(sessionId).delete();
      },
    );
  },

  async clearSessionRecords(sessionId: string): Promise<void> {
    await db.extracted_records.where("sessionId").equals(sessionId).delete();
  },

  async clearSessionData(
    sessionId: string,
    options?: { clearSyncQueue?: boolean },
  ): Promise<{
    clearedResponses: number;
    clearedRecords: number;
    clearedSources: number;
    clearedSchemas: number;
    clearedErrors: number;
  }> {
    const clearSyncQueue = options?.clearSyncQueue ?? true;

    let clearedResponses = 0;
    let clearedRecords = 0;
    let clearedSources = 0;
    let clearedSchemas = 0;
    let clearedErrors = 0;

    await db.transaction(
      "rw",
      [
        db.raw_responses,
        db.extracted_records,
        db.sources,
        db.capture_errors,
        db.schemas,
        db.activity_events,
        db.capture_sessions,
        db.sync_queue,
      ],
      async () => {
        clearedResponses = await db.raw_responses
          .where("sessionId")
          .equals(sessionId)
          .delete();
        clearedRecords = await db.extracted_records
          .where("sessionId")
          .equals(sessionId)
          .delete();
        clearedSources = await db.sources
          .where("sessionId")
          .equals(sessionId)
          .delete();
        clearedSchemas = await db.schemas
          .where("sessionId")
          .equals(sessionId)
          .delete();
        clearedErrors = await db.capture_errors
          .where("sessionId")
          .equals(sessionId)
          .delete();
        await db.activity_events.where("sessionId").equals(sessionId).delete();

        await db.capture_sessions.update(sessionId, {
          lastResponseAt: undefined,
        });

        if (clearSyncQueue) {
          await db.sync_queue.clear();
        }
      },
    );

    const targetSession = await db.capture_sessions.get(sessionId);
    if (targetSession) {
      await activityRepo.logEvent({
        sessionId,
        actor: "user",
        category: "session",
        message:
          "Cleared all captured data for this tab (raw traffic, records, schemas, and sources)",
        detail: `Purged ${clearedResponses} response(s), ${clearedRecords} record(s), ${clearedSources} source(s)`,
      });
    }

    return {
      clearedResponses,
      clearedRecords,
      clearedSources,
      clearedSchemas,
      clearedErrors,
    };
  },

  async clearAllCapturedData(options?: {
    clearSessions?: boolean;
    clearSyncQueue?: boolean;
  }): Promise<void> {
    const clearSessions = options?.clearSessions ?? false;
    const clearSyncQueue = options?.clearSyncQueue ?? true;

    await db.transaction(
      "rw",
      [
        db.raw_responses,
        db.extracted_records,
        db.sources,
        db.capture_errors,
        db.schemas,
        db.activity_events,
        db.capture_sessions,
        db.sync_queue,
      ],
      async () => {
        await db.raw_responses.clear();
        await db.extracted_records.clear();
        await db.sources.clear();
        await db.schemas.clear();
        await db.capture_errors.clear();
        await db.activity_events.clear();

        if (clearSyncQueue) {
          await db.sync_queue.clear();
        }

        if (clearSessions) {
          await db.capture_sessions.clear();
        } else {
          const sessions = await db.capture_sessions.toArray();
          for (const s of sessions) {
            await db.capture_sessions.update(s.id, {
              lastResponseAt: undefined,
            });
          }
        }
      },
    );
  },
};

export const rawResponseRepo = {
  async addResponse(response: RawResponse): Promise<void> {
    await db.raw_responses.put(response);
    await db.capture_sessions.update(response.sessionId, {
      lastResponseAt: response.capturedAt,
    });
  },

  async getBySession(sessionId: string, limit = 150): Promise<RawResponse[]> {
    const all = await db.raw_responses
      .where("sessionId")
      .equals(sessionId)
      .toArray();
    all.sort((a, b) => b.capturedAt.localeCompare(a.capturedAt));
    return all.slice(0, limit);
  },

  async getById(id: string): Promise<RawResponse | undefined> {
    return db.raw_responses.get(id);
  },

  async getAllBySession(sessionId: string): Promise<RawResponse[]> {
    const all = await db.raw_responses
      .where("sessionId")
      .equals(sessionId)
      .toArray();
    all.sort((a, b) => a.capturedAt.localeCompare(b.capturedAt));
    return all;
  },
};

export const sourceRepo = {
  async getOrCreateSource(params: {
    sessionId: string;
    url: string;
    httpMethod: string;
    parsedBody?: unknown;
    operationName?: string;
    detectedPagination?: DetectedPagination;
  }): Promise<{ source: EndpointSource; isNew: boolean }> {
    const normalized = normalizeEndpoint(params.url, params.operationName);
    const id = `${params.sessionId}_${params.httpMethod}_${normalized}`;

    const existing = await db.sources.get(id);
    if (existing) {
      existing.observedCount += 1;
      existing.lastObservedAt = new Date().toISOString();
      if (!existing.label) {
        existing.label = inferDatasetLabel({
          url: params.url,
          operationName: params.operationName || existing.operationName,
          recordPath: existing.recordPath,
        });
      }
      if (params.detectedPagination) {
        existing.pagination = mergePaginationState(
          existing.pagination,
          params.detectedPagination,
          params.url,
        );
      }
      await db.sources.put(existing);
      return { source: existing, isNew: false };
    }

    // Infer default record path & identity key if sample body is provided
    let recordPath = "root";
    let identityKeyField = "id";
    if (params.parsedBody) {
      recordPath = inferBestRecordPath(params.parsedBody);
      const sampleItems = extractItemsByPath(params.parsedBody, recordPath);
      if (sampleItems.length > 0) {
        identityKeyField = inferBestIdentityKey(sampleItems);
      }
    }

    // Infer clear semantic dataset label (e.g. "Medicines", "Customers", "Orders")
    let baseLabel = inferDatasetLabel({
      url: params.url,
      operationName: params.operationName,
      recordPath,
    });

    // Disambiguate if another source in the same session already has this exact label
    const siblingSources = await db.sources
      .where("sessionId")
      .equals(params.sessionId)
      .toArray();
    const existingLabels = new Set(
      siblingSources.map((s) => (s.label || "").toLowerCase()),
    );
    if (existingLabels.has(baseLabel.toLowerCase())) {
      const suffix = params.url.includes("cursor")
        ? "Cursor"
        : params.httpMethod !== "GET"
          ? params.httpMethod
          : `${siblingSources.length + 1}`;
      baseLabel = `${baseLabel} (${suffix})`;
    }

    const pagination = params.detectedPagination
      ? mergePaginationState(undefined, params.detectedPagination, params.url)
      : undefined;

    const newSource: EndpointSource = {
      id,
      sessionId: params.sessionId,
      label: baseLabel,
      normalizedEndpoint: normalized,
      httpMethod: params.httpMethod,
      operationName: params.operationName,
      included: true,
      recordPath,
      identityKeyField,
      consolidationPolicy: "keep_latest",
      observedCount: 1,
      lastObservedAt: new Date().toISOString(),
      pagination,
    };

    await db.sources.put(newSource);
    return { source: newSource, isNew: true };
  },

  async updateSource(
    id: string,
    updates: Partial<EndpointSource>,
  ): Promise<void> {
    await db.sources.update(id, updates);
  },

  async renameSource(id: string, label: string): Promise<void> {
    const trimmed = label.trim();
    if (!trimmed) return;
    await db.sources.update(id, { label: trimmed, customLabel: true });
  },

  async getSourcesBySession(sessionId: string): Promise<EndpointSource[]> {
    const list = await db.sources
      .where("sessionId")
      .equals(sessionId)
      .toArray();
    // Ensure backwards compatibility if older records lacked `label`
    return list.map((s) => ({
      ...s,
      label:
        s.label ||
        inferDatasetLabel({
          url: s.normalizedEndpoint,
          operationName: s.operationName,
          recordPath: s.recordPath,
        }),
    }));
  },

  async getSource(id: string): Promise<EndpointSource | undefined> {
    return db.sources.get(id);
  },
};

export const recordRepo = {
  async upsertRecords(
    toInsert: ExtractedRecord[],
    toUpdate: ExtractedRecord[],
  ): Promise<void> {
    await db.transaction("rw", db.extracted_records, async () => {
      if (toInsert.length > 0) {
        await db.extracted_records.bulkPut(toInsert);
      }
      if (toUpdate.length > 0) {
        await db.extracted_records.bulkPut(toUpdate);
      }
    });
  },

  async getRecordsBySession(
    sessionId: string,
    limit = 500,
  ): Promise<ExtractedRecord[]> {
    return db.extracted_records
      .where("sessionId")
      .equals(sessionId)
      .limit(limit)
      .toArray();
  },

  async getAllRecordsBySession(sessionId: string): Promise<ExtractedRecord[]> {
    return db.extracted_records.where("sessionId").equals(sessionId).toArray();
  },

  async getRecordsBySource(
    sessionId: string,
    sourceId: string,
  ): Promise<ExtractedRecord[]> {
    return db.extracted_records
      .where("sessionId")
      .equals(sessionId)
      .filter((r) => r.sourceId === sourceId)
      .toArray();
  },
};

export const schemaRepo = {
  async saveSchema(schema: EndpointSchema): Promise<void> {
    await db.schemas.put(schema);
  },

  async getSchema(sourceId: string): Promise<EndpointSchema | undefined> {
    return db.schemas.get(sourceId);
  },

  async getSchemasBySession(sessionId: string): Promise<EndpointSchema[]> {
    return db.schemas.where("sessionId").equals(sessionId).toArray();
  },
};

export const errorRepo = {
  async logError(params: {
    sessionId: string;
    kind: CaptureError["kind"];
    message: string;
    url?: string;
    details?: unknown;
  }): Promise<void> {
    const error: CaptureError = {
      id: `err_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      sessionId: params.sessionId,
      timestamp: new Date().toISOString(),
      kind: params.kind,
      url: params.url,
      message: params.message,
      details: params.details,
    };
    await db.capture_errors.put(error);
  },

  async getErrorsBySession(
    sessionId: string,
    limit = 50,
  ): Promise<CaptureError[]> {
    const all = await db.capture_errors
      .where("sessionId")
      .equals(sessionId)
      .toArray();
    all.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
    return all.slice(0, limit);
  },
};

export const activityRepo = {
  async logEvent(params: {
    sessionId: string;
    actor: ActivityEvent["actor"];
    category: ActivityEvent["category"];
    message: string;
    detail?: string;
  }): Promise<void> {
    try {
      const event: ActivityEvent = {
        id: `act_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
        sessionId: params.sessionId,
        timestamp: new Date().toISOString(),
        actor: params.actor,
        category: params.category,
        message: params.message,
        detail: params.detail,
      };
      await db.activity_events.put(event);
    } catch {
      // Non-critical telemetry/audit log
    }
  },

  async getEventsBySession(
    sessionId: string,
    limit = 40,
  ): Promise<ActivityEvent[]> {
    try {
      const all = await db.activity_events
        .where("sessionId")
        .equals(sessionId)
        .toArray();
      all.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
      return all.slice(0, limit);
    } catch {
      return [];
    }
  },
};

export async function calculateSessionMetrics(
  sessionId: string,
): Promise<SessionMetrics> {
  const [rawResponses, captureErrors, uniqueRecords, sources] =
    await Promise.all([
      db.raw_responses.where("sessionId").equals(sessionId).toArray(),
      db.capture_errors.where("sessionId").equals(sessionId).count(),
      db.extracted_records.where("sessionId").equals(sessionId).count(),
      db.sources.where("sessionId").equals(sessionId).count(),
    ]);

  const responsesObserved = rawResponses.length;
  const responsesSaved = rawResponses.filter(
    (r) => r.parseStatus === "parsed" || r.parseStatus === "pending",
  ).length;

  let bytesStored = 0;
  let totalExtractedItems = 0;
  for (const r of rawResponses) {
    bytesStored += r.responseBytes || 0;
    totalExtractedItems += r.extractedCount || 0;
  }

  const parsedRecords = Math.max(totalExtractedItems, uniqueRecords);

  return {
    responsesObserved,
    responsesSaved,
    captureErrors,
    parsedRecords,
    uniqueRecords,
    endpointGroups: sources,
    bytesStored,
  };
}

export const syncQueueRepo = {
  async getQueueStats() {
    const { SyncQueueManager } = await import("../sync/sync-queue");
    return SyncQueueManager.getStats();
  },
  async retryFailed() {
    const { SyncQueueManager } = await import("../sync/sync-queue");
    return SyncQueueManager.retryFailed();
  },
  async clearQueue() {
    const { SyncQueueManager } = await import("../sync/sync-queue");
    return SyncQueueManager.clearQueue();
  },
};
