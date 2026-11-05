import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { db } from "../../src/data/db";
import {
  sessionRepo,
  rawResponseRepo,
  recordRepo,
  sourceRepo,
  schemaRepo,
  errorRepo,
  activityRepo,
} from "../../src/data/repositories";
import { captureController } from "../../src/background/capture-controller";

function createMockTable<T extends { id?: any; sessionId?: string }>() {
  let items: T[] = [];
  return {
    _getItems: () => items,
    put: vi.fn(async (item: T) => {
      const idx = items.findIndex(
        (i) => i.id !== undefined && i.id === item.id,
      );
      if (idx >= 0) {
        items[idx] = { ...items[idx], ...item };
      } else {
        items.push({ ...item });
      }
      return item.id;
    }),
    bulkPut: vi.fn(async (newItems: T[]) => {
      for (const item of newItems) {
        const idx = items.findIndex(
          (i) => i.id !== undefined && i.id === item.id,
        );
        if (idx >= 0) items[idx] = { ...items[idx], ...item };
        else items.push({ ...item });
      }
    }),
    get: vi.fn(async (id: any) => {
      return items.find((i) => i.id === id);
    }),
    update: vi.fn(async (id: any, changes: Partial<T>) => {
      const item = items.find((i) => i.id === id);
      if (item) {
        Object.assign(item, changes);
      }
    }),
    delete: vi.fn(async (id: any) => {
      items = items.filter((i) => i.id !== id);
    }),
    clear: vi.fn(async () => {
      items = [];
    }),
    count: vi.fn(async () => items.length),
    toArray: vi.fn(async () => [...items]),
    orderBy: vi.fn(() => ({
      reverse: () => ({
        toArray: async () => [...items],
      }),
    })),
    where: vi.fn((field: string) => ({
      equals: (val: any) => ({
        delete: vi.fn(async () => {
          const before = items.length;
          items = items.filter((i) => (i as any)[field] !== val);
          return before - items.length;
        }),
        toArray: vi.fn(async () =>
          items.filter((i) => (i as any)[field] === val),
        ),
        count: vi.fn(
          async () => items.filter((i) => (i as any)[field] === val).length,
        ),
        limit: (n: number) => ({
          toArray: async () =>
            items.filter((i) => (i as any)[field] === val).slice(0, n),
        }),
        filter: (pred: (item: T) => boolean) => ({
          toArray: async () =>
            items.filter((i) => (i as any)[field] === val && pred(i)),
        }),
      }),
      anyOf: (vals: any[]) => ({
        first: vi.fn(async () =>
          items.find((i) => vals.includes((i as any)[field])),
        ),
        toArray: vi.fn(async () =>
          items.filter((i) => vals.includes((i as any)[field])),
        ),
      }),
    })),
  };
}

