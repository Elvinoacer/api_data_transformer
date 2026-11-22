import {
  deriveBandagoSiblingUrl,
  SphereSyncClient,
  type OutboundRunStatus,
} from "../sync/sphere-client";
import { CdpNetworkAdapter } from "./cdp-adapter";

export interface ClaimedOutboundJob {
  id: string;
  idempotencyKey: string;
  eventType:
    | "ONLINE_SALE"
    | "ADMIN_STOCK_ADJUST"
    | "REFUND_RESTOCK"
    | "ADMIN_PRICE_UPDATE";
  status: string;
  orderId: string | null;
  orderReference: string | null;
  productId: string;
  externalPosId: string | null;
  productName: string;
  sku: string | null;
  qtyDelta: number;
  targetStock: number | null;
  posStockSnapshot: number | null;
  attempts: number;
  maxAttempts: number;
  lockToken: string | null;
  externalInventoryUU: string | null;
  externalWarehouseId: string | null;
  externalLocatorId: string | null;
  externalOrgId: string | null;
  sphereStockQty: number;
  lastPosStock: number | null;
}

export interface BandaGoStorageRow {
  UU?: string;
  QtyOnHand?: number | null;
  AD_Client?: { UU?: string } | null;
  AD_Org?: { UU?: string } | null;
  M_Locator?: {
    UU?: string;
    Value?: string;
    Name?: string;
    IsActive?: boolean | string;
    M_Warehouse?: {
      UU?: string;
      Name?: string;
      AD_Org?: { UU?: string };
    };
  } | null;
  M_AttributeSetInstance?: {
    UU?: string;
    Lot?: string;
    GuaranteeDate?: string | null;
    Description?: string | null;
  } | null;
}

export interface PlannedInventoryLine {
  M_Product: { UU: string };
  M_Locator: { UU: string };
  M_AttributeSetInstance: { UU: string };
  QtyBook: number;
  QtyCount: number;
}

export interface PlannedAdjustmentResult {
  lines: PlannedInventoryLine[];
  deltaApplied: number;
  alreadyMatched: boolean;
  warningCode?: string;
  warningMessage?: string;
  newTotalStock: number;
  warehouseUU: string | null;
  orgUU: string | null;
}

export interface WritebackSyncResult {
  ok: boolean;
  synced: number;
  released: number;
  failed: number;
  message: string;
  mode?: string;
}

/**
 * Formats a JS Date into BandaGo iDempiere GraphQL Date literal (`YYYY/MM/DD`).
 */
export function formatBandaGoDate(date: Date = new Date()): string {
  const yyyy = date.getFullYear();
  const mm = String(date.getMonth() + 1).padStart(2, "0");
  const dd = String(date.getDate()).padStart(2, "0");
  return `${yyyy}/${mm}/${dd}`;
}

function isQuarantineOrInactiveRow(row: BandaGoStorageRow): boolean {
  const loc = row.M_Locator;
  if (!loc) return false;
  if (
    loc.IsActive === false ||
    (typeof loc.IsActive === "string" &&
      ["n", "false", "0"].includes(loc.IsActive.trim().toLowerCase()))
  ) {
    return true;
  }
  const label = [loc.Value, loc.Name, loc.M_Warehouse?.Name]
    .filter(Boolean)
    .join(" ");
  return /\b(quarantine|expired|damaged|reject|return|waste)\b/i.test(label);
}

function parseFlexibleWritebackDateMs(raw: unknown): number | null {
  if (raw === undefined || raw === null || raw === "") return null;
  if (typeof raw === "number") {
    if (!Number.isFinite(raw) || raw <= 0) return null;
    return raw < 1e11 ? raw * 1000 : raw;
  }
  const str = String(raw).trim();
  if (!str) return null;
  if (/^\d{10,13}(?:\.\d+)?$/.test(str)) {
    const num = Number(str);
    if (Number.isFinite(num) && num > 0) {
      return num < 1e11 ? num * 1000 : num;
    }
  }
  const ms = Date.parse(str);
  return Number.isNaN(ms) ? null : ms;
}

function isExpiredGuaranteeDate(guaranteeDate?: string | number | null): boolean {
  const ms = parseFlexibleWritebackDateMs(guaranteeDate);
  if (ms === null) return false;
  return ms < Date.now();
}

function selectBestBandaGoWritebackTab(
  tabs: chrome.tabs.Tab[],
): chrome.tabs.Tab | null {
  const valid = tabs.filter((t) => typeof t.id === "number");
  if (valid.length === 0) return null;
  const nonDiscarded = valid.filter((t) => !t.discarded);
  const pool = nonDiscarded.length > 0 ? nonDiscarded : valid;
  return [...pool].sort((a, b) => {
    const score = (t: chrome.tabs.Tab) => {
      const u = (t.url || "").toLowerCase();
      let s = 0;
      if (!/\/(login|signin|auth)\b/.test(u)) s += 100;
      if (/\/(products|inventory|dispense|sales)/.test(u)) s += 50;
      if (t.active) s += 20;
      if (t.status === "complete") s += 10;
      return s;
    };
    return score(b) - score(a);
  })[0];
}

/**
 * Pure FEFO inventory adjustment planner translating Sphere outbound stock jobs
 * into concrete iDempiere M_InventoryLine count entries.
 */
