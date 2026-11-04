import { describe, it, expect } from "vitest";
import {
  inferDatasetLabel,
  humanizeIdentifier,
  slugifyLabel,
} from "../../src/extraction/label-inference";
import {
  detectPaginationFromResponse,
  mergePaginationState,
  getMissingPages,
  buildPageUrlsForSource,
} from "../../src/extraction/pagination-detector";
import { generateExportFilename } from "../../src/export/filenames";

describe("semantic dataset label inference & labeled filenames", () => {
  it("infers clean human labels from REST API endpoints", () => {
    expect(
      inferDatasetLabel({ url: "https://api.pharmacy.io/v2/medicines?page=1" }),
    ).toBe("Medicines");
    expect(
      inferDatasetLabel({ url: "https://shop.example.com/api/v1/customers" }),
    ).toBe("Customers");
    expect(
      inferDatasetLabel({
        url: "https://shop.example.com/api/customers/42/patient_orders",
      }),
    ).toBe("Patient Orders");
  });

  it("infers clean labels from GraphQL operation names", () => {
    expect(
      inferDatasetLabel({
        url: "https://api.example.com/graphql",
        operationName: "GetCustomersQuery",
      }),
    ).toBe("Customers");
    expect(
      inferDatasetLabel({
        url: "https://api.example.com/graphql",
        operationName: "ListActiveMedicinesConnection",
      }),
    ).toBe("Active Medicines");
  });

  it("falls back to domain-specific JSON recordPath keys when URL is generic", () => {
    expect(
      inferDatasetLabel({
        url: "https://api.example.com/api/query",
        recordPath: "data.dispensed_medicines",
      }),
    ).toBe("Dispensed Medicines");
  });

  it("humanizes camelCase and snake_case identifiers cleanly", () => {
    expect(humanizeIdentifier("customer_loyalty_tier")).toBe(
      "Customer Loyalty Tier",
    );
    expect(humanizeIdentifier("unitPriceUSD")).toBe("Unit Price USD");
    expect(slugifyLabel("Medicines & Supplies (Active)")).toBe(
      "medicines_supplies_active",
    );
  });

  it("generates clear label-first export filenames", () => {
    const fixedDate = new Date("2026-11-03T20:40:05");
    expect(
      generateExportFilename({
        label: "Medicines",
        site: "localhost",
        extension: "csv",
        includeTime: false,
        date: fixedDate,
      }),
    ).toBe("medicines_2026-11-03.csv");

    expect(
      generateExportFilename({
        label: "Customers",
        site: "clinic.example.com",
        extension: "csv",
        includeTime: false,
        date: fixedDate,
      }),
    ).toBe("customers_clinic_example_com_2026-11-03.csv");
  });
});

describe("multi-page API pagination detection & URL generation", () => {
  it("detects page-number pagination, totalPages, and synthesizes nextUrl", () => {
    const detected = detectPaginationFromResponse({
      url: "https://api.example.com/api/medicines?page=1&limit=50",
      parsedBody: {
        data: {
          items: [{ id: 1 }],
          page: 1,
          limit: 50,
          totalItems: 250,
          totalPages: 5,
        },
      },
      extractedCount: 50,
    });

    expect(detected.strategy).toBe("page");
    expect(detected.currentPage).toBe(1);
    expect(detected.totalPages).toBe(5);
    expect(detected.totalRecords).toBe(250);
    expect(detected.hasNextPage).toBe(true);
    expect(detected.nextUrl).toBe(
      "https://api.example.com/api/medicines?page=2&limit=50",
    );
  });

  it("detects cursor pagination and terminal page when nextCursor is null", () => {
    const page1 = detectPaginationFromResponse({
      url: "https://api.example.com/api/medications/cursor?limit=50",
      parsedBody: {
        results: [{ id: "m1" }],
        nextCursor: "cursor_50",
        total: 100,
      },
      extractedCount: 50,
    });
    expect(page1.strategy).toBe("cursor");
    expect(page1.hasNextPage).toBe(true);
    expect(page1.nextCursor).toBe("cursor_50");

    const lastPage = detectPaginationFromResponse({
      url: "https://api.example.com/api/medications/cursor?cursor=cursor_50&limit=50",
      parsedBody: {
        results: [{ id: "m51" }],
        nextCursor: null,
        total: 100,
      },
      extractedCount: 50,
    });
    expect(lastPage.strategy).toBe("cursor");
    expect(lastPage.hasNextPage).toBe(false);
  });

  it("tracks observed pages, computes missing pages, and builds remaining page URLs", () => {
    const p1 = detectPaginationFromResponse({
      url: "https://api.example.com/api/customers?page=1&limit=30",
      parsedBody: {
        meta: { currentPage: 1, perPage: 30, totalPages: 4, totalCount: 120 },
      },
      extractedCount: 30,
    });
    let state = mergePaginationState(
      undefined,
      p1,
      "https://api.example.com/api/customers?page=1&limit=30",
    );

    const p3 = detectPaginationFromResponse({
      url: "https://api.example.com/api/customers?page=3&limit=30",
      parsedBody: {
        meta: { currentPage: 3, perPage: 30, totalPages: 4, totalCount: 120 },
      },
      extractedCount: 30,
    });
    state = mergePaginationState(
      state,
      p3,
      "https://api.example.com/api/customers?page=3&limit=30",
    );

    expect(state?.observedPages).toEqual([1, 3]);
    expect(getMissingPages(state)).toEqual([2, 4]);

    const urls = buildPageUrlsForSource(state!, 10);
    expect(urls).toEqual([
      "https://api.example.com/api/customers?page=2&limit=30",
      "https://api.example.com/api/customers?page=4&limit=30",
    ]);
  });
});
