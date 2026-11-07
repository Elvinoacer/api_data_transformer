import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { BandaGoActivePoller } from "../../src/background/bandago-poller";
import { SphereSyncClient } from "../../src/sync/sphere-client";
import { CdpNetworkAdapter } from "../../src/background/cdp-adapter";

describe("BandaGoActivePoller", () => {
  beforeEach(() => {
    (BandaGoActivePoller as any).isInitialized = false;
    (global as any).chrome = {
      alarms: {
        create: vi.fn(),
        get: vi.fn((_name: string, cb: (alarm: any) => void) => cb(null)),
        onAlarm: {
          addListener: vi.fn(),
        },
      },
      tabs: {
        query: vi.fn(),
      },
      scripting: {
        executeScript: vi.fn(),
      },
      storage: {
        local: {
          get: vi.fn().mockResolvedValue({
            sphere_sync_enabled: true,
            sphere_endpoint_url: "https://test/sync",
            sphere_api_key: "key",
          }),
        },
      },
    };
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("registers periodic alarm on initialization when not already present", () => {
    BandaGoActivePoller.init();
    expect(chrome.alarms.create).toHaveBeenCalledWith(
      BandaGoActivePoller.ALARM_NAME,
      expect.objectContaining({
        periodInMinutes: 10,
      }),
    );
  });

  it("does not re-create alarm if it already exists", () => {
    (chrome.alarms.get as any).mockImplementation(
      (_name: string, cb: (alarm: any) => void) =>
        cb({ name: BandaGoActivePoller.ALARM_NAME }),
    );
    BandaGoActivePoller.init();
    expect(chrome.alarms.create).not.toHaveBeenCalled();
  });

  it("skips polling when Sphere sync is disabled", async () => {
    vi.spyOn(SphereSyncClient, "getConfig").mockResolvedValue({
      endpointUrl: "",
      apiKey: "",
      enabled: false,
    });

    const result = await BandaGoActivePoller.pollActiveTabs();
    expect(result.success).toBe(false);
    expect(result.message).toContain("disabled");
    expect(chrome.tabs.query).not.toHaveBeenCalled();
  });

  it("reports when no active go.bandahealth.org tab is open", async () => {
    vi.spyOn(SphereSyncClient, "getConfig").mockResolvedValue({
      endpointUrl: "https://test/sync",
      apiKey: "key",
      enabled: true,
    });

    (chrome.tabs.query as any).mockResolvedValue([]);

    const result = await BandaGoActivePoller.pollActiveTabs();
    expect(result.success).toBe(false);
    expect(result.count).toBe(0);
    expect(result.message).toContain("No active go.bandahealth.org tab found");
  });

  it("executes GraphQL query in open tab, normalizes returned products, and enqueues to SphereSyncClient", async () => {
    vi.spyOn(SphereSyncClient, "getConfig").mockResolvedValue({
      endpointUrl: "https://test/sync",
      apiKey: "key",
      enabled: true,
    });

    (chrome.tabs.query as any).mockResolvedValue([
      { id: 42, url: "https://go.bandahealth.org/inventory" },
    ]);

    const enqueueSpy = vi
      .spyOn(SphereSyncClient, "enqueue")
      .mockResolvedValue(1);

    (chrome.scripting.executeScript as any).mockResolvedValue([
      {
        result: {
          data: {
            products: [
              {
                id: "prod-poll-1",
                uu: "uu-poll-1",
                name: "Paracetamol 500mg Tablets",
                bh_sellprice: 40,
                quantityOnHand: 80,
              },
            ],
          },
        },
      },
    ]);

    const result = await BandaGoActivePoller.pollActiveTabs();

    expect(chrome.scripting.executeScript).toHaveBeenCalledWith(
      expect.objectContaining({
        target: { tabId: 42 },
      }),
    );

    expect(result.success).toBe(true);
    expect(result.count).toBe(1);
    expect(enqueueSpy).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({
          externalPosId: "uu-poll-1",
          name: "Paracetamol 500mg Tablets",
          stock: 80,
        }),
      ]),
      "BACKGROUND_POLL",
    );
  });

  it("handles in-tab session expiration returning GraphQL errors array", async () => {
    vi.spyOn(SphereSyncClient, "getConfig").mockResolvedValue({
      endpointUrl: "https://test/sync",
      apiKey: "key",
      enabled: true,
    });

    (chrome.tabs.query as any).mockResolvedValue([
      { id: 42, url: "https://go.bandahealth.org/inventory" },
    ]);

    (chrome.scripting.executeScript as any).mockResolvedValue([
      {
        result: {
          errors: [{ message: "Session expired. Please re-authenticate." }],
        },
      },
    ]);

    const result = await BandaGoActivePoller.pollActiveTabs();
    expect(result.success).toBe(false);
    expect(result.count).toBe(0);
    expect(result.message).toContain("Session expired");
  });

  it("handles non-200 HTTP response from in-tab endpoint", async () => {
    vi.spyOn(SphereSyncClient, "getConfig").mockResolvedValue({
      endpointUrl: "https://test/sync",
      apiKey: "key",
      enabled: true,
    });

    (chrome.tabs.query as any).mockResolvedValue([
      { id: 42, url: "https://go.bandahealth.org/inventory" },
    ]);

    (chrome.scripting.executeScript as any).mockResolvedValue([
      {
        result: {
          error: "HTTP 401: Unauthorized",
        },
      },
    ]);

    const result = await BandaGoActivePoller.pollActiveTabs();
    expect(result.success).toBe(false);
    expect(result.message).toContain("HTTP 401");
  });

  it("forwards captured Authorization Bearer token into executeScript args", async () => {
    vi.spyOn(SphereSyncClient, "getConfig").mockResolvedValue({
      endpointUrl: "https://test/sync",
      apiKey: "key",
      enabled: true,
    });

    (chrome.tabs.query as any).mockResolvedValue([
      { id: 42, url: "https://go.bandahealth.org/inventory" },
    ]);

    await CdpNetworkAdapter.setAuthHeader(
      "https://go.bandahealth.org",
      "Bearer jwt-token-xyz-123",
    );

    (chrome.scripting.executeScript as any).mockResolvedValue([
      { result: { data: { products: [] } } },
    ]);

    await BandaGoActivePoller.pollActiveTabs();

    expect(chrome.scripting.executeScript).toHaveBeenCalledWith(
      expect.objectContaining({
        target: { tabId: 42 },
        args: [
          "/graphql/",
          expect.any(String),
          expect.any(String),
          expect.any(String),
          "Bearer jwt-token-xyz-123",
        ],
      }),
    );
  });

  it("alarm triggers sequential execution: awaits pollActiveTabs before flushQueue", async () => {
    let alarmListener: ((alarm: any) => void) | null = null;
    (chrome.alarms.onAlarm.addListener as any).mockImplementation((fn: any) => {
      alarmListener = fn;
    });

    const executionOrder: string[] = [];
    vi.spyOn(BandaGoActivePoller, "pollActiveTabs").mockImplementation(
      async () => {
        executionOrder.push("pollActiveTabs");
        return { success: true, count: 5, message: "OK" };
      },
    );

    vi.spyOn(SphereSyncClient, "flushQueue").mockImplementation(async () => {
      executionOrder.push("flushQueue");
      return { synced: 5, failed: 0 };
    });

    BandaGoActivePoller.init();
    expect(alarmListener).not.toBeNull();

    // Trigger the alarm
    alarmListener!({ name: BandaGoActivePoller.ALARM_NAME });

    // Allow async promises in alarm listener to resolve
    await new Promise((r) => setTimeout(r, 10));

    expect(executionOrder).toEqual(["pollActiveTabs", "flushQueue"]);
  });

  it("in-tab poller function extracts JWT token from JSON object in localStorage", async () => {
    vi.spyOn(SphereSyncClient, "getConfig").mockResolvedValue({
      endpointUrl: "https://test/sync",
      apiKey: "key",
      enabled: true,
    });

    (chrome.tabs.query as any).mockResolvedValue([
      { id: 42, url: "https://go.bandahealth.org/inventory" },
    ]);

    let passedFunc: any = null;
    (chrome.scripting.executeScript as any).mockImplementation(
      async (opts: any) => {
        passedFunc = opts.func;
        return [{ result: { data: { products: [] } } }];
      },
    );

    await BandaGoActivePoller.pollActiveTabs();
    expect(passedFunc).toBeTypeOf("function");

    // Execute the passedFunc in a simulated tab environment with JSON token in localStorage
    const fakeStore: Record<string, string> = {
      user_session: JSON.stringify({
        token:
          "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c",
      }),
    };

    let capturedFetchOpts: any = null;
    (global as any).window = {
      localStorage: {
        length: 1,
        key: (i: number) => (i === 0 ? "user_session" : null),
        getItem: (k: string) => fakeStore[k] || null,
      },
      sessionStorage: { length: 0, key: () => null, getItem: () => null },
    };

    const origFetch = global.fetch;
    global.fetch = vi
      .fn()
      .mockImplementation(async (_url: string, opts: any) => {
        capturedFetchOpts = opts;
        return {
          ok: true,
          json: async () => ({ data: { products: [] } }),
        };
      });

    try {
      const res = await passedFunc("/graphql", "query {}", null);
      expect(res).toEqual({ data: { products: [] } });
      expect(capturedFetchOpts?.headers?.["Authorization"]).toContain(
        "Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9",
      );
    } finally {
      global.fetch = origFetch;
      delete (global as any).window;
    }
  });

  it("in-tab poller function executes real BandaGo iDempiere queries and combines data", async () => {
    vi.spyOn(SphereSyncClient, "getConfig").mockResolvedValue({
      endpointUrl: "https://test/sync",
      apiKey: "key",
      enabled: true,
    });

    (chrome.tabs.query as any).mockResolvedValue([
      { id: 42, url: "https://go.bandahealth.org/inventory" },
    ]);

    let passedFunc: any = null;
    let passedArgs: any[] = [];
    (chrome.scripting.executeScript as any).mockImplementation(
      async (opts: any) => {
        passedFunc = opts.func;
        passedArgs = opts.args;
        return [{ result: { data: {} } }];
      },
    );

    await BandaGoActivePoller.pollActiveTabs();
    expect(passedFunc).toBeTypeOf("function");
    expect(passedArgs).toHaveLength(5);
    expect(passedArgs[0]).toBe("/graphql/");

    const calls: Array<{ url: string; body: any }> = [];
    const origFetch = global.fetch;
    global.fetch = vi.fn().mockImplementation(async (url: string, opts: any) => {
      const body = JSON.parse(opts.body);
      calls.push({ url, body });
      if (body.operationName === "M_StorageOnHandForInventoryList") {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            data: {
              M_StorageOnHandGet: {
                Results: [
                  {
                    UU: "storage-1",
                    QtyOnHand: 45,
                    M_Product: { UU: "prod-1", Name: "Metformin 500mg" },
                  },
                ],
              },
            },
          }),
        };
      }
      if (body.operationName === "M_ProductForProductListPage") {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            data: {
              M_ProductGet: {
                Results: [
                  {
                    UU: "prod-1",
                    Name: "Metformin 500mg",
                    KnhtsConcept: { code: "KNHTS-MET-500", name: "Metformin" },
                  },
                ],
              },
            },
          }),
        };
      }
      return { ok: true, status: 200, json: async () => ({ data: {} }) };
    });

    try {
      const result = await passedFunc(
        passedArgs[0],
        passedArgs[1],
        passedArgs[2],
        passedArgs[3],
        "Bearer token-123",
      );

      expect(calls.length).toBe(2);
      expect(calls[0].body.operationName).toBe("M_StorageOnHandForInventoryList");
      expect(calls[1].body.operationName).toBe("M_ProductForProductListPage");
      expect(result.data.M_StorageOnHandGet).toBeDefined();
      expect(result.data.M_ProductGet).toBeDefined();
    } finally {
      global.fetch = origFetch;
    }
  });

  it("in-tab poller retries with alternate trailing slash when 404 is encountered", async () => {
    vi.spyOn(SphereSyncClient, "getConfig").mockResolvedValue({
      endpointUrl: "https://test/sync",
      apiKey: "key",
      enabled: true,
    });

    (chrome.tabs.query as any).mockResolvedValue([
      { id: 42, url: "https://go.bandahealth.org/inventory" },
    ]);

    let passedFunc: any = null;
    let passedArgs: any[] = [];
    (chrome.scripting.executeScript as any).mockImplementation(
      async (opts: any) => {
        passedFunc = opts.func;
        passedArgs = opts.args;
        return [{ result: { data: {} } }];
      },
    );

    await BandaGoActivePoller.pollActiveTabs();

    const attemptedUrls: string[] = [];
    const origFetch = global.fetch;
    global.fetch = vi.fn().mockImplementation(async (url: string) => {
      attemptedUrls.push(url);
      if (url === "/graphql/") {
        return {
          ok: false,
          status: 404,
          text: async () => "Not Found",
        };
      }
      if (url === "/graphql") {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            data: {
              M_StorageOnHandGet: { Results: [] },
            },
          }),
        };
      }
      return { ok: true, status: 200, json: async () => ({ data: {} }) };
    });

    try {
      const result = await passedFunc(
        "/graphql/",
        passedArgs[1],
        passedArgs[2],
        passedArgs[3],
        "Bearer test",
      );

      expect(attemptedUrls).toContain("/graphql/");
      expect(attemptedUrls).toContain("/graphql");
      expect(result.data.M_StorageOnHandGet).toBeDefined();
    } finally {
      global.fetch = origFetch;
    }
  });

  it("pollActiveTabs normalizes live iDempiere payload and enqueues to SphereSyncClient", async () => {
    vi.spyOn(SphereSyncClient, "getConfig").mockResolvedValue({
      endpointUrl: "https://test/sync",
      apiKey: "key",
      enabled: true,
    });

    (chrome.tabs.query as any).mockResolvedValue([
      { id: 42, url: "https://go.bandahealth.org/inventory" },
    ]);

    const enqueueSpy = vi
      .spyOn(SphereSyncClient, "enqueue")
      .mockResolvedValue(1);

    const futureDate = new Date(Date.now() + 60 * 24 * 60 * 60 * 1000).toISOString();
    (chrome.scripting.executeScript as any).mockResolvedValue([
      {
        result: {
          data: {
            M_ProductGet: {
              Results: [
                {
                  UU: "prod-live-idempiere",
                  Name: "Azithromycin 500mg Tablets",
                  BH_SellPrice: 650,
                  TotalQuantity: 30,
                  KnhtsConcept: {
                    code: "KNHTS-AZI-500",
                    name: "Azithromycin Dihydrate",
                  },
                },
              ],
            },
            M_StorageOnHandGet: {
              Results: [
                {
                  UU: "storage-live-1",
                  QtyOnHand: 30,
                  M_Product: {
                    UU: "prod-live-idempiere",
                    Name: "Azithromycin 500mg Tablets",
                    BH_SellPrice: 650,
                  },
                  M_AttributeSetInstance: {
                    UU: "asi-live-1",
                    Lot: "AZI-LOT-99",
                    GuaranteeDate: futureDate,
                    PurchasePrice: 400,
                  },
                },
              ],
            },
          },
        },
      },
    ]);

    const result = await BandaGoActivePoller.pollActiveTabs();
    expect(result.success).toBe(true);
    expect(result.count).toBe(1);
    expect(enqueueSpy).toHaveBeenCalledWith(
      [
        expect.objectContaining({
          externalPosId: "prod-live-idempiere",
          sku: "KNHTS-AZI-500",
          genericName: "Azithromycin Dihydrate",
          price: 650,
          costPrice: 400,
          stock: 30,
          batches: [
            expect.objectContaining({
              batchNumber: "AZI-LOT-99",
              qtyOnHand: 30,
            }),
          ],
        }),
      ],
      "BACKGROUND_POLL",
    );
  });

  it("in-tab poller automatically iterates through multi-page results when TotalPages > 1", async () => {
    vi.spyOn(SphereSyncClient, "getConfig").mockResolvedValue({
      endpointUrl: "https://test/sync",
      apiKey: "key",
      enabled: true,
    });

    (chrome.tabs.query as any).mockResolvedValue([
      { id: 42, url: "https://go.bandahealth.org/inventory" },
    ]);

    let passedFunc: any = null;
    let passedArgs: any[] = [];
    (chrome.scripting.executeScript as any).mockImplementation(
      async (opts: any) => {
        passedFunc = opts.func;
        passedArgs = opts.args;
        return [{ result: { data: {} } }];
      },
    );

    await BandaGoActivePoller.pollActiveTabs();

    const fetchCalls: Array<{ url: string; variables: any }> = [];
    const origFetch = global.fetch;
    global.fetch = vi.fn().mockImplementation(async (url: string, opts: any) => {
      const body = JSON.parse(opts.body);
      fetchCalls.push({ url, variables: body.variables });
      if (body.operationName === "M_StorageOnHandForInventoryList") {
        const page = body.variables?.Page || 1;
        return {
          ok: true,
          status: 200,
          json: async () => ({
            data: {
              M_StorageOnHandGet: {
                PagingInfo: { Page: page, PageSize: 500, TotalCount: 600, TotalPages: 2 },
                Results: [
                  {
                    UU: `storage-p${page}`,
                    QtyOnHand: 50,
                    M_Product: { UU: `prod-p${page}`, Name: `Product Page ${page}` },
                  },
                ],
              },
            },
          }),
        };
      }
      return { ok: true, status: 200, json: async () => ({ data: {} }) };
    });

    try {
      const result = await passedFunc(
        passedArgs[0],
        passedArgs[1],
        passedArgs[2],
        passedArgs[3],
        "Bearer test",
      );

      // Verify page 1 and page 2 were both fetched
      const storageCalls = fetchCalls.filter((c) => c.variables?.Page !== undefined);
      expect(storageCalls.some((c) => c.variables.Page === 1)).toBe(true);
      expect(storageCalls.some((c) => c.variables.Page === 2)).toBe(true);
      // Both results should be merged into M_StorageOnHandGet.Results
      expect(result.data.M_StorageOnHandGet.Results).toHaveLength(2);
    } finally {
      global.fetch = origFetch;
    }
  });

  it("in-tab poller continues to execute productQuery when storageQuery fails with a schema error", async () => {
    vi.spyOn(SphereSyncClient, "getConfig").mockResolvedValue({
      endpointUrl: "https://test/sync",
      apiKey: "key",
      enabled: true,
    });

    (chrome.tabs.query as any).mockResolvedValue([
      { id: 42, url: "https://go.bandahealth.org/inventory" },
    ]);

    let passedFunc: any = null;
    let passedArgs: any[] = [];
    (chrome.scripting.executeScript as any).mockImplementation(
      async (opts: any) => {
        passedFunc = opts.func;
        passedArgs = opts.args;
        return [{ result: { data: {} } }];
      },
    );

    await BandaGoActivePoller.pollActiveTabs();

    const origFetch = global.fetch;
    global.fetch = vi.fn().mockImplementation(async (_url: string, opts: any) => {
      const body = JSON.parse(opts.body);
      if (body.operationName === "M_StorageOnHandForInventoryList") {
        // Storage query errors out (e.g. schema error or lack of permission)
        return {
          ok: true,
          status: 200,
          json: async () => ({
            errors: [{ message: "Cannot query field M_StorageOnHandGet on type Query" }],
          }),
        };
      }
      if (body.operationName === "M_ProductForProductListPage") {
        // Product list succeeds
        return {
          ok: true,
          status: 200,
          json: async () => ({
            data: {
              M_ProductGet: {
                Results: [
                  {
                    UU: "prod-resilient-1",
                    Name: "Ibuprofen 200mg",
                    BH_SellPrice: 120,
                    TotalQuantity: 50,
                  },
                ],
              },
            },
          }),
        };
      }
      return { ok: true, status: 200, json: async () => ({ data: {} }) };
    });

    try {
      const result = await passedFunc(
        passedArgs[0],
        passedArgs[1],
        passedArgs[2],
        passedArgs[3],
        "Bearer test",
      );

      expect(result.data.M_ProductGet).toBeDefined();
      expect(result.data.M_ProductGet.Results).toHaveLength(1);
    } finally {
      global.fetch = origFetch;
    }
  });

  it("queries include essential fields: Value, Description, Category, Expiration, and Margin", async () => {
    vi.spyOn(SphereSyncClient, "getConfig").mockResolvedValue({
      endpointUrl: "https://test/sync",
      apiKey: "key",
      enabled: true,
    });

    (chrome.tabs.query as any).mockResolvedValue([
      { id: 42, url: "https://go.bandahealth.org/inventory" },
    ]);

    let capturedArgs: any[] = [];
    (chrome.scripting.executeScript as any).mockImplementation(
      async (opts: any) => {
        capturedArgs = opts.args;
        return [{ result: { data: {} } }];
      },
    );

    await BandaGoActivePoller.pollActiveTabs();

    const storageQuery = capturedArgs[1];
    const productQuery = capturedArgs[2];

    expect(storageQuery).toContain("Value");
    expect(storageQuery).toContain("Description");
    expect(storageQuery).toContain("BH_PriceMargin");
    expect(storageQuery).toContain("BH_HasExpiration");
    expect(storageQuery).toContain("HasExpirationDate");
    expect(storageQuery).toContain("M_Product_Category");
    expect(storageQuery).toContain("KnhtsConcept");
    expect(storageQuery).toContain("SerNo");

    expect(productQuery).toContain("Value");
    expect(productQuery).toContain("Description");
    expect(productQuery).toContain("BH_BuyPrice");
    expect(productQuery).toContain("BH_PriceMargin");
    expect(productQuery).toContain("BH_HasExpiration");
    expect(productQuery).toContain("HasExpirationDate");
    expect(productQuery).toContain("M_Product_Category");
    expect(productQuery).toContain("KnhtsConcept");
  });

  it("in-tab poller retries with alternate endpoint when HTTP 200 returns non-JSON SPA HTML", async () => {
    vi.spyOn(SphereSyncClient, "getConfig").mockResolvedValue({
      endpointUrl: "https://test/sync",
      apiKey: "key",
      enabled: true,
    });

    (chrome.tabs.query as any).mockResolvedValue([
      { id: 42, url: "https://go.bandahealth.org/inventory" },
    ]);

    let passedFunc: any = null;
    let passedArgs: any[] = [];
    (chrome.scripting.executeScript as any).mockImplementation(
      async (opts: any) => {
        passedFunc = opts.func;
        passedArgs = opts.args;
        return [{ result: { data: {} } }];
      },
    );

    await BandaGoActivePoller.pollActiveTabs();

    const attemptedUrls: string[] = [];
    const origFetch = global.fetch;
    global.fetch = vi.fn().mockImplementation(async (url: string) => {
      attemptedUrls.push(url);
      if (url === "/graphql/") {
        // Return HTTP 200 with HTML (typical SPA router rewrite)
        return {
          ok: true,
          status: 200,
          headers: {
            get: (name: string) =>
              name.toLowerCase() === "content-type" ? "text/html; charset=utf-8" : null,
          },
          text: async () => "<!DOCTYPE html><html><body>SPA</body></html>",
          json: async () => {
            throw new SyntaxError("Unexpected token < in JSON at position 0");
          },
        };
      }
      if (url === "/graphql") {
        return {
          ok: true,
          status: 200,
          headers: {
            get: (name: string) =>
              name.toLowerCase() === "content-type" ? "application/json" : null,
          },
          json: async () => ({
            data: {
              M_StorageOnHandGet: { Results: [] },
            },
          }),
        };
      }
      return { ok: true, status: 200, json: async () => ({ data: {} }) };
    });

    try {
      const result = await passedFunc(
        "/graphql/",
        passedArgs[1],
        passedArgs[2],
        passedArgs[3],
        "Bearer test",
      );

      // Verify that non-JSON response on /graphql/ triggered fallback to /graphql
      expect(attemptedUrls).toContain("/graphql/");
      expect(attemptedUrls).toContain("/graphql");
      expect(result.data.M_StorageOnHandGet).toBeDefined();
    } finally {
      global.fetch = origFetch;
    }
  });
});

