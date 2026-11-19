import { describe, it, expect, vi, afterEach } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";
import ts from "typescript";

describe("Zero-PHI Passive Content Scripts", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  function loadInterceptorInMockWindow() {
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
    const underlyingFetch = vi.fn().mockImplementation(async (_input: any, init: any) => {
      const reqBody = typeof init?.body === "string" ? JSON.parse(init.body) : {};
      if (reqBody.operationName === "BH_VisitGet") {
        return {
          ok: true,
          status: 200,
          clone() {
            return {
              json: async () => ({
                data: {
                  BH_VisitGet: { Results: [{ PatientName: "SENSITIVE PHI" }] },
                },
              }),
            };
          },
        };
      }
      if (reqBody.operationName === "M_StorageOnHandForInventoryList") {
        return {
          ok: true,
          status: 200,
          clone() {
            return {
              json: async () => ({
                data: {
                  M_StorageOnHandGet: { Results: [{ QtyOnHand: 12 }] },
                },
              }),
            };
          },
        };
      }
      return {
        ok: true,
        status: 200,
        clone() {
          return {
            json: async () => ({ data: { secretOrderData: "MUST_NOT_FORWARD" } }),
          };
        },
      };
    });

    const mockWindow: Record<string, any> = {
      location: { origin: "https://go.bandahealth.org" },
      fetch: underlyingFetch,
      postMessage: (message: any, origin: string) => {
        posted.push({ message, origin });
      },
      XMLHttpRequest: undefined,
    };

    const runner = new Function("window", "Request", compiled);
    runner(mockWindow, class MockRequest {});
    return { mockWindow, posted };
  }

  it("contains zero static ES import or export statements", () => {
    const mainSrc = readFileSync(
      resolve(__dirname, "../../src/content/main-interceptor.ts"),
      "utf8",
    );
    const bridgeSrc = readFileSync(
      resolve(__dirname, "../../src/content/isolated-bridge.ts"),
      "utf8",
    );
    expect(mainSrc).not.toMatch(/^\s*(import|export)\b/m);
    expect(bridgeSrc).not.toMatch(/^\s*(import|export)\b/m);
  });

  it("allows catalog reads, emits signal-only mutations, and drops clinical PHI queries", async () => {
    const { mockWindow, posted } = loadInterceptorInMockWindow();

    // 1. Clinical patient query MUST be completely ignored
    await mockWindow.fetch("/graphql/", {
      method: "POST",
      body: JSON.stringify({
        operationName: "BH_VisitGet",
        query: "query BH_VisitGet { BH_VisitGet { Results { PatientName } } }",
      }),
    });
    await new Promise((r) => setTimeout(r, 10));
    expect(posted).toHaveLength(0);

    // 2. Allowlisted inventory read forwards catalog payload
    await mockWindow.fetch("/graphql/", {
      method: "POST",
      body: JSON.stringify({
        operationName: "M_StorageOnHandForInventoryList",
        query: "query M_StorageOnHandForInventoryList { M_StorageOnHandGet { Results { QtyOnHand } } }",
      }),
    });
    await new Promise((r) => setTimeout(r, 10));
    expect(posted).toHaveLength(1);
    expect(posted[0].message).toEqual({
      source: "SPHERE_BANDAGO_MAIN",
      type: "BANDAGO_PASSIVE_CATALOG",
      operationName: "M_StorageOnHandForInventoryList",
      payload: { data: { M_StorageOnHandGet: { Results: [{ QtyOnHand: 12 }] } } },
    });

    // 3. Stock-changing mutation forwards strictly signal-only (zero payload)
    await mockWindow.fetch("/graphql", {
      method: "POST",
      body: JSON.stringify({
        operationName: "C_OrderProcess",
        query: "mutation C_OrderProcess { C_OrderProcess { UU } }",
      }),
    });
    await new Promise((r) => setTimeout(r, 10));
    expect(posted).toHaveLength(2);
    expect(posted[1].message).toEqual({
      source: "SPHERE_BANDAGO_MAIN",
      type: "BANDAGO_PASSIVE_MUTATION",
      operationName: "C_OrderProcess",
    });
    expect((posted[1].message as any).payload).toBeUndefined();
  });
});
