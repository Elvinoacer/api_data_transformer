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
  allowOutboundWriteback?: boolean;
  expectedTenantUU?: string;
}

export interface ServerSyncPolicy {
  outboundSyncMode?: "MANUAL_EXPORT" | "AUTO_SYNC";
  inboundEnabled?: boolean;
  expectedTenantUU?: string | null;
  outboundPollIntervalMinutes?: number;
}

export interface OutboundRunStatus {
  lastRunAt: string | null;
  ok: boolean | null;
  mode?: string;
  syncedCount?: number;
  failedCount?: number;
  pendingCount?: number;
  message: string | null;
  lastErrorCode?: string | null;
}

export interface TelemetryReportInput {
  heartbeat?: Record<string, unknown>;
  errors?: Array<{
    direction?: "INBOUND" | "OUTBOUND";
    source: string;
    severity?: "CRITICAL" | "ERROR" | "WARNING";
    code: string;
    message: string;
    remediation?: string;
    externalPosId?: string;
    productName?: string;
    orderReference?: string;
  }>;
}

export interface EndpointValidationResult {
  normalizedUrl: string;
  suggestedFix?: string;
  warning?: string;
}

/**
 * Validates and detects common typos in the Sphere BandaGo ingestion endpoint URL
 * (e.g. `intergrations` -> `integrations`, `bandgo` -> `bandago`, or bare site root).
 */
export function validateSphereEndpointUrl(
  rawUrl: string,
): EndpointValidationResult {
  const trimmed = (rawUrl || "").trim();
  if (!trimmed) {
    return { normalizedUrl: "" };
  }

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return {
      normalizedUrl: trimmed,
      warning:
        "Invalid URL format. Expected https://<your-sphere-domain>/api/integrations/bandago/sync",
    };
  }

  const pathname = parsed.pathname || "/";
  if (/\/intergrations?(?:\/|$)/i.test(pathname)) {
    const fixedPath = pathname.replace(/\/intergrations?(?=\/|$)/i, "/integrations");
    const hasSyncSuffix = /\/integrations\/bandago\/sync\/?$/i.test(fixedPath);
    const finalPath = hasSyncSuffix
      ? fixedPath
      : "/api/integrations/bandago/sync";
    return {
      normalizedUrl: trimmed,
      suggestedFix: `${parsed.origin}${finalPath}`,
      warning:
        'Typo detected in URL ("intergrations" should be "integrations"). Requests to the misspelled path hit HTML instead of the sync API.',
    };
  }

  if (/\/bandgo(?:\/|$)/i.test(pathname)) {
    const fixedPath = pathname.replace(/\/bandgo(?=\/|$)/i, "/bandago");
    return {
      normalizedUrl: trimmed,
      suggestedFix: `${parsed.origin}${fixedPath}`,
      warning: 'Typo detected in URL ("bandgo" should be "bandago").',
    };
  }

  if (pathname === "/" || pathname === "") {
    return {
      normalizedUrl: trimmed,
      suggestedFix: `${parsed.origin}/api/integrations/bandago/sync`,
      warning:
        "URL points to the site root rather than the sync API route (/api/integrations/bandago/sync).",
    };
  }

  if (
    /\/api\/integrations\/bandago\/?$/i.test(pathname)
  ) {
    return {
      normalizedUrl: trimmed,
      suggestedFix: `${parsed.origin}/api/integrations/bandago/sync`,
      warning:
        "URL is missing the trailing /sync path segment (/api/integrations/bandago/sync).",
    };
  }

  return { normalizedUrl: trimmed };
}

async function parseSphereJsonResponse(
  response: Response,
  endpointUrl: string,
): Promise<
  { ok: true; data: Record<string, any> } | { ok: false; error: string }