export function planInventoryAdjustmentLines(input: {
  job: Pick<
    ClaimedOutboundJob,
    | "externalPosId"
    | "productName"
    | "eventType"
    | "qtyDelta"
    | "targetStock"
    | "externalLocatorId"
    | "externalWarehouseId"
    | "externalOrgId"
  >;
  storageRows: BandaGoStorageRow[];
  fallbackLocatorUU?: string | null;
  fallbackWarehouseUU?: string | null;
  fallbackOrgUU?: string | null;
  fallbackAsiUU?: string | null;
}): PlannedAdjustmentResult {
  const { job, storageRows } = input;
  const productUU = job.externalPosId || "";

  const sellableRows = storageRows
    .filter((r) => !isQuarantineOrInactiveRow(r))
    .filter(
      (r) => !isExpiredGuaranteeDate(r.M_AttributeSetInstance?.GuaranteeDate),
    )
    .sort((a, b) => {
      const aExp =
        parseFlexibleWritebackDateMs(a.M_AttributeSetInstance?.GuaranteeDate) ??
        Number.MAX_SAFE_INTEGER;
      const bExp =
        parseFlexibleWritebackDateMs(b.M_AttributeSetInstance?.GuaranteeDate) ??
        Number.MAX_SAFE_INTEGER;
      if (aExp !== bExp) return aExp - bExp;
      return (b.QtyOnHand ?? 0) - (a.QtyOnHand ?? 0);
    });

  const firstRow = sellableRows[0] ?? storageRows[0];
  const resolvedLocatorUU =
    firstRow?.M_Locator?.UU ||
    job.externalLocatorId ||
    input.fallbackLocatorUU ||
    null;
  const resolvedWarehouseUU =
    firstRow?.M_Locator?.M_Warehouse?.UU ||
    job.externalWarehouseId ||
    input.fallbackWarehouseUU ||
    null;
  const resolvedOrgUU =
    firstRow?.AD_Org?.UU ||
    firstRow?.M_Locator?.M_Warehouse?.AD_Org?.UU ||
    job.externalOrgId ||
    input.fallbackOrgUU ||
    null;

  const currentTotal = sellableRows.reduce(
    (sum, r) => sum + Math.max(0, Math.floor(Number(r.QtyOnHand) || 0)),
    0,
  );

  let desiredDelta = Math.trunc(job.qtyDelta);
  if (job.eventType === "ADMIN_STOCK_ADJUST" && job.targetStock !== null) {
    desiredDelta = Math.max(0, Math.floor(job.targetStock)) - currentTotal;
    if (desiredDelta === 0) {
      return {
        lines: [],
        deltaApplied: 0,
        alreadyMatched: true,
        newTotalStock: currentTotal,
        warehouseUU: resolvedWarehouseUU,
        orgUU: resolvedOrgUU,
      };
    }
  }

  const lines: PlannedInventoryLine[] = [];

  if (desiredDelta < 0) {
    let remainingToDeduct = Math.abs(desiredDelta);
    for (const row of sellableRows) {
      if (remainingToDeduct <= 0) break;
      const qtyBook = Math.max(0, Math.floor(Number(row.QtyOnHand) || 0));
      const locUU = row.M_Locator?.UU || resolvedLocatorUU;
      const asiUU = row.M_AttributeSetInstance?.UU || input.fallbackAsiUU;
      if (qtyBook <= 0 || !locUU || !asiUU || !productUU) continue;

      const deductHere = Math.min(qtyBook, remainingToDeduct);
      lines.push({
        M_Product: { UU: productUU },
        M_Locator: { UU: locUU },
        M_AttributeSetInstance: { UU: asiUU },
        QtyBook: qtyBook,
        QtyCount: qtyBook - deductHere,
      });
      remainingToDeduct -= deductHere;
    }

    const actuallyDeducted = Math.abs(desiredDelta) - remainingToDeduct;
    const newTotalStock = Math.max(0, currentTotal - actuallyDeducted);
    const shortBy = remainingToDeduct;

    return {
      lines,
      deltaApplied: -actuallyDeducted,
      alreadyMatched: false,
      ...(shortBy > 0
        ? {
            warningCode: "INSUFFICIENT_POS_STOCK",
            warningMessage: `BandaGo had ${currentTotal} sellable unit(s) for "${job.productName}" when deducting ${Math.abs(desiredDelta)}; clamped POS stock to ${newTotalStock}.`,
          }
        : {}),
      newTotalStock,
      warehouseUU: resolvedWarehouseUU,
      orgUU: resolvedOrgUU,
    };
  }

  if (desiredDelta > 0 && productUU) {
    const targetRow =
      sellableRows.find((r) => (r.QtyOnHand ?? 0) >= 0 && r.M_Locator?.UU) ??
      firstRow;
    const locUU = targetRow?.M_Locator?.UU || resolvedLocatorUU;
    const asiUU =
      targetRow?.M_AttributeSetInstance?.UU || input.fallbackAsiUU || null;
    if (locUU && asiUU) {
      const qtyBook = Math.max(
        0,
        Math.floor(Number(targetRow?.QtyOnHand) || 0),
      );
      lines.push({
        M_Product: { UU: productUU },
        M_Locator: { UU: locUU },
        M_AttributeSetInstance: { UU: asiUU },
        QtyBook: qtyBook,
        QtyCount: qtyBook + desiredDelta,
      });
      return {
        lines,
        deltaApplied: desiredDelta,
        alreadyMatched: false,
        newTotalStock: currentTotal + desiredDelta,
        warehouseUU: resolvedWarehouseUU,
        orgUU: resolvedOrgUU,
      };
    }
  }

  return {
    lines: [],
    deltaApplied: 0,
    alreadyMatched: desiredDelta === 0,
    newTotalStock: currentTotal,
    warehouseUU: resolvedWarehouseUU,
    orgUU: resolvedOrgUU,
  };
}

