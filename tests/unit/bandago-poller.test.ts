import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { BandaGoActivePoller } from "../../src/background/bandago-poller";
import { SphereSyncClient } from "../../src/sync/sphere-client";

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
});
