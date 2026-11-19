# BandaGo POS Extension -> Sphere Pharmacy Sync Remediation Guide

## Executive Summary: Where Do Changes Need to Happen?

**Only the Chrome Extension requires code changes.**

The Sphere Pharmacy web application (`/api/integrations/bandago/sync`) already exposes the right ingestion schema and authentication checks. All 6 functional bugs occur inside the extension during **GraphQL querying**, **normalization**, **queue coalescing**, and **batch flushing** before the payload ever reaches Sphere Pharmacy.

## Priority Overview

| Priority | File in Extension | Issue Summary | Impact if Unfixed | 
| ----- | ----- | ----- | ----- | 
| **P0 (Critical)** | `src/sync/sync-queue.ts` | Re-enqueuing an item overwrites `payload` instead of merging | Wipes out FEFO batches, expiry dates, SKUs, or multi-page batch totals | 
| **P0 (Critical)** | `src/extraction/bandago-normalizer.ts` | Unbounded `.includes()` substring checks in `CATEGORY_MAP` | Marks *"Paracetamol BP"* as Rx Heart Health; puts *Fluconazole* & *Fluoxetine* in Cold & Flu | 
| **P1 (High)** | `src/background/bandago-poller.ts` | Active poller GraphQL queries omit `M_Product_Category`, `Value`, and `M_ProductPrices` | Non-regex Rx drugs default to OTC (`requiresPrescription: false`); SKUs sync as `null` | 
| **P1 (High)** | `src/sync/sphere-client.ts` | Early `break` when batch `< 50` and `maxBatches = 10` ceiling | Strands items arriving mid-flush; caps sync at 500 items when poller fetches up to 5,000 | 
| **P2 (Medium)** | `src/background/bandago-poller.ts` | `/graphql/` fallback only triggers on HTTP `404` | Fails if BandaGo returns HTTP `200` SPA HTML on trailing-slash mismatch | 
| **P2 (Low)** | `src/background/capture-controller.ts` | Missing `trigger` parameter in `SphereSyncClient.enqueue()` | Logs live CDP interceptions as `"BACKGROUND_POLL"` in Sphere audit logs | 

## 1. P0: Merge Payloads Instead of Overwriting in Sync Queue

### File: `src/sync/sync-queue.ts`

### Why This Needs Fixing

BandaGo splits product data across two different GraphQL operations:

1. `M_StorageOnHandGet` / `M_StorageOnHandForInventoryList` (contains `QtyOnHand` and `GuaranteeDate` expiry per batch, plus sellable FEFO stock, but lacks `KnhtsConcept` generic name and `LastPurchasePrice`).

2. `M_ProductGet` / `M_ProductForProductListPage` (contains `TotalQuantity`, `KnhtsConcept`, and `LastPurchasePrice`, but **no** batch/expiry breakdown).

In ADDITION, when a product has multiple batches split across pages in passive CDP capture mode, each page is enqueued separately. Currently, `coalesceSyncItems()` and `SyncQueueManager.enqueue()` overwrite `existing.payload = item`, destroying either the batch/FEFO data or the SKU/generic metadata.

### What to Change

Import `BandaGoNormalizer` in `src/sync/sync-queue.ts` and use `BandaGoNormalizer.mergeProducts()` whenever an `externalPosId` already exists in the batch or queue.

```
// src/sync/sync-queue.ts
import { StorageManager } from "../storage/storage-manager";
import {
  NormalizedSphereProduct,
  BandaGoNormalizer,
} from "../extraction/bandago-normalizer";
import { Logger } from "../utils/logger";

export interface SyncQueueItem {
  id: string; // Matches externalPosId
  payload: NormalizedSphereProduct;
  status: "PENDING" | "IN_FLIGHT" | "FAILED";
  retryCount: number;
  lastAttempt: number | null;
  error?: string;
  updatedAt: number;
}

export function coalesceSyncItems(
  items: NormalizedSphereProduct[],
): NormalizedSphereProduct[] {
  const deduped = new Map<string, NormalizedSphereProduct>();
  for (const item of items) {
    if (!item || !item.externalPosId) continue;
    const existing = deduped.get(item.externalPosId);
    if (existing) {
      // FIX: Merge batch arrays, FEFO stock, and metadata instead of overwriting
      deduped.set(
        item.externalPosId,
        BandaGoNormalizer.mergeProducts(existing, item),
      );
    } else {
      deduped.set(item.externalPosId, item);
    }
  }
  return Array.from(deduped.values());
}

```

And inside `SyncQueueManager.enqueue()` (around lines 44-72):