export class BandaGoWritebackEngine {
  public static readonly ALARM_NAME = "BANDAGO_OUTBOUND_SYNC_ALARM";
  public static readonly DEFAULT_INTERVAL_MINUTES = 2;
  private static isInitialized = false;
  private static currentIntervalMinutes = 2;
  private static inFlightSync: Promise<WritebackSyncResult> | null = null;

  static init(): void {
    if (this.isInitialized) return;
    this.isInitialized = true;

    try {
      if (typeof chrome !== "undefined" && chrome.alarms) {
        chrome.alarms.onAlarm.addListener((alarm) => {
          if (alarm.name === this.ALARM_NAME) {
            this.syncOutboundNow({ trigger: "ALARM" }).catch((err) => {
              console.warn("[BandaGo Writeback] Scheduled run error:", err);
            });
          }
        });

        chrome.alarms.get(this.ALARM_NAME, (existing) => {
          if (!existing) {
            chrome.alarms.create(this.ALARM_NAME, {
              periodInMinutes: this.DEFAULT_INTERVAL_MINUTES,
            });
          }
        });
      }
    } catch (err) {
      console.warn("[BandaGo Writeback] Could not register alarm:", err);
    }
  }

  private static updateAlarmPeriodIfNeeded(minutes: number): void {
    const safeMinutes = Math.max(1, Math.min(60, Math.floor(minutes || 2)));
    if (safeMinutes === this.currentIntervalMinutes) return;
    this.currentIntervalMinutes = safeMinutes;
    try {
      if (typeof chrome !== "undefined" && chrome.alarms) {
        chrome.alarms.create(this.ALARM_NAME, {
          periodInMinutes: safeMinutes,
        });
      }
    } catch {}
  }

  static syncOutboundNow(opts?: {
    trigger?: "ALARM" | "MANUAL" | "POST_ORDER";
  }): Promise<WritebackSyncResult> {
    if (this.inFlightSync) {
      return this.inFlightSync;
    }
    this.inFlightSync = this.executeSyncOutbound(opts).finally(() => {
      this.inFlightSync = null;
    });
    return this.inFlightSync;
  }

