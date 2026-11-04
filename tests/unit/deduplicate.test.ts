import { describe, it, expect } from "vitest";
import {
  extractIdentityKey,
  generateStableContentHash,
  consolidateRecords,
} from "../../src/extraction/deduplicate";
import { ExtractedRecord } from "../../src/shared/types";

describe("deduplication engine", () => {
  it("extracts identity key from id, sku, or configured field", () => {
    expect(extractIdentityKey({ id: "abc-1" }).identityKey).toBe("abc-1");
    expect(extractIdentityKey({ sku: "sku-99" }).identityKey).toBe("sku-99");
    expect(
      extractIdentityKey({ customId: "xyz" }, "customId").identityKey,
    ).toBe("xyz");
  });

  it("generates deterministic content hash regardless of property key insertion order", () => {
    const objA = { b: 2, a: 1, nested: { y: 20, x: 10 } };
    const objB = { a: 1, b: 2, nested: { x: 10, y: 20 } };

    const hashA = generateStableContentHash(objA);
    const hashB = generateStableContentHash(objB);

    expect(hashA).toBe(hashB);
  });

  it("proves MVP Acceptance Criterion: 3 pages x 50 items = 150 items; revisiting page 1 retains 150 items", () => {
    const sessionId = "test-session";
    const sourceId = "med-api";

    // Page 1: 50 items (IDs 1..50)
    const page1Items = Array.from({ length: 50 }, (_, i) => ({
      id: `med-${i + 1}`,
      price: 10,
    }));
    let existingRecords: ExtractedRecord[] = [];

    const res1 = consolidateRecords({
      sessionId,
      sourceId,
      responseId: "resp-1",
      rawItems: page1Items,
      existingRecords,
      policy: "keep_latest",
    });
    existingRecords = [...res1.toInsert];
    expect(res1.uniqueCount).toBe(50);

    // Page 2: 50 items (IDs 51..100)
    const page2Items = Array.from({ length: 50 }, (_, i) => ({
      id: `med-${i + 51}`,
      price: 15,
    }));
    const res2 = consolidateRecords({
      sessionId,
      sourceId,
      responseId: "resp-2",
      rawItems: page2Items,
      existingRecords,
      policy: "keep_latest",
    });
    existingRecords = [...existingRecords, ...res2.toInsert];
    expect(res2.uniqueCount).toBe(100);

    // Page 3: 50 items (IDs 101..150)
    const page3Items = Array.from({ length: 50 }, (_, i) => ({
      id: `med-${i + 101}`,
      price: 20,
    }));
    const res3 = consolidateRecords({
      sessionId,
      sourceId,
      responseId: "resp-3",
      rawItems: page3Items,
      existingRecords,
      policy: "keep_latest",
    });
    existingRecords = [...existingRecords, ...res3.toInsert];
    expect(res3.uniqueCount).toBe(150);

    // Revisit Page 1 with updated price
    const page1RevisitItems = Array.from({ length: 50 }, (_, i) => ({
      id: `med-${i + 1}`,
      price: 99,
    }));
    const resRevisit = consolidateRecords({
      sessionId,
      sourceId,
      responseId: "resp-4",
      rawItems: page1RevisitItems,
      existingRecords,
      policy: "keep_latest",
    });

    // 0 new inserts, 50 updates, exactly 150 unique records
    expect(resRevisit.toInsert.length).toBe(0);
    expect(resRevisit.toUpdate.length).toBe(50);
    expect(resRevisit.uniqueCount).toBe(150);
    expect(resRevisit.toUpdate[0].version).toBe(2);
    expect((resRevisit.toUpdate[0].rawRecord as any).price).toBe(99);
  });
});
