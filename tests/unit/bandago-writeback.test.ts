import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  formatBandaGoDate,
  planInventoryAdjustmentLines,
  BandaGoWritebackEngine,
} from "../../src/background/bandago-writeback";
import { SphereSyncClient } from "../../src/sync/sphere-client";

describe("BandaGoWritebackEngine & Physical Inventory Planner", () => {
  const origFetch = global.fetch;

  beforeEach(() => {
    (global as any).chrome = {
      storage: {
        local: {
          store: {} as Record<string, any>,
          get: vi.fn(async (keys: string[]) => {
            const res: Record<string, any> = {};
            for (const k of keys) {
              if (k in (global as any).chrome.storage.local.store) {
                res[k] = (global as any).chrome.storage.local.store[k];
              }
            }
            return res;
          }),
          set: vi.fn(async (items: Record<string, any>) => {
            Object.assign((global as any).chrome.storage.local.store, items);
          }),
        },
      },
      tabs: {
        query: vi.fn(),
      },
      scripting: {
        executeScript: vi.fn(),
      },
      alarms: {
        onAlarm: { addListener: vi.fn() },
        get: vi.fn(),
        create: vi.fn(),
      },
    };
  });

  afterEach(() => {
    global.fetch = origFetch;
    vi.restoreAllMocks();
  });

  it("formats dates in BandaGo iDempiere YYYY/MM/DD format", () => {
    const formatted = formatBandaGoDate(new Date(2026, 10, 5));
    expect(formatted).toBe("2026/11/05");
  });

  it("plans FEFO lot deductions while skipping expired and quarantine locators", () => {
    const pastIso = new Date(Date.now() - 86400_000 * 10).toISOString();
    const soonIso = new Date(Date.now() + 86400_000 * 20).toISOString();
    const laterIso = new Date(Date.now() + 86400_000 * 120).toISOString();

    const plan = planInventoryAdjustmentLines({
      job: {
        externalPosId: "prod-uu-1",
        productName: "Amoxicillin 500mg",
        eventType: "ONLINE_SALE",
        qtyDelta: -7,
        targetStock: null,
        externalLocatorId: null,
        externalWarehouseId: null,
        externalOrgId: null,
      },
      storageRows: [
        {
          QtyOnHand: 50,
          M_Locator: { UU: "loc-q", Value: "Quarantine Damaged" },
          M_AttributeSetInstance: { UU: "asi-q", GuaranteeDate: laterIso },
        },
        {
          QtyOnHand: 20,
          M_Locator: { UU: "loc-exp", Value: "Main Shelf" },
          M_AttributeSetInstance: { UU: "asi-exp", GuaranteeDate: pastIso },
        },
        {
          QtyOnHand: 4,
          M_Locator: { UU: "loc-main", Value: "Dispensary", M_Warehouse: { UU: "wh-1" } },
          M_AttributeSetInstance: { UU: "asi-soon", GuaranteeDate: soonIso },
        },
        {
          QtyOnHand: 10,
          M_Locator: { UU: "loc-main", Value: "Dispensary", M_Warehouse: { UU: "wh-1" } },
          M_AttributeSetInstance: { UU: "asi-later", GuaranteeDate: laterIso },
        },
      ],
    });

    expect(plan.warningCode).toBeUndefined();
    expect(plan.deltaApplied).toBe(-7);
    expect(plan.newTotalStock).toBe(7); // 14 sellable - 7
    expect(plan.lines).toHaveLength(2);
    // Soonest expiry lot consumed completely (4 -> 0), next consumes 3 (10 -> 7)
    expect(plan.lines[0]).toMatchObject({
      M_AttributeSetInstance: { UU: "asi-soon" },
      QtyBook: 4,
      QtyCount: 0,
    });
    expect(plan.lines[1]).toMatchObject({
      M_AttributeSetInstance: { UU: "asi-later" },
      QtyBook: 10,
      QtyCount: 7,
    });
  });

  it("clamps deduction cleanly and emits INSUFFICIENT_POS_STOCK when POS has fewer sellable units", () => {
    const futureIso = new Date(Date.now() + 86400_000 * 60).toISOString();
    const plan = planInventoryAdjustmentLines({
      job: {
        externalPosId: "prod-uu-2",
        productName: "Paracetamol 500mg",
        eventType: "ONLINE_SALE",
        qtyDelta: -10,
        targetStock: null,
        externalLocatorId: null,
        externalWarehouseId: null,
        externalOrgId: null,
      },
      storageRows: [
        {
          QtyOnHand: 3,
          M_Locator: { UU: "loc-1", M_Warehouse: { UU: "wh-1" } },
          M_AttributeSetInstance: { UU: "asi-1", GuaranteeDate: futureIso },
        },
      ],
    });

    expect(plan.deltaApplied).toBe(-3);
    expect(plan.newTotalStock).toBe(0);
    expect(plan.warningCode).toBe("INSUFFICIENT_POS_STOCK");
    expect(plan.lines[0]).toMatchObject({ QtyBook: 3, QtyCount: 0 });
  });

  it("handles ADMIN_STOCK_ADJUST target stock matching and REFUND_RESTOCK additions", () => {
    const futureIso = new Date(Date.now() + 86400_000 * 60).toISOString();

    const matched = planInventoryAdjustmentLines({
      job: {
        externalPosId: "prod-uu-3",
        productName: "Cetirizine 10mg",
        eventType: "ADMIN_STOCK_ADJUST",
        qtyDelta: 0,
        targetStock: 12,
        externalLocatorId: null,
        externalWarehouseId: null,
        externalOrgId: null,
      },
      storageRows: [
        {
          QtyOnHand: 12,
          M_Locator: { UU: "loc-1", M_Warehouse: { UU: "wh-1" } },
          M_AttributeSetInstance: { UU: "asi-1", GuaranteeDate: futureIso },
        },
      ],
    });
    expect(matched.alreadyMatched).toBe(true);
    expect(matched.lines).toHaveLength(0);

    const restocked = planInventoryAdjustmentLines({
      job: {
        externalPosId: "prod-uu-3",
        productName: "Cetirizine 10mg",
        eventType: "REFUND_RESTOCK",
        qtyDelta: 4,
        targetStock: null,
        externalLocatorId: "loc-default",
        externalWarehouseId: "wh-default",
        externalOrgId: null,
      },
      storageRows: [],
      fallbackAsiUU: "asi-empty",
    });
    expect(restocked.deltaApplied).toBe(4);
    expect(restocked.lines).toHaveLength(1);
    expect(restocked.lines[0]).toMatchObject({
      M_Locator: { UU: "loc-default" },
      M_AttributeSetInstance: { UU: "asi-empty" },
      QtyBook: 0,
      QtyCount: 4,
    });
  });

  it("releases claimed outbound jobs cleanly via /outbound/ack when no BandaGo tab is open", async () => {
    vi.spyOn(SphereSyncClient, "getConfig").mockResolvedValue({
      endpointUrl: "https://pharmacy.example/api/integrations/bandago/sync",
      apiKey: "secret-key",
      enabled: true,
      allowOutboundWriteback: true,
    });
    vi.spyOn(SphereSyncClient, "reportTelemetry").mockResolvedValue({ ok: true });

    (chrome.tabs.query as any).mockResolvedValue([]);

    const postedBodies: Array<{ url: string; body: any }> = [];
    global.fetch = vi.fn().mockImplementation(async (url: string, opts?: any) => {
      if (url.includes("/outbound/ack")) {
        postedBodies.push({ url, body: JSON.parse(opts.body) });
        return { ok: true, status: 200, json: async () => ({ ok: true }) };
      }
      if (url.includes("/outbound?claim=1")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            policy: { outboundSyncMode: "AUTO_SYNC" },
            jobs: [
              {
                id: "job-1",
                lockToken: "tok-1",
                productName: "Azithromycin 500mg",
                externalPosId: "uu-azi",
                eventType: "ONLINE_SALE",
                qtyDelta: -2,
                targetStock: null,
              },
            ],
          }),
        };
      }
      return { ok: true, status: 200, json: async () => ({ ok: true }) };
    });

    const result = await BandaGoWritebackEngine.syncOutboundNow({ trigger: "MANUAL" });
    expect(result.ok).toBe(false);
    expect(result.released).toBe(1);
    expect(postedBodies).toHaveLength(1);
    expect(postedBodies[0].body.results[0]).toMatchObject({
      jobId: "job-1",
      lockToken: "tok-1",
      status: "RELEASE",
      warningCode: "NO_POS_TAB",
    });
  });

  it("respects MANUAL_EXPORT policy and performs full writeback flow on AUTO_SYNC when tab succeeds", async () => {
    vi.spyOn(SphereSyncClient, "getConfig").mockResolvedValue({
      endpointUrl: "https://pharmacy.example/api/integrations/bandago/sync",
      apiKey: "secret-key",
      enabled: true,
      allowOutboundWriteback: true,
    });
    vi.spyOn(SphereSyncClient, "reportTelemetry").mockResolvedValue({ ok: true });

    // 1. MANUAL_EXPORT does not touch Chrome tabs
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        policy: { outboundSyncMode: "MANUAL_EXPORT" },
        jobs: [],
      }),
    });
    const manualRes = await BandaGoWritebackEngine.syncOutboundNow();
    expect(manualRes.ok).toBe(true);
    expect(manualRes.mode).toBe("MANUAL_EXPORT");
    expect(chrome.tabs.query).not.toHaveBeenCalled();

    // 2. AUTO_SYNC executes writeback script in tab and posts SYNCED ack
    (chrome.tabs.query as any).mockResolvedValue([
      { id: 99, url: "https://go.bandahealth.org/inventory" },
    ]);
    (chrome.scripting.executeScript as any).mockResolvedValue([
      {
        result: {
          results: [
            {
              jobId: "job-9",
              lockToken: "tok-9",
              status: "SYNCED",
              externalDocumentNo: "PI-2026-0042",
              externalInventoryUU: "inv-uu-9",
              posStockAfter: 18,
            },
          ],
        },
      },
    ]);

    const ackCalls: any[] = [];
    global.fetch = vi.fn().mockImplementation(async (url: string, opts?: any) => {
      if (url.includes("/outbound/ack")) {
        ackCalls.push(JSON.parse(opts.body));
        return { ok: true, status: 200, json: async () => ({ ok: true }) };
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({
          policy: { outboundSyncMode: "AUTO_SYNC", outboundPollIntervalMinutes: 2 },
          jobs: [
            {
              id: "job-9",
              lockToken: "tok-9",
              externalPosId: "prod-uu-9",
              productName: "Metformin 500mg",
              eventType: "ONLINE_SALE",
              qtyDelta: -2,
              targetStock: null,
            },
          ],
        }),
      };
    });

    const autoRes = await BandaGoWritebackEngine.syncOutboundNow({ trigger: "MANUAL" });
    expect(autoRes.ok).toBe(true);
    expect(autoRes.synced).toBe(1);
    expect(ackCalls).toHaveLength(1);
    expect(ackCalls[0].results[0].externalDocumentNo).toBe("PI-2026-0042");
  });
});
