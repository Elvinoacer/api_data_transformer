import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";
import ts from "typescript";
import { checkResponseEligibility } from "../../src/privacy/source-policy";
import {
  extractItemsByPath,
  inferBestIdentityKey,
  inferBestRecordPath,
} from "../../src/extraction/path-selector";
import {
  detectPaginationFromResponse,
  mergePaginationState,
} from "../../src/extraction/pagination-detector";
import { inferDatasetLabel } from "../../src/extraction/label-inference";
import {
  BandaGoNormalizer,
  parseFlexibleTimestampMs,
} from "../../src/extraction/bandago-normalizer";
import { BandaGoActivePoller } from "../../src/background/bandago-poller";
import { BandaGoWritebackEngine } from "../../src/background/bandago-writeback";
import { SphereSyncClient } from "../../src/sync/sphere-client";
import { SyncQueueManager } from "../../src/sync/sync-queue";

const LIVE_PRODUCTS_15 = [
  {
    bh_reorder_level: 0,
    bh_reorder_quantity: 0,
    BH_SellPrice: 100,
    Created: 1794937529484,
    IsActive: true,
    KnhtsConcept: null,
    LastPurchasePrice: 32.25,
    Name: "EFLARON SUSP 60ML",
    TotalQuantity: 7.0,
    UU: "17b2790a-e3ef-4606-bbbc-430df706af6b",
    __typename: "M_Product",
  },
  {
    bh_reorder_level: 0,
    bh_reorder_quantity: 0,
    BH_SellPrice: 3500,
    Created: 1794937053054,
    IsActive: true,
    KnhtsConcept: null,
    LastPurchasePrice: 2360,
    Name: "CALMID EXTRA 30'S TABS ",
    TotalQuantity: 1.0,
    UU: "db9943b1-796c-4cc7-a727-04411a8435ef",
    __typename: "M_Product",
  },
  {
    bh_reorder_level: 0,
    bh_reorder_quantity: 0,
    BH_SellPrice: 350,
    Created: 1794853514107,
    IsActive: true,
    KnhtsConcept: null,
    LastPurchasePrice: 135,
    Name: "KISS LUBRICATING GEL 50ML",
    TotalQuantity: 5.0,
    UU: "9af75d78-b7c6-4546-8171-a1b0237b8557",
    __typename: "M_Product",
  },
  {
    bh_reorder_level: 0,
    bh_reorder_quantity: 0,
    BH_SellPrice: 349,
    Created: 1794504135981,
    IsActive: true,
    KnhtsConcept: null,
    LastPurchasePrice: 117,
    Name: "AL-BEL DRY SYP 60ML",
    TotalQuantity: 3.0,
    UU: "5bd674ca-eadf-4c9d-8571-4432f06932ff",
    __typename: "M_Product",
  },
  {
    bh_reorder_level: 0,
    bh_reorder_quantity: 0,
    BH_SellPrice: 80,
    Created: 1794500643247,
    IsActive: true,
    KnhtsConcept: null,
    LastPurchasePrice: 36.416666666666664,
    Name: "ISLIM 400MG CAPS 30'S ",
    TotalQuantity: 30.0,
    UU: "3987b147-9b6f-4db1-a068-b9b62a550891",
    __typename: "M_Product",
  },
  {
    bh_reorder_level: 0,
    bh_reorder_quantity: 0,
    BH_SellPrice: 100,
    Created: 1794498639363,
    IsActive: true,
    KnhtsConcept: null,
    LastPurchasePrice: 38,
    Name: "DAZOLE B CREAM 20G ",
    TotalQuantity: 6.0,
    UU: "3add5d76-4744-4d75-b6f9-5491d896d54b",
    __typename: "M_Product",
  },
  {
    bh_reorder_level: 0,
    bh_reorder_quantity: 0,
    BH_SellPrice: 3500,
    Created: 1794384256522,
    IsActive: true,
    KnhtsConcept: null,
    LastPurchasePrice: 1890,
    Name: "FERTILION F CAPS 30'S",
    TotalQuantity: 1.0,
    UU: "1f081a52-fb24-4236-8255-db6dd45cdf4a",
    __typename: "M_Product",
  },
  {
    bh_reorder_level: 0,
    bh_reorder_quantity: 0,
    BH_SellPrice: 500,
    Created: 1793953517050,
    IsActive: true,
    KnhtsConcept: null,
    LastPurchasePrice: 130,
    Name: "MIDAZOLAM 15MG INJ 1'S DDA",
    TotalQuantity: 10.0,
    UU: "601f943b-bfa9-47c5-9013-082dcc5ba13e",
    __typename: "M_Product",
  },
  {
    bh_reorder_level: 0,
    bh_reorder_quantity: 0,
    BH_SellPrice: 100,
    Created: 1793950648067,
    IsActive: true,
    KnhtsConcept: null,
    LastPurchasePrice: 0.1,
    Name: "MENTHOPLUS STRONG BALN JAR 9G",
    TotalQuantity: 1.0,
    UU: "b18f9a76-cb21-4bda-8252-9c55a772fa7d",
    __typename: "M_Product",
  },
  {
    bh_reorder_level: 0,
    bh_reorder_quantity: 0,
    BH_SellPrice: 350,
    Created: 1793768550963,
    IsActive: true,
    KnhtsConcept: null,
    LastPurchasePrice: 196,
    Name: "PHILCOLIN DM 100ML",
    TotalQuantity: 4.0,
    UU: "9416aca0-1b53-443e-aa83-bc687d062dbc",
    __typename: "M_Product",
  },
  {
    bh_reorder_level: 0,
    bh_reorder_quantity: 0,
    BH_SellPrice: 300,
    Created: 1793767810112,
    IsActive: true,
    KnhtsConcept: null,
    LastPurchasePrice: 144.5,
    Name: "AXE OIL 5ML",
    TotalQuantity: 3.0,
    UU: "d1f51853-6918-4823-94e7-d0133700a238",
    __typename: "M_Product",
  },
  {
    bh_reorder_level: 0,
    bh_reorder_quantity: 0,
    BH_SellPrice: 596,
    Created: 1793176358661,
    IsActive: true,
    KnhtsConcept: null,
    LastPurchasePrice: 149,
    Name: "VITHIOL PROMETHAZINE 125ML",
    TotalQuantity: 4.0,
    UU: "1853a818-854d-401c-b10e-024ca77ee2f3",
    __typename: "M_Product",
  },
  {
    bh_reorder_level: 0,
    bh_reorder_quantity: 0,
    BH_SellPrice: 250,
    Created: 1793176225670,
    IsActive: true,
    KnhtsConcept: null,
    LastPurchasePrice: 65,
    Name: "SHALTOUX 4 WAY  100ML SYRUP",
    TotalQuantity: 5.0,
    UU: "ef925546-cc0e-438a-b152-a271a7ae7d8b",
    __typename: "M_Product",
  },
  {
    bh_reorder_level: 0,
    bh_reorder_quantity: 0,
    BH_SellPrice: 650,
    Created: 1793175572217,
    IsActive: true,
    KnhtsConcept: null,
    LastPurchasePrice: 199,
    Name: "MIXICLAV 1G TABS 10'S",
    TotalQuantity: 10.0,
    UU: "89496e41-20a0-4eed-9af8-b63b16611ed9",
    __typename: "M_Product",
  },
  {
    bh_reorder_level: 0,
    bh_reorder_quantity: 0,
    BH_SellPrice: 450,
    Created: 1793173349658,
    IsActive: true,
    KnhtsConcept: null,
    LastPurchasePrice: 114.75,
    Name: "FUNBACT POWDER 50G",
    TotalQuantity: 3.0,
    UU: "e8f9fdda-9e99-4570-92b5-854d8013e89f",
    __typename: "M_Product",
  },
];

