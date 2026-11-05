/**
 * BandaGo POS (iDempiere OSGi GraphQL) to Sphere Pharmacy Normalizer.
 * Enforces FEFO (First-Expired, First-Out), Kenya Pharmacy and Poisons Board (PPB)
 * prescription scheduling regulations, and standardized category taxonomy.
 */

export interface SphereBatchSyncItem {
  batchNumber: string;
  qtyOnHand: number;
  expiryDate: string | null;
  externalBatchId?: string;
}

export interface SphereProductSyncItem {
  externalPosId: string;
  sku: string | null;
  name: string;
  genericName: string | null;
  dosageForm: string | null;
  slug: string;
  categorySlug: string;
  price: number;
  buyPrice: number | null;
  costPrice: number | null;
  stock: number;
  inStock: boolean;
  requiresPrescription: boolean;
  imageUrl: string;
  nearestExpiryDate: string | null;
  batches: SphereBatchSyncItem[];
  strength?: string;
  description?: string;
  packSize?: string;
}

export type SphereProductInput = SphereProductSyncItem;

export interface CategoryMapping {
  slug: string;
  defaultImage: string;
  rx: boolean;
}

export const CATEGORY_MAP: Record<string, CategoryMapping> = {
  allergy: {
    slug: "allergy",
    defaultImage: "/images/categories/cat-allergy.webp",
    rx: false,
  },
  cold: {
    slug: "cold-flu",
    defaultImage: "/images/categories/cat-cold-flu.webp",
    rx: false,
  },
  cough: {
    slug: "cold-flu",
    defaultImage: "/images/categories/cat-cold-flu.webp",
    rx: false,
  },
  flu: {
    slug: "cold-flu",
    defaultImage: "/images/categories/cat-cold-flu.webp",
    rx: false,
  },
  diabetes: {
    slug: "diabetes",
    defaultImage: "/images/categories/cat-diabetes.webp",
    rx: true,
  },
  diabetic: {
    slug: "diabetes",
    defaultImage: "/images/categories/cat-diabetes.webp",
    rx: true,
  },
  diagnostic: {
    slug: "diagnostics",
    defaultImage: "/images/categories/cat-diagnostics.webp",
    rx: false,
  },
  test: {
    slug: "diagnostics",
    defaultImage: "/images/categories/cat-diagnostics.webp",
    rx: false,
  },
  "first aid": {
    slug: "first-aid",
    defaultImage: "/images/categories/cat-first-aid.webp",
    rx: false,
  },
  bandage: {
    slug: "first-aid",
    defaultImage: "/images/categories/cat-first-aid.webp",
    rx: false,
  },
  gastro: {
    slug: "gastro",
    defaultImage: "/images/categories/cat-gastro.webp",
    rx: false,
  },
  stomach: {
    slug: "gastro",
    defaultImage: "/images/categories/cat-gastro.webp",
    rx: false,
  },
  antacid: {
    slug: "gastro",
    defaultImage: "/images/categories/cat-gastro.webp",
    rx: false,
  },
  heart: {
    slug: "heart-health",
    defaultImage: "/images/categories/cat-heart-health.webp",
    rx: true,
  },
  hypertension: {
    slug: "heart-health",
    defaultImage: "/images/categories/cat-heart-health.webp",
    rx: true,
  },
  cardio: {
    slug: "heart-health",
    defaultImage: "/images/categories/cat-heart-health.webp",
    rx: true,
  },
  bp: {
    slug: "heart-health",
    defaultImage: "/images/categories/cat-heart-health.webp",
    rx: true,
  },
  device: {
    slug: "medical-devices",
    defaultImage: "/images/categories/cat-medical-devices.webp",
    rx: false,
  },
  baby: {
    slug: "mother-baby",
    defaultImage: "/images/categories/cat-mother-baby.webp",
    rx: false,
  },
  infant: {
    slug: "mother-baby",
    defaultImage: "/images/categories/cat-mother-baby.webp",
    rx: false,
  },
  mother: {
    slug: "mother-baby",
    defaultImage: "/images/categories/cat-mother-baby.webp",
    rx: false,
  },
  pain: {
    slug: "pain-fever",
    defaultImage: "/images/categories/cat-pain-fever.webp",
    rx: false,
  },
  fever: {
    slug: "pain-fever",
    defaultImage: "/images/categories/cat-pain-fever.webp",
    rx: false,
  },
  analgesic: {
    slug: "pain-fever",
    defaultImage: "/images/categories/cat-pain-fever.webp",
    rx: false,
  },
  personal: {
    slug: "personal-care",
    defaultImage: "/images/categories/cat-personal-care.webp",
    rx: false,
  },
  hygiene: {
    slug: "personal-care",
    defaultImage: "/images/categories/cat-personal-care.webp",
    rx: false,
  },
  prescription: {
    slug: "prescription",
    defaultImage: "/images/categories/cat-prescription.webp",
    rx: true,
  },
  antibiotic: {
    slug: "prescription",
    defaultImage: "/images/categories/cat-prescription.webp",
    rx: true,
  },
  sexual: {
    slug: "sexual-health",
    defaultImage: "/images/categories/cat-sexual-health.webp",
    rx: false,
  },
  skin: {
    slug: "skin-care",
    defaultImage: "/images/categories/cat-skin-care.webp",
    rx: false,
  },
  dermatology: {
    slug: "skin-care",
    defaultImage: "/images/categories/cat-skin-care.webp",
    rx: false,
  },
  vitamin: {
    slug: "vitamins",
    defaultImage: "/images/categories/cat-vitamins.webp",
    rx: false,
  },
  supplement: {
    slug: "vitamins",
    defaultImage: "/images/categories/cat-vitamins.webp",
    rx: false,
  },
};

