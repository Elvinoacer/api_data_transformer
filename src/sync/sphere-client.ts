import {
  SphereProductInput,
  SphereProductSyncItem,
} from "../extraction/bandago-normalizer";
import { SyncQueueManager, QueueStats, coalesceSyncItems } from "./sync-queue";

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

const STORAGE_KEYS = {
  ENDPOINT_URL: "sphere_endpoint_url",
  API_KEY: "sphere_api_key",
  ENABLED: "sphere_sync_enabled",
  PHARMACY_ID: "sphere_pharmacy_id",
  LAST_SYNC_AT: "sphere_last_sync_at",
  LAST_SYNC_ERROR: "sphere_last_sync_error",
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
  static async enqueue(items: SphereProductInput[]): Promise<number> {
    const count = await SyncQueueManager.enqueue(items);
    // Trigger immediate background flush (non-blocking)
    this.flushQueue().catch((err) => {
      console.error("[SphereSyncClient] Background flush failed:", err);
    });
    return count;
  }

  /**
   * Dispatches pending items to the Sphere Pharmacy ingestion endpoint.
   * Processes multiple batches (up to 10 batches / 500 items per flush)
   * so catalog updates drain efficiently.
   */
  static async flushQueue(): Promise<FlushResult> {
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
      const maxBatches = 10;
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

          await SyncQueueManager.markSuccess(ids);
          totalSynced += pendingItems.length;

          // Record successful sync timestamp
          const nowIso = new Date().toISOString();
          if (typeof chrome !== "undefined" && chrome.storage?.local) {
            await chrome.storage.local.set({
              [STORAGE_KEYS.LAST_SYNC_AT]: nowIso,
              [STORAGE_KEYS.LAST_SYNC_ERROR]: "",
            });
          }

          // If batch was smaller than BATCH_SIZE, queue has drained
          if (pendingItems.length < this.BATCH_SIZE) {
            break;
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

          return {
            synced: totalSynced,
            failed: pendingItems.length,
            error: errorMessage,
          };
        } finally {
          clearTimeout(timeoutId);
        }
      }

      return { synced: totalSynced, failed: 0 };
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
