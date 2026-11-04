import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { SphereSyncClient } from "../../src/sync/sphere-client";
import { SyncQueueManager, coalesceSyncItems } from "../../src/sync/sync-queue";
import { db } from "../../src/data/db";

describe("SphereSyncClient & SyncQueueManager", () => {
  const originalFetch = global.fetch;

  beforeEach(async () => {
    // Reset local/chrome storage
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
    };

    try {
      await db.sync_queue.clear();
    } catch {
      // If indexedDB not active in environment
    }
  });

  afterEach(() => {
    global.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("saves and reads sync configuration via chrome.storage.local", async () => {
    const saved = await SphereSyncClient.saveConfig({
      endpointUrl:
        "https://pharmacy.sphere.health/api/integrations/bandago/sync",
      apiKey: "test-secret-pos-key",
      enabled: true,
      pharmacyId: "BRANCH-CBD-01",
    });

    expect(saved.enabled).toBe(true);
    expect(saved.endpointUrl).toBe(
      "https://pharmacy.sphere.health/api/integrations/bandago/sync",
    );

    const retrieved = await SphereSyncClient.getConfig();
    expect(retrieved.enabled).toBe(true);
    expect(retrieved.apiKey).toBe("test-secret-pos-key");
    expect(retrieved.pharmacyId).toBe("BRANCH-CBD-01");
  });

  it("tests connection handshake reporting success, 401 Unauthorized, and network failures", async () => {
    // 1. Success 200
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ success: true, count: 0 }),
    } as any);

    const testOk = await SphereSyncClient.testConnection({
      endpointUrl: "https://test.sphere/api/sync",
      apiKey: "valid-key",
      enabled: true,
    });
    expect(testOk.ok).toBe(true);
    expect(testOk.status).toBe(200);

    // 2. Unauthorized 401
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      text: async () => "Invalid Bearer Token",
    } as any);

    const testUnauthorized = await SphereSyncClient.testConnection({
      endpointUrl: "https://test.sphere/api/sync",
      apiKey: "wrong-key",
      enabled: true,
    });
    expect(testUnauthorized.ok).toBe(false);
    expect(testUnauthorized.error).toContain("Invalid API Key");

    // 3. Network error
    global.fetch = vi.fn().mockRejectedValue(new Error("ECONNREFUSED"));
    const testNetErr = await SphereSyncClient.testConnection({
      endpointUrl: "https://offline-server/api/sync",
      apiKey: "key",
      enabled: true,
    });
    expect(testNetErr.ok).toBe(false);
    expect(testNetErr.error).toBe("ECONNREFUSED");
  });

  it("marks failed items and increments retryCount with exponential backoff on server 500 error", async () => {
    const mockItems = [
      {
        id: 1,
        externalPosId: "pos-item-1",
        payload: { name: "Drug A" },
        status: "SYNCING" as const,
        retryCount: 0,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      },
    ];

    // Mock db.transaction for isolated queue testing
    const updateSpy = vi.fn();
    const origTransaction = db.transaction;
    (db as any).transaction = async (
      _mode: string,
      _table: any,
      callback: () => Promise<void>,
    ) => {
      (db.sync_queue as any).update = updateSpy;
      (db.sync_queue as any).get = vi
        .fn()
        .mockImplementation(async (id: number) => {
          return mockItems.find((m) => m.id === id);
        });
      await callback();
    };

    await SyncQueueManager.markFailed(
      mockItems,
      "Internal Server Error 500",
      5,
    );

    expect(updateSpy).toHaveBeenCalledWith(
      1,
      expect.objectContaining({
        status: "PENDING",
        retryCount: 1,
        lastError: "Internal Server Error 500",
      }),
    );

    // Test transition to FAILED when retry count reaches maxRetries
    mockItems[0].retryCount = 4;
    await SyncQueueManager.markFailed(
      mockItems,
      "Internal Server Error 500",
      5,
    );

    expect(updateSpy).toHaveBeenCalledWith(
      1,
      expect.objectContaining({
        status: "FAILED",
        retryCount: 5,
        lastError: "Internal Server Error 500",
      }),
    );

    db.transaction = origTransaction;
  });

  it("markSuccess only deletes items if status is SYNCING, preserving re-enqueued items", async () => {
    const deleteSpy = vi.fn();
    const origTransaction = db.transaction;

    (db as any).transaction = async (
      _mode: string,
      _table: any,
      callback: () => Promise<void>,
    ) => {
      (db.sync_queue as any).delete = deleteSpy;
      (db.sync_queue as any).get = vi
        .fn()
        .mockImplementation(async (id: number) => {
          if (id === 1) return { id: 1, status: "SYNCING" };
          if (id === 2) return { id: 2, status: "PENDING" }; // Re-enqueued while in-flight!
          return null;
        });
      await callback();
    };

    await SyncQueueManager.markSuccess([1, 2]);

    // Item 1 (SYNCING) is deleted, but Item 2 (PENDING) is preserved!
    expect(deleteSpy).toHaveBeenCalledWith(1);
    expect(deleteSpy).not.toHaveBeenCalledWith(2);

    db.transaction = origTransaction;
  });

  it("flushes queue and deletes items upon HTTP 200 success", async () => {
    // Setup enabled config
    (global as any).chrome.storage.local.store = {
      sphere_endpoint_url:
        "https://sphere.pharmacy/api/integrations/bandago/sync",
      sphere_api_key: "test-key",
      sphere_sync_enabled: true,
      sphere_pharmacy_id: "STORE-01",
    };

    const mockPending = [
      {
        id: 10,
        externalPosId: "pos-10",
        payload: { name: "Metformin 500mg", price: 150 },
        status: "PENDING" as const,
        retryCount: 0,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      },
    ];

    vi.spyOn(SyncQueueManager, "getPending").mockResolvedValue(mockPending);
    const markSyncingSpy = vi
      .spyOn(SyncQueueManager, "markSyncing")
      .mockResolvedValue();
    const markSuccessSpy = vi
      .spyOn(SyncQueueManager, "markSuccess")
      .mockResolvedValue();

    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ success: true, syncedCount: 1 }),
    } as any);

    const result = await SphereSyncClient.flushQueue();

    expect(result.synced).toBe(1);
    expect(result.failed).toBe(0);
    expect(markSyncingSpy).toHaveBeenCalledWith([10]);
    expect(markSuccessSpy).toHaveBeenCalledWith([10]);

    // Verify correct HTTP headers and payload were sent
    expect(global.fetch).toHaveBeenCalledWith(
      "https://sphere.pharmacy/api/integrations/bandago/sync",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          "Content-Type": "application/json",
          Authorization: "Bearer test-key",
          "X-Pharmacy-Source": "BANDAGO_POS",
        }),
      }),
    );
  });

  it("drains multiple pending batches during a single flushQueue invocation", async () => {
    (global as any).chrome.storage.local.store = {
      sphere_endpoint_url: "https://sphere.pharmacy/api/sync",
      sphere_api_key: "test-key",
      sphere_sync_enabled: true,
    };

    const batch1 = Array.from({ length: 50 }, (_, i) => ({
      id: i + 1,
      externalPosId: `pos-${i + 1}`,
      payload: { name: `Drug ${i + 1}` },
      status: "PENDING" as const,
      retryCount: 0,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }));

    const batch2 = Array.from({ length: 25 }, (_, i) => ({
      id: i + 51,
      externalPosId: `pos-${i + 51}`,
      payload: { name: `Drug ${i + 51}` },
      status: "PENDING" as const,
      retryCount: 0,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }));

    // First call returns full batch of 50, second returns remaining 25, then empty
    vi.spyOn(SyncQueueManager, "getPending")
      .mockResolvedValueOnce(batch1)
      .mockResolvedValueOnce(batch2)
      .mockResolvedValue([]);

    vi.spyOn(SyncQueueManager, "markSyncing").mockResolvedValue();
    vi.spyOn(SyncQueueManager, "markSuccess").mockResolvedValue();

    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ success: true }),
    } as any);

    const result = await SphereSyncClient.flushQueue();

    // Total synced should be 50 + 25 = 75 in one flush call
    expect(result.synced).toBe(75);
    expect(result.failed).toBe(0);
    expect(global.fetch).toHaveBeenCalledTimes(2);
  });

  it("markFailed preserves re-enqueued items (status PENDING) and does not penalize or overwrite them", async () => {
    const updateSpy = vi.fn();
    const origTransaction = db.transaction;

    const mockInFlight = [
      {
        id: 1,
        externalPosId: "pos-1",
        payload: { name: "Drug 1" },
        status: "SYNCING" as const,
        retryCount: 0,
        createdAt: 100,
        updatedAt: 100,
      },
      {
        id: 2,
        externalPosId: "pos-2",
        payload: { name: "Drug 2" },
        status: "SYNCING" as const,
        retryCount: 0,
        createdAt: 100,
        updatedAt: 100,
      },
    ];

    (db as any).transaction = async (
      _mode: string,
      _table: any,
      callback: () => Promise<void>,
    ) => {
      (db.sync_queue as any).update = updateSpy;
      (db.sync_queue as any).get = vi
        .fn()
        .mockImplementation(async (id: number) => {
          if (id === 1) return { id: 1, status: "SYNCING", retryCount: 0 };
          if (id === 2) return { id: 2, status: "PENDING", retryCount: 0 }; // Re-enqueued while sync in flight!
          return null;
        });
      await callback();
    };

    await SyncQueueManager.markFailed(mockInFlight, "HTTP 500 error", 5);

    // Item 1 (still SYNCING) must be updated with failure state
    expect(updateSpy).toHaveBeenCalledWith(
      1,
      expect.objectContaining({
        status: "PENDING",
        retryCount: 1,
        lastError: "HTTP 500 error",
      }),
    );

    // Item 2 (re-enqueued as PENDING) must NOT be penalized or overwritten!
    expect(updateSpy).not.toHaveBeenCalledWith(2, expect.anything());

    db.transaction = origTransaction;
  });

  it("recoverStaleSyncing restores items stuck in SYNCING state back to PENDING", async () => {
    const modifySpy = vi.fn();
    const toArraySpy = vi.fn().mockResolvedValue([
      { id: 101, status: "SYNCING", updatedAt: Date.now() - 120000 }, // 2 minutes ago (stale)
      { id: 102, status: "SYNCING", updatedAt: Date.now() - 10000 }, // 10 seconds ago (fresh)
    ]);

    (db.sync_queue as any).where = vi.fn().mockReturnValue({
      equals: vi.fn().mockReturnValue({
        toArray: toArraySpy,
      }),
      anyOf: vi.fn().mockReturnValue({
        modify: modifySpy,
      }),
    });

    const recovered = await SyncQueueManager.recoverStaleSyncing(60000);
    expect(recovered).toBe(1);
    expect(modifySpy).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "PENDING",
      }),
    );
  });

  it("flushQueue prevents overlapping concurrent invocations via isFlushing guard", async () => {
    (global as any).chrome.storage.local.store = {
      sphere_endpoint_url: "https://sphere.pharmacy/api/sync",
      sphere_api_key: "test-key",
      sphere_sync_enabled: true,
    };

    vi.spyOn(SyncQueueManager, "getPending").mockImplementation(async () => {
      // Simulate delay during getPending
      await new Promise((r) => setTimeout(r, 50));
      return [];
    });

    // Launch two concurrent flushes
    const p1 = SphereSyncClient.flushQueue();
    const p2 = SphereSyncClient.flushQueue();

    const [, r2] = await Promise.all([p1, p2]);
    // The second flush call immediately returns 0 due to concurrency guard
    expect(r2).toEqual({ synced: 0, failed: 0 });
  });

  it("coalesceSyncItems deduplicates by externalPosId, keeps newest state, and retains stock === 0", () => {
    const rawItems: any[] = [
      {
        externalPosId: "pos-panadol",
        name: "Panadol 500mg",
        stock: 19,
        price: 50,
      },
      {
        externalPosId: "pos-amox",
        name: "Amoxicillin 500mg",
        stock: 5,
        price: 250,
      },
      {
        externalPosId: "pos-panadol",
        name: "Panadol 500mg",
        stock: 18,
        price: 50,
      },
      {
        externalPosId: "pos-panadol",
        name: "Panadol 500mg",
        stock: 17, // Latest dispense
        price: 50,
      },
      {
        externalPosId: "pos-depleted",
        name: "Syrup 100ml",
        stock: 0, // Out-of-stock must NOT be dropped!
        price: 120,
      },
    ];

    const coalesced = coalesceSyncItems(rawItems);
    expect(coalesced).toHaveLength(3);

    const panadol = coalesced.find((i) => i.externalPosId === "pos-panadol");
    expect(panadol?.stock).toBe(17);

    const amox = coalesced.find((i) => i.externalPosId === "pos-amox");
    expect(amox?.stock).toBe(5);

    const depleted = coalesced.find((i) => i.externalPosId === "pos-depleted");
    expect(depleted?.stock).toBe(0);

    expect(coalesceSyncItems(null as any)).toEqual([]);
    expect(coalesceSyncItems(undefined as any)).toEqual([]);
    expect(coalesceSyncItems([])).toEqual([]);
  });

  it("flushQueue coalesces pending items before transmitting payload to Sphere", async () => {
    (global as any).chrome.storage.local.store = {
      sphere_endpoint_url: "https://sphere.pharmacy/api/sync",
      sphere_api_key: "test-key",
      sphere_sync_enabled: true,
      sphere_pharmacy_id: "BRANCH-01",
    };

    const mockPending = [
      {
        id: 1,
        externalPosId: "med-1",
        payload: { externalPosId: "med-1", name: "Drug A", stock: 10 },
        status: "PENDING" as const,
        retryCount: 0,
        createdAt: 1000,
        updatedAt: 1000,
      },
      {
        id: 2,
        externalPosId: "med-1",
        payload: { externalPosId: "med-1", name: "Drug A", stock: 8 }, // newer dispense
        status: "PENDING" as const,
        retryCount: 0,
        createdAt: 2000,
        updatedAt: 2000,
      },
    ];

    vi.spyOn(SyncQueueManager, "getPending")
      .mockResolvedValueOnce(mockPending as any)
      .mockResolvedValue([]);
    vi.spyOn(SyncQueueManager, "markSyncing").mockResolvedValue();
    const markSuccessSpy = vi
      .spyOn(SyncQueueManager, "markSuccess")
      .mockResolvedValue();

    let capturedBody: any = null;
    global.fetch = vi
      .fn()
      .mockImplementation(async (_url: string, opts: any) => {
        capturedBody = JSON.parse(opts.body);
        return {
          ok: true,
          status: 200,
          json: async () => ({ success: true }),
        };
      });

    const result = await SphereSyncClient.flushQueue();
    expect(result.synced).toBe(2);
    expect(markSuccessSpy).toHaveBeenCalledWith([1, 2]);

    // Transmitted items should have only 1 coalesced item with stock: 8
    expect(capturedBody.items).toHaveLength(1);
    expect(capturedBody.items[0].stock).toBe(8);
  });

  it("handles fetch AbortError timeout cleanly in flushQueue and testConnection", async () => {
    const abortErr = new Error("The operation was aborted");
    abortErr.name = "AbortError";

    global.fetch = vi.fn().mockRejectedValue(abortErr);

    const testRes = await SphereSyncClient.testConnection({
      endpointUrl: "https://sphere.pharmacy/api/sync",
      apiKey: "test-key",
      enabled: true,
    });

    expect(testRes.ok).toBe(false);
    expect(testRes.error).toContain("timed out after 15 seconds");
  });
});