> {
  const validation = validateSphereEndpointUrl(endpointUrl);
  const hint = validation.suggestedFix
    ? ` Did you mean ${validation.suggestedFix}?`
    : " Expected a Sphere JSON API endpoint ending in /api/integrations/bandago/sync.";

  const contentType =
    (typeof response.headers?.get === "function"
      ? response.headers.get("content-type")
      : (response.headers as any)?.["content-type"]) || "";

  if (contentType && !contentType.toLowerCase().includes("json")) {
    return {
      ok: false,
      error: `Endpoint returned non-JSON response (${contentType.split(";")[0].trim()}) instead of Sphere API JSON.${hint}`,
    };
  }

  if (typeof response.json === "function") {
    try {
      const data = await response.json();
      if (!data || typeof data !== "object" || Array.isArray(data)) {
        return {
          ok: false,
          error: `Endpoint returned unexpected JSON shape.${hint}`,
        };
      }
      return { ok: true, data };
    } catch {
      return {
        ok: false,
        error: `Endpoint returned invalid JSON (likely an HTML page instead of the Sphere API).${hint}`,
      };
    }
  }

  return { ok: true, data: {} };
}

/**
 * Derives a sibling BandaGo integration URL (e.g. /outbound, /outbound/ack, /telemetry)
 * cleanly from the configured /api/integrations/bandago/sync endpoint URL.
 */