// Prescription-only keywords per PPB (Pharmacy & Poisons Board Kenya) schedule
export const RX_SCHEDULE_REGEX =
  /\b(amoxicillin|amoxil|augmentin|co-amoxiclav|ampicillin|cloxacillin|azithromycin|ciprofloxacin|clarithromycin|metronidazole|flagyl|ceftriaxone|cefixime|doxycycline|erythromycin|fluconazole|gentamicin|metformin|glibenclamide|insulin|amlodipine|losartan|atenolol|enalapril|hydrochlorothiazide|salbutamol|ventolin|prednisolone|dexamethasone|tramadol|codeine|diazepam|fluoxetine|omeprazole|esomeprazole|artemether|lumefantrine|coartem|diclofenac|paroxetine|sertraline|amitriptyline|warfarin|morphine|carbamazepine|atorvastatin|rosuvastatin|simvastatin|pantoprazole)\b/i;

export const STRENGTH_REGEX = /(\d+(\.\d+)?\s*(mg|g|mcg|ml|iu|%))/i;
export const DOSAGE_FORM_REGEX =
  /\b(tablet|tablets|tab|tabs|capsule|capsules|cap|caps|syrup|syr|suspension|susp|injection|inj|cream|ointment|drops|inhaler|gel|powder|sachet)\b/i;

export function generateSlug(name: string, externalId: string): string {
  const base = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
  const cleanBase = base || "product";
  const rawSuffix = (externalId || "").slice(0, 6).toLowerCase();
  const cleanSuffix = rawSuffix.replace(/^-+|-+$/g, "") || "med";
  return `${cleanBase}-${cleanSuffix}`;
}

export class BandaGoNormalizer {
  /**
   * Identifies whether a raw object matches BandaGo / iDempiere product records.
   */
  static isProductRecord(raw: unknown): boolean {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      return false;
    }
    const r = raw as Record<string, any>;
    // BandaGo's GraphQL mirrors iDempiere column names (e.g. `UU`, `Name`,
    // `M_Product_UU`) alongside lower-case aliases, so accept both.
    const hasIdentifier = Boolean(
      r.UU || r.uu || r.M_Product_UU || r.externalPosId || r.id || r.M_Product_ID,
    );
    const hasName = Boolean(r.name || r.Name || r.productName);

