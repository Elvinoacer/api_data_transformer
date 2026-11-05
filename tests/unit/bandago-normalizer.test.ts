import { describe, it, expect } from "vitest";
import {
  BandaGoNormalizer,
  generateSlug,
  CATEGORY_MAP,
  RX_SCHEDULE_REGEX,
  STRENGTH_REGEX,
  DOSAGE_FORM_REGEX,
} from "../../src/extraction/bandago-normalizer";

describe("BandaGoNormalizer (FEFO & PPB Regulations)", () => {
  it("validates regular expressions and category mapping constants", () => {
    expect(CATEGORY_MAP.allergy.slug).toBe("allergy");
    expect("500mg".match(STRENGTH_REGEX)?.[0]).toBe("500mg");
    expect("capsule".match(DOSAGE_FORM_REGEX)?.[0]).toBe("capsule");
  });

  it("correctly identifies BandaGo product records vs arbitrary JSON", () => {
    const validProduct = {
      uu: "b293-1934-abc",
      name: "Amoxicillin 500mg Capsules",
      bh_sellprice: 450,
      quantityOnHand: 100,
    };
    expect(BandaGoNormalizer.isProductRecord(validProduct)).toBe(true);

    const nonProduct = {
      id: "session-123",
      token: "xyz",
      createdAt: "2026-11-04",
    };
    expect(BandaGoNormalizer.isProductRecord(nonProduct)).toBe(false);

    expect(BandaGoNormalizer.isProductRecord(null)).toBe(false);
    expect(BandaGoNormalizer.isProductRecord([])).toBe(false);
  });

  it("implements FEFO: discards expired batches and calculates nearest valid expiry date", () => {
    const now = Date.now();
    const expiredDate = new Date(now - 30 * 24 * 60 * 60 * 1000).toISOString(); // 30 days ago
    const nearFutureDate = new Date(
      now + 90 * 24 * 60 * 60 * 1000,
    ).toISOString(); // 90 days from now
    const farFutureDate = new Date(
      now + 365 * 24 * 60 * 60 * 1000,
    ).toISOString(); // 1 year from now

    const raw = {
      uu: "prod-fefo-101",
      value: "SKU-AMX500",
      name: "Amoxicillin 500mg Capsules",
      bh_sellprice: 550,
      bh_buyprice: 320,
      bh_hasexpiration: true,
      storageOnHand: [
        {
          qtyOnHand: 40,
          m_attributesetinstance: {
            lot: "BATCH-EXPIRED",
            guaranteeDate: expiredDate,
          },
        },
        {
          qtyOnHand: 100,
          m_attributesetinstance: {
            lot: "BATCH-NEAR",
            guaranteeDate: nearFutureDate,
          },
        },
        {
          qtyOnHand: 150,
          m_attributesetinstance: {
            lot: "BATCH-FAR",
            guaranteeDate: farFutureDate,
          },
        },
      ],
    };

    const normalized = BandaGoNormalizer.normalize(raw);
    expect(normalized).not.toBeNull();
    // 40 expired capsules must be discarded! Valid stock = 100 + 150 = 250
    expect(normalized?.stock).toBe(250);
    expect(normalized?.inStock).toBe(true);
    // Nearest valid expiry date must be BATCH-NEAR
    expect(normalized?.nearestExpiryDate).toBe(
      new Date(nearFutureDate).toISOString(),
    );
    // Antibiotic check per PPB regulations
    expect(normalized?.requiresPrescription).toBe(true);
    expect(normalized?.dosageForm).toBe("capsules");
    expect(normalized?.strength).toBe("500mg");
    expect(normalized?.price).toBe(550);
    expect(normalized?.costPrice).toBe(320);
    expect(normalized?.sku).toBe("SKU-AMX500");
  });

  it("correctly handles all expired batches by setting valid stock to 0 and inStock false", () => {
    const pastDate = new Date(Date.now() - 100000).toISOString();
    const raw = {
      id: "prod-expired-all",
      name: "Paracetamol 500mg Tablets",
      bh_sellprice: 50,
      storageOnHand: [
        {
          qtyOnHand: 300,
          m_attributesetinstance: {
            guaranteeDate: pastDate,
          },
        },
      ],
    };

    const normalized = BandaGoNormalizer.normalize(raw);
    expect(normalized?.stock).toBe(0);
    expect(normalized?.inStock).toBe(false);
    expect(normalized?.nearestExpiryDate).toBeNull();
  });

  it("enforces Kenya PPB prescription scheduling rules on medication names and categories", () => {
    const rxMedications = [
      "Amoxicillin Trihydrate 500mg",
      "Metformin HCl 500mg Tablets",
      "Amlodipine Besylate 10mg",
      "Azithromycin 500mg Tab",
      "Ciprofloxacin 500mg",
      "Ventolin Inhaler 100mcg",
      "Tramadol 50mg Caps",
      "Omeprazole 20mg Delayed-Release",
    ];

    for (const medName of rxMedications) {
      expect(RX_SCHEDULE_REGEX.test(medName)).toBe(true);
      const normalized = BandaGoNormalizer.normalize({
        id: `rx-${medName.slice(0, 5)}`,
        name: medName,
        bh_sellprice: 100,
        quantityOnHand: 20,
      });
      expect(normalized?.requiresPrescription).toBe(true);
    }

    // OTC items
    const otcMed = BandaGoNormalizer.normalize({
      id: "otc-bandages",
      name: "Sterile Elastic Bandage 10cm",
      bh_sellprice: 80,
      quantityOnHand: 50,
      m_product_category: { name: "First Aid" },
    });
    expect(otcMed?.requiresPrescription).toBe(false);
    expect(otcMed?.categorySlug).toBe("first-aid");
  });

  it("maps category names to Sphere standardized slugs and fallback images", () => {
    const cardiac = BandaGoNormalizer.normalize({
      id: "cardio-1",
      name: "Hypertension Blood Pressure Monitor",
      bh_sellprice: 3500,
      quantityOnHand: 5,
      m_product_category: { name: "Cardio / Heart Health" },
    });
    expect(cardiac?.categorySlug).toBe("heart-health");
    expect(cardiac?.imageUrl).toBe("/images/categories/cat-heart-health.webp");

    const unknownCat = BandaGoNormalizer.normalize({
      id: "unk-1",
      name: "Generic Household Disinfectant",
      bh_sellprice: 250,
      quantityOnHand: 15,
      m_product_category: { name: "Miscellaneous Store Supply" },
    });
    expect(unknownCat?.categorySlug).toBe("otc");
    expect(unknownCat?.imageUrl).toBe("/images/categories/cat-otc.webp");
  });

  it("generates consistent URL-safe slugs with externalPosId suffix", () => {
    const slug = generateSlug(
      "Augmentin 625mg Tablets (GlaxoSmithKline)",
      "b93f18a2-9981-4200",
    );
    expect(slug).toBe("augmentin-625mg-tablets-glaxosmithkline-b93f18");
  });

  it("extracts all candidate products recursively from GraphQL responses and mutations", () => {
    const graphqlResponse = {
      data: {
        products: [
          {
            uu: "med-001",
            name: "Paracetamol 500mg Tabs",
            bh_sellprice: 50,
            quantityOnHand: 120,
          },
          {
            uu: "med-002",
            name: "Cough Syrup 100ml",
            bh_sellprice: 220,
            quantityOnHand: 35,
          },
        ],
        unrelatedData: {
          clinicName: "Nairobi Central Pharmacy",
        },
      },
    };

    const extracted =
      BandaGoNormalizer.extractProductsFromPayload(graphqlResponse);
    expect(extracted.length).toBe(2);
    expect(extracted[0].externalPosId).toBe("med-001");
    expect(extracted[1].externalPosId).toBe("med-002");
  });

  it("ignores depleted batches (qty <= 0) when computing nearestExpiryDate", () => {
    const now = Date.now();
    const futureDate1 = new Date(now + 30 * 24 * 60 * 60 * 1000).toISOString();
    const futureDate2 = new Date(now + 90 * 24 * 60 * 60 * 1000).toISOString();

    const raw = {
      id: "prod-depleted-test",
      name: "Cetirizine 10mg Tabs",
      bh_sellprice: 15,
      storageOnHand: [
        {
          qtyOnHand: 0, // Depleted! Should NOT be nearest expiry
          m_attributesetinstance: {
            guaranteeDate: futureDate1,
          },
        },
        {
          qtyOnHand: 50, // Valid stock
          m_attributesetinstance: {
            guaranteeDate: futureDate2,
          },
        },
      ],
    };

    const normalized = BandaGoNormalizer.normalize(raw);
    expect(normalized?.stock).toBe(50);
    expect(normalized?.nearestExpiryDate).toBe(
      new Date(futureDate2).toISOString(),
    );
  });

  it("normalizes negative or invalid pricing safely to zero", () => {
    const raw = {
      id: "prod-neg-price",
      name: "Surgical Gloves Pair",
      bh_sellprice: -50,
      bh_buyprice: -30,
      quantityOnHand: 20,
    };
    const normalized = BandaGoNormalizer.normalize(raw);
    expect(normalized?.price).toBe(0);
    expect(normalized?.costPrice).toBe(0);
  });

  it("generates safe fallback slug when drug name contains only symbols", () => {
    const slug = generateSlug("$$$ ###", "pos-777");
    expect(slug).toBe("product-pos-77");
  });

  it("preserves description and packSize when provided", () => {
    const raw = {
      uu: "uu-desc-pack",
      name: "Paracetamol 500mg Tablets",
      description: "Effective relief from fever and mild to moderate pain",
      packSize: "100 tablets",
      bh_sellprice: 120,
      quantityOnHand: 40,
    };
    const normalized = BandaGoNormalizer.normalize(raw);
    expect(normalized?.description).toBe(
      "Effective relief from fever and mild to moderate pain",
    );
    expect(normalized?.packSize).toBe("100 tablets");
  });

  it("identifies expanded Kenya PPB POM medications", () => {
    const pomItems = [
      "Ampicillin 500mg Capsules",
      "Cloxacillin Sodium 250mg",
      "Fluconazole 150mg Single Dose",
      "Gentamicin Eye Drops 0.3%",
      "Coartem 20/120 Dispersible",
    ];

    for (const item of pomItems) {
      const normalized = BandaGoNormalizer.normalize({
        id: "pom-test",
        name: item,
        bh_sellprice: 200,
        quantityOnHand: 10,
      });
      expect(normalized?.requiresPrescription).toBe(true);
    }
  });

  it("handles non-finite / NaN batch quantity safely without corrupting validStock", () => {
    const raw = {
      id: "prod-nan-qty",
      name: "Salbutamol 100mcg Inhaler",
      bh_sellprice: 350,
      storageOnHand: [
        {
          qtyOnHand: "not-a-number", // NaN
          m_attributesetinstance: { guaranteeDate: "2028-01-01" },
        },
        {
          qtyOnHand: 25, // Valid
          m_attributesetinstance: { guaranteeDate: "2028-06-01" },
        },
      ],
    };

    const normalized = BandaGoNormalizer.normalize(raw);
    expect(normalized?.stock).toBe(25);
    expect(normalized?.inStock).toBe(true);
    expect(Number.isFinite(normalized?.stock)).toBe(true);
  });

  it("resolves batch guaranteeDate across diverse casing and attribute set conventions", () => {
    const rawUpper = {
      id: "prod-upper-case",
      name: "Diclofenac 50mg Tablets",
      bh_sellprice: 80,
      storageOnHand: [
        {
          QtyOnHand: 60,
          M_AttributeSetInstance: {
            GuaranteeDate: "2027-12-31",
          },
        },
      ],
    };

    const normalized = BandaGoNormalizer.normalize(rawUpper);
    expect(normalized?.stock).toBe(60);
    expect(normalized?.nearestExpiryDate).toBe(
      new Date("2027-12-31").toISOString(),
    );
    expect(normalized?.requiresPrescription).toBe(true);
  });

  it("cleans slug suffix to avoid double hyphens from raw IDs", () => {
    const slug = generateSlug("Amoxicillin 500mg", "--uuid-456--");
    expect(slug).toBe("amoxicillin-500mg-uuid");
    expect(slug).not.toContain("--");
  });

  it("preserves batches array for Sphere ProductBatch table with FEFO filtering and lot fallback", () => {
    const now = Date.now();
    const futureDate1 = new Date(now + 60 * 24 * 3600 * 1000).toISOString();
    const futureDate2 = new Date(now + 120 * 24 * 3600 * 1000).toISOString();
    const pastDate = new Date(now - 10 * 24 * 3600 * 1000).toISOString();

    const raw = {
      uu: "drug-lot-12345",
      name: "Ciprofloxacin 500mg Film-Coated Tablets",
      genericName: "Ciprofloxacin Hydrochloride",
      dosageForm: "tablet",
      bh_sellprice: 300,
      bh_buyprice: 180,
      storageOnHand: [
        {
          qtyOnHand: 50,
          m_attributesetinstance: {
            lot: "LOT-CIP-001",
            guaranteeDate: futureDate1,
          },
        },
        {
          qtyOnHand: 30, // Missing lot, should get deterministic fallback LOT-drug-2
          m_attributesetinstance: {
            guaranteeDate: futureDate2,
          },
        },
        {
          qtyOnHand: 90, // Expired lot, must be excluded from batches!
          m_attributesetinstance: {
            lot: "LOT-EXPIRED",
            guaranteeDate: pastDate,
          },
        },
        {
          qtyOnHand: 0, // Depleted lot, must be excluded
          m_attributesetinstance: {
            lot: "LOT-DEPLETED",
            guaranteeDate: futureDate1,
          },
        },
      ],
    };

    const normalized = BandaGoNormalizer.normalize(raw);
    expect(normalized).not.toBeNull();
    expect(normalized?.genericName).toBe("Ciprofloxacin Hydrochloride");
    expect(normalized?.dosageForm).toBe("tablet");
    expect(normalized?.stock).toBe(80); // 50 + 30
    expect(normalized?.batches).toHaveLength(2);
    expect(normalized?.batches[0]).toEqual({
      batchNumber: "LOT-CIP-001",
      qtyOnHand: 50,
      expiryDate: new Date(futureDate1).toISOString(),
    });
    expect(normalized?.batches[1]).toEqual({
      batchNumber: "LOT-drug-2",
      qtyOnHand: 30,
      expiryDate: new Date(futureDate2).toISOString(),
    });
  });

  it("preserves numeric lot 0 and handles empty string lot fallback correctly", () => {
    const raw = {
      uu: "drug-zero-lot",
      name: "Ibuprofen 400mg Tablets",
      buyPrice: 120,
      storageOnHand: [
        {
          qtyOnHand: 20,
          m_attributesetinstance: {
            lot: 0, // Numeric 0 must be preserved as "0", not treated as falsy!
          },
        },
        {
          qtyOnHand: 15,
          m_attributesetinstance: {
            lot: "   ", // Whitespace lot must fall back to deterministic LOT ID
          },
        },
      ],
    };

    const normalized = BandaGoNormalizer.normalize(raw);
    expect(normalized).not.toBeNull();
    expect(normalized?.buyPrice).toBe(120);
    expect(normalized?.costPrice).toBe(120);
    expect(normalized?.batches).toHaveLength(2);
    expect(normalized?.batches[0].batchNumber).toBe("0");
    expect(normalized?.batches[1].batchNumber).toBe("LOT-drug-2");
  });

  it("extractProductsFromPayload merges M_ProductGet catalog attributes (SKU, generic) with M_StorageOnHandGet batches", () => {
    const futureDate = new Date(Date.now() + 180 * 24 * 60 * 60 * 1000).toISOString();
    const payload = {
      data: {
        M_ProductGet: {
          Results: [
            {
              UU: "prod-uu-merged",
              Name: "Amoxicillin 500mg Capsules",
              BH_SellPrice: 500,
              TotalQuantity: 100,
              IsActive: true,
              KnhtsConcept: {
                code: "KNHTS-AMOX-500",
                name: "Amoxicillin Trihydrate",
              },
            },
          ],
        },
        M_StorageOnHandGet: {
          Results: [
            {
              UU: "storage-uu-1",
              QtyOnHand: 100,
              M_Product: {
                UU: "prod-uu-merged",
                Name: "Amoxicillin 500mg Capsules",
                BH_SellPrice: 500,
              },
              M_AttributeSetInstance: {
                UU: "asi-uu-1",
                Lot: "AMX-LOT-2026",
                GuaranteeDate: futureDate,
                PurchasePrice: 320,
              },
            },
          ],
        },
      },
    };

    const products = BandaGoNormalizer.extractProductsFromPayload(payload);
    expect(products).toHaveLength(1);
    const prod = products[0];
    expect(prod.externalPosId).toBe("prod-uu-merged");
    expect(prod.sku).toBe("KNHTS-AMOX-500");
    expect(prod.genericName).toBe("Amoxicillin Trihydrate");
    expect(prod.price).toBe(500);
    expect(prod.costPrice).toBe(320);
    expect(prod.stock).toBe(100);
    expect(prod.batches).toHaveLength(1);
    expect(prod.batches[0].batchNumber).toBe("AMX-LOT-2026");
    expect(prod.batches[0].qtyOnHand).toBe(100);
  });

  it("extractProductsFromPayload retains SKU, genericName, and LastPurchasePrice when all storage lots are expired", () => {
    const pastDate = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    const payload = {
      data: {
        M_ProductGet: {
          Results: [
            {
              UU: "prod-exp-verify",
              Name: "Amoxicillin 500mg Capsules",
              BH_SellPrice: 500,
              TotalQuantity: 25,
              KnhtsConcept: {
                code: "KNHTS-AMOX-500",
                name: "Amoxicillin Trihydrate",
              },
              LastPurchasePrice: 350,
            },
          ],
        },
        M_StorageOnHandGet: {
          Results: [
            {
              UU: "storage-exp-1",
              QtyOnHand: 25,
              M_Product: {
                UU: "prod-exp-verify",
                Name: "Amoxicillin 500mg Capsules",
                BH_SellPrice: 500,
              },
              M_AttributeSetInstance: {
                UU: "asi-exp-1",
                Lot: "EXP-BATCH-99",
                GuaranteeDate: pastDate,
              },
            },
          ],
        },
      },
    };

    const products = BandaGoNormalizer.extractProductsFromPayload(payload);
    expect(products).toHaveLength(1);
    const prod = products[0];
    expect(prod.externalPosId).toBe("prod-exp-verify");
    // Under PPB regulations, expired lots legally reduce sellable stock to 0
    expect(prod.stock).toBe(0);
    expect(prod.inStock).toBe(false);
    expect(prod.batches).toHaveLength(0);
    // Crucially: catalog metadata must NOT be wiped out!
    expect(prod.sku).toBe("KNHTS-AMOX-500");
    expect(prod.genericName).toBe("Amoxicillin Trihydrate");
    expect(prod.costPrice).toBe(350);
    expect(prod.buyPrice).toBe(350);
    expect(prod.price).toBe(500);
  });

  it("extractProductsFromPayload consolidates duplicate batches across multiple warehouse locators", () => {
    const futureDate1 = new Date(Date.now() + 100 * 24 * 60 * 60 * 1000).toISOString();
    const futureDate2 = new Date(Date.now() + 90 * 24 * 60 * 60 * 1000).toISOString();
    const payload = {
      data: {
        M_StorageOnHandGet: {
          Results: [
            {
              UU: "loc-1",
              QtyOnHand: 40,
              M_Product: {
                UU: "prod-multi-loc",
                Name: "Paracetamol 500mg Tablets",
                BH_SellPrice: 50,
              },
              M_AttributeSetInstance: {
                UU: "asi-loc-1",
                Lot: "BATCH-SHARED-LOT",
                GuaranteeDate: futureDate1,
                PurchasePrice: 30,
              },
            },
            {
              UU: "loc-2",
              QtyOnHand: 60,
              M_Product: {
                UU: "prod-multi-loc",
                Name: "Paracetamol 500mg Tablets",
                BH_SellPrice: 50,
              },
              M_AttributeSetInstance: {
                UU: "asi-loc-2",
                Lot: "BATCH-SHARED-LOT",
                GuaranteeDate: futureDate2,
                PurchasePrice: 30,
              },
            },
          ],
        },
      },
    };

    const products = BandaGoNormalizer.extractProductsFromPayload(payload);
    expect(products).toHaveLength(1);
    const prod = products[0];
    expect(prod.stock).toBe(100);
    // Should aggregate into a single batch entry with summed quantity and earliest expiry
    expect(prod.batches).toHaveLength(1);
    expect(prod.batches[0].batchNumber).toBe("BATCH-SHARED-LOT");
    expect(prod.batches[0].qtyOnHand).toBe(100);
    expect(prod.batches[0].expiryDate).toBe(new Date(futureDate2).toISOString());
  });
});

