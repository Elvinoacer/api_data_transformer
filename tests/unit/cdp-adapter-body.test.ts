import { describe, it, expect } from "vitest";
import { CdpNetworkAdapter } from "../../src/background/cdp-adapter";

describe("CdpNetworkAdapter request body hooks", () => {
  it("captures requestWillBeSent postData and matches it upon responseReceived", () => {
    const adapter = new CdpNetworkAdapter();
    const emitted: any[] = [];
    adapter.onResponse((res) => emitted.push(res));

    // 1. Outgoing GraphQL POST request
    adapter.handleDebuggerEvent({ tabId: 1 }, "Network.requestWillBeSent", {
      requestId: "req-001",
      request: {
        method: "POST",
        url: "https://go.bandahealth.org/graphql",
        postData: JSON.stringify({
          operationName: "GetPharmacyInventory",
          query: "query GetPharmacyInventory { products { id name } }",
        }),
      },
    });

    expect(adapter.getRequestPayload("req-001")).toContain(
      "GetPharmacyInventory",
    );

    // 2. Incoming response
    adapter.handleDebuggerEvent({ tabId: 1 }, "Network.responseReceived", {
      requestId: "req-001",
      response: {
        url: "https://go.bandahealth.org/graphql",
        status: 200,
        mimeType: "application/json",
      },
    });

    expect(emitted.length).toBe(1);
    expect(emitted[0].requestId).toBe("req-001");
    expect(emitted[0].postData).toContain("GetPharmacyInventory");
    expect(emitted[0].status).toBe(200);
  });

  it("captures Authorization header from GraphQL request and caches it", async () => {
    const adapter = new CdpNetworkAdapter();

    adapter.handleDebuggerEvent({ tabId: 1 }, "Network.requestWillBeSent", {
      requestId: "req-auth-1",
      request: {
        method: "POST",
        url: "https://go.bandahealth.org/graphql",
        headers: {
          Authorization: "Bearer captured-jwt-token-789",
        },
        postData: "{}",
      },
    });

    const token = await CdpNetworkAdapter.getAuthHeader(
      "https://go.bandahealth.org",
    );
    expect(token).toBe("Bearer captured-jwt-token-789");
  });

  it("immediately deletes requestId from map on Network.loadingFailed", () => {
    const adapter = new CdpNetworkAdapter();

    adapter.handleDebuggerEvent({ tabId: 1 }, "Network.requestWillBeSent", {
      requestId: "req-aborted",
      request: {
        method: "GET",
        url: "https://go.bandahealth.org/api/status",
        postData: "test-data",
      },
    });

    expect(adapter.getRequestPayload("req-aborted")).toBe("test-data");

    // Browser network error / abort
    adapter.handleDebuggerEvent({ tabId: 1 }, "Network.loadingFailed", {
      requestId: "req-aborted",
      errorText: "net::ERR_ABORTED",
    });

    expect(adapter.getRequestPayload("req-aborted")).toBeUndefined();
  });

  it("evicts stale requests older than 60 seconds (TTL cleanup)", () => {
    const adapter = new CdpNetworkAdapter();

    // Insert active request
    adapter.handleDebuggerEvent({ tabId: 1 }, "Network.requestWillBeSent", {
      requestId: "req-fresh",
      request: {
        method: "POST",
        url: "https://go.bandahealth.org/graphql",
        postData: "fresh-payload",
      },
    });

    // Manually simulate a 65-second-old request
    (adapter as any).requestPayloadMap.set("req-stale", {
      postData: "stale-payload",
      timestamp: Date.now() - 65000,
    });

    expect(adapter.getRequestPayload("req-stale")).toBe("stale-payload");
    expect(adapter.getRequestPayload("req-fresh")).toBe("fresh-payload");

    // Prune entries older than 60s (or trigger next debugger event)
    const evicted = adapter.pruneStale(60000);
    expect(evicted).toBe(1);

    expect(adapter.getRequestPayload("req-stale")).toBeUndefined();
    expect(adapter.getRequestPayload("req-fresh")).toBe("fresh-payload");
  });
});