    // Reject non-product entities that happen to carry a name + id
    // (e.g. AD_Language, C_BPartner) when GraphQL exposes a __typename.
    if (typeof r.__typename === "string" && !/product/i.test(r.__typename)) {
      return false;
    }
    // iDempiere ProductType: I = Item (stocked). S/E/R/A = services, expenses,
    // resources, assets (e.g. consultation fees) which must not become shop items.
    // In BandaGo's GraphQL schema, ProductType is an AD_Ref_List object `{ UU, Value }`.
    const rawProductType =
      typeof r.ProductType === "object" && r.ProductType !== null
        ? (r.ProductType.Value ?? r.ProductType.value)
        : (r.ProductType ?? r.productType);
    if (
      typeof rawProductType === "string" &&
      rawProductType.trim() !== "" &&
      rawProductType.trim().toUpperCase() !== "I"
    ) {
      return false;
    }

    const hasStockField =
      "TotalQuantity" in r ||
      "totalQuantity" in r ||
      "quantityOnHand" in r ||
      "QuantityOnHand" in r ||
      "M_StorageOnHandList" in r ||
      "storageOnHand" in r ||
      "M_StorageOnHand" in r ||
      "batches" in r ||
      "Batches" in r ||
      "stock" in r ||
      "Stock" in r;

    // In live BandaGo GraphQL, display-only fragments (e.g. M_ProductDisplayForVisits
    // or ReceiveProducts autocomplete) expose `__typename: "M_Product"` with `{ UU, Name }`
    // and no inventory fields. Never treat stockless GraphQL fragments as full sync payloads,
    // otherwise they would overwrite real stock with 0.
    if (typeof r.__typename === "string" && !hasStockField) {
      return false;
    }

    const hasPharmacyTraits =
      hasStockField ||
      "bh_sellprice" in r ||
      "BH_SellPrice" in r ||
      "bh_buyprice" in r ||
      "BH_BuyPrice" in r ||
      "LastPurchasePrice" in r ||
      "M_ProductPrices" in r ||
      "bh_hasexpiration" in r ||
      "BH_HasExpiration" in r ||
      "m_product_category" in r ||
      "M_Product_Category" in r;

