import {
  SphereProductInput,
  SphereProductSyncItem,
} from "../extraction/bandago-normalizer";
import {
  SyncQueueManager,
  QueueStats,
  ProblemQueueItem,
  coalesceSyncItems,
} from "./sync-queue";
import { activityRepo, sessionRepo } from "../data/repositories";

export interface SyncConfig {
  endpointUrl: string;
  apiKey: string;
  enabled: boolean;
  pharmacyId?: string;
}

export interface FlushResult {
  synced: number;
  failed: number;
  error?: string;
}

export interface SyncErrorLogEntry {
  id: string;
  timestamp: string;
  source: "SYNC_FLUSH" | "BANDAGO_POLL" | "ITEM_UPSERT" | "CONNECTION_TEST";
  message: string;
  externalPosId?: string;
  productName?: string;
}

export interface SyncDiagnostics {
  lastSyncAt: string | null;
  lastSyncError: string | null;
  lastPollAt: string | null;
  lastPollSuccess: boolean | null;
  lastPollMessage: string | null;
  lastPollCount: number;
  errorHistory: SyncErrorLogEntry[];
  failedItems: ProblemQueueItem[];
}

const STORAGE_KEYS = {
  ENDPOINT_URL: "sphere_endpoint_url",
  API_KEY: "sphere_api_key",
  ENABLED: "sphere_sync_enabled",
  PHARMACY_ID: "sphere_pharmacy_id",
  LAST_SYNC_AT: "sphere_last_sync_at",
  LAST_SYNC_ERROR: "sphere_last_sync_error",
  LAST_POLL_AT: "sphere_last_poll_at",
  LAST_POLL_SUCCESS: "sphere_last_poll_success",
  LAST_POLL_MESSAGE: "sphere_last_poll_message",
  LAST_POLL_COUNT: "sphere_last_poll_count",
  ERROR_LOG: "sphere_error_log",
};

export class SphereSyncClient {
  public static readonly BATCH_SIZE = 50;
  public static readonly MAX_RETRIES = 5;
  private static isFlushing = false;

  /**
   * Retrieves active Sphere synchronization configuration.
   */
  static async getConfig(): Promise<SyncConfig> {
    try {
      if (typeof chrome !== "undefined" && chrome.storage?.local) {
        const data = await chrome.storage.local.get([
          STORAGE_KEYS.ENDPOINT_URL,
          STORAGE_KEYS.API_KEY,
          STORAGE_KEYS.ENABLED,
          STORAGE_KEYS.PHARMACY_ID,
        ]);

        return {
          endpointUrl: data[STORAGE_KEYS.ENDPOINT_URL] || "",
          apiKey: data[STORAGE_KEYS.API_KEY] || "",
          enabled: Boolean(data[STORAGE_KEYS.ENABLED]),
          pharmacyId: data[STORAGE_KEYS.PHARMACY_ID] || "DEFAULT_STORE",
        };
      } else if (typeof localStorage !== "undefined") {
        return {
          endpointUrl: localStorage.getItem(STORAGE_KEYS.ENDPOINT_URL) || "",
          apiKey: localStorage.getItem(STORAGE_KEYS.API_KEY) || "",
          enabled: localStorage.getItem(STORAGE_KEYS.ENABLED) === "true",
          pharmacyId:
            localStorage.getItem(STORAGE_KEYS.PHARMACY_ID) || "DEFAULT_STORE",
        };
      }
    } catch (err) {
      console.warn("[SphereSyncClient] Could not read sync config:", err);
    }

    return {
      endpointUrl: "",
      apiKey: "",
      enabled: false,
      pharmacyId: "DEFAULT_STORE",
    };
  }

  /**
   * Saves updated synchronization configuration.
   */
  static async saveConfig(updates: Partial<SyncConfig>): Promise<SyncConfig> {
    const current = await this.getConfig();
    const merged: SyncConfig = { ...current, ...updates };

    const toStore: Record<string, any> = {
      [STORAGE_KEYS.ENDPOINT_URL]: merged.endpointUrl,
      [STORAGE_KEYS.API_KEY]: merged.apiKey,
      [STORAGE_KEYS.ENABLED]: merged.enabled,
      [STORAGE_KEYS.PHARMACY_ID]: merged.pharmacyId,
    };

    try {
      if (typeof chrome !== "undefined" && chrome.storage?.local) {
        await chrome.storage.local.set(toStore);
      } else if (typeof localStorage !== "undefined") {
        for (const [k, v] of Object.entries(toStore)) {
          localStorage.setItem(k, String(v));
        }
      }
    } catch (err) {
      console.warn("[SphereSyncClient] Could not save sync config:", err);
    }

    return merged;
  }

