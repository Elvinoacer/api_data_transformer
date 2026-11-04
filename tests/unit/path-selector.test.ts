import { describe, it, expect } from "vitest";
import {
  extractItemsByPath,
  findCandidatePaths,
  inferBestRecordPath,
} from "../../src/extraction/path-selector";

describe("path selector", () => {
  it('extracts top-level arrays when path is "root"', () => {
    const data = [{ id: 1 }, { id: 2 }];
    expect(extractItemsByPath(data, "root")).toEqual(data);
  });

  it("extracts nested array by dot notation path", () => {
    const data = {
      data: {
        items: [{ id: 1 }, { id: 2 }],
      },
    };
    expect(extractItemsByPath(data, "data.items")).toEqual([
      { id: 1 },
      { id: 2 },
    ]);
  });

  it("automatically detects candidate paths and ranks best path", () => {
    const data = {
      status: "ok",
      results: [
        { id: 1, name: "Item 1" },
        { id: 2, name: "Item 2" },
      ],
      pagination: { total: 2 },
    };

    const candidates = findCandidatePaths(data);
    expect(candidates.some((c) => c.path === "results")).toBe(true);
    expect(inferBestRecordPath(data)).toBe("results");
  });

  it("handles data.items nested pattern", () => {
    const data = {
      data: {
        items: [{ id: 10 }],
        cursor: "abc",
      },
    };
    expect(inferBestRecordPath(data)).toBe("data.items");
  });

  it("detects BandaGo GraphQL data.products and infers uu as identity key", async () => {
    const { inferBestIdentityKey } =
      await import("../../src/extraction/path-selector");
    const bandagoGql = {
      data: {
        products: [
          {
            uu: "uu-1",
            value: "AMX-500",
            name: "Amoxicillin 500mg",
            bh_sellprice: 450,
          },
          {
            uu: "uu-2",
            value: "MET-500",
            name: "Metformin 500mg",
            bh_sellprice: 250,
          },
        ],
      },
    };

    expect(inferBestRecordPath(bandagoGql)).toBe("data.products");
    const items = extractItemsByPath(bandagoGql, "data.products");
    expect(items.length).toBe(2);
    expect(inferBestIdentityKey(items)).toBe("uu");
  });
});
