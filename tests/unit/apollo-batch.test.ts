import { describe, it, expect, vi, beforeEach } from "vitest";
import { BandaGoNormalizer } from "../../src/extraction/bandago-normalizer";
import { SphereSyncClient } from "../../src/sync/sphere-client";
import { captureController } from "../../src/background/capture-controller";
import { extractOperationName } from "../../src/privacy/url-redaction";

describe("Batched Apollo GraphQL responses (Fix 4)", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("extracts candidate products from top-level batched Apollo response arrays", () => {
    const batchedPayload = [
      {
        data: {
          products: [
            {
              uu: "apollo-batch-001",
              name: "Amoxicillin 500mg Capsules",
              bh_sellprice: 450,
              quantityOnHand: 100,
            },
          ],
        },
      },
      {
        data: {
          visits: [
            {
              id: "visit-88",
              date: "2026-11-04",
            },
          ],
        },
      },
      {
        data: {
          products: [
            {
              uu: "apollo-batch-002",
              name: "Metformin 500mg Tablets",
              bh_sellprice: 180,
              quantityOnHand: 60,
            },
          ],
        },
      },
    ];

    const extracted =
      BandaGoNormalizer.extractProductsFromPayload(batchedPayload);
    expect(extracted).toHaveLength(2);
    expect(extracted.map((p) => p.externalPosId)).toEqual([
      "apollo-batch-001",
      "apollo-batch-002",
    ]);
    expect(extracted[0].name).toBe("Amoxicillin 500mg Capsules");
    expect(extracted[1].name).toBe("Metformin 500mg Tablets");
  });

  it("handleBandaGoPayload successfully enqueues products from batched Apollo response", async () => {
    const enqueueSpy = vi
      .spyOn(SphereSyncClient, "enqueue")
      .mockResolvedValue(1);

    const batchedPayload = [
      {
        data: {
          M_Product: [
            {
              id: "prod-batched-1",
              name: "Paracetamol 500mg Tabs",
              bh_sellprice: 50,
              quantityOnHand: 80,
            },
          ],
        },
      },
      {
        data: {
          unrelatedEntity: { info: "ignored" },
        },
      },
    ];

    await captureController.handleBandaGoPayload(
      "https://go.bandahealth.org/graphql",
      JSON.stringify([
        { operationName: "GetProducts" },
        { operationName: "GetUnrelated" },
      ]),
      batchedPayload,
    );

    expect(enqueueSpy).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({
          externalPosId: "prod-batched-1",
          name: "Paracetamol 500mg Tabs",
          stock: 80,
        }),
      ]),
    );
  });

  it("extractOperationName correctly handles single, array, and URL operation names", () => {
    const op = extractOperationName(
      "https://go.bandahealth.org/graphql?operationName=GetInventory",
    );
    expect(op).toBe("GetInventory");

    const jsonOp = extractOperationName(
      "https://go.bandahealth.org/graphql",
      JSON.stringify({ operationName: "FetchStock" }),
    );
    expect(jsonOp).toBe("FetchStock");

    const batchOp = extractOperationName(
      "https://go.bandahealth.org/graphql",
      JSON.stringify([
        { operationName: "BatchFirstOp" },
        { operationName: "BatchSecondOp" },
      ]),
    );
    expect(batchOp).toBe("BatchFirstOp");
  });

  it("handles mixed batched Apollo response where one operation has errors and another has products", async () => {
    const enqueueSpy = vi
      .spyOn(SphereSyncClient, "enqueue")
      .mockResolvedValue(1);

    const mixedBatchPayload = [
      {
        errors: [
          {
            message: "Field 'unknownField' not found on type 'Query'",
          },
        ],
      },
      {
        data: {
          products: [
            {
              uu: "prod-mixed-001",
              name: "Diclofenac Sodium 50mg",
              bh_sellprice: 150,
              quantityOnHand: 45,
            },
          ],
        },
      },
    ];

    // Normalizer should cleanly extract the product without throwing on the error envelope
    const extracted =
      BandaGoNormalizer.extractProductsFromPayload(mixedBatchPayload);
    expect(extracted).toHaveLength(1);
    expect(extracted[0].externalPosId).toBe("prod-mixed-001");
    expect(extracted[0].name).toBe("Diclofenac Sodium 50mg");

    // handleBandaGoPayload should enqueue the valid products despite error sibling
    await captureController.handleBandaGoPayload(
      "https://go.bandahealth.org/graphql",
      JSON.stringify([
        { operationName: "FailingQuery" },
        { operationName: "GetDiclofenac" },
      ]),
      mixedBatchPayload,
    );

    expect(enqueueSpy).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({
          externalPosId: "prod-mixed-001",
          stock: 45,
        }),
      ]),
    );
  });
});