```
      for (const item of uniqueItems) {
        const existingIndex = queue.findIndex(
          (q) => q.id === item.externalPosId,
        );

        if (existingIndex > -1) {
          const existing = queue[existingIndex];
          // FIX: If existing item is PENDING or FAILED, merge with incoming payload
          // so M_ProductGet and M_StorageOnHandGet enrich each other instead of clobbering.
          const mergedPayload =
            existing.status === "PENDING" || existing.status === "FAILED"
              ? BandaGoNormalizer.mergeProducts(existing.payload, item)
              : item;

          queue[existingIndex] = {
            ...existing,
            payload: mergedPayload,
            status: "PENDING",
            updatedAt: now,
          };
        } else {
          queue.push({
            id: item.externalPosId,
            payload: item,
            status: "PENDING",
            retryCount: 0,
            lastAttempt: null,
            updatedAt: now,
          });
        }
      }

```

## 2. P0: Fix Category & Prescription Substring Collisions

### File: `src/extraction/bandago-normalizer.ts`

### Why This Needs Fixing

In `BandaGoNormalizer.normalize()`, category matching currently runs:

```
for (const [key, mapping] of Object.entries(CATEGORY_MAP)) {
  if (rawCategory.includes(key) || name.toLowerCase().includes(key)) {
    resolvedCategory = mapping;
    break;
  }
}

```

This causes three dangerous collisions on Kenyan pharmacy inventory:

1. **`"bp"` collision:** In Kenya, `"BP"` in product names stands for **British Pharmacopoeia** (e.g., *"Paracetamol 500mg Tablets BP"*, *"Calamine Lotion BP"*). Matching `.includes("bp")` classifies OTC Paracetamol under `heart-health` with **`requiresPrescription: true`**.

2. **`"flu"` collision:** Matching `.includes("flu")` without word boundaries matches **Fluconazole** (antifungal), **Fluoxetine** (antidepressant), **Fluticasone** (corticosteroid), and **Flucloxacillin** (antibiotic), placing them in **Cold & Flu (`cold-flu`)**.

3. **`"test"` collision:** Matching `.includes("test")` without word boundaries matches **Testosterone** injections/gels and classifies them as OTC **Diagnostics (`requiresPrescription: false`)**.

### What to Change

1. Replace `"bp"` in `CATEGORY_MAP` with explicit terms (`"blood pressure"`, `"antihypertensive"`).

2. Add missing common Rx drugs (such as `testosterone`, `cefuroxime`, `levofloxacin`, `clindamycin`, `pregabalin`, `gabapentin`, `furosemide`, `spironolactone`, `carvedilol`, `montelukast`, `carbimazole`) to `RX_SCHEDULE_REGEX`.

3. Match `CATEGORY_MAP` keys using word-boundary regular expressions (`\b`) rather than `.includes()`, and prioritize `rawCategory` before falling back to `name`.