  private static async executeSyncOutbound(opts?: {
    trigger?: "ALARM" | "MANUAL" | "POST_ORDER";
  }): Promise<WritebackSyncResult> {
    const startTime = Date.now();
    const saveStatus = async (status: Partial<OutboundRunStatus>) => {
      await SphereSyncClient.saveOutboundStatus({
        lastRunAt: new Date().toISOString(),
        ...status,
      }).catch(() => {});
    };

    const config = await SphereSyncClient.getConfig();
    if (!config.enabled || !config.endpointUrl || !config.apiKey) {
      const msg = "Sphere sync is disabled or unconfigured";
      await saveStatus({ ok: false, message: msg });
      return { ok: false, synced: 0, released: 0, failed: 0, message: msg };
    }

    if (config.allowOutboundWriteback === false) {
      const msg = "Outbound Website -> POS writeback disabled on this device";
      await saveStatus({ ok: false, message: msg, mode: "DEVICE_DISABLED" });
      return {
        ok: false,
        synced: 0,
        released: 0,
        failed: 0,
        message: msg,
        mode: "DEVICE_DISABLED",
      };
    }

    const outboundUrl = `${deriveBandagoSiblingUrl(config.endpointUrl, "/outbound")}?claim=1&limit=20`;
    const ackUrl = deriveBandagoSiblingUrl(config.endpointUrl, "/outbound/ack");

    let claimResponse: any;
    try {
      const res = await fetch(outboundUrl, {
        method: "GET",
        headers: {
          Authorization: `Bearer ${config.apiKey}`,
          Accept: "application/json",
        },
      });
      if (!res.ok) {
        const errBody = await res.text().catch(() => "");
        const errCode =
          res.status === 401 ? "SPHERE_AUTH_FAILED" : "OUTBOUND_WRITEBACK_FAILED";
        const msg = `Sphere outbound claim HTTP ${res.status}: ${errBody.slice(0, 180)}`;
        await saveStatus({ ok: false, message: msg, lastErrorCode: errCode });
        return { ok: false, synced: 0, released: 0, failed: 0, message: msg };
      }
      const ct =
        (typeof res.headers?.get === "function"
          ? res.headers.get("content-type")
          : (res.headers as any)?.["content-type"]) || "";
      if (ct && !ct.toLowerCase().includes("json")) {
        const msg = `Sphere outbound endpoint returned HTML/non-JSON (${ct.split(";")[0].trim()}) — check your Sphere Ingestion Endpoint URL spelling (expected .../api/integrations/bandago/sync)`;
        await saveStatus({
          ok: false,
          message: msg,
          lastErrorCode: "INVALID_ENDPOINT_URL",
        });
        return { ok: false, synced: 0, released: 0, failed: 0, message: msg };
      }
      try {
        claimResponse = await res.json();
      } catch (parseErr: unknown) {
        const parseMsg =
          parseErr instanceof Error ? parseErr.message : "Invalid JSON response";
        const msg = `Sphere outbound endpoint returned non-JSON payload (${parseMsg}) — check your Sphere Ingestion Endpoint URL spelling (expected .../api/integrations/bandago/sync)`;
        await saveStatus({
          ok: false,
          message: msg,
          lastErrorCode: "INVALID_ENDPOINT_URL",
        });
        return { ok: false, synced: 0, released: 0, failed: 0, message: msg };
      }
    } catch (err: unknown) {
      const msg =
        err instanceof Error
          ? err.message
          : "Network error fetching outbound jobs";
      await saveStatus({
        ok: false,
        message: msg,
        lastErrorCode: "NETWORK_TIMEOUT",
      });
      return { ok: false, synced: 0, released: 0, failed: 0, message: msg };
    }

    const policy = claimResponse?.policy;
    if (policy) {
      await SphereSyncClient.saveServerPolicy(policy).catch(() => {});
      if (typeof policy.outboundPollIntervalMinutes === "number") {
        this.updateAlarmPeriodIfNeeded(policy.outboundPollIntervalMinutes);
      }
    }

    const mode = policy?.outboundSyncMode || "MANUAL_EXPORT";
    const jobs: ClaimedOutboundJob[] = Array.isArray(claimResponse?.jobs)
      ? claimResponse.jobs
      : [];

    if (mode !== "AUTO_SYNC") {
      const msg = "Server policy is Manual Daily Export (auto writeback off)";
      await saveStatus({
        ok: true,
        mode,
        pendingCount: jobs.length,
        message: msg,
        lastErrorCode: null,
      });
      return {
        ok: true,
        synced: 0,
        released: 0,
        failed: 0,
        message: msg,
        mode,
      };
    }

    if (jobs.length === 0) {
      const msg =
        opts?.trigger === "MANUAL"
          ? "No pending online sales or stock edits to push to BandaGo"
          : "Outbound queue clear";
      await saveStatus({
        ok: true,
        mode,
        pendingCount: 0,
        message: msg,
        lastErrorCode: null,
      });
      return {
        ok: true,
        synced: 0,
        released: 0,
        failed: 0,
        message: msg,
        mode,
      };
    }

    if (typeof chrome === "undefined" || !chrome.tabs || !chrome.scripting) {
      const msg = "Chrome scripting API unavailable for outbound writeback";
      await this.postAck(
        ackUrl,
        config.apiKey,
        jobs.map((j) => ({
          jobId: j.id,
          lockToken: j.lockToken,
          status: "RELEASE",
          warningCode: "NO_POS_TAB",
          warningMessage: msg,
        })),
        Date.now() - startTime,
      );
      await saveStatus({
        ok: false,
        mode,
        pendingCount: jobs.length,
        message: msg,
        lastErrorCode: "NO_POS_TAB",
      });
      return {
        ok: false,
        synced: 0,
        released: jobs.length,
        failed: 0,
        message: msg,
        mode,
      };
    }

    const tabs = await chrome.tabs.query({ url: "*://go.bandahealth.org/*" });
    const bestTab = selectBestBandaGoWritebackTab(tabs);
    if (!bestTab || !bestTab.id) {
      const msg =
        "No open go.bandahealth.org tab — released jobs cleanly until POS is open";
      await this.postAck(
        ackUrl,
        config.apiKey,
        jobs.map((j) => ({
          jobId: j.id,
          lockToken: j.lockToken,
          status: "RELEASE",
          warningCode: "NO_POS_TAB",
          warningMessage: msg,
        })),
        Date.now() - startTime,
      );
      await SphereSyncClient.reportTelemetry({
        heartbeat: {
          bandagoTabOpen: false,
          lastOutboundRunAt: new Date().toISOString(),
          lastOutboundOk: false,
          lastOutboundMessage: msg,
        },
      }).catch(() => {});
      await saveStatus({
        ok: false,
        mode,
        pendingCount: jobs.length,
        message: msg,
        lastErrorCode: "NO_POS_TAB",
      });
      return {
        ok: false,
        synced: 0,
        released: jobs.length,
        failed: 0,
        message: msg,
        mode,
      };
    }

    const tabId = bestTab.id;
    let origin = "https://go.bandahealth.org";
    try {
      if (bestTab.url) origin = new URL(bestTab.url).origin;
    } catch {}
    const cachedAuthHeader = await CdpNetworkAdapter.getAuthHeader(origin);
    const discoveredGql = await CdpNetworkAdapter.getGraphqlEndpoint(origin);
    const gqlEndpoint = discoveredGql?.endpointUrl || "/graphql/";
    const expectedTenantUU =
      config.expectedTenantUU?.trim() || policy?.expectedTenantUU || null;

    let tabResults: any[] = [];
    try {
      const execResults = await chrome.scripting.executeScript({
        target: { tabId },
        func: inTabExecuteWritebackBatch,
        args: discoveredGql?.usesBatchArray
          ? [gqlEndpoint, jobs, expectedTenantUU, cachedAuthHeader, true]
          : [gqlEndpoint, jobs, expectedTenantUU, cachedAuthHeader],
      });
      tabResults = Array.isArray(execResults?.[0]?.result?.results)
        ? execResults[0].result.results
        : [];
      if (execResults?.[0]?.result?.fatalError) {
        const fatal = execResults[0].result.fatalError;
        tabResults = jobs.map((j) => ({
          jobId: j.id,
          lockToken: j.lockToken,
          status: "FAILED",
          errorCode: fatal.code || "OUTBOUND_WRITEBACK_FAILED",
          errorMessage: fatal.message || "BandaGo in-tab writeback failed",
        }));
      }
    } catch (err: unknown) {
      const msg =
        err instanceof Error ? err.message : "Failed executing writeback script";
      tabResults = jobs.map((j) => ({
        jobId: j.id,
        lockToken: j.lockToken,
        status: "FAILED",
        errorCode: "OUTBOUND_WRITEBACK_FAILED",
        errorMessage: msg,
      }));
    }

    if (tabResults.length === 0) {
      tabResults = jobs.map((j) => ({
        jobId: j.id,
        lockToken: j.lockToken,
        status: "RELEASE",
        warningCode: "OUTBOUND_WRITEBACK_FAILED",
        warningMessage: "Writeback script returned empty result set",
      }));
    }

    const durationMs = Date.now() - startTime;
    await this.postAck(ackUrl, config.apiKey, tabResults, durationMs);

    const synced = tabResults.filter((r) => r.status === "SYNCED").length;
    const released = tabResults.filter((r) => r.status === "RELEASE").length;
    const failedResults = tabResults.filter((r) => r.status === "FAILED");
    const failed = failedResults.length;
    const firstErr = failedResults[0];
    const summaryMsg =
      failed === 0
        ? `Synced ${synced} inventory adjustment(s) to BandaGo`
        : `${synced} synced, ${failed} failed (${firstErr?.errorCode || "ERROR"}: ${firstErr?.errorMessage || ""})`;

    await SphereSyncClient.reportTelemetry({
      heartbeat: {
        bandagoTabOpen: true,
        bandagoOrigin: origin,
        lastOutboundRunAt: new Date().toISOString(),
        lastOutboundOk: failed === 0,
        lastOutboundMessage: summaryMsg,
      },
    }).catch(() => {});

    await saveStatus({
      ok: failed === 0,
      mode,
      syncedCount: synced,
      failedCount: failed,
      pendingCount: failed + released,
      message: summaryMsg,
      lastErrorCode: firstErr?.errorCode ?? null,
    });

    return {
      ok: failed === 0,
      synced,
      released,
      failed,
      message: summaryMsg,
      mode,
    };
  }