  /**
   * Enqueues normalized product items for sync and triggers an immediate queue flush.
   */
  static async enqueue(
    items: SphereProductInput[],
    trigger: string = "BACKGROUND_POLL",
  ): Promise<number> {
    const count = await SyncQueueManager.enqueue(items);
    // Trigger immediate background flush (non-blocking)
    this.flushQueue(trigger).catch((err) => {
      console.error("[SphereSyncClient] Background flush failed:", err);
    });
    return count;
  }

  /**
   * Dispatches pending items to the Sphere Pharmacy ingestion endpoint.
   * Processes multiple batches (up to 100 batches / 5,000 items per flush)
   * so catalog updates drain efficiently.
   */
  static async flushQueue(
    trigger: string = "BACKGROUND_POLL",
  ): Promise<FlushResult> {
    if (this.isFlushing) {
      return { synced: 0, failed: 0 };
    }

    const config = await this.getConfig();
    if (!config.enabled || !config.endpointUrl || !config.apiKey) {
      const missing = [
        !config.enabled && "sync disabled",
        !config.endpointUrl && "endpoint URL",
        !config.apiKey && "API key",
      ].filter(Boolean);
      const hasPending = await SyncQueueManager.getPending(1)
        .then((p) => p.length > 0)
        .catch(() => false);
      if (hasPending) {
        console.warn(
          `[SphereSyncClient] Queue flush skipped (${missing.join(", ")}). Items remain queued.`,
        );
      }
      return { synced: 0, failed: 0, error: `Sync not configured: ${missing.join(", ")}` };
    }

    this.isFlushing = true;

    try {
      // First recover any items stuck in SYNCING from a previously interrupted worker
      await SyncQueueManager.recoverStaleSyncing().catch((err) => {
        console.warn(
          "[SphereSyncClient] Could not recover stale syncing items:",
          err,
        );
      });

      let totalSynced = 0;
      let totalFailed = 0;
      let lastPartialError: string | undefined;
      const maxBatches = 100;
      let batchesProcessed = 0;

      while (batchesProcessed < maxBatches) {
        const pendingItems = await SyncQueueManager.getPending(this.BATCH_SIZE);
        if (pendingItems.length === 0) {
          break;
        }
        batchesProcessed++;

        const ids = pendingItems.map((p) => p.id!).filter(Boolean);
        await SyncQueueManager.markSyncing(ids);

        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 15000);

        try {
          const payloadItems = pendingItems.map(
            (p) => p.payload as SphereProductSyncItem,
          );
          const coalescedItems = coalesceSyncItems(payloadItems);

          const response = await fetch(config.endpointUrl, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${config.apiKey}`,
              "X-Pharmacy-Source": "BANDAGO_POS",
            },
            signal: controller.signal,
            body: JSON.stringify({
              source: "BANDAGO_POS",
              trigger: trigger || "BACKGROUND_POLL",
              pharmacyId: config.pharmacyId,
              timestamp: new Date().toISOString(),
              items: coalescedItems,
            }),
          });

          if (!response.ok) {
            const errorText = await response.text();
            throw new Error(
              `HTTP ${response.status}: ${errorText.slice(0, 500)}`,
            );
          }

          let resData: any = null;
          if (typeof response.json === "function") {
            try {
              resData = await response.json();
            } catch {
              // Ignore if response has no JSON body
            }
          }

          if (resData && resData.success === false) {
            const serverErr =
              resData.error ||
              (Array.isArray(resData.errors) && resData.errors[0]?.error) ||
              "Sphere API reported sync failure (success: false)";
            throw new Error(serverErr);
          }

          const nowIso = new Date().toISOString();
          const itemErrors: Array<{
            externalPosId?: string;
            name?: string;
            error?: string;
          }> = Array.isArray(resData?.errors) ? resData.errors : [];

          if (itemErrors.length > 0) {
            const failedMap = new Map<
              string,
              { error: string; name?: string }
            >();
            for (const errEntry of itemErrors) {
              if (errEntry && errEntry.externalPosId) {
                failedMap.set(String(errEntry.externalPosId).trim(), {
                  error: errEntry.error || "Item upsert failed on Sphere server",
                  name: errEntry.name,
                });
              }
            }

            const succeededIds: number[] = [];
            const failedQueueItems = [];

            for (const qItem of pendingItems) {
              const matchedErr = failedMap.get(qItem.externalPosId);
              if (matchedErr) {
                failedQueueItems.push({ item: qItem, err: matchedErr });
              } else if (qItem.id) {
                succeededIds.push(qItem.id);
              }
            }

            if (succeededIds.length > 0) {
              await SyncQueueManager.markSuccess(succeededIds);
              totalSynced += succeededIds.length;
            }

            for (const { item, err } of failedQueueItems) {
              await SyncQueueManager.markFailed(
                [item],
                err.error,
                this.MAX_RETRIES,
              );
              await this.recordError({
                source: "ITEM_UPSERT",
                message: err.error,
                externalPosId: item.externalPosId,
                productName:
                  err.name ||
                  (item.payload as SphereProductSyncItem)?.name ||
                  item.externalPosId,
              });
            }

            totalFailed += failedQueueItems.length;
            const firstErr = itemErrors[0];
            lastPartialError = `Partial sync: ${failedQueueItems.length} medication(s) failed (${firstErr?.name || firstErr?.externalPosId || "item"}: ${firstErr?.error || "error"})`;

            if (typeof chrome !== "undefined" && chrome.storage?.local) {
              await chrome.storage.local.set({
                [STORAGE_KEYS.LAST_SYNC_AT]: nowIso,
                [STORAGE_KEYS.LAST_SYNC_ERROR]: lastPartialError,
              });
            }
          } else {
            await SyncQueueManager.markSuccess(ids);
            totalSynced += pendingItems.length;

            // Record successful sync timestamp
            if (typeof chrome !== "undefined" && chrome.storage?.local) {
              await chrome.storage.local.set({
                [STORAGE_KEYS.LAST_SYNC_AT]: nowIso,
                [STORAGE_KEYS.LAST_SYNC_ERROR]: "",
              });
            }
          }
        } catch (err: any) {
          const errorMessage =
            err?.name === "AbortError"
              ? "Sphere sync request timed out after 15 seconds"
              : err?.message || "Unknown network error";
          console.error(
            "[SphereSyncClient] Sync transmission failed:",
            errorMessage,
          );

          await SyncQueueManager.markFailed(
            pendingItems,
            errorMessage,
            this.MAX_RETRIES,
          );

          if (typeof chrome !== "undefined" && chrome.storage?.local) {
            await chrome.storage.local.set({
              [STORAGE_KEYS.LAST_SYNC_ERROR]: errorMessage,
            });
          }

          await this.recordError({
            source: "SYNC_FLUSH",
            message: errorMessage,
          });

          return {
            synced: totalSynced,
            failed: totalFailed + pendingItems.length,
            error: errorMessage,
          };
        } finally {
          clearTimeout(timeoutId);
        }
      }

      return {
        synced: totalSynced,
        failed: totalFailed,
        ...(lastPartialError ? { error: lastPartialError } : {}),
      };
    } finally {
      this.isFlushing = false;
    }
  }

  /**
   * Tests connection to Sphere Pharmacy API by sending an empty sync payload.
   */
  static async testConnection(
    config: SyncConfig,
  ): Promise<{ ok: boolean; status?: number; error?: string }> {
    if (!config.endpointUrl || !config.apiKey) {
      return { ok: false, error: "Endpoint URL and API Key are required" };
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 15000);

    try {
      const response = await fetch(config.endpointUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${config.apiKey}`,
          "X-Pharmacy-Source": "BANDAGO_POS",
        },
        signal: controller.signal,
        body: JSON.stringify({
          source: "BANDAGO_POS",
          pharmacyId: config.pharmacyId || "TEST_PING",
          timestamp: new Date().toISOString(),
          items: [],
        }),
      });

      if (response.status === 401 || response.status === 403) {
        return {
          ok: false,
          status: response.status,
          error: "Authentication failed: Invalid API Key",
        };
      }

      if (!response.ok) {
        const text = await response.text();
        return {
          ok: false,
          status: response.status,
          error: `Server responded with ${response.status}: ${text.slice(0, 120)}`,
        };
      }

      return { ok: true, status: response.status };
    } catch (err: any) {
      const msg =
        err?.name === "AbortError"
          ? "Connection test timed out after 15 seconds"
          : err.message || "Connection test failed";
      return { ok: false, error: msg };
    } finally {
      clearTimeout(timeoutId);
    }
  }

  /**
   * Records a structured error entry in persistent error history (up to 25 most recent)
   * and logs it to the active capture session's activity log if one exists.
   */
  static async recordError(
    entry: Omit<SyncErrorLogEntry, "id" | "timestamp">,
  ): Promise<void> {
    const newEntry: SyncErrorLogEntry = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      timestamp: new Date().toISOString(),
      ...entry,
    };

    try {
      if (typeof chrome !== "undefined" && chrome.storage?.local) {
        const data = await chrome.storage.local.get([STORAGE_KEYS.ERROR_LOG]);
        const existing: SyncErrorLogEntry[] = Array.isArray(
          data[STORAGE_KEYS.ERROR_LOG],
        )
          ? data[STORAGE_KEYS.ERROR_LOG]
          : [];
        const updated = [newEntry, ...existing].slice(0, 25);
        await chrome.storage.local.set({
          [STORAGE_KEYS.ERROR_LOG]: updated,
        });
      } else if (typeof localStorage !== "undefined") {
        const raw = localStorage.getItem(STORAGE_KEYS.ERROR_LOG);
        const existing: SyncErrorLogEntry[] = raw ? JSON.parse(raw) : [];
        const updated = [newEntry, ...existing].slice(0, 25);
        localStorage.setItem(STORAGE_KEYS.ERROR_LOG, JSON.stringify(updated));
      }
    } catch {
      // Ignore storage errors
    }

    // Also log to session activity feed if an active session exists
    try {
      const activeSession = await sessionRepo.getActiveSession();
      if (activeSession?.id) {
        const label = entry.productName
          ? `[${entry.source}] ${entry.productName}: ${entry.message}`
          : `[${entry.source}] ${entry.message}`;
        await activityRepo.logEvent({
          sessionId: activeSession.id,
          actor: "system",
          category: "warning",
          message: label,
        });
      }
    } catch {
      // Ignore if IndexedDB is mocked or unavailable
    }
  }

  /**
   * Records the status of the latest BandaGo active tab poll for diagnostics UI.
   */
  static async recordPollStatus(result: {
    success: boolean;
    count: number;
    message: string;
  }): Promise<void> {
    const nowIso = new Date().toISOString();
    try {
      if (typeof chrome !== "undefined" && chrome.storage?.local) {
        await chrome.storage.local.set({
          [STORAGE_KEYS.LAST_POLL_AT]: nowIso,
          [STORAGE_KEYS.LAST_POLL_SUCCESS]: result.success,
          [STORAGE_KEYS.LAST_POLL_MESSAGE]: result.message,
          [STORAGE_KEYS.LAST_POLL_COUNT]: result.count,
        });
      } else if (typeof localStorage !== "undefined") {
        localStorage.setItem(STORAGE_KEYS.LAST_POLL_AT, nowIso);
        localStorage.setItem(
          STORAGE_KEYS.LAST_POLL_SUCCESS,
          String(result.success),
        );
        localStorage.setItem(STORAGE_KEYS.LAST_POLL_MESSAGE, result.message);
        localStorage.setItem(
          STORAGE_KEYS.LAST_POLL_COUNT,
          String(result.count),
        );
      }
    } catch {
      // Ignore storage errors
    }

    if (
      !result.success &&
      !result.message.includes("disabled in settings") &&
      !result.message.includes("Chrome extension APIs not available")
    ) {
      await this.recordError({
        source: "BANDAGO_POLL",
        message: result.message,
      });
    }
  }

  /**
   * Retrieves comprehensive synchronization health & error reporting diagnostics.
   */
  static async getDiagnostics(): Promise<SyncDiagnostics> {
    let lastSyncAt: string | null = null;
    let lastSyncError: string | null = null;
    let lastPollAt: string | null = null;
    let lastPollSuccess: boolean | null = null;
    let lastPollMessage: string | null = null;
    let lastPollCount = 0;
    let errorHistory: SyncErrorLogEntry[] = [];

    try {
      if (typeof chrome !== "undefined" && chrome.storage?.local) {
        const data = await chrome.storage.local.get([
          STORAGE_KEYS.LAST_SYNC_AT,
          STORAGE_KEYS.LAST_SYNC_ERROR,
          STORAGE_KEYS.LAST_POLL_AT,
          STORAGE_KEYS.LAST_POLL_SUCCESS,
          STORAGE_KEYS.LAST_POLL_MESSAGE,
          STORAGE_KEYS.LAST_POLL_COUNT,
          STORAGE_KEYS.ERROR_LOG,
        ]);
        lastSyncAt = data[STORAGE_KEYS.LAST_SYNC_AT] || null;
        lastSyncError = data[STORAGE_KEYS.LAST_SYNC_ERROR] || null;
        lastPollAt = data[STORAGE_KEYS.LAST_POLL_AT] || null;
        lastPollSuccess =
          typeof data[STORAGE_KEYS.LAST_POLL_SUCCESS] === "boolean"
            ? data[STORAGE_KEYS.LAST_POLL_SUCCESS]
            : null;
        lastPollMessage = data[STORAGE_KEYS.LAST_POLL_MESSAGE] || null;
        lastPollCount = Number(data[STORAGE_KEYS.LAST_POLL_COUNT] || 0);
        errorHistory = Array.isArray(data[STORAGE_KEYS.ERROR_LOG])
          ? data[STORAGE_KEYS.ERROR_LOG]
          : [];
      } else if (typeof localStorage !== "undefined") {
        lastSyncAt = localStorage.getItem(STORAGE_KEYS.LAST_SYNC_AT) || null;
        lastSyncError =
          localStorage.getItem(STORAGE_KEYS.LAST_SYNC_ERROR) || null;
        lastPollAt = localStorage.getItem(STORAGE_KEYS.LAST_POLL_AT) || null;
        const pollSuccRaw = localStorage.getItem(
          STORAGE_KEYS.LAST_POLL_SUCCESS,
        );
        lastPollSuccess =
          pollSuccRaw === "true" ? true : pollSuccRaw === "false" ? false : null;
        lastPollMessage =
          localStorage.getItem(STORAGE_KEYS.LAST_POLL_MESSAGE) || null;
        lastPollCount = Number(
          localStorage.getItem(STORAGE_KEYS.LAST_POLL_COUNT) || 0,
        );
        const errRaw = localStorage.getItem(STORAGE_KEYS.ERROR_LOG);
        errorHistory = errRaw ? JSON.parse(errRaw) : [];
      }
    } catch {
      // Ignore storage read error
    }

    const failedItems = await SyncQueueManager.getProblemItems(25);

    return {
      lastSyncAt,
      lastSyncError,
      lastPollAt,
      lastPollSuccess,
      lastPollMessage,
      lastPollCount,
      errorHistory,
      failedItems,
    };
  }

  /**
   * Clears stored error history and active sync error banner.
   */
  static async clearErrorHistory(): Promise<void> {
    try {
      if (typeof chrome !== "undefined" && chrome.storage?.local) {
        await chrome.storage.local.set({
          [STORAGE_KEYS.ERROR_LOG]: [],
          [STORAGE_KEYS.LAST_SYNC_ERROR]: "",
        });
      } else if (typeof localStorage !== "undefined") {
        localStorage.removeItem(STORAGE_KEYS.ERROR_LOG);
        localStorage.removeItem(STORAGE_KEYS.LAST_SYNC_ERROR);
      }
    } catch {
      // Ignore storage error
    }
  }

  /**
   * Returns current sync queue stats.
   */
  static async getQueueStats(): Promise<QueueStats> {
    return SyncQueueManager.getStats();
  }

  /**
   * Retries all failed queue items.
   */
  static async retryFailed(): Promise<number> {
    const count = await SyncQueueManager.retryFailed();
    if (count > 0) {
      this.flushQueue().catch(console.error);
    }
    return count;
  }

  /**
   * Clears queue.
   */
  static async clearQueue(): Promise<void> {
    await SyncQueueManager.clearQueue();
  }
}