```
// src/extraction/bandago-normalizer.ts

// 1. Expand RX_SCHEDULE_REGEX to cover additional common Kenyan PoM medications
const RX_SCHEDULE_REGEX =
  /\b(amoxicillin|augmentin|azithromycin|ciprofloxacin|cefuroxime|cefixime|ceftriaxone|clindamycin|levofloxacin|moxifloxacin|nitrofurantoin|flucloxacillin|erythromycin|clarithromycin|metronidazole|doxycycline|tinidazole|fluconazole|itraconazole|ketoconazole|acyclovir|valacyclovir|amlodipine|losartan|telmisartan|valsartan|enalapril|lisinopril|ramipril|atenolol|metoprolol|bisoprolol|carvedilol|nebivolol|nifedipine|furosemide|hydrochlorothiazide|spironolactone|atorvastatin|rosuvastatin|simvastatin|metformin|glibenclamide|gliclazide|glimepiride|sitagliptin|vildagliptin|dapagliflozin|empagliflozin|insulin|salbutamol|ventolin|symbicort|seretide|budesonide|fluticasone|montelukast|prednisolone|dexamethasone|hydrocortisone|betamethasone|omeprazole|esomeprazole|pantoprazole|lansoprazole|rabeprazole|diclofenac|celecoxib|etoricoxib|meloxicam|indomethacin|tramadol|codeine|morphine|amitriptyline|fluoxetine|sertraline|escitalopram|citalopram|paroxetine|venlafaxine|duloxetine|alprazolam|diazepam|lorazepam|clonazepam|zolpidem|carbamazepine|valproate|phenytoin|levetiracetam|lamotrigine|pregabalin|gabapentin|sildenafil|tadalafil|finasteride|tamsulosin|testosterone|warfarin|rivaroxaban|apixaban|clopidogrel|levothyroxine|carbimazole|methotrexate|hydroxychloroquine|allopurinol|colchicine)\b/i;

// 2. Replace ambiguous short keys ("bp") in CATEGORY_MAP
const CATEGORY_MAP: Record<string, { slug: string; rx: boolean }> = {
  antibiotic: { slug: "antibiotics", rx: true },
  antimicrobial: { slug: "antibiotics", rx: true },
  antiinfective: { slug: "antibiotics", rx: true },
  antifungal: { slug: "antibiotics", rx: true },
  antiviral: { slug: "antibiotics", rx: true },
  cardiovascular: { slug: "heart-health", rx: true },
  hypertension: { slug: "heart-health", rx: true },
  antihypertensive: { slug: "heart-health", rx: true },
  "blood pressure": { slug: "heart-health", rx: true },
  cardiac: { slug: "heart-health", rx: true },
  diabetes: { slug: "diabetes", rx: true },
  antidiabetic: { slug: "diabetes", rx: true },
  insulin: { slug: "diabetes", rx: true },
  respiratory: { slug: "respiratory", rx: true },
  asthma: { slug: "respiratory", rx: true },
  inhaler: { slug: "respiratory", rx: true },
  pain: { slug: "pain-relief", rx: false },
  analgesic: { slug: "pain-relief", rx: false },
  antiinflammatory: { slug: "pain-relief", rx: false },
  nsaid: { slug: "pain-relief", rx: false },
  fever: { slug: "pain-relief", rx: false },
  cold: { slug: "cold-flu", rx: false },
  flu: { slug: "cold-flu", rx: false },
  cough: { slug: "cold-flu", rx: false },
  allergy: { slug: "cold-flu", rx: false },
  antihistamine: { slug: "cold-flu", rx: false },
  digestive: { slug: "digestive", rx: false },
  gastro: { slug: "digestive", rx: false },
  antacid: { slug: "digestive", rx: false },
  ulcer: { slug: "digestive", rx: false },
  laxative: { slug: "digestive", rx: false },
  vitamin: { slug: "vitamins", rx: false },
  supplement: { slug: "vitamins", rx: false },
  mineral: { slug: "vitamins", rx: false },
  wellness: { slug: "vitamins", rx: false },
  nutrition: { slug: "vitamins", rx: false },
  dermatology: { slug: "skincare", rx: false },
  skin: { slug: "skincare", rx: false },
  topical: { slug: "skincare", rx: false },
  ointment: { slug: "skincare", rx: false },
  cream: { slug: "skincare", rx: false },
  pediatric: { slug: "mother-baby", rx: false },
  baby: { slug: "mother-baby", rx: false },
  infant: { slug: "mother-baby", rx: false },
  maternal: { slug: "mother-baby", rx: false },
  surgical: { slug: "first-aid", rx: false },
  "first aid": { slug: "first-aid", rx: false },
  wound: { slug: "first-aid", rx: false },
  bandage: { slug: "first-aid", rx: false },
  dressing: { slug: "first-aid", rx: false },
  diagnostic: { slug: "diagnostics", rx: false },
  device: { slug: "diagnostics", rx: false },
  equipment: { slug: "diagnostics", rx: false },
  "test strip": { slug: "diagnostics", rx: false },
  "test kit": { slug: "diagnostics", rx: false },
  rapid: { slug: "diagnostics", rx: false },
  malaria: { slug: "antibiotics", rx: true },
  antimalarial: { slug: "antibiotics", rx: true },
  eye: { slug: "eye-ear", rx: false },
  ear: { slug: "eye-ear", rx: false },
  ophthalmic: { slug: "eye-ear", rx: true },
  otic: { slug: "eye-ear", rx: false },
};

```

And update the category lookup loop in `BandaGoNormalizer.normalize()` (around lines 458-467):

```
    let resolvedCategory = { slug: "otc-medicines", rx: false };
    let matchedCategory = false;

    // Step 1: Check explicit POS category first using word boundaries
    for (const [key, mapping] of Object.entries(CATEGORY_MAP)) {
      const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const keyRegex = new RegExp(`\\b${escapedKey}\\b`, "i");
      if (keyRegex.test(rawCategory)) {
        resolvedCategory = mapping;
        matchedCategory = true;
        break;
      }
    }

    // Step 2: Only fall back to product name if rawCategory didn't match
    if (!matchedCategory) {
      for (const [key, mapping] of Object.entries(CATEGORY_MAP)) {
        const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        const keyRegex = new RegExp(`\\b${escapedKey}\\b`, "i");
        if (keyRegex.test(name)) {
          resolvedCategory = mapping;
          break;
        }
      }
    }

```

