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
});
