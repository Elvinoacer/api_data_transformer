import { describe, it, expect } from "vitest";
import { inferSchemaFromRecords } from "../../src/extraction/schema-inference";

describe("schema inference engine", () => {
  it("infers field paths, types, and marks optional fields when absent in some items", () => {
    const records = [
      { id: "1", name: "Product A", price: 10.5, inStock: true },
      { id: "2", name: "Product B", inStock: false }, // price absent
    ];

    const schema = inferSchemaFromRecords({
      sourceId: "src-1",
      sessionId: "sess-1",
      inferredRecordPath: "items",
      records,
    });

    expect(schema.fields["id"].types).toEqual(["string"]);
    expect(schema.fields["id"].optional).toBe(false);

    expect(schema.fields["price"].types).toEqual(["number"]);
    expect(schema.fields["price"].optional).toBe(true);
    expect(schema.fields["price"].hasConflict).toBe(false);
  });

  it("detects type conflicts when a field appears with multiple distinct primitive types", () => {
    const records = [
      { id: "1", score: 100 },
      { id: "2", score: "N/A" },
    ];

    const schema = inferSchemaFromRecords({
      sourceId: "src-1",
      sessionId: "sess-1",
      inferredRecordPath: "items",
      records,
    });

    expect(schema.fields["score"].hasConflict).toBe(true);
    expect(schema.fields["score"].types).toContain("number");
    expect(schema.fields["score"].types).toContain("string");
  });
});