    return hasIdentifier && hasName && hasPharmacyTraits;
  }

  /**
   * Identifies inverted BandaGo `M_StorageOnHandGet` rows where each element represents
   * a batch/locator holding nested `M_Product` + top-level `QtyOnHand` & `M_AttributeSetInstance`.
   */
  static isStorageOnHandRow(raw: unknown): raw is Record<string, any> {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return false;
    const r = raw as Record<string, any>;
    const prod = r.M_Product || r.m_product;
    if (!prod || typeof prod !== "object" || Array.isArray(prod)) return false;
    const prodId = prod.UU || prod.uu || prod.M_Product_UU || prod.id;
    const prodName = prod.Name || prod.name || prod.productName;
    const hasBatchQty = "QtyOnHand" in r || "qtyOnHand" in r;
    return Boolean(prodId && prodName && hasBatchQty);
  }

  /**
   * Normalizes a single BandaGo medication node into a Sphere Pharmacy product.
   */
  static normalize(raw: Record<string, any>): SphereProductInput | null {
    if (!raw || typeof raw !== "object") return null;

    const externalPosId = String(
      raw.UU ||
        raw.uu ||
        raw.M_Product_UU ||
        raw.externalPosId ||
        raw.id ||
        raw.M_Product_ID ||
        "",
    ).trim();
    const name = String(raw.name || raw.Name || raw.productName || "").trim();

    if (!externalPosId || !name) return null;

    const isInactive = raw.IsActive === false || raw.isActive === false;

    const genericName =
      raw.genericName ||
      raw.generic_name ||
      raw.GenericName ||
      raw.bh_genericname ||
      raw.BH_GenericName ||
      raw.bh_generic_name ||
      raw.KnhtsConcept?.name ||
      raw.BH_Concept?.bh_display_name ||
      null;

    // Extract Strength and Form from drug title
    const strengthMatch = name.match(STRENGTH_REGEX);
    const strength =
      raw.strength ||
      raw.Strength ||
      (strengthMatch ? strengthMatch[0] : undefined);

    const formMatch = name.match(DOSAGE_FORM_REGEX);
    const dosageForm =
      raw.dosageForm ||
      raw.dosage_form ||
      raw.DosageForm ||
      raw.bh_dosageform ||
      (formMatch ? formMatch[0].toLowerCase() : null) ||
      null;

    // Category Resolution
    const rawCategory = String(
      raw.m_product_category?.name ||
        raw.M_Product_Category?.Name ||
        raw.KnhtsConcept?.name ||
        raw.category?.name ||
        raw.category ||
        "OTC",
    ).toLowerCase();

    let resolvedCategory: CategoryMapping = {
      slug: "otc",
      defaultImage: "/images/categories/cat-otc.webp",
      rx: false,
    };

    for (const [key, mapping] of Object.entries(CATEGORY_MAP)) {
      if (rawCategory.includes(key) || name.toLowerCase().includes(key)) {
        resolvedCategory = mapping;
        break;
      }
    }

    // Prescription Classification (PPB Guidelines & BandaGo expiration/attribute flags)
    const hasExpirationFlag = Boolean(
      raw.bh_hasexpiration ||
        raw.BH_HasExpiration ||
        raw.M_AttributeSet?.IsGuaranteeDate,
    );
    const requiresPrescription =
      Boolean(hasExpirationFlag && resolvedCategory.rx) ||
      resolvedCategory.rx ||
      RX_SCHEDULE_REGEX.test(name);

    // Batch & FEFO Expiry Calculation
    // Evaluates M_StorageOnHandList / storageOnHand batches: discards expired stock,
    // ignores depleted batches (qty <= 0), and identifies nearest future expiry date.
    const now = Date.now();
    let validStock = 0;
    let nearestExpiryDate: string | null = null;
    const normalizedBatches: SphereBatchSyncItem[] = [];

    const batches =
      raw.M_StorageOnHandList ||
      raw.storageOnHand ||
      raw.M_StorageOnHand ||
      raw.batches ||
      raw.Batches;

    if (isInactive) {
      validStock = 0;
    } else if (Array.isArray(batches) && batches.length > 0) {
      for (const [idx, batch] of batches.entries()) {
        if (!batch || typeof batch !== "object") continue;
        const rawQty = batch.qtyOnHand ?? batch.QtyOnHand ?? 0;
        const qty = Math.floor(Number(rawQty));
        if (!Number.isFinite(qty) || qty <= 0) {
          // Zero, negative, or invalid inventory holds no sellable units and must not skew nearest expiry
          continue;
        }

        const asi =
          batch.m_attributesetinstance ||
          batch.m_attributeSetInstance ||
          batch.M_AttributeSetInstance ||
          batch.attributeSetInstance ||
          {};

        const expRaw =
          asi.guaranteeDate ||
          asi.GuaranteeDate ||
          asi.expiryDate ||
          asi.ExpiryDate ||
          batch.guaranteeDate ||
          batch.GuaranteeDate ||
          batch.expiryDate ||
          batch.ExpiryDate;

        let expiryIso: string | null = null;

        if (expRaw) {
          const expTime = new Date(expRaw).getTime();
          if (!isNaN(expTime)) {
            if (expTime < now) {
              // Expired stock is legally unsellable under Kenya PPB guidelines
              continue;
            }
            expiryIso = new Date(expTime).toISOString();
            if (
              !nearestExpiryDate ||
              expTime < new Date(nearestExpiryDate).getTime()
            ) {
              nearestExpiryDate = expiryIso;
            }
          }
        }

        validStock += qty;
        const candidateLot =
          asi.Lot ??
          asi.lot ??
          asi.SerNo ??
          asi.serNo ??
          batch.batchNumber ??
          batch.BatchNumber;

        const lotNo =
          candidateLot !== undefined &&
          candidateLot !== null &&
          String(candidateLot).trim() !== ""
            ? String(candidateLot).trim()
            : `LOT-${externalPosId.slice(0, 4)}-${idx + 1}`;

        const rawBatchId =
          batch.externalBatchId || batch.UU || batch.uu || asi.UU || asi.uu;
        const externalBatchId =
          typeof rawBatchId === "string" && rawBatchId.trim() !== ""
            ? rawBatchId.trim()
            : undefined;

        const existingBatch = normalizedBatches.find(
          (b) => b.batchNumber === lotNo,
        );
        if (existingBatch) {
          existingBatch.qtyOnHand += qty;
          if (
            expiryIso &&
            (!existingBatch.expiryDate ||
              new Date(expiryIso).getTime() <
                new Date(existingBatch.expiryDate).getTime())
          ) {
            existingBatch.expiryDate = expiryIso;
          }
        } else {
          normalizedBatches.push({
            batchNumber: lotNo,
            qtyOnHand: qty,
            expiryDate: expiryIso,
            ...(externalBatchId ? { externalBatchId } : {}),
          });
        }
      }
    } else if (Array.isArray(batches) && batches.length === 0) {
      // Explicit empty storage list means 0 physical units in warehouse
      validStock = 0;
    } else {
      const rawStock = Number(
        raw.TotalQuantity ??
          raw.totalQuantity ??
          raw.quantityOnHand ??
          raw.QuantityOnHand ??
          raw.stock ??
          raw.Stock ??
          0,
      );
      validStock = Math.max(
        0,
        Math.floor(Number.isFinite(rawStock) ? rawStock : 0),
      );
    }

    // Pricing parsing: supports BH_SellPrice as well as M_ProductPrices[0].PriceStd
    const priceFromList =
      Array.isArray(raw.M_ProductPrices) && raw.M_ProductPrices.length > 0
        ? raw.M_ProductPrices.find(
            (p: any) => p && Number(p.PriceStd ?? p.priceStd) > 0,
          )?.PriceStd ?? raw.M_ProductPrices[0]?.PriceStd
        : undefined;

    const rawPrice =
      raw.bh_sellprice ??
      raw.BH_SellPrice ??
      raw.price ??
      raw.Price ??
      priceFromList ??
      0;
    const price = Math.max(0, Number(rawPrice) || 0);

    const costPriceRaw =
      raw.bh_buyprice ??
      raw.BH_BuyPrice ??
      raw.LastPurchasePrice ??
      raw.lastPurchasePrice ??
      raw.buyPrice ??
      raw.BuyPrice ??
      raw.costPrice ??
      raw.CostPrice;
    const costPrice =
      costPriceRaw !== undefined && costPriceRaw !== null
        ? Math.max(0, Number(costPriceRaw) || 0)
        : null;

    const rawDesc = raw.description ?? raw.Description;
    const description = rawDesc ? String(rawDesc).trim() : undefined;
    const packSize =
      raw.packSize || raw.pack_size || raw.bh_packsize
        ? String(raw.packSize || raw.pack_size || raw.bh_packsize).trim()
        : undefined;

    return {
      externalPosId,
      sku: raw.value || raw.Value || raw.sku || raw.KnhtsConcept?.code || null,
      name,
      genericName: genericName ? String(genericName).trim() : null,
      dosageForm: dosageForm ? String(dosageForm).trim() : null,
      slug: generateSlug(name, externalPosId),
      categorySlug: resolvedCategory.slug,
      price: isNaN(price) ? 0 : price,
      buyPrice: costPrice !== null && !isNaN(costPrice) ? costPrice : null,
      costPrice: costPrice !== null && !isNaN(costPrice) ? costPrice : null,
      stock: Math.max(0, Math.floor(validStock)),
      inStock: validStock > 0,
      requiresPrescription,
      imageUrl: resolvedCategory.defaultImage,
      nearestExpiryDate,
      batches: normalizedBatches,
      strength,
      description,
      packSize,
    };
  }

  /**
   * Merges two normalized product representations of the same externalPosId,
   * cleanly reconciling physical storage on hand (lots, quantities, expirations)
   * with catalog metadata (SKUs, Kenya national health concept codes, prices).
   */
  static mergeProducts(
    existing: SphereProductInput,
    incoming: SphereProductInput,
    isPhysicalStorageItem = false,
  ): SphereProductInput {
    let batches: SphereBatchSyncItem[] = [];
    let stock = 0;
    let nearestExpiryDate: string | null = null;

    const existingHasBatches = existing.batches && existing.batches.length > 0;
    const incomingHasBatches = incoming.batches && incoming.batches.length > 0;

    if (existingHasBatches && incomingHasBatches) {
      // Both records carry batches: aggregate by batchNumber across multiple locators
      const batchMap = new Map<string, SphereBatchSyncItem>();
      for (const b of [...existing.batches, ...incoming.batches]) {
        const key = b.batchNumber.trim();
        const prevB = batchMap.get(key);
        if (prevB) {
          prevB.qtyOnHand += b.qtyOnHand;
          if (
            b.expiryDate &&
            (!prevB.expiryDate ||
              new Date(b.expiryDate).getTime() < new Date(prevB.expiryDate).getTime())
          ) {
            prevB.expiryDate = b.expiryDate;
          }
        } else {
          batchMap.set(key, { ...b, batchNumber: key });
        }
      }
      batches = Array.from(batchMap.values());
      stock = batches.reduce((sum, b) => sum + b.qtyOnHand, 0);
    } else if (incomingHasBatches) {
      batches = incoming.batches;
      stock = incoming.stock;
      nearestExpiryDate = incoming.nearestExpiryDate;
    } else if (existingHasBatches) {
      batches = existing.batches;
      stock = existing.stock;
      nearestExpiryDate = existing.nearestExpiryDate;
    } else if (isPhysicalStorageItem) {
      // Record originated from physical warehouse rows where all lots were expired or depleted
      batches = [];
      stock = 0;
      nearestExpiryDate = null;
    } else {
      batches = [];
      stock = incoming.stock !== undefined ? incoming.stock : existing.stock;
      nearestExpiryDate = null;
    }

    // Determine earliest valid expiry date from surviving batches
    if (!nearestExpiryDate && batches.length > 0) {
      for (const b of batches) {
        if (b.expiryDate) {
          if (
            !nearestExpiryDate ||
            new Date(b.expiryDate).getTime() < new Date(nearestExpiryDate).getTime()
          ) {
            nearestExpiryDate = b.expiryDate;
          }
        }
      }
    }

    const price = (incoming.price > 0 ? incoming.price : existing.price) || 0;
    const costPrice = incoming.costPrice ?? existing.costPrice ?? null;
    const buyPrice = incoming.buyPrice ?? existing.buyPrice ?? costPrice;

    const sku = incoming.sku || existing.sku || null;
    const genericName = incoming.genericName || existing.genericName || null;
    const dosageForm = incoming.dosageForm || existing.dosageForm || null;
    const strength = incoming.strength || existing.strength || undefined;
    const description = incoming.description || existing.description || undefined;
    const packSize = incoming.packSize || existing.packSize || undefined;

    const categorySlug =
      incoming.categorySlug && incoming.categorySlug !== "otc"
        ? incoming.categorySlug
        : existing.categorySlug || "otc";

    return {
      externalPosId: existing.externalPosId,
      name: incoming.name || existing.name,
      sku,
      genericName,
      dosageForm,
      strength,
      slug: existing.slug || incoming.slug,
      categorySlug,
      price,
      buyPrice,
      costPrice,
      stock: Math.max(0, Math.floor(stock)),
      inStock: stock > 0,
      requiresPrescription: Boolean(
        existing.requiresPrescription || incoming.requiresPrescription,
      ),
      imageUrl:
        categorySlug !== "otc" && incoming.imageUrl.includes("cat-otc")
          ? existing.imageUrl
          : incoming.imageUrl || existing.imageUrl,
      nearestExpiryDate,
      batches,
      description,
      packSize,
    };
  }

  /**
   * Recursively traverses an arbitrary GraphQL response payload (query or mutation)
   * to extract and normalize all candidate BandaGo medication products, including
   * inverted `M_StorageOnHandGet` batch lists.
   */
  static extractProductsFromPayload(payload: unknown): SphereProductInput[] {
    const candidates: Record<string, any>[] = [];
    const groupedStorageByProduct = new Map<
      string,
      { product: Record<string, any>; batches: Record<string, any>[] }
    >();
    const seen = new Set<unknown>();

    const traverse = (node: unknown) => {
      if (!node || typeof node !== "object") return;
      if (seen.has(node)) return;
      seen.add(node);

      if (Array.isArray(node)) {
        for (const item of node) {
          traverse(item);
        }
      } else {
        const obj = node as Record<string, any>;
        if (BandaGoNormalizer.isStorageOnHandRow(obj)) {
          const prod = (obj.M_Product || obj.m_product) as Record<string, any>;
          seen.add(prod); // Prevent bare nested M_Product (without QtyOnHand) from being parsed separately
          const prodId = String(
            prod.UU || prod.uu || prod.M_Product_UU || prod.id || "",
          ).trim();
          if (prodId) {
            const existing = groupedStorageByProduct.get(prodId);
            if (existing) {
              existing.batches.push(obj);
            } else {
              groupedStorageByProduct.set(prodId, {
                product: prod,
                batches: [obj],
              });
            }
          }
        } else if (BandaGoNormalizer.isProductRecord(obj)) {
          candidates.push(obj);
        } else {
          for (const val of Object.values(obj)) {
            traverse(val);
          }
        }
      }
    };

    traverse(payload);

    // Track which products had physical inventory storage rows returned
    const storageProductUUs = new Set<string>(groupedStorageByProduct.keys());

    // Append synthesized products built from inverted M_StorageOnHandGet rows
    for (const { product, batches } of groupedStorageByProduct.values()) {
      const firstAsiPrice = batches.find(
        (b) =>
          b?.M_AttributeSetInstance?.PurchasePrice != null ||
          b?.m_attributesetinstance?.purchasePrice != null,
      );
      const purchasePrice =
        firstAsiPrice?.M_AttributeSetInstance?.PurchasePrice ??
        firstAsiPrice?.m_attributesetinstance?.purchasePrice;

      candidates.push({
        ...product,
        ...(purchasePrice != null &&
        product.BH_BuyPrice == null &&
        product.LastPurchasePrice == null
          ? { LastPurchasePrice: purchasePrice }
          : {}),
        M_StorageOnHandList: batches,
        _isFromStorage: true,
      });
    }

    const normalizedMap = new Map<string, SphereProductInput>();
    for (const raw of candidates) {
      const item = BandaGoNormalizer.normalize(raw);
      if (item) {
        const isFromStorage =
          Boolean(raw._isFromStorage) || storageProductUUs.has(item.externalPosId);
        const prev = normalizedMap.get(item.externalPosId);
        if (prev) {
          const merged = BandaGoNormalizer.mergeProducts(prev, item, isFromStorage);
          normalizedMap.set(item.externalPosId, merged);
        } else {
          // If this single item originated from physical storage where all lots expired, clamp to 0
          if (raw._isFromStorage && item.batches.length === 0) {
            item.stock = 0;
            item.inStock = false;
          }
          normalizedMap.set(item.externalPosId, item);
        }
      }
    }

    return Array.from(normalizedMap.values());
  }
}

export const transformBandaGoRecord = BandaGoNormalizer.normalize;
