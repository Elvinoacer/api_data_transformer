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

    vi.spyOn(SyncQueueManager, "getPending")
      .mockResolvedValueOnce(mockPending)
      .mockResolvedValue([]);
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

  it("SyncQueueManager.enqueue merges existing PENDING/FAILED payload with incoming payload", async () => {
    const updateSpy = vi.fn();
    const origTransaction = db.transaction;
    const origWhere = db.sync_queue.where;

    const existingPendingItem = {
      id: 42,
      externalPosId: "pos-merge-1",
      status: "PENDING" as const,
      payload: {
        externalPosId: "pos-merge-1",
        name: "Amoxicillin 500mg",
        stock: 30,
        price: 400,
        batches: [
          { batchNumber: "LOT-001", qtyOnHand: 30, expiryDate: "2027-01-01" },
        ],
      },
    };

    (db as any).transaction = async (
      _mode: string,
      _table: any,
      cb: () => Promise<void>,
    ) => {
      await cb();
    };
    (db.sync_queue as any).update = updateSpy;
    (db.sync_queue as any).where = vi.fn().mockReturnValue({
      equals: vi.fn().mockReturnValue({
        first: vi.fn().mockResolvedValue(existingPendingItem),
      }),
    });

    const incomingCatalogItem = {
      externalPosId: "pos-merge-1",
      name: "Amoxicillin 500mg Capsules",
      sku: "KNHTS-AMX-500",
      genericName: "Amoxicillin Trihydrate",
      price: 450,
      stock: 30,
      inStock: true,
      requiresPrescription: true,
      imageUrl: "/images/cat-rx.webp",
      nearestExpiryDate: null,
      categorySlug: "prescription",
      slug: "amoxicillin-500mg-pos-me",
      batches: [],
    };

    await SyncQueueManager.enqueue([incomingCatalogItem as any]);

    expect(updateSpy).toHaveBeenCalledWith(
      42,
      expect.objectContaining({
        status: "PENDING",
        payload: expect.objectContaining({
          externalPosId: "pos-merge-1",
          sku: "KNHTS-AMX-500",
          genericName: "Amoxicillin Trihydrate",
          batches: expect.arrayContaining([
            expect.objectContaining({ batchNumber: "LOT-001", qtyOnHand: 30 }),
          ]),
        }),
      }),
    );

    db.transaction = origTransaction;
    db.sync_queue.where = origWhere;
  });

  it("coalesceSyncItems merges batches and metadata instead of clobbering", () => {
    const itemPage1 = {
      externalPosId: "pos-multi-batch",
      name: "Paracetamol 500mg",
      stock: 20,
      price: 50,
      batches: [
        { batchNumber: "LOT-A", qtyOnHand: 20, expiryDate: "2027-06-01" },
      ],
    };
    const itemPage2 = {
      externalPosId: "pos-multi-batch",
      name: "Paracetamol 500mg",
      sku: "SKU-PARA-500",
      genericName: "Paracetamol",
      stock: 30,
      price: 50,
      batches: [
        { batchNumber: "LOT-B", qtyOnHand: 30, expiryDate: "2027-09-01" },
      ],
    };

    const coalesced = coalesceSyncItems([itemPage1 as any, itemPage2 as any]);
    expect(coalesced).toHaveLength(1);
    expect(coalesced[0].stock).toBe(50);
    expect(coalesced[0].sku).toBe("SKU-PARA-500");
    expect(coalesced[0].genericName).toBe("Paracetamol");
    expect(coalesced[0].batches).toHaveLength(2);
  });

  it("flushQueue drains items that arrive mid-flush without stopping on batch < BATCH_SIZE", async () => {
    (global as any).chrome.storage.local.store = {
      sphere_endpoint_url: "https://sphere.pharmacy/api/sync",
      sphere_api_key: "test-key",
      sphere_sync_enabled: true,
    };

    const initialSmallBatch = [
      {
        id: 1,
        externalPosId: "pos-small-1",
        payload: { name: "Drug A", stock: 10 },
        status: "PENDING" as const,
        retryCount: 0,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      },
    ];

    const arrivingMidFlight = [
      {
        id: 2,
        externalPosId: "pos-mid-2",
        payload: { name: "Drug B", stock: 20 },
        status: "PENDING" as const,
        retryCount: 0,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      },
    ];

    vi.spyOn(SyncQueueManager, "getPending")
      .mockResolvedValueOnce(initialSmallBatch as any)
      .mockResolvedValueOnce(arrivingMidFlight as any)
      .mockResolvedValue([]);

    vi.spyOn(SyncQueueManager, "markSyncing").mockResolvedValue();
    const markSuccessSpy = vi
      .spyOn(SyncQueueManager, "markSuccess")
      .mockResolvedValue();

    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ success: true }),
    } as any);

    const result = await SphereSyncClient.flushQueue();
    // Both initial small batch (1 item < 50) and arriving items (1 item) should be drained!
    expect(result.synced).toBe(2);
    expect(markSuccessSpy).toHaveBeenCalledWith([1]);
    expect(markSuccessSpy).toHaveBeenCalledWith([2]);
  });

  it("flushQueue supports draining up to 100 batches (5,000 items)", async () => {
    (global as any).chrome.storage.local.store = {
      sphere_endpoint_url: "https://sphere.pharmacy/api/sync",
      sphere_api_key: "test-key",
      sphere_sync_enabled: true,
    };

    // Simulate 15 consecutive batches of 50 items (750 items, exceeding previous 10-batch / 500-item cap)
    const mockBatches = Array.from({ length: 15 }, (_, batchIdx) =>
      Array.from({ length: 50 }, (_, itemIdx) => ({
        id: batchIdx * 50 + itemIdx + 1,
        externalPosId: `pos-${batchIdx}-${itemIdx}`,
        payload: { name: `Drug ${batchIdx}-${itemIdx}`, stock: 10 },
        status: "PENDING" as const,
        retryCount: 0,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      })),
    );

    const getPendingSpy = vi.spyOn(SyncQueueManager, "getPending");
    for (const b of mockBatches) {
      getPendingSpy.mockResolvedValueOnce(b as any);
    }
    getPendingSpy.mockResolvedValue([]);

    vi.spyOn(SyncQueueManager, "markSyncing").mockResolvedValue();
    vi.spyOn(SyncQueueManager, "markSuccess").mockResolvedValue();

    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ success: true }),
    } as any);

    const result = await SphereSyncClient.flushQueue();
    // Should have drained all 15 batches (15 * 50 = 750 items)
    expect(result.synced).toBe(750);
  });

  it("flushQueue drains re-enqueued items with the same id arriving mid-flush without dropping them", async () => {
    (global as any).chrome.storage.local.store = {
      sphere_endpoint_url: "https://sphere.pharmacy/api/sync",
      sphere_api_key: "test-key",
      sphere_sync_enabled: true,
    };

    // Item 1 is in batch 1, then re-enqueued mid-flight (keeps same Dexie id: 1) for batch 2
    const batch1 = [
      {
        id: 1,
        externalPosId: "pos-re-enqueued",
        payload: { name: "Drug A", stock: 20 },
        status: "PENDING" as const,
        retryCount: 0,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      },
    ];

    const batch2ReEnqueued = [
      {
        id: 1,
        externalPosId: "pos-re-enqueued",
        payload: { name: "Drug A", stock: 15 }, // newer dispense
        status: "PENDING" as const,
        retryCount: 0,
        createdAt: Date.now(),
        updatedAt: Date.now() + 100,
      },
    ];

    vi.spyOn(SyncQueueManager, "getPending")
      .mockResolvedValueOnce(batch1 as any)
      .mockResolvedValueOnce(batch2ReEnqueued as any)
      .mockResolvedValue([]);

    vi.spyOn(SyncQueueManager, "markSyncing").mockResolvedValue();
    const markSuccessSpy = vi
      .spyOn(SyncQueueManager, "markSuccess")
      .mockResolvedValue();

    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ success: true }),
    } as any);

    const result = await SphereSyncClient.flushQueue();
    // Both initial batch and re-enqueued same-id item must be flushed
    expect(result.synced).toBe(2);
    expect(markSuccessSpy).toHaveBeenCalledTimes(2);
    expect(markSuccessSpy).toHaveBeenNthCalledWith(1, [1]);
    expect(markSuccessSpy).toHaveBeenNthCalledWith(2, [1]);
  });

  it("SyncQueueManager.enqueue merges payload when existing item is in SYNCING state", async () => {
    const updateSpy = vi.fn();
    const origTransaction = db.transaction;
    const origWhere = db.sync_queue.where;

    const existingSyncingItem = {
      id: 88,
      externalPosId: "pos-syncing-1",
      status: "SYNCING" as const,
      payload: {
        externalPosId: "pos-syncing-1",
        name: "Amoxicillin 500mg",
        stock: 25,
        price: 400,
        batches: [
          { batchNumber: "LOT-SYNC-1", qtyOnHand: 25, expiryDate: "2027-01-01" },
        ],
      },
    };

    (db as any).transaction = async (
      _mode: string,
      _table: any,
      cb: () => Promise<void>,
    ) => {
      await cb();
    };
    (db.sync_queue as any).update = updateSpy;
    (db.sync_queue as any).where = vi.fn().mockReturnValue({
      equals: vi.fn().mockReturnValue({
        first: vi.fn().mockResolvedValue(existingSyncingItem),
      }),
    });

    const incomingCatalogItem = {
      externalPosId: "pos-syncing-1",
      name: "Amoxicillin 500mg Capsules",
      sku: "KNHTS-AMX-SYNC",
      genericName: "Amoxicillin Trihydrate",
      price: 450,
      stock: 25,
      inStock: true,
      requiresPrescription: true,
      imageUrl: "/images/cat-rx.webp",
      nearestExpiryDate: null,
      categorySlug: "prescription",
      slug: "amoxicillin-500mg-pos-sy",
      batches: [],
    };

    await SyncQueueManager.enqueue([incomingCatalogItem as any]);

    expect(updateSpy).toHaveBeenCalledWith(
      88,
      expect.objectContaining({
        status: "PENDING",
        payload: expect.objectContaining({
          externalPosId: "pos-syncing-1",
          sku: "KNHTS-AMX-SYNC",
          genericName: "Amoxicillin Trihydrate",
          batches: expect.arrayContaining([
            expect.objectContaining({
              batchNumber: "LOT-SYNC-1",
              qtyOnHand: 25,
            }),
          ]),
        }),
      }),
    );

    db.transaction = origTransaction;
    db.sync_queue.where = origWhere;
  });

  it("coalesceSyncItems does not sum duplicate batches across sequential dispenses", () => {
    const dispense1 = {
      externalPosId: "pos-dispense-test",
      name: "Paracetamol 500mg",
      stock: 20,
      price: 50,
      inStock: true,
      batches: [
        { batchNumber: "LOT-A", qtyOnHand: 20, expiryDate: "2027-06-01" },
      ],
    };
    const dispense2 = {
      externalPosId: "pos-dispense-test",
      name: "Paracetamol 500mg",
      stock: 18,
      price: 50,
      inStock: true,
      batches: [
        { batchNumber: "LOT-A", qtyOnHand: 18, expiryDate: "2027-06-01" },
      ],
    };
    const dispense3 = {
      externalPosId: "pos-dispense-test",
      name: "Paracetamol 500mg",
      stock: 15,
      price: 50,
      inStock: true,
      batches: [
        { batchNumber: "LOT-A", qtyOnHand: 15, expiryDate: "2027-06-01" },
      ],
    };

    const coalesced = coalesceSyncItems([
      dispense1 as any,
      dispense2 as any,
      dispense3 as any,
    ]);

    expect(coalesced).toHaveLength(1);
    expect(coalesced[0].stock).toBe(15); // NOT 20 + 18 + 15 = 53!
    expect(coalesced[0].batches).toHaveLength(1);
    expect(coalesced[0].batches[0].qtyOnHand).toBe(15);
  });

  it("coalesceSyncItems cleanly transitions item to out-of-stock and clears batches", () => {
    const inStockState = {
      externalPosId: "pos-stockout-test",
      name: "Ibuprofen 400mg",
      stock: 10,
      inStock: true,
      price: 80,
      batches: [
        { batchNumber: "LOT-IBU-1", qtyOnHand: 10, expiryDate: "2027-12-01" },
      ],
    };
    const outOfStockState = {
      externalPosId: "pos-stockout-test",
      name: "Ibuprofen 400mg",
      stock: 0,
      inStock: false,
      price: 80,
      batches: [],
    };

    const coalesced = coalesceSyncItems([
      inStockState as any,
      outOfStockState as any,
    ]);

    expect(coalesced).toHaveLength(1);
    expect(coalesced[0].stock).toBe(0);
    expect(coalesced[0].inStock).toBe(false);
    expect(coalesced[0].batches).toHaveLength(0);
  });

  it("flushQueue handles HTTP 200 with success: false by marking items failed and recording error diagnostics", async () => {
    (global as any).chrome.storage.local.store = {
      sphere_endpoint_url: "https://sphere.pharmacy/api/sync",
      sphere_api_key: "test-key",
      sphere_sync_enabled: true,
    };

    const mockPending = [
      {
        id: 501,
        externalPosId: "pos-bad-1",
        payload: { externalPosId: "pos-bad-1", name: "Invalid Item", stock: 5 },
        status: "PENDING" as const,
        retryCount: 0,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      },
    ];

    vi.spyOn(SyncQueueManager, "getPending")
      .mockResolvedValueOnce(mockPending as any)
      .mockResolvedValue([]);
    vi.spyOn(SyncQueueManager, "markSyncing").mockResolvedValue();
    const markSuccessSpy = vi
      .spyOn(SyncQueueManager, "markSuccess")
      .mockResolvedValue();
    const markFailedSpy = vi
      .spyOn(SyncQueueManager, "markFailed")
      .mockResolvedValue();

    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        success: false,
        synced: 0,
        failedCount: 1,
        errors: [
          {
            externalPosId: "pos-bad-1",
            error: "Missing required externalPosId or name",
          },
        ],
      }),
    } as any);

    const result = await SphereSyncClient.flushQueue();
    expect(result.synced).toBe(0);
    expect(result.failed).toBe(1);
    expect(result.error).toContain("Missing required externalPosId or name");
    expect(markSuccessSpy).not.toHaveBeenCalled();
    expect(markFailedSpy).toHaveBeenCalledWith(
      mockPending,
      "Missing required externalPosId or name",
      SphereSyncClient.MAX_RETRIES,
    );

    const diag = await SphereSyncClient.getDiagnostics();
    expect(diag.lastSyncError).toContain(
      "Missing required externalPosId or name",
    );
    expect(diag.errorHistory.length).toBeGreaterThan(0);
    expect(diag.errorHistory[0].source).toBe("SYNC_FLUSH");
  });

  it("flushQueue handles partial batch failure (HTTP 200 with errors array) by marking only succeeded items as success and failed items as failed", async () => {
    (global as any).chrome.storage.local.store = {
      sphere_endpoint_url: "https://sphere.pharmacy/api/sync",
      sphere_api_key: "test-key",
      sphere_sync_enabled: true,
    };

    const itemOk = {
      id: 601,
      externalPosId: "pos-ok-1",
      payload: {
        externalPosId: "pos-ok-1",
        name: "Amoxicillin 500mg",
        stock: 20,
      },
      status: "PENDING" as const,
      retryCount: 0,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    const itemFail = {
      id: 602,
      externalPosId: "pos-fail-2",
      payload: {
        externalPosId: "pos-fail-2",
        name: "Corrupt Drug",
        stock: 10,
      },
      status: "PENDING" as const,
      retryCount: 0,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    vi.spyOn(SyncQueueManager, "getPending")
      .mockResolvedValueOnce([itemOk, itemFail] as any)
      .mockResolvedValue([]);
    vi.spyOn(SyncQueueManager, "markSyncing").mockResolvedValue();
    const markSuccessSpy = vi
      .spyOn(SyncQueueManager, "markSuccess")
      .mockResolvedValue();
    const markFailedSpy = vi
      .spyOn(SyncQueueManager, "markFailed")
      .mockResolvedValue();

    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        success: true,
        upsertedCount: 1,
        failedCount: 1,
        errors: [
          {
            externalPosId: "pos-fail-2",
            name: "Corrupt Drug",
            error: "Unique constraint failed on the fields: (`sku`)",
          },
        ],
      }),
    } as any);

    const result = await SphereSyncClient.flushQueue();
    expect(result.synced).toBe(1);
    expect(result.failed).toBe(1);
    expect(result.error).toContain("Partial sync: 1 medication(s) failed");

    // Succeeded item is deleted from queue
    expect(markSuccessSpy).toHaveBeenCalledWith([601]);
    // Failed item is retained and marked failed with specific server error
    expect(markFailedSpy).toHaveBeenCalledWith(
      [itemFail],
      "Unique constraint failed on the fields: (`sku`)",
      SphereSyncClient.MAX_RETRIES,
    );

    const diag = await SphereSyncClient.getDiagnostics();
    expect(diag.lastSyncError).toContain("Partial sync");
    expect(diag.errorHistory[0]).toEqual(
      expect.objectContaining({
        source: "ITEM_UPSERT",
        externalPosId: "pos-fail-2",
        productName: "Corrupt Drug",
      }),
    );

    await SphereSyncClient.clearErrorHistory();
    const clearedDiag = await SphereSyncClient.getDiagnostics();
    expect(clearedDiag.errorHistory).toEqual([]);
    expect(clearedDiag.lastSyncError).toBeNull();
  });
});