## 3. P1: Request Missing GraphQL Fields & Harden Endpoint Fallback in Active Poller

### File: `src/background/bandago-poller.ts`

### Why This Needs Fixing

1. `BandaGoNormalizer.normalize()` inspects `raw.M_Product_Category?.Name`, `raw.Value` (SKU fallback), `raw.BH_HasExpiration`, and `raw.M_ProductPrices`, **none of which are requested** in `bandago-poller.ts`'s two GraphQL queries.

2. When `/graphql/` returns an HTML `200 OK` (common on SPA deployments when a trailing slash doesn't match the proxy route), `res.json()` fails with a parse error and `status` is `undefined`, preventing the fallback to `/graphql`.

### What to Change

Update `storageQuery`, `productQuery`, and the endpoint fallback check in `src/background/bandago-poller.ts`:

```
// src/background/bandago-poller.ts (Lines 95-163)

    const storageQuery = `
      query M_StorageOnHandForInventoryList($Page: Int, $Size: Int, $Filter: String) {
        M_StorageOnHandGet(Page: $Page, Size: $Size, Filter: $Filter) {
          Results {
            QtyOnHand
            M_Product {
              UU
              Name
              Value
              Description
              BH_SellPrice
              BH_PriceMargin
              BH_HasExpiration
              HasExpirationDate
              IsActive
              M_Product_Category {
                UU
                Name
              }
              KnhtsConcept {
                UU
                name
                code
                type
              }
            }
            M_AttributeSetInstance {
              UU
              GuaranteeDate
              SerNo
              Lot
            }
            M_Locator {
              Value
              M_Warehouse {
                Name
              }
            }
          }
          PagingInfo {
            Page
            PageSize
            TotalPages
            TotalCount
          }
        }
      }
    `;

    const productQuery = `
      query M_ProductForProductListPage($Filter: String, $Page: Int, $Size: Int, $Sort: String) {
        M_ProductGet(Filter: $Filter, Page: $Page, Size: $Size, Sort: $Sort) {
          Results {
            UU
            Name
            Value
            Description
            BH_BuyPrice
            BH_SellPrice
            BH_PriceMargin
            BH_HasExpiration
            HasExpirationDate
            IsActive
            TotalQuantity
            LastPurchasePrice
            M_Product_Category {
              UU
              Name
            }
            KnhtsConcept {
              UU
              name
              code
              type
            }
          }
          PagingInfo {
            Page
            PageSize
            TotalPages
            TotalCount
          }
        }
      }
    `;

```

And inside the injected `executeScript` function in `bandago-poller.ts` (around lines 346-402), check `content-type` and retry `/graphql` whenever `storageRes?.error` occurs (not only when `status === 404`):

```
          // Inside executeGql() in src/background/bandago-poller.ts:
          const contentType = res.headers.get("content-type") || "";
          if (!contentType.includes("application/json")) {
            return {
              error: `Non-JSON response (${contentType})`,
              status: res.status,
              nonJson: true,
            };
          }

```

```
        // Inside fetchAllPages() in src/background/bandago-poller.ts:
        let activeEndpoint = "/graphql/";
        let storageRes = await executeGql(activeEndpoint, sQuery, {
          Page: 0,
          Size: PAGE_SIZE,
          Filter: JSON.stringify({}),
        });

        // Fallback to /graphql without trailing slash on 404 OR non-JSON SPA response
        if (
          storageRes?.status === 404 ||
          storageRes?.nonJson ||
          storageRes?.error
        ) {
          const fallbackRes = await executeGql("/graphql", sQuery, {
            Page: 0,
            Size: PAGE_SIZE,
            Filter: JSON.stringify({}),
          });
          if (!fallbackRes?.error) {
            activeEndpoint = "/graphql";
            storageRes = fallbackRes;
          }
        }

```

## 4. P1: Fix `flushQueue()` Race Condition & 500-Item Flush Cap

### File: `src/sync/sphere-client.ts`

### Why This Needs Fixing

1. **Race condition on small initial batches:** In `SphereSyncClient.flushQueue()`, lines 199-201 check:

   ```
   if (pendingItems.length < this.BATCH_SIZE) {
     break;
   }
   
   ```

   If Batch 1 has 20 items (`< 50`) and is currently awaiting `fetch()`, and another GraphQL response arrives 100ms later with 40 items, the second `flushQueue()` call immediately exits because `this.isFlushing` is `true`. Then Batch 1 finishes and hits `if (20 < 50) break;`, leaving the 40 newly queued items stuck in `PENDING` until the 10-minute background alarm runs.

2. **500-item ceiling:** `BandaGoActivePoller` pulls up to 5,000 products (`10 pages x 500 items`), but `flushQueue()` sets `maxBatches = 10` (`10 x 50 = 500 items`), leaving up to 4,500 items unsynced per poll cycle.

### What to Change

In `src/sync/sphere-client.ts`:

1. Increase `maxBatches` from `10` to `100` (allows up to `100 x 50 = 5,000` items to drain in a single poll).

2. Remove the `if (pendingItems.length < this.BATCH_SIZE) break;` check so the `while` loop naturally checks `SyncQueueManager.getPending(this.BATCH_SIZE)` at the start of the next iteration and drains any items that arrived while `fetch()` was in flight.

```
// src/sync/sphere-client.ts (Lines 140-206)

      let totalSynced = 0;
      let totalFailed = 0;
      let batchIteration = 0;
      const maxBatches = 100; // Supports up to 5,000 items (100 x 50) per flush

      while (batchIteration < maxBatches) {
        batchIteration++;
        const pendingItems = await SyncQueueManager.getPending(this.BATCH_SIZE);
        if (pendingItems.length === 0) {
          break; // Queue is genuinely empty
        }

        const itemIds = pendingItems.map((i) => i.id);
        await SyncQueueManager.markInFlight(itemIds);

        const payload = {
          source: "BANDAGO_POS_EXTENSION",
          trigger,
          timestamp: new Date().toISOString(),
          count: pendingItems.length,
          items: pendingItems.map((i) => i.payload),
        };

        try {
          const response = await this.fetchWithTimeout(config.endpointUrl, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${config.apiKey}`,
              "X-Sphere-Sync-Version": "1.0.0",
            },
            body: JSON.stringify(payload),
            timeout: this.REQUEST_TIMEOUT_MS,
          });

          if (!response.ok) {
            const errorText = await response
              .text()
              .catch(() => "Unknown HTTP Error");
            throw new Error(
              `HTTP ${response.status}: ${errorText.slice(0, 200)}`,
            );
          }

          await SyncQueueManager.markSuccess(itemIds);
          totalSynced += pendingItems.length;
          // NOTE: Removed `if (pendingItems.length < this.BATCH_SIZE) break;`
          // so items enqueued while `fetchWithTimeout` was in-flight are immediately drained.
        } catch (batchErr: any) {
          Logger.error("Sphere sync batch failed", {
            batchIteration,
            count: pendingItems.length,
            error: batchErr.message,
          });
          await SyncQueueManager.markFailed(
            itemIds,
            batchErr.message || "Network Error",
          );
          totalFailed += pendingItems.length;
          break; // Stop flushing further batches if network/server is down
        }
      }