export function deriveBandagoSiblingUrl(
  syncEndpointUrl: string,
  suffix: string,
): string {
  const cleanSuffix = suffix.startsWith("/") ? suffix : `/${suffix}`;
  const trimmed = (syncEndpointUrl || "").trim().replace(/\/+$/, "");
  if (!trimmed) return "";
  if (trimmed.endsWith("/sync")) {
    return `${trimmed.slice(0, -5)}${cleanSuffix}`;
  }
  return `${trimmed}${cleanSuffix}`;
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
  ALLOW_OUTBOUND: "sphere_allow_outbound_writeback",
  EXPECTED_TENANT_UU: "sphere_expected_tenant_uu",
  LAST_TENANT_UU: "sphere_last_tenant_uu",
  SERVER_POLICY: "sphere_server_policy",
  OUTBOUND_STATUS: "sphere_outbound_status",
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
          STORAGE_KEYS.ALLOW_OUTBOUND,
          STORAGE_KEYS.EXPECTED_TENANT_UU,
        ]);

        return {
          endpointUrl: data[STORAGE_KEYS.ENDPOINT_URL] || "",
          apiKey: data[STORAGE_KEYS.API_KEY] || "",
          enabled: Boolean(data[STORAGE_KEYS.ENABLED]),
          pharmacyId: data[STORAGE_KEYS.PHARMACY_ID] || "DEFAULT_STORE",
          allowOutboundWriteback: data[STORAGE_KEYS.ALLOW_OUTBOUND] !== false,
          expectedTenantUU: data[STORAGE_KEYS.EXPECTED_TENANT_UU] || "",
        };
      } else if (typeof localStorage !== "undefined") {
        const allowOutboundRaw = localStorage.getItem(
          STORAGE_KEYS.ALLOW_OUTBOUND,
        );
        return {
          endpointUrl: localStorage.getItem(STORAGE_KEYS.ENDPOINT_URL) || "",
          apiKey: localStorage.getItem(STORAGE_KEYS.API_KEY) || "",
          enabled: localStorage.getItem(STORAGE_KEYS.ENABLED) === "true",
          pharmacyId:
            localStorage.getItem(STORAGE_KEYS.PHARMACY_ID) || "DEFAULT_STORE",
          allowOutboundWriteback: allowOutboundRaw !== "false",
          expectedTenantUU:
            localStorage.getItem(STORAGE_KEYS.EXPECTED_TENANT_UU) || "",
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
      allowOutboundWriteback: true,
      expectedTenantUU: "",
    };
  }

  /**
   * Saves updated synchronization configuration.
   */
  static async saveConfig(updates: Partial<SyncConfig>): Promise<SyncConfig> {
    const current = await this.getConfig();
    const rawMerged: SyncConfig = { ...current, ...updates };
    const merged: SyncConfig = {
      ...rawMerged,
      endpointUrl: (rawMerged.endpointUrl || "").trim(),
      apiKey: (rawMerged.apiKey || "").trim(),
      pharmacyId: (rawMerged.pharmacyId || "DEFAULT_STORE").trim() || "DEFAULT_STORE",
      expectedTenantUU: (rawMerged.expectedTenantUU || "").trim(),
    };

    const toStore: Record<string, any> = {
      [STORAGE_KEYS.ENDPOINT_URL]: merged.endpointUrl,
      [STORAGE_KEYS.API_KEY]: merged.apiKey,
      [STORAGE_KEYS.ENABLED]: merged.enabled,
      [STORAGE_KEYS.PHARMACY_ID]: merged.pharmacyId,
      [STORAGE_KEYS.ALLOW_OUTBOUND]: merged.allowOutboundWriteback !== false,
      [STORAGE_KEYS.EXPECTED_TENANT_UU]: merged.expectedTenantUU || "",
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
    tenantUU?: string | null,
  ): Promise<number> {
    if (tenantUU && typeof chrome !== "undefined" && chrome.storage?.local) {
      await chrome.storage.local
        .set({ [STORAGE_KEYS.LAST_TENANT_UU]: tenantUU })
        .catch(() => {});
    }
    const count = await SyncQueueManager.enqueue(items);
    // Trigger immediate background flush (non-blocking)
    this.flushQueue(trigger, tenantUU).catch((err) => {
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
    tenantUUOverride?: string | null,
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
        const timeoutId = setTimeout(() => controller.abort(), 45000);

        try {
          const payloadItems = pendingItems.map(
            (p) => p.payload as SphereProductSyncItem,
          );
          const coalescedItems = coalesceSyncItems(payloadItems);
          const batchTenantUU =
            tenantUUOverride ||
            coalescedItems.find((i) => Boolean(i.tenantUU))?.tenantUU ||
            undefined;

          const response = await fetch(config.endpointUrl.trim(), {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${config.apiKey.trim()}`,
              "X-Pharmacy-Source": "BANDAGO_POS",
            },
            signal: controller.signal,
            body: JSON.stringify({
              source: "BANDAGO_POS",
              trigger: trigger || "BACKGROUND_POLL",
              pharmacyId: config.pharmacyId,
              ...(batchTenantUU ? { tenantUU: batchTenantUU } : {}),
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

          const parsedBody = await parseSphereJsonResponse(
            response,
            config.endpointUrl,
          );
          if (!parsedBody.ok) {
            throw new Error(parsedBody.error);
          }
          const resData = parsedBody.data;

          if (resData && resData.policySummary) {
            await this.saveServerPolicy({
              outboundSyncMode: resData.policySummary.outboundSyncMode,
              inboundEnabled:
                resData.policySummary.inboundEnabled ??
                (!resData.paused && !resData.skipped),
              expectedTenantUU: resData.policySummary.expectedTenantUU ?? null,
            }).catch(() => {});
          }

          if (resData && (resData.skipped === true || resData.paused === true)) {
            await SyncQueueManager.requeueWithoutPenalty(ids);
            await this.saveServerPolicy({
              outboundSyncMode: resData.policySummary?.outboundSyncMode,
              inboundEnabled: false,
              expectedTenantUU: resData.policySummary?.expectedTenantUU ?? null,
            }).catch(() => {});
            const pausedReason =
              resData.reason || "Inbound POS sync is paused by Sphere admin policy";
            return {
              synced: totalSynced,
              failed: totalFailed,
              error: pausedReason,
            };
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
    const endpointUrl = (config.endpointUrl || "").trim();
    const apiKey = (config.apiKey || "").trim();
    if (!endpointUrl || !apiKey) {
      return { ok: false, error: "Endpoint URL and API Key are required" };
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 15000);

    try {
      const response = await fetch(endpointUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
          "X-Pharmacy-Source": "BANDAGO_POS",
        },
        signal: controller.signal,
        body: JSON.stringify({
          source: "BANDAGO_POS",
          pharmacyId: (config.pharmacyId || "TEST_PING").trim(),
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

      const parsed = await parseSphereJsonResponse(response, endpointUrl);
      if (!parsed.ok) {
        return {
          ok: false,
          status: response.status,
          error: parsed.error,
        };
      }

      if (typeof response.json === "function") {
        const pingData = parsed.data;
        const hasRecognizedKey =
          "success" in pingData ||
          "policySummary" in pingData ||
          "upsertedCount" in pingData ||
          "syncedCount" in pingData ||
          "synced" in pingData ||
          "count" in pingData ||
          "paused" in pingData ||
          "skipped" in pingData;
        if (!hasRecognizedKey) {
          return {
            ok: false,
            status: response.status,
            error:
              "Endpoint returned JSON, but not from the Sphere BandaGo Sync API. Verify URL ends with /api/integrations/bandago/sync.",
          };
        }

        if (pingData.success === false) {
          return {
            ok: false,
            status: response.status,
            error:
              typeof pingData.error === "string" && pingData.error
                ? pingData.error
                : "Sphere API rejected handshake",
          };
        }

        if (pingData.policySummary) {
          await this.saveServerPolicy({
            outboundSyncMode: pingData.policySummary.outboundSyncMode,
            inboundEnabled:
              pingData.policySummary.inboundEnabled ??
              (!pingData.paused && !pingData.skipped),
            expectedTenantUU: pingData.policySummary.expectedTenantUU ?? null,
          }).catch(() => {});
        }
        if (pingData.paused || pingData.skipped) {
          return {
            ok: true,
            status: response.status,
            error:
              pingData.reason ||
              "Connected (Inbound POS sync is currently paused by Sphere admin)",
          };
        }
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
   * Clears active synchronization and polling error banners from UI and storage.
   */
  static async dismissActiveErrors(): Promise<void> {
    try {
      if (typeof chrome !== "undefined" && chrome.storage?.local) {
        await chrome.storage.local.set({
          [STORAGE_KEYS.LAST_SYNC_ERROR]: "",
          [STORAGE_KEYS.LAST_POLL_MESSAGE]: "",
          [STORAGE_KEYS.LAST_POLL_SUCCESS]: null,
        });
      } else if (typeof localStorage !== "undefined") {
        localStorage.removeItem(STORAGE_KEYS.LAST_SYNC_ERROR);
        localStorage.removeItem(STORAGE_KEYS.LAST_POLL_MESSAGE);
        localStorage.removeItem(STORAGE_KEYS.LAST_POLL_SUCCESS);
      }
    } catch {
      // Ignore storage error
    }
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
          [STORAGE_KEYS.LAST_POLL_MESSAGE]: "",
          [STORAGE_KEYS.LAST_POLL_SUCCESS]: null,
        });
      } else if (typeof localStorage !== "undefined") {
        localStorage.removeItem(STORAGE_KEYS.ERROR_LOG);
        localStorage.removeItem(STORAGE_KEYS.LAST_SYNC_ERROR);
        localStorage.removeItem(STORAGE_KEYS.LAST_POLL_MESSAGE);
        localStorage.removeItem(STORAGE_KEYS.LAST_POLL_SUCCESS);
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

  /**
   * Deletes a single item by id from the sync queue.
   */
  static async deleteQueueItem(id: number): Promise<void> {
    await SyncQueueManager.deleteItem(id);
  }

  static async getOutboundStatus(): Promise<OutboundRunStatus> {
    const empty: OutboundRunStatus = {
      lastRunAt: null,
      ok: null,
      message: null,
      lastErrorCode: null,
    };
    try {
      if (typeof chrome !== "undefined" && chrome.storage?.local) {
        const data = await chrome.storage.local.get([
          STORAGE_KEYS.OUTBOUND_STATUS,
        ]);
        const val = data[STORAGE_KEYS.OUTBOUND_STATUS];
        return val && typeof val === "object" ? { ...empty, ...val } : empty;
      } else if (typeof localStorage !== "undefined") {
        const raw = localStorage.getItem(STORAGE_KEYS.OUTBOUND_STATUS);
        return raw ? { ...empty, ...JSON.parse(raw) } : empty;
      }
    } catch {}
    return empty;
  }

  static async saveOutboundStatus(
    updates: Partial<OutboundRunStatus>,
  ): Promise<OutboundRunStatus> {
    const current = await this.getOutboundStatus();
    const merged: OutboundRunStatus = { ...current, ...updates };
    try {
      if (typeof chrome !== "undefined" && chrome.storage?.local) {
        await chrome.storage.local.set({
          [STORAGE_KEYS.OUTBOUND_STATUS]: merged,
        });
      } else if (typeof localStorage !== "undefined") {
        localStorage.setItem(
          STORAGE_KEYS.OUTBOUND_STATUS,
          JSON.stringify(merged),
        );
      }
    } catch {}
    return merged;
  }

  static async getServerPolicy(): Promise<ServerSyncPolicy> {
    try {
      if (typeof chrome !== "undefined" && chrome.storage?.local) {
        const data = await chrome.storage.local.get([
          STORAGE_KEYS.SERVER_POLICY,
        ]);
        const val = data[STORAGE_KEYS.SERVER_POLICY];
        return val && typeof val === "object" ? val : {};
      } else if (typeof localStorage !== "undefined") {
        const raw = localStorage.getItem(STORAGE_KEYS.SERVER_POLICY);
        return raw ? JSON.parse(raw) : {};
      }
    } catch {}
    return {};
  }

  static async saveServerPolicy(
    updates: Partial<ServerSyncPolicy>,
  ): Promise<ServerSyncPolicy> {
    const current = await this.getServerPolicy();
    const merged: ServerSyncPolicy = { ...current, ...updates };
    try {
      if (typeof chrome !== "undefined" && chrome.storage?.local) {
        await chrome.storage.local.set({
          [STORAGE_KEYS.SERVER_POLICY]: merged,
        });
      } else if (typeof localStorage !== "undefined") {
        localStorage.setItem(
          STORAGE_KEYS.SERVER_POLICY,
          JSON.stringify(merged),
        );
      }
    } catch {}
    return merged;
  }

  /**
   * Posts strictly Zero-PHI structural heartbeats and error summaries to Sphere /telemetry
   * and caches the live server policy returned by Sphere.
   */
  static async reportTelemetry(input: TelemetryReportInput): Promise<{
    ok: boolean;
    policy?: ServerSyncPolicy;
    pendingOutboundCount?: number;
  }> {
    const config = await this.getConfig();
    if (!config.enabled || !config.endpointUrl || !config.apiKey) {
      return { ok: false };
    }

    const telemetryUrl = deriveBandagoSiblingUrl(
      config.endpointUrl,
      "/telemetry",
    );
    if (!telemetryUrl) return { ok: false };

    let queueStats: QueueStats = { pending: 0, syncing: 0, failed: 0, total: 0 };
    try {
      queueStats = await SyncQueueManager.getStats();
    } catch {}

    let lastTenantUU: string | null = null;
    try {
      if (typeof chrome !== "undefined" && chrome.storage?.local) {
        const d = await chrome.storage.local.get([STORAGE_KEYS.LAST_TENANT_UU]);
        lastTenantUU = d[STORAGE_KEYS.LAST_TENANT_UU] || null;
      }
    } catch {}

    const manifestVersion =
      typeof chrome !== "undefined" && chrome.runtime?.getManifest
        ? chrome.runtime.getManifest().version
        : null;

    try {
      const res = await fetch(telemetryUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${config.apiKey.trim()}`,
        },
        body: JSON.stringify({
          heartbeat: {
            extensionVersion: manifestVersion,
            pharmacyId: config.pharmacyId || "DEFAULT_STORE",
            tenantUU: lastTenantUU,
            inboundQueuePending: queueStats.pending,
            inboundQueueFailed: queueStats.failed,
            ...(input.heartbeat || {}),
          },
          errors: input.errors || [],
        }),
      });

      if (!res.ok) return { ok: false };
      const ct =
        (typeof res.headers?.get === "function"
          ? res.headers.get("content-type")
          : (res.headers as any)?.["content-type"]) || "";
      if (ct && !ct.toLowerCase().includes("json")) {
        return { ok: false };
      }
      const json = await res.json().catch(() => ({}));
      if (json?.policy) {
        await this.saveServerPolicy(json.policy).catch(() => {});
      }
      return {
        ok: Boolean(json?.ok),
        policy: json?.policy,
        pendingOutboundCount: json?.pendingOutboundCount,
      };
    } catch {
      return { ok: false };
    }
  }
}