  private static async postAck(
    ackUrl: string,
    apiKey: string,
    results: any[],
    durationMs: number,
  ): Promise<void> {
    try {
      await fetch(ackUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({ results, durationMs }),
      });
    } catch (err) {
      console.warn("[BandaGo Writeback] Ack post failed:", err);
    }
  }
}

/**
 * Self-contained page-context GraphQL Physical Inventory writer executed inside an
 * authenticated go.bandahealth.org tab. MUST contain ZERO outer closure/module references.
 */
async function inTabExecuteWritebackBatch(
  gqlEndpoint: string,
  jobs: ClaimedOutboundJob[],
  expectedTenantUU: string | null,
  cachedAuthHeader: string | null,
  preferBatchArray = false,
): Promise<{
  results: any[];
  fatalError?: { code: string; message: string };
}> {
  const jwtRegex = /^eyJ[A-Za-z0-9-_]+\.[A-Za-z0-9-_]+\.[A-Za-z0-9-_]+$/;
  const extractJwt = (val: unknown, depth = 0): string | null => {
    if (depth > 3 || val == null) return null;
    if (typeof val === "string") {
      const cleaned = val.trim().replace(/^"|"$/g, "").replace(/^Bearer\s+/i, "").trim();
      if (jwtRegex.test(cleaned)) return cleaned;
      if (cleaned.startsWith("{") || cleaned.startsWith("[")) {
        try {
          return extractJwt(JSON.parse(cleaned), depth + 1);
        } catch {}
      }
      return null;
    }
    if (Array.isArray(val)) {
      for (const el of val) {
        const hit = extractJwt(el, depth + 1);
        if (hit) return hit;
      }
      return null;
    }
    if (typeof val === "object") {
      const obj = val as Record<string, unknown>;
      for (const k of [
        "token",
        "accessToken",
        "access_token",
        "jwt",
        "id_token",
        "idToken",
        "authToken",
        "authorization",
      ]) {
        const hit = extractJwt(obj[k], depth + 1);
        if (hit) return hit;
      }
      for (const sub of ["state", "auth", "user", "session", "data"]) {
        if (obj[sub] && typeof obj[sub] === "object") {
          const hit = extractJwt(obj[sub], depth + 1);
          if (hit) return hit;
        }
      }
    }
    return null;
  };

  let authHeader = cachedAuthHeader;
  if (!authHeader) {
    try {
      for (const store of [window.localStorage, window.sessionStorage]) {
        if (!store) continue;
        for (let i = 0; i < store.length; i++) {
          const key = store.key(i);
          const val = key ? store.getItem(key) : null;
          if (!val) continue;
          const rawToken = extractJwt(val, 0);
          if (rawToken) {
            authHeader = `Bearer ${rawToken}`;
            break;
          }
        }
        if (authHeader) break;
      }
    } catch {}
  }

  if (authHeader && !authHeader.toLowerCase().startsWith("bearer ")) {
    authHeader = `Bearer ${authHeader}`;
  }

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json",
  };
  if (authHeader) {
    headers["Authorization"] = authHeader;
  }

  const parseDateMs = (raw: unknown): number | null => {
    if (raw === undefined || raw === null || raw === "") return null;
    if (typeof raw === "number") {
      if (!Number.isFinite(raw) || raw <= 0) return null;
      return raw < 1e11 ? raw * 1000 : raw;
    }
    const str = String(raw).trim();
    if (!str) return null;
    if (/^\d{10,13}(?:\.\d+)?$/.test(str)) {
      const num = Number(str);
      if (Number.isFinite(num) && num > 0) {
        return num < 1e11 ? num * 1000 : num;
      }
    }
    const ms = Date.parse(str);
    return Number.isNaN(ms) ? null : ms;
  };

  let activeEndpoint = gqlEndpoint;

  const classifyError = (status: number | undefined, msg: string): string => {
    if (status === 401 || /unauth|expired token|invalid token/i.test(msg)) {
      return "AUTH_EXPIRED";
    }
    if (
      status === 403 ||
      /permission|not authorized|access denied|forbidden/i.test(msg)
    ) {
      return "POS_PERMISSION_DENIED";
    }
    if (/tenant mismatch/i.test(msg)) return "TENANT_MISMATCH";
    if (/Cannot query field|Validation|Unknown type|Unknown argument/i.test(msg)) {
      return "GRAPHQL_SCHEMA_ERROR";
    }
    if (/timed out|timeout|AbortError|Failed to fetch/i.test(msg)) {
      return "NETWORK_TIMEOUT";
    }
    return "OUTBOUND_WRITEBACK_FAILED";
  };

  const runGql = async (query: string, variables?: Record<string, any>) => {
    const attempt = async (
      url: string,
      asBatch = preferBatchArray,
      allowBatchFlip = true,
    ): Promise<any> => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 15000);
      try {
        const bodyPayload = { query, variables };
        const res = await fetch(url, {
          method: "POST",
          credentials: "include",
          headers,
          signal: controller.signal,
          body: JSON.stringify(asBatch ? [bodyPayload] : bodyPayload),
        });
        const ct =
          (typeof res.headers?.get === "function"
            ? res.headers.get("content-type")
            : "") || "";
        if (!res.ok) {
          if (
            allowBatchFlip &&
            (res.status === 400 ||
              res.status === 415 ||
              res.status === 422 ||
              res.status === 500)
          ) {
            const batchRetry = await attempt(url, !asBatch, false);
            if (batchRetry.ok) return batchRetry;
          }
          const text = await res.text().catch(() => "");
          return {
            ok: false,
            status: res.status,
            error: `HTTP ${res.status}: ${text.slice(0, 220)}`,
          };
        }
        if (ct && !ct.toLowerCase().includes("json")) {
          return {
            ok: false,
            status: res.status,
            nonJson: true,
            error: `Non-JSON response (${ct})`,
          };
        }
        const parsed = await res.json();
        const json = Array.isArray(parsed) ? parsed[0] || {} : parsed;
        if (Array.isArray(json?.errors) && json.errors.length > 0) {
          const msg = json.errors.map((e: any) => e?.message || "").join("; ");
          return { ok: false, status: res.status, error: msg };
        }
        return { ok: true, status: res.status, data: json?.data };
      } catch (e: any) {
        return {
          ok: false,
          error:
            e?.name === "AbortError"
              ? "BandaGo GraphQL request timed out"
              : e?.message || "Network fetch failed",
        };
      } finally {
        clearTimeout(timer);
      }
    };

    let res = await attempt(activeEndpoint);
    if (!res.ok && (res.status === 404 || (res as any).nonJson)) {
      const alt = activeEndpoint.endsWith("/")
        ? activeEndpoint.slice(0, -1)
        : `${activeEndpoint}/`;
      const altRes = await attempt(alt);
      if (altRes.ok || altRes.status !== 404) {
        activeEndpoint = alt;
        res = altRes;
      }
    }
    return res;
  };

  // Resolve C_DocType for Physical Inventory (MMI / PI)
  let docTypeUU: string | null = null;
  const docTypeQuery = `
    query C_DocTypeGet($Filter: String, $Size: Int) {
      C_DocTypeGet(Filter: $Filter, Size: $Size) {
        Results { UU Name DocBaseType DocSubTypeInv }
      }
    }
  `;
  const dtRes = await runGql(docTypeQuery, {
    Filter: JSON.stringify({ docbasetype: "MMI" }),
    Size: 20,
  });
  if (!dtRes.ok && dtRes.status === 401) {
    return {
      results: [],
      fatalError: {
        code: "AUTH_EXPIRED",
        message: dtRes.error || "BandaGo authentication expired",
      },
    };
  }
  const dtList: any[] = dtRes.data?.C_DocTypeGet?.Results || [];
  const preferredDt =
    dtList.find(
      (d) =>
        d.DocBaseType === "MMI" &&
        (d.DocSubTypeInv === "PI" || /physical inventory/i.test(d.Name || "")),
    ) || dtList[0];
  docTypeUU = preferredDt?.UU || null;

  // Fallback warehouse + empty "---" ASI resolution
  const whRes = await runGql(
    `query M_WarehouseGet($Size: Int) { M_WarehouseGet(Size: $Size) { Results { UU Name AD_Org { UU } } } }`,
    { Size: 20 },
  );
  const warehouses: any[] = whRes.data?.M_WarehouseGet?.Results || [];
  const defaultWh = warehouses[0] || null;

  const asiRes = await runGql(
    `query M_AttributeSetInstanceGet($Filter: String, $Size: Int) { M_AttributeSetInstanceGet(Filter: $Filter, Size: $Size) { Results { UU Description } } }`,
    { Filter: JSON.stringify({ description: "---" }), Size: 5 },
  );
  const defaultAsiUU: string | null =
    asiRes.data?.M_AttributeSetInstanceGet?.Results?.[0]?.UU || null;

  const now = new Date();
  const movementDate = `${now.getFullYear()}/${String(now.getMonth() + 1).padStart(2, "0")}/${String(now.getDate()).padStart(2, "0")}`;

  const results: any[] = [];

  for (const job of jobs) {
    try {
      if (!job.externalPosId) {
        results.push({
          jobId: job.id,
          lockToken: job.lockToken,
          status: "FAILED",
          errorCode: "UNMAPPED_PRODUCT",
          errorMessage: `Missing externalPosId for ${job.productName}`,
        });
        continue;
      }

      // 1. Idempotency check on deterministic M_Inventory.UU
      if (job.externalInventoryUU) {
        const invCheck = await runGql(
          `query M_InventoryGet($Filter: String, $Size: Int) { M_InventoryGet(Filter: $Filter, Size: $Size) { Results { UU DocumentNo DocStatus } } }`,
          { Filter: JSON.stringify({ UU: job.externalInventoryUU }), Size: 1 },
        );
        const existingInv = invCheck.data?.M_InventoryGet?.Results?.[0];
        if (existingInv && existingInv.DocStatus === "CO") {
          results.push({
            jobId: job.id,
            lockToken: job.lockToken,
            status: "SYNCED",
            externalInventoryUU: existingInv.UU,
            externalDocumentNo: existingInv.DocumentNo || null,
          });
          continue;
        }
      }

      // 2. Fetch live storage rows for product
      const storageRes = await runGql(
        `query M_StorageOnHandGet($Filter: String, $Size: Int) {
          M_StorageOnHandGet(Filter: $Filter, Size: $Size) {
            Results {
              QtyOnHand
              AD_Client { UU }
              AD_Org { UU }
              M_Product { UU AD_Client { UU } }
              M_Locator { UU Value IsActive M_Warehouse { UU Name AD_Org { UU } } }
              M_AttributeSetInstance { UU Lot GuaranteeDate }
            }
          }
        }`,
        {
          Filter: JSON.stringify({ M_Product: { UU: job.externalPosId } }),
          Size: 200,
        },
      );

      if (!storageRes.ok) {
        const code = classifyError(storageRes.status, storageRes.error || "");
        results.push({
          jobId: job.id,
          lockToken: job.lockToken,
          status: "FAILED",
          errorCode: code,
          errorMessage: storageRes.error || "Failed loading product stock",
        });
        continue;
      }

      const storageRows: any[] =
        storageRes.data?.M_StorageOnHandGet?.Results || [];
      const rowTenantUU =
        storageRows[0]?.AD_Client?.UU ||
        storageRows[0]?.M_Product?.AD_Client?.UU ||
        null;
      if (expectedTenantUU && rowTenantUU && expectedTenantUU !== rowTenantUU) {
        results.push({
          jobId: job.id,
          lockToken: job.lockToken,
          status: "FAILED",
          errorCode: "TENANT_MISMATCH",
          errorMessage: `Tenant mismatch: expected ${expectedTenantUU}, got ${rowTenantUU}`,
        });
        continue;
      }

      // Filter sellable rows FEFO
      const sellable = storageRows
        .filter((r) => {
          const loc = r.M_Locator;
          if (!loc) return true;
          if (loc.IsActive === false || loc.IsActive === "N") return false;
          const label = [loc.Value, loc.M_Warehouse?.Name]
            .filter(Boolean)
            .join(" ");
          return !/\b(quarantine|expired|damaged|reject|return|waste)\b/i.test(
            label,
          );
        })
        .filter((r) => {
          const gd = r.M_AttributeSetInstance?.GuaranteeDate;
          if (gd === undefined || gd === null || gd === "") return true;
          const ms = parseDateMs(gd);
          return ms === null || ms >= Date.now();
        })
        .sort((a, b) => {
          const aExp =
            parseDateMs(a.M_AttributeSetInstance?.GuaranteeDate) ??
            Number.MAX_SAFE_INTEGER;
          const bExp =
            parseDateMs(b.M_AttributeSetInstance?.GuaranteeDate) ??
            Number.MAX_SAFE_INTEGER;
          return aExp - bExp;
        });

      const currentTotal = sellable.reduce(
        (sum, r) => sum + Math.max(0, Math.floor(Number(r.QtyOnHand) || 0)),
        0,
      );

      let desiredDelta = Math.trunc(job.qtyDelta);
      if (job.eventType === "ADMIN_STOCK_ADJUST" && job.targetStock !== null) {
        desiredDelta = Math.max(0, Math.floor(job.targetStock)) - currentTotal;
      }

      if (desiredDelta === 0) {
        results.push({
          jobId: job.id,
          lockToken: job.lockToken,
          status: "SYNCED",
          posStockAfter: currentTotal,
          externalInventoryUU: job.externalInventoryUU,
        });
        continue;
      }

      const firstRow = sellable[0] || storageRows[0];
      const whUU =
        job.externalWarehouseId ||
        firstRow?.M_Locator?.M_Warehouse?.UU ||
        defaultWh?.UU ||
        null;
      const orgUU =
        job.externalOrgId ||
        firstRow?.AD_Org?.UU ||
        firstRow?.M_Locator?.M_Warehouse?.AD_Org?.UU ||
        defaultWh?.AD_Org?.UU ||
        null;
      const fallbackLocUU =
        job.externalLocatorId || firstRow?.M_Locator?.UU || null;

      const lines: any[] = [];
      let warningCode: string | undefined;
      let warningMessage: string | undefined;
      let newTotalStock = currentTotal;

      if (desiredDelta < 0) {
        let remaining = Math.abs(desiredDelta);
        for (const row of sellable) {
          if (remaining <= 0) break;
          const qtyBook = Math.max(0, Math.floor(Number(row.QtyOnHand) || 0));
          const locUU = row.M_Locator?.UU || fallbackLocUU;
          const asiUU = row.M_AttributeSetInstance?.UU || defaultAsiUU;
          if (qtyBook <= 0 || !locUU || !asiUU) continue;
          const take = Math.min(qtyBook, remaining);
          lines.push({
            M_Product: { UU: job.externalPosId },
            M_Locator: { UU: locUU },
            M_AttributeSetInstance: { UU: asiUU },
            QtyBook: qtyBook,
            QtyCount: qtyBook - take,
          });
          remaining -= take;
        }
        const applied = Math.abs(desiredDelta) - remaining;
        newTotalStock = Math.max(0, currentTotal - applied);
        if (remaining > 0) {
          warningCode = "INSUFFICIENT_POS_STOCK";
          warningMessage = `BandaGo had ${currentTotal} sellable units for "${job.productName}" when deducting ${Math.abs(desiredDelta)}; clamped to ${newTotalStock}.`;
        }
      } else {
        const targetRow = sellable[0] || firstRow;
        const locUU = targetRow?.M_Locator?.UU || fallbackLocUU;
        const asiUU = targetRow?.M_AttributeSetInstance?.UU || defaultAsiUU;
        if (locUU && asiUU) {
          const qtyBook = Math.max(
            0,
            Math.floor(Number(targetRow?.QtyOnHand) || 0),
          );
          lines.push({
            M_Product: { UU: job.externalPosId },
            M_Locator: { UU: locUU },
            M_AttributeSetInstance: { UU: asiUU },
            QtyBook: qtyBook,
            QtyCount: qtyBook + desiredDelta,
          });
          newTotalStock = currentTotal + desiredDelta;
        }
      }

      if (lines.length === 0) {
        if (warningCode === "INSUFFICIENT_POS_STOCK") {
          results.push({
            jobId: job.id,
            lockToken: job.lockToken,
            status: "SYNCED",
            posStockAfter: 0,
            warningCode,
            warningMessage,
          });
        } else {
          results.push({
            jobId: job.id,
            lockToken: job.lockToken,
            status: "FAILED",
            errorCode: "OUTBOUND_WRITEBACK_FAILED",
            errorMessage: `Missing BandaGo locator or AttributeSetInstance ("---") for ${job.productName}`,
          });
        }
        continue;
      }

      if (!whUU || !docTypeUU) {
        results.push({
          jobId: job.id,
          lockToken: job.lockToken,
          status: "FAILED",
          errorCode: "OUTBOUND_WRITEBACK_FAILED",
          errorMessage:
            "Missing M_Warehouse or Physical Inventory C_DocType (MMI/PI) in BandaGo",
        });
        continue;
      }

      // 3. Save M_Inventory header
      const invHeaderInput: Record<string, any> = {
        ...(job.externalInventoryUU ? { UU: job.externalInventoryUU } : {}),
        M_Warehouse: { UU: whUU },
        C_DocType: { UU: docTypeUU },
        MovementDate: movementDate,
        Description: `Sphere Sync ${job.orderReference || job.eventType}: ${job.productName}`,
        ...(orgUU ? { AD_Org: { UU: orgUU } } : {}),
      };

      const saveHeaderRes = await runGql(
        `mutation M_InventorySave($Entity: M_InventoryInput!) {
          M_InventorySave(Entity: $Entity) { UU DocumentNo DocStatus }
        }`,
        { Entity: invHeaderInput },
      );

      if (!saveHeaderRes.ok || !saveHeaderRes.data?.M_InventorySave?.UU) {
        const msg = saveHeaderRes.error || "M_InventorySave failed";
        results.push({
          jobId: job.id,
          lockToken: job.lockToken,
          status: "FAILED",
          errorCode: classifyError(saveHeaderRes.status, msg),
          errorMessage: msg,
        });
        continue;
      }

      const invUU = saveHeaderRes.data.M_InventorySave.UU;
      const docNo = saveHeaderRes.data.M_InventorySave.DocumentNo || null;

      // 4. Save inventory lines (prefer M_InventoryLineSaveMany, fallback per line)
      const lineEntities = lines.map((line) => ({
        ...line,
        M_Inventory: { UU: invUU },
        ...(orgUU ? { AD_Org: { UU: orgUU } } : {}),
      }));

      let linesSavedOk = false;
      let linesErr = "";
      let linesErrStatus: number | undefined;

      const manyRes = await runGql(
        `mutation M_InventoryLineSaveMany($Entities: [M_InventoryLineInput!]!) {
          M_InventoryLineSaveMany(Entities: $Entities) { UU }
        }`,
        { Entities: lineEntities },
      );
      if (manyRes.ok) {
        linesSavedOk = true;
      } else {
        let fallbackOk = true;
        for (const entity of lineEntities) {
          const singleRes = await runGql(
            `mutation M_InventoryLineSave($Entity: M_InventoryLineInput!) {
              M_InventoryLineSave(Entity: $Entity) { UU }
            }`,
            { Entity: entity },
          );
          if (!singleRes.ok) {
            fallbackOk = false;
            linesErr = singleRes.error || manyRes.error || "Line save failed";
            linesErrStatus = singleRes.status;
            break;
          }
        }
        linesSavedOk = fallbackOk;
      }

      if (!linesSavedOk) {
        results.push({
          jobId: job.id,
          lockToken: job.lockToken,
          status: "FAILED",
          errorCode: classifyError(linesErrStatus, linesErr),
          errorMessage: linesErr,
        });
        continue;
      }

      // 5. Complete Physical Inventory Document ("CO")
      const processRes = await runGql(
        `mutation M_InventoryProcess($UU: ID!, $DocumentAction: String!) {
          M_InventoryProcess(UU: $UU, DocumentAction: $DocumentAction) { UU DocumentNo DocStatus }
        }`,
        { UU: invUU, DocumentAction: "CO" },
      );

      if (!processRes.ok) {
        const msg = processRes.error || "M_InventoryProcess(CO) failed";
        results.push({
          jobId: job.id,
          lockToken: job.lockToken,
          status: "FAILED",
          errorCode: classifyError(processRes.status, msg),
          errorMessage: msg,
        });
        continue;
      }

      results.push({
        jobId: job.id,
        lockToken: job.lockToken,
        status: "SYNCED",
        externalInventoryUU: invUU,
        externalDocumentNo:
          processRes.data?.M_InventoryProcess?.DocumentNo || docNo,
        posStockAfter: newTotalStock,
        ...(warningCode ? { warningCode, warningMessage } : {}),
      });
    } catch (err: any) {
      results.push({
        jobId: job.id,
        lockToken: job.lockToken,
        status: "FAILED",
        errorCode: "OUTBOUND_WRITEBACK_FAILED",
        errorMessage: err?.message || "Unexpected error processing job",
      });
    }
  }

  return { results };
}