```

## 5. P2: Tag Live CDP Captures Accurately

### File: `src/background/capture-controller.ts`

### Why This Needs Fixing

In `handleBandaGoPayload()` (line 539), `SphereSyncClient.enqueue(normalizedProducts)` is called without a trigger label, defaulting to `"BACKGROUND_POLL"`. Passing `"CDP_INTERCEPT"` makes it easy to distinguish passive real-time cashier/pharmacist browsing from scheduled 10-minute background polls in the Sphere Pharmacy logs.

### What to Change

```
// src/background/capture-controller.ts (Line 539)
const syncResult = await SphereSyncClient.enqueue(
  normalizedProducts,
  "CDP_INTERCEPT",
);

```

## 6. Runtime Configuration Checklist (Required Before First Sync)

Because `SphereSyncClient.getConfig()` defaults to `enabled: false`, verify these settings after rebuilding the extension:

1. **Sphere Pharmacy `.env`:**
   Ensure `BANDAGO_SYNC_API_KEY` is set on the Sphere Pharmacy server:

   ```
   BANDAGO_SYNC_API_KEY="sphere_bandago_live_sync_secret_key_2026"
   
   ```

2. **Extension Dashboard -> Settings & Privacy:**

   * **Enable Sphere Sync:** Toggle **ON** (`true`)

   * **Endpoint URL:**

     * Local Dev: `http://localhost:3000/api/integrations/bandago/sync`

     * Production: `https://<your-sphere-domain>/api/integrations/bandago/sync`

   * **API Key:** Paste the exact value of `BANDAGO_SYNC_API_KEY` from step 1.

3. **Rebuild the Extension:**
   Run `npm run build` in the extension directory and click **Reload** on `chrome://extensions`.