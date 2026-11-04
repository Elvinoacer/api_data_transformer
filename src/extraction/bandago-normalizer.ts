/**
 * BandaGo POS (iDempiere OSGi GraphQL) to Sphere Pharmacy Normalizer.
 * Enforces FEFO (First-Expired, First-Out), Kenya Pharmacy and Poisons Board (PPB)
 * prescription scheduling regulations, and standardized category taxonomy.
 */

export interface SphereBatchSyncItem {
  batchNumber: string;
  qtyOnHand: number;
  expiryDate: string | null;
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
    const hasIdentifier = Boolean(r.uu || r.id || r.externalPosId);
    const hasName = Boolean(r.name || r.Name || r.productName);
    const hasPharmacyTraits =
      "bh_sellprice" in r ||
      "BH_SellPrice" in r ||
      "bh_buyprice" in r ||
      "BH_BuyPrice" in r ||
      "bh_hasexpiration" in r ||
      "BH_HasExpiration" in r ||
      "quantityOnHand" in r ||
      "QuantityOnHand" in r ||
      "storageOnHand" in r ||
      "M_StorageOnHand" in r ||
      "batches" in r ||
      "Batches" in r ||
      "stock" in r ||
      "Stock" in r ||
      "price" in r ||
      "Price" in r ||
      "m_product_category" in r ||
      "M_Product_Category" in r;

    return hasIdentifier && hasName && hasPharmacyTraits;
  }

  /**
   * Normalizes a single BandaGo medication node into a Sphere Pharmacy product.
   */
  static normalize(raw: Record<string, any>): SphereProductInput | null {
    if (!raw || typeof raw !== "object") return null;

    const externalPosId = String(
      raw.uu || raw.id || raw.externalPosId || "",
    ).trim();
    const name = String(raw.name || raw.Name || raw.productName || "").trim();

    if (!externalPosId || !name) return null;

    const genericName =
      raw.genericName ||
      raw.generic_name ||
      raw.GenericName ||
      raw.bh_genericname ||
      raw.BH_GenericName ||
      raw.bh_generic_name ||
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

    // Prescription Classification (PPB Guidelines & BandaGo hasExpiration flag)
    const requiresPrescription =
      Boolean(raw.bh_hasexpiration && resolvedCategory.rx) ||
      resolvedCategory.rx ||
      RX_SCHEDULE_REGEX.test(name);

    // Batch & FEFO Expiry Calculation
    // Evaluates storageOnHand batches: discards expired stock, ignores depleted batches (qty <= 0),
    // and identifies the nearest future expiry date of available stock.
    const now = Date.now();
    let validStock = 0;
    let nearestExpiryDate: string | null = null;
    const normalizedBatches: SphereBatchSyncItem[] = [];

    const batches =
      raw.storageOnHand || raw.M_StorageOnHand || raw.batches || raw.Batches;

    if (Array.isArray(batches) && batches.length > 0) {
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

        normalizedBatches.push({
          batchNumber: lotNo,
          qtyOnHand: qty,
          expiryDate: expiryIso,
        });
      }
    } else {
      const rawStock = Number(
        raw.quantityOnHand ?? raw.QuantityOnHand ?? raw.stock ?? 0,
      );
      validStock = Math.max(
        0,
        Math.floor(Number.isFinite(rawStock) ? rawStock : 0),
      );
    }

    // Pricing parsing (guarantee non-negative values)
    const rawPrice = raw.bh_sellprice ?? raw.BH_SellPrice ?? raw.price ?? 0;
    const price = Math.max(0, Number(rawPrice) || 0);

    const costPriceRaw =
      raw.bh_buyprice ??
      raw.BH_BuyPrice ??
      raw.buyPrice ??
      raw.BuyPrice ??
      raw.costPrice ??
      raw.CostPrice;
    const costPrice =
      costPriceRaw !== undefined && costPriceRaw !== null
        ? Math.max(0, Number(costPriceRaw) || 0)
        : null;

    const description = raw.description
      ? String(raw.description).trim()
      : undefined;
    const packSize =
      raw.packSize || raw.pack_size || raw.bh_packsize
        ? String(raw.packSize || raw.pack_size || raw.bh_packsize).trim()
        : undefined;

    return {
      externalPosId,
      sku: raw.value || raw.Value || raw.sku || null,
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
   * Recursively traverses an arbitrary GraphQL response payload (query or mutation)
   * to extract and normalize all candidate BandaGo medication products.
   */
  static extractProductsFromPayload(payload: unknown): SphereProductInput[] {
    const candidates: Record<string, any>[] = [];
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
        if (BandaGoNormalizer.isProductRecord(obj)) {
          candidates.push(obj);
        } else {
          for (const val of Object.values(obj)) {
            traverse(val);
          }
        }
      }
    };

    traverse(payload);

    const normalizedMap = new Map<string, SphereProductInput>();
    for (const raw of candidates) {
      const item = BandaGoNormalizer.normalize(raw);
      if (item) {
        // Keep latest/cleanest by externalPosId
        normalizedMap.set(item.externalPosId, item);
      }
    }

    return Array.from(normalizedMap.values());
  }
}

export const transformBandaGoRecord = BandaGoNormalizer.normalize;