const LIVE_PRODUCT_ENVELOPE = {
  data: {
    M_ProductGet: {
      PagingInfo: {
        Page: 0,
        PageSize: 15,
        TotalCount: 1349,
        TotalPages: 90,
        __typename: "PagingInfo",
      },
      Results: LIVE_PRODUCTS_15,
      __typename: "M_ProductConnection",
    },
  },
};

const LIVE_APOLLO_BATCH_RESPONSE = [
  {
    data: {
      C_LocationGet: {
        Results: [{ UU: "loc-1", City: "Nairobi" }],
      },
    },
  },
  {
    data: {
      M_Product_CategoryGet: {
        Results: [
          { Name: "Pharmacy", UU: "cat-1", __typename: "M_Product_Category" },
        ],
      },
    },
  },
  LIVE_PRODUCT_ENVELOPE,
];

describe("Live Banda Health (go.bandahealth.org) End-to-End Capture & Sync", () => {
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
        session: {
          get: vi.fn(async () => ({})),
          set: vi.fn(async () => {}),
        },
      },
      tabs: { query: vi.fn() },
      scripting: { executeScript: vi.fn() },
      alarms: {
        onAlarm: { addListener: vi.fn() },
        get: vi.fn((_n: string, cb: (a: any) => void) => cb(null)),
        create: vi.fn(),
      },
    };
  });

  afterEach(() => {
    global.fetch = origFetch;
    vi.restoreAllMocks();
  });

  it("excludes static i18n/version JSON while allowing live Banda GraphQL", () => {
    expect(
      checkResponseEligibility({
        url: "https://go.bandahealth.org/translation.json?v=e556d2b",
        mimeType: "application/json",
        resourceType: "Fetch",
        allowedHostnames: ["go.bandahealth.org"],
        scopeMode: "all_tab_apis",
      }).isEligible,
    ).toBe(false);

    expect(
      checkResponseEligibility({
        url: "https://go.bandahealth.org/version.json?v=1795331327748",
        mimeType: "application/json",
        resourceType: "Fetch",
        allowedHostnames: ["go.bandahealth.org"],
        scopeMode: "all_tab_apis",
      }).isEligible,
    ).toBe(false);

    expect(
      checkResponseEligibility({
        url: "https://go.bandahealth.org/graphql/",
        mimeType: "application/json",
        resourceType: "Fetch",
        allowedHostnames: ["go.bandahealth.org"],
        scopeMode: "all_tab_apis",
      }).isEligible,
    ).toBe(true);
  });

  it("extracts data.M_ProductGet.Results with UU key, clean label, and 0-indexed PagingInfo", () => {
    const bestPath = inferBestRecordPath(LIVE_PRODUCT_ENVELOPE);
    expect(bestPath).toBe("data.M_ProductGet.Results");

    const items = extractItemsByPath(LIVE_PRODUCT_ENVELOPE, bestPath);
    expect(items).toHaveLength(15);
    expect(inferBestIdentityKey(items)).toBe("UU");

    expect(
      inferDatasetLabel({
        url: "https://go.bandahealth.org/graphql/",
        operationName: "M_ProductGet",
        recordPath: bestPath,
      }),
    ).toBe("BandaGo Products");

    const pag = detectPaginationFromResponse({
      url: "https://go.bandahealth.org/graphql/",
      parsedBody: LIVE_PRODUCT_ENVELOPE,
      extractedCount: items.length,
    });
    expect(pag.strategy).toBe("page");
    expect(pag.currentPage).toBe(1);
    expect(pag.pageSize).toBe(15);
    expect(pag.totalPages).toBe(90);
    expect(pag.totalRecords).toBe(1349);
    expect(pag.hasNextPage).toBe(true);

    // Count-only query must not overwrite existing list pagination
    const state = mergePaginationState(
      undefined,
      pag,
      "https://go.bandahealth.org/graphql/",
    );
    const countOnlyDetected = detectPaginationFromResponse({
      url: "https://go.bandahealth.org/graphql/",
      parsedBody: {
        data: {
          M_ProductGet: {
            PagingInfo: { TotalCount: 24, __typename: "PagingInfo" },
            __typename: "M_ProductConnection",
          },
        },
      },
      extractedCount: 0,
    });
    const mergedState = mergePaginationState(
      state,
      countOnlyDetected,
      "https://go.bandahealth.org/graphql/",
    );
    expect(mergedState?.totalRecords).toBe(1349);
    expect(mergedState?.totalPages).toBe(90);
  });

  it("normalizes all 15 live BandaGo drugs accurately including DDA, epoch ms dates, whitespace & rounding", () => {
    const normalized =
      BandaGoNormalizer.extractProductsFromPayload(LIVE_APOLLO_BATCH_RESPONSE);
    expect(normalized).toHaveLength(15);

    const byName = new Map(normalized.map((p) => [p.name, p]));

    const midazolam = byName.get("MIDAZOLAM 15MG INJ 1'S DDA");
    expect(midazolam?.requiresPrescription).toBe(true);
    expect(midazolam?.categorySlug).toBe("prescription");
    expect(midazolam?.dosageForm).toBe("inj");
    expect(midazolam?.packSize).toBe("1'S");

    const mixiclav = byName.get("MIXICLAV 1G TABS 10'S");
    expect(mixiclav?.requiresPrescription).toBe(true);
    expect(mixiclav?.packSize).toBe("10'S");

    const eflaron = byName.get("EFLARON SUSP 60ML");
    expect(eflaron?.requiresPrescription).toBe(true);
    expect(eflaron?.dosageForm).toBe("susp");
    expect(eflaron?.packSize).toBe("60ML");

    expect(byName.get("DAZOLE B CREAM 20G")?.requiresPrescription).toBe(true);
    expect(byName.get("FUNBACT POWDER 50G")?.requiresPrescription).toBe(true);
    expect(byName.get("VITHIOL PROMETHAZINE 125ML")?.requiresPrescription).toBe(true);

    const shaltoux = byName.get("SHALTOUX 4 WAY 100ML SYRUP");
    expect(shaltoux).toBeDefined();
    expect(shaltoux?.price).toBe(250);
    expect(shaltoux?.costPrice).toBe(65);
    expect(shaltoux?.stock).toBe(5);

    const islim = byName.get("ISLIM 400MG CAPS 30'S");
    expect(islim).toBeDefined();
    expect(islim?.costPrice).toBe(36.42);
    expect(islim?.packSize).toBe("30'S");
    expect(islim?.reorderLevel).toBe(0);
    expect(islim?.reorderQuantity).toBe(0);

    const kiss = byName.get("KISS LUBRICATING GEL 50ML");
    expect(kiss?.categorySlug).toBe("sexual-health");
    expect(kiss?.requiresPrescription).toBe(false);

    // Epoch millisecond parsing
    expect(parseFlexibleTimestampMs(1796072399000)).toBe(1796072399000);
    expect(parseFlexibleTimestampMs("1796072399000")).toBe(1796072399000);
  });

  it("passive main-interceptor intercepts Apollo batched catalog arrays, skips count-only, and drops BH_IDSR_CaseGet PHI", async () => {
    const tsCode = readFileSync(
      resolve(__dirname, "../../src/content/main-interceptor.ts"),
      "utf8",
    );
    const compiled = ts.transpileModule(tsCode, {
      compilerOptions: {
        module: ts.ModuleKind.None,
        target: ts.ScriptTarget.ES2020,
      },
    }).outputText;

    const posted: Array<{ message: any; origin: string }> = [];
    const customEvents: any[] = [];
    const mockFetch = vi.fn().mockImplementation(async (_url: any, init: any) => {
      const reqParsed = JSON.parse(String(init.body));
      if (Array.isArray(reqParsed) && reqParsed[0]?.operationName === "CountOnly") {
        return {
          ok: true,
          status: 200,
          clone: () => ({
            json: async () => [
              {
                data: {
                  M_ProductGet: { PagingInfo: { TotalCount: 24 } },
                },
              },
            ],
          }),
        };
      }
      if (Array.isArray(reqParsed) && reqParsed[0]?.operationName === "BH_IDSR_CaseGet") {
        return {
          ok: true,
          status: 200,
          clone: () => ({
            json: async () => [
              {
                data: {
                  BH_IDSR_CaseGet: {
                    Results: [{ C_BPartner: { Name: "PATIENT PHI" } }],
                  },
                },
              },
            ],
          }),
        };
      }
      return {
        ok: true,
        status: 200,
        clone: () => ({
          json: async () => LIVE_APOLLO_BATCH_RESPONSE,
        }),
      };
    });

    const mockWindow: Record<string, any> = {
      location: { origin: "https://go.bandahealth.org" },
      fetch: mockFetch,
      postMessage: (message: any, origin: string) => {
        posted.push({ message, origin });
      },
      XMLHttpRequest: undefined,
    };
    const mockDocument = {
      dispatchEvent: (ev: any) => {
        customEvents.push(ev);
        return true;
      },
    };

    const runner = new Function("window", "document", "Request", compiled);
    runner(mockWindow, mockDocument, class MockRequest {});

    // 1. Batched mixed request containing M_ProductGet
    await mockWindow.fetch("graphql/", {
      method: "POST",
      body: JSON.stringify([
        { operationName: "C_LocationGet", query: "query C_LocationGet { C_LocationGet { Results { UU } } }" },
        { operationName: "M_Product_CategoryGet", query: "query M_Product_CategoryGet { M_Product_CategoryGet { Results { Name } } }" },
        { operationName: "M_ProductGet", query: "query M_ProductGet { M_ProductGet { Results { UU Name } } }" },
      ]),
    });

    // 2. Count-only batch (must NOT post)
    await mockWindow.fetch("graphql/", {
      method: "POST",
      body: JSON.stringify([
        { operationName: "CountOnly", query: "query CountOnly { M_ProductGet { PagingInfo { TotalCount } } }" },
      ]),
    });

    // 3. PHI batch (must NOT post)
    await mockWindow.fetch("graphql/", {
      method: "POST",
      body: JSON.stringify([
        { operationName: "BH_IDSR_CaseGet", query: "query BH_IDSR_CaseGet { BH_IDSR_CaseGet { Results { UU } } }" },
      ]),
    });

    await new Promise((r) => setTimeout(r, 15));

    expect(posted).toHaveLength(1);
    expect(posted[0].message.type).toBe("BANDAGO_PASSIVE_CATALOG");
    expect(posted[0].message.payload.data.M_ProductGet.Results).toHaveLength(15);
    expect(posted[0].message.payload.data.C_LocationGet).toBeUndefined();
    expect(customEvents.length).toBeGreaterThanOrEqual(1);
    expect(customEvents[0].detail.endpointUrl).toBe(
      "https://go.bandahealth.org/graphql/",
    );
    expect(customEvents[0].detail.usesBatchArray).toBe(true);
  });

  it("in-tab poller unwraps Apollo array responses and falls back to Tier-3 minimal proven-live query", async () => {
    vi.spyOn(SphereSyncClient, "getConfig").mockResolvedValue({
      endpointUrl: "https://test/sync",
      apiKey: "key",
      enabled: true,
    });
    (chrome.tabs.query as any).mockResolvedValue([
      { id: 42, url: "https://go.bandahealth.org/products", active: true },
    ]);

    let passedFunc: any = null;
    let passedArgs: any[] = [];
    (chrome.scripting.executeScript as any).mockImplementation(async (opts: any) => {
      passedFunc = opts.func;
      passedArgs = opts.args;
      return [{ result: { data: {} } }];
    });

    await BandaGoActivePoller.pollActiveTabs();

    let productQueryCalls = 0;
    global.fetch = vi.fn().mockImplementation(async (_url: string, opts: any) => {
      const body = JSON.parse(opts.body);
      if (body.operationName === "M_StorageOnHandForInventoryList") {
        return {
          ok: true,
          status: 200,
          json: async () => [
            { errors: [{ message: "Cannot query field M_StorageOnHandGet" }] },
          ],
        };
      }
      productQueryCalls++;
      if (productQueryCalls <= 2) {
        // Tier 1 & Tier 2 fail with subfield validation error on older schema
        return {
          ok: true,
          status: 200,
          json: async () => [
            { errors: [{ message: "Cannot query field 'BH_PriceMargin' on type 'M_Product'" }] },
          ],
        };
      }
      // Tier 3 minimal proven-live succeeds with Apollo array response
      return {
        ok: true,
        status: 200,
        json: async () => [
          {
            data: {
              M_ProductGet: {
                PagingInfo: {
                  Page: 0,
                  PageSize: 15,
                  TotalCount: 15,
                  TotalPages: 1,
                },
                Results: [...LIVE_PRODUCTS_15],
              },
            },
          },
        ],
      };
    });

    const result = await passedFunc(
      passedArgs[0],
      passedArgs[1],
      passedArgs[2],
      passedArgs[3],
      "Bearer live-token",
    );

    expect(productQueryCalls).toBe(3);
    expect(result.data.M_ProductGet.Results).toHaveLength(15);
  });

  it("in-tab writeback handles Unix epoch ms GuaranteeDate for expiry filtering and FEFO sorting", async () => {
    vi.spyOn(SphereSyncClient, "getConfig").mockResolvedValue({
      endpointUrl: "https://test/sync",
      apiKey: "key",
      enabled: true,
      allowOutboundWriteback: true,
    });
    vi.spyOn(SphereSyncClient, "reportTelemetry").mockResolvedValue({ ok: true });
    vi.spyOn(SphereSyncClient, "saveServerPolicy").mockResolvedValue({});
    vi.spyOn(SphereSyncClient, "saveOutboundStatus").mockResolvedValue({
      lastRunAt: new Date().toISOString(),
      ok: true,
      message: "ok",
    });

    global.fetch = vi.fn().mockImplementation(async (url: string) => {
      if (String(url).includes("/outbound?claim=1")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            policy: { outboundSyncMode: "AUTO_SYNC" },
            jobs: [
              {
                id: "job-epoch-1",
                idempotencyKey: "k-1",
                eventType: "ONLINE_SALE",
                status: "PROCESSING",
                orderId: "ord-1",
                orderReference: "ORD-1",
                productId: "p-1",
                externalPosId: "17b2790a-e3ef-4606-bbbc-430df706af6b",
                productName: "EFLARON SUSP 60ML",
                sku: null,
                qtyDelta: -3,
                targetStock: null,
                posStockSnapshot: 10,
                attempts: 1,
                maxAttempts: 5,
                lockToken: "lt-1",
                externalInventoryUU: null,
                externalWarehouseId: null,
                externalLocatorId: null,
                externalOrgId: null,
                sphereStockQty: 7,
                lastPosStock: 10,
              },
            ],
          }),
        } as any;
      }
      return { ok: true, status: 200, json: async () => ({ ok: true }) } as any;
    });

    (chrome.tabs.query as any).mockResolvedValue([
      { id: 77, url: "https://go.bandahealth.org/products" },
    ]);

    let capturedWritebackFunc: any = null;
    (chrome.scripting.executeScript as any).mockImplementation(async (opts: any) => {
      capturedWritebackFunc = opts.func;
      return [{ result: { results: [{ jobId: "job-epoch-1", lockToken: "lt-1", status: "SYNCED" }] } }];
    });

    await BandaGoWritebackEngine.syncOutboundNow({ trigger: "MANUAL" });
    expect(capturedWritebackFunc).toBeTypeOf("function");

    const nowMs = Date.now();
    const expiredEpochMs = nowMs - 86400_000 * 5;
    const soonerEpochMs = nowMs + 86400_000 * 30;
    const laterEpochMs = nowMs + 86400_000 * 180;

    let savedLines: any[] = [];
    global.fetch = vi.fn().mockImplementation(async (_url: string, opts: any) => {
      const body = JSON.parse(opts.body);
      const q = String(body.query || "");
      if (q.includes("C_DocTypeGet")) {
        return {
          ok: true,
          status: 200,
          json: async () => [{ data: { C_DocTypeGet: { Results: [{ UU: "dt-pi", DocBaseType: "MMI", DocSubTypeInv: "PI" }] } } }],
        };
      }
      if (q.includes("M_WarehouseGet")) {
        return {
          ok: true,
          status: 200,
          json: async () => [{ data: { M_WarehouseGet: { Results: [{ UU: "wh-main" }] } } }],
        };
      }
      if (q.includes("M_AttributeSetInstanceGet")) {
        return {
          ok: true,
          status: 200,
          json: async () => [{ data: { M_AttributeSetInstanceGet: { Results: [{ UU: "asi-default" }] } } }],
        };
      }
      if (q.includes("M_StorageOnHandGet")) {
        return {
          ok: true,
          status: 200,
          json: async () => [
            {
              data: {
                M_StorageOnHandGet: {
                  Results: [
                    {
                      QtyOnHand: 20,
                      M_Locator: { UU: "loc-1", M_Warehouse: { UU: "wh-main" } },
                      M_AttributeSetInstance: { UU: "asi-expired", GuaranteeDate: expiredEpochMs },
                    },
                    {
                      QtyOnHand: 5,
                      M_Locator: { UU: "loc-1", M_Warehouse: { UU: "wh-main" } },
                      M_AttributeSetInstance: { UU: "asi-later", GuaranteeDate: laterEpochMs },
                    },
                    {
                      QtyOnHand: 2,
                      M_Locator: { UU: "loc-1", M_Warehouse: { UU: "wh-main" } },
                      M_AttributeSetInstance: { UU: "asi-sooner", GuaranteeDate: soonerEpochMs },
                    },
                  ],
                },
              },
            },
          ],
        };
      }
      if (q.includes("M_InventorySave")) {
        return {
          ok: true,
          status: 200,
          json: async () => [{ data: { M_InventorySave: { UU: "inv-new", DocumentNo: "PI-100" } } }],
        };
      }
      if (q.includes("M_InventoryLineSaveMany")) {
        savedLines = body.variables?.Entities || [];
        return {
          ok: true,
          status: 200,
          json: async () => [{ data: { M_InventoryLineSaveMany: [{ UU: "line-1" }] } }],
        };
      }
      if (q.includes("M_InventoryProcess")) {
        return {
          ok: true,
          status: 200,
          json: async () => [{ data: { M_InventoryProcess: { UU: "inv-new", DocumentNo: "PI-100", DocStatus: "CO" } } }],
        };
      }
      return { ok: true, status: 200, json: async () => ({ data: {} }) };
    }) as any;

    const wbRes = await capturedWritebackFunc(
      "/graphql/",
      [
        {
          id: "job-epoch-1",
          idempotencyKey: "k-1",
          eventType: "ONLINE_SALE",
          status: "PROCESSING",
          orderId: "ord-1",
          orderReference: "ORD-1",
          productId: "p-1",
          externalPosId: "17b2790a-e3ef-4606-bbbc-430df706af6b",
          productName: "EFLARON SUSP 60ML",
          sku: null,
          qtyDelta: -3,
          targetStock: null,
          posStockSnapshot: 7,
          attempts: 1,
          maxAttempts: 5,
          lockToken: "lt-1",
          externalInventoryUU: null,
          externalWarehouseId: null,
          externalLocatorId: null,
          externalOrgId: null,
          sphereStockQty: 4,
          lastPosStock: 7,
        },
      ],
      null,
      "Bearer live-token",
    );

    expect(wbRes.results[0].status).toBe("SYNCED");
    // Expired lot (20 units) ignored; 2 consumed from asi-sooner (2 -> 0), 1 from asi-later (5 -> 4)
    expect(savedLines).toHaveLength(2);
    expect(savedLines[0].M_AttributeSetInstance.UU).toBe("asi-sooner");
    expect(savedLines[0].QtyCount).toBe(0);
    expect(savedLines[1].M_AttributeSetInstance.UU).toBe("asi-later");
    expect(savedLines[1].QtyCount).toBe(4);
    expect(wbRes.results[0].posStockAfter).toBe(4);
  });

  it("requeues items safely without deleting or incrementing retries when Sphere returns skipped/paused policy", async () => {
    vi.spyOn(SphereSyncClient, "getConfig").mockResolvedValue({
      endpointUrl: "https://sphere.example/api/integrations/bandago/sync",
      apiKey: "valid-key",
      enabled: true,
    });
    vi.spyOn(SyncQueueManager, "recoverStaleSyncing").mockResolvedValue(0);
    vi.spyOn(SyncQueueManager, "getPending").mockResolvedValueOnce([
      {
        id: 101,
        externalPosId: "uu-1",
        payload: { externalPosId: "uu-1", name: "EFLARON SUSP 60ML", price: 100, stock: 7 } as any,
        status: "PENDING",
        retryCount: 0,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      },
    ]);
    vi.spyOn(SyncQueueManager, "markSyncing").mockResolvedValue();
    const markSuccessSpy = vi.spyOn(SyncQueueManager, "markSuccess").mockResolvedValue();
    const requeueSpy = vi.spyOn(SyncQueueManager, "requeueWithoutPenalty").mockResolvedValue();

    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        success: true,
        skipped: true,
        paused: true,
        reason: "Inbound POS sync is paused by admin policy",
        policySummary: { inboundEnabled: false, outboundSyncMode: "MANUAL_EXPORT" },
      }),
    } as any);

    const res = await SphereSyncClient.flushQueue("MANUAL");
    expect(requeueSpy).toHaveBeenCalledWith([101]);
    expect(markSuccessSpy).not.toHaveBeenCalled();
    expect(res.synced).toBe(0);
    expect(res.error).toContain("paused");
  });
});