describe("Clear Tab Data & Reset Captured Data", () => {
  beforeEach(async () => {
    // Reset fake chrome runtime if any
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
      action: {
        setBadgeText: vi.fn().mockResolvedValue(undefined),
        setBadgeBackgroundColor: vi.fn().mockResolvedValue(undefined),
      },
      debugger: {
        attach: vi.fn().mockResolvedValue(undefined),
        detach: vi.fn().mockResolvedValue(undefined),
        sendCommand: vi.fn().mockResolvedValue(undefined),
      },
    };

    // Attach mock tables to db
    (db as any).capture_sessions = createMockTable();
    (db as any).raw_responses = createMockTable();
    (db as any).extracted_records = createMockTable();
    (db as any).sources = createMockTable();
    (db as any).schemas = createMockTable();
    (db as any).capture_errors = createMockTable();
    (db as any).activity_events = createMockTable();
    (db as any).sync_queue = createMockTable();

    (db as any).transaction = async (
      _mode: any,
      _tables: any,
      cb: () => Promise<any>,
    ) => {
      return await cb();
    };
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("sessionRepo.clearSessionData purges raw traffic, extracted records, schemas, sources, errors, and sync queue for target session", async () => {
    const sessionA = await sessionRepo.createSession({
      targetTabId: 101,
      originalUrl: "https://shop.example.com",
      allowedHostnames: ["shop.example.com"],
      label: "Shop Tab",
    });

    const sessionB = await sessionRepo.createSession({
      targetTabId: 102,
      originalUrl: "https://other.example.com",
      allowedHostnames: ["other.example.com"],
      label: "Other Tab",
    });

    // Populate data for Session A
    await rawResponseRepo.addResponse({
      id: "resp_a1",
      sessionId: sessionA.id,
      capturedAt: new Date().toISOString(),
      url: "https://shop.example.com/api/products",
      normalizedEndpoint: "https://shop.example.com/api/products",
      httpStatus: 200,
      httpMethod: "GET",
      resourceType: "Fetch",
      mimeType: "application/json",
      responseBody: '{"products":[{"id":1}]}',
      parseStatus: "parsed",
      responseBytes: 30,
    });

    await recordRepo.upsertRecords(
      [
        {
          id: "rec_a1",
          sessionId: sessionA.id,
          sourceId: "src_a1",
          identityKey: "1",
          extractedAt: new Date().toISOString(),
          latestResponseId: "resp_a1",
          rawRecord: { id: 1, name: "Item A" },
          version: 1,
        },
      ],
      [],
    );

    await sourceRepo.getOrCreateSource({
      sessionId: sessionA.id,
      url: "https://shop.example.com/api/products",
      httpMethod: "GET",
      parsedBody: { products: [{ id: 1 }] },
    });

    await schemaRepo.saveSchema({
      sourceId: "src_a1",
      sessionId: sessionA.id,
      inferredRecordPath: "products",
      fields: {
        id: {
          path: "id",
          types: ["number"],
          optional: false,
          sampleValues: [1],
          hasConflict: false,
        },
      },
      detectedCount: 1,
      updatedAt: new Date().toISOString(),
    });

    await errorRepo.logError({
      sessionId: sessionA.id,
      kind: "parse_error",
      message: "Minor parse warning",
    });

    await db.sync_queue.put({
      id: 1,
      externalPosId: "pos_1",
      payload: { name: "Med A" },
      status: "PENDING",
      retryCount: 0,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });

    // Populate data for Session B to verify ISOLATION
    await rawResponseRepo.addResponse({
      id: "resp_b1",
      sessionId: sessionB.id,
      capturedAt: new Date().toISOString(),
      url: "https://other.example.com/api/users",
      normalizedEndpoint: "https://other.example.com/api/users",
      httpStatus: 200,
      httpMethod: "GET",
      resourceType: "Fetch",
      mimeType: "application/json",
      responseBody: '{"users":[]}',
      parseStatus: "parsed",
      responseBytes: 15,
    });

    await recordRepo.upsertRecords(
      [
        {
          id: "rec_b1",
          sessionId: sessionB.id,
          sourceId: "src_b1",
          identityKey: "b1",
          extractedAt: new Date().toISOString(),
          latestResponseId: "resp_b1",
          rawRecord: { id: "b1", name: "User B" },
          version: 1,
        },
      ],
      [],
    );

    // Verify Session A has responses and records before clearing
    const beforeResponsesA = await rawResponseRepo.getAllBySession(sessionA.id);
    const beforeRecordsA = await recordRepo.getAllRecordsBySession(sessionA.id);
    expect(beforeResponsesA.length).toBe(1);
    expect(beforeRecordsA.length).toBe(1);

    // ACT: Clear Session A tab data
    const result = await sessionRepo.clearSessionData(sessionA.id, {
      clearSyncQueue: true,
    });

    expect(result.clearedResponses).toBe(1);
    expect(result.clearedRecords).toBe(1);
    expect(result.clearedSources).toBe(1);

    // Verify Session A data is completely empty
    const afterResponsesA = await rawResponseRepo.getAllBySession(sessionA.id);
    const afterRecordsA = await recordRepo.getAllRecordsBySession(sessionA.id);
    const afterSourcesA = await sourceRepo.getSourcesBySession(sessionA.id);
    const afterSchemasA = await schemaRepo.getSchemasBySession(sessionA.id);
    const afterErrorsA = await errorRepo.getErrorsBySession(sessionA.id);
    const syncQueueCount = await db.sync_queue.count();

    expect(afterResponsesA).toHaveLength(0);
    expect(afterRecordsA).toHaveLength(0);
    expect(afterSourcesA).toHaveLength(0);
    expect(afterSchemasA).toHaveLength(0);
    expect(afterErrorsA).toHaveLength(0);
    expect(syncQueueCount).toBe(0);

    // Verify Session A entity itself is preserved with lastResponseAt reset
    const reloadedSessionA = await sessionRepo.getSession(sessionA.id);
    expect(reloadedSessionA).toBeDefined();
    expect(reloadedSessionA?.id).toBe(sessionA.id);
    expect(reloadedSessionA?.lastResponseAt).toBeUndefined();

    // Verify Session A has an audit activity log entry recording the clear action
    const sessionAEvents = await activityRepo.getEventsBySession(sessionA.id);
    expect(sessionAEvents.length).toBeGreaterThan(0);
    expect(sessionAEvents[0].message).toContain("Cleared all captured data");

    // CRITICAL: Verify Session B data was NOT touched (isolation intact)
    const responsesB = await rawResponseRepo.getAllBySession(sessionB.id);
    const recordsB = await recordRepo.getAllRecordsBySession(sessionB.id);
    expect(responsesB).toHaveLength(1);
    expect(recordsB).toHaveLength(1);
  });

  it("sessionRepo.clearAllCapturedData wipes all data across all sessions and optionally preserves sessions", async () => {
    const s1 = await sessionRepo.createSession({
      targetTabId: 1,
      originalUrl: "https://tab1.com",
      allowedHostnames: ["tab1.com"],
    });
    await sessionRepo.createSession({
      targetTabId: 2,
      originalUrl: "https://tab2.com",
      allowedHostnames: ["tab2.com"],
    });

    await rawResponseRepo.addResponse({
      id: "r1",
      sessionId: s1.id,
      capturedAt: new Date().toISOString(),
      url: "https://tab1.com/api",
      normalizedEndpoint: "https://tab1.com/api",
      httpStatus: 200,
      httpMethod: "GET",
      resourceType: "Fetch",
      mimeType: "application/json",
      responseBody: "{}",
      parseStatus: "parsed",
      responseBytes: 10,
    });

    // Clear all with clearSessions: false (default retention)
    await sessionRepo.clearAllCapturedData({ clearSessions: false });

    expect(await db.raw_responses.count()).toBe(0);
    expect(await db.extracted_records.count()).toBe(0);
    expect(await db.sources.count()).toBe(0);
    expect(await db.capture_sessions.count()).toBe(2);

    // Now clear all with clearSessions: true
    await sessionRepo.clearAllCapturedData({ clearSessions: true });
    expect(await db.capture_sessions.count()).toBe(0);
  });

  it("captureController.clearTabData resets in-memory request queues, autoPaginate state, and clears DB", async () => {
    const session = await sessionRepo.createSession({
      targetTabId: 99,
      originalUrl: "https://demo.com",
      allowedHostnames: ["demo.com"],
    });

    await rawResponseRepo.addResponse({
      id: "resp_demo",
      sessionId: session.id,
      capturedAt: new Date().toISOString(),
      url: "https://demo.com/api/items",
      normalizedEndpoint: "https://demo.com/api/items",
      httpStatus: 200,
      httpMethod: "GET",
      resourceType: "Fetch",
      mimeType: "application/json",
      responseBody: "{}",
      parseStatus: "parsed",
      responseBytes: 20,
    });

    const result = await captureController.clearTabData(session.id, true);
    expect(result.clearedResponses).toBe(1);

    const autoState = captureController.getAutoPaginateState();
    expect(autoState.status).toBe("idle");

    const responses = await rawResponseRepo.getAllBySession(session.id);
    expect(responses).toHaveLength(0);
  });

  it("sessionRepo.clearSessionData respects clearSyncQueue: false", async () => {
    const session = await sessionRepo.createSession({
      targetTabId: 50,
      originalUrl: "https://queue.example.com",
      allowedHostnames: ["queue.example.com"],
    });

    await db.sync_queue.put({
      id: 99,
      externalPosId: "pos_preserve",
      payload: { name: "Retained" },
      status: "PENDING",
      retryCount: 0,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });

    await sessionRepo.clearSessionData(session.id, { clearSyncQueue: false });
    const count = await db.sync_queue.count();
    expect(count).toBe(1);
  });

  it("clearing an inactive session preserves active session's running autoPaginate, in-flight requests, and sync queue", async () => {
    const activeSession = await sessionRepo.createSession({
      targetTabId: 10,
      originalUrl: "https://active.com",
      allowedHostnames: ["active.com"],
      label: "Active Tab",
    });
    await sessionRepo.updateStatus(activeSession.id, "recording");

    const inactiveSession = await sessionRepo.createSession({
      targetTabId: 20,
      originalUrl: "https://inactive.com",
      allowedHostnames: ["inactive.com"],
      label: "Inactive Tab",
    });

    (captureController as any).currentSession = activeSession;
    (captureController as any).activeTabId = 10;
    (captureController as any).trackedRequests.set("active_req_1", {
      httpMethod: "GET",
      timestamp: Date.now(),
    });
    (captureController as any).autoPaginateState = {
      status: "running",
      pagesAttempted: 3,
      maxPages: 10,
      initialUniqueRecords: 5,
      currentUniqueRecords: 15,
      message: "Active pagination running...",
    };

    await db.sync_queue.put({
      id: 50,
      externalPosId: "active_pos_item",
      payload: { name: "Active Med" },
      status: "PENDING",
      retryCount: 0,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });

    // Populate data for inactive session
    await rawResponseRepo.addResponse({
      id: "resp_inactive",
      sessionId: inactiveSession.id,
      capturedAt: new Date().toISOString(),
      url: "https://inactive.com/api",
      normalizedEndpoint: "https://inactive.com/api",
      httpStatus: 200,
      httpMethod: "GET",
      resourceType: "Fetch",
      mimeType: "application/json",
      responseBody: "{}",
      parseStatus: "parsed",
      responseBytes: 10,
    });

    // Clear inactive session data
    const res = await captureController.clearTabData(inactiveSession.id, true);
    expect(res.clearedResponses).toBe(1);

    // Verify active session autoPaginate was NOT killed
    const autoState = captureController.getAutoPaginateState();
    expect(autoState.status).toBe("running");
    expect(autoState.message).toBe("Active pagination running...");

    // Verify active session's tracked requests were NOT wiped
    expect((captureController as any).trackedRequests.has("active_req_1")).toBe(
      true,
    );

    // Verify active session's sync queue was NOT wiped
    const queueCount = await db.sync_queue.count();
    expect(queueCount).toBe(1);
  });

  it("discards in-flight responses initiated prior to clearTabData", async () => {
    const session = await sessionRepo.createSession({
      targetTabId: 44,
      originalUrl: "https://racing.com",
      allowedHostnames: ["racing.com"],
    });
    await sessionRepo.updateStatus(session.id, "recording");
    (captureController as any).currentSession = session;
    (captureController as any).activeTabId = 44;

    const requestStartTime = Date.now() - 500;
    const pendingReq = {
      tabId: 44,
      requestId: "in_flight_1",
      url: "https://racing.com/api/products",
      httpMethod: "GET",
      httpStatus: 200,
      mimeType: "application/json",
      resourceType: "Fetch",
      timestamp: requestStartTime,
    };

    // Trigger clear AFTER the request was already in flight
    await captureController.clearTabData(session.id, true);

    // Now simulate in-flight response finishing
    await (captureController as any).processFinishedResponse(pendingReq);

    // Verify it was discarded and NOT persisted into IndexedDB
    const stored = await rawResponseRepo.getAllBySession(session.id);
    expect(stored).toHaveLength(0);
  });

  it("clearSessionData does not log ghost activity events when called on non-existent session ID", async () => {
    const res = await sessionRepo.clearSessionData("non-existent-uuid-12345");
    expect(res.clearedResponses).toBe(0);

    const events = await db.activity_events
      .where("sessionId")
      .equals("non-existent-uuid-12345")
      .toArray();
    expect(events).toHaveLength(0);
  });
});
