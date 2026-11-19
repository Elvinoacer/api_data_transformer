# BandaGo POS to Sphere Pharmacy: Complete Data Transformer & Live Sync Blueprint

This document specifies the technical architecture, data structures, code refactors, and implementation roadmap required to turn `api_data_transformer` into an automated, production-ready ingestion and synchronization engine between **BandaGo Pharmacy POS** (`go.bandahealth.org`) and **Sphere Pharmacy** (`sphere_pharmacy`).

---

## 1. Executive Architecture & System Topology

### 1.1 The Operational Reality
1. **BandaGo POS** is a cloud clinic/pharmacy HMIS built on a customized iDempiere ERP (Java OSGi) backend running on PostgreSQL, with a React frontend communicating via **GraphQL over HTTP** (`POST /graphql`).
2. Pharmacies in Kenya use BandaGo on counter desktop browsers (Google Chrome) throughout the working day for dispensing medications, checking batch stock, processing cashier sales, and receiving supplier delivery notes.
3. Direct server-to-server API access is constrained: Banda Health does not provide a public developer portal or self-service REST webhooks, and cloud firewalls block external unauthorized connections.
4. **`api_data_transformer`** operates as a Chrome Manifest V3 Extension leveraging the Chrome DevTools Protocol (`chrome.debugger`) to inspect network payloads directly within the authenticated pharmacist's browser session.

### 1.2 System Topology Diagram

```
+---------------------------------------------------------------------------------------------------+
|                                  PHARMACY COUNTER BROWSER (CHROME)                                |
|                                                                                                   |
|  +------------------------------------+          +---------------------------------------------+  |
|  |     BandaGo POS Web Application    |          |            api_data_transformer             |  |
|  |       (go.bandahealth.org)         |          |          (Manifest V3 Extension)            |  |
|  +-----------------+------------------+          +----------------------+----------------------+  |
|                    |                                                    |                         |
|      GraphQL POST  | (Cookies / Session)                                | CDP Network Hooks       |
|      Requests      |                                                    | chrome.debugger         |
|                    v                                                    v                         |
|     +------------------------------+             +---------------------------------------------+  |
|     |  BandaGo Cloud Backend       |             | cdp-adapter.ts                              |  |
|     |  (iDempiere ERP + GraphQL)   |             | Captures Network.responseReceived           |  |
|     +--------------+---------------+             +----------------------+----------------------+  |
|                    |                                                    |                         |
|      JSON Response |                               Raw GraphQL Payload  v                         |
|                    +---------------------------->+---------------------------------------------+  |
|                                                  | bandago-normalizer.ts                       |  |
|                                                  | - Resolves GraphQL operationName            |  |
|                                                  | - Filters expired batches (FEFO)            |  |
|                                                  | - Infers PPB Prescription flags             |  |
|                                                  | - Maps category images & slugs              |  |
|                                                  +----------------------+----------------------+  |
|                                                                         |                         |
|                                                    Normalized Records   v                         |
|                                                  +---------------------------------------------+  |
|                                                  | Dexie.js (Local IndexedDB Storage)          |  |
|                                                  | - Offline Queue & Sync Ledger               |  |
|                                                  +----------------------+----------------------+  |
|                                                                         |                         |
+-------------------------------------------------------------------------|-------------------------+
                                                                          |
                                                                          | HTTPS Push (Bearer Auth)
                                                                          | /api/integrations/bandago/sync
                                                                          v
                                                  +-----------------------------------------------+
                                                  |             SPHERE PHARMACY CLOUD             |
                                                  |                                               |
                                                  |  +-----------------------------------------+  |
                                                  |  | Next.js API: /api/integrations/...      |  |
                                                  |  +--------------------+--------------------+  |
                                                  |                       |                       |
                                                  |                       v                       |
                                                  |  +-----------------------------------------+  |
                                                  |  | PostgreSQL (Prisma ORM)                 |  |
                                                  |  | - Product catalog (externalPosId match) |  |
                                                  |  | - Live stock updates                    |  |
                                                  |  | - Near-expiry safety checks             |  |
                                                  |  +--------------------+--------------------+  |
                                                  |                       |                       |
                                                  |                       v                       |
                                                  |  +-----------------------------------------+  |
                                                  |  | Customer Storefront & PWA               |  |
                                                  |  +-----------------------------------------+  |
                                                  +-----------------------------------------------+
```

---

## 2. Deep-Dive Audit of `api_data_transformer`

### 2.1 Existing Module Inventory

| File Path | Role in `api_data_transformer` | Current Capability | Gaps When Handling BandaGo POS |
| :--- | :--- | :--- | :--- |
| `src/background/cdp-adapter.ts` | Attaches `chrome.debugger` to active tab; enables `Network` domain. | Captures network requests, headers, and bodies via `Network.getResponseBody`. | Does not capture request POST bodies (`requestWillBeSent`). Because all BandaGo calls go to `/graphql`, the request body containing `operationName` is lost. |
| `src/background/capture-controller.ts` | Orchestrates capture pipeline and triggers data persistence. | Redacts URLs, detects MIME types, and saves raw responses to IndexedDB. | Groups responses solely by URL. Every BandaGo operation (stock, billing, patients) collides under `go.bandahealth.org/graphql`. |
| `src/data/db.ts` | Dexie.js schema definition. | Stores `sources`, `responses`, `records`, `schemas`, and `exports`. | Lacks an outbound sync queue table (`sync_queue`) with retry counters and dispatch status. |
| `src/extraction/path-selector.ts` | Identifies array paths in JSON payloads. | Traverses object graph to locate records (`data.items`, etc.). | Fails on nested inventory structures where `data.products` has nested batch arrays (`storageOnHand`). |
| `src/extraction/flatten.ts` | Flattens nested JSON objects into 2D records. | Dot-notation flattening (`user.address.city`). | Flattens batch arrays into `storageOnHand.0.qtyOnHand`, `storageOnHand.1.qtyOnHand`, creating fragmented tabular columns instead of summing available stock. |
| `src/extraction/deduplicate.ts` | Deduplicates records by field or hash. | Deduplicates rows in memory during export. | Does not handle stateful upserts (e.g., product A stock updated from 50 to 45). |
| `src/export/csv.ts` | Generates RFC 4180 CSV strings. | Escapes quotes, formats headers, downloads files. | Outputs raw iDempiere field names (`BH_SellPrice`, `M_Product_Category_ID`) incompatible with `sphere_pharmacy`. |
| `src/dashboard/pages/Exports.tsx` | UI for downloading captured datasets. | Manual download button for CSV, JSON, and JSONL. | Entirely manual. Requires a human operator to click, save, and manually import into the storefront. |

---

## 3. BandaGo POS & iDempiere Data Architecture

### 3.1 BandaGo GraphQL Request/Response Signatures

BandaGo encapsulates iDempiere ERP entities inside its custom OSGi GraphQL schema.

#### A. Product & Inventory Query
When a pharmacist opens the inventory or product catalog, BandaGo sends:

```graphql
query GetPharmacyInventory($categoryId: Int, $searchTerm: String, $pageSize: Int, $offset: Int) {
  products(categoryId: $categoryId, search: $searchTerm, limit: $pageSize, offset: $offset) {
    id
    uu
    value
    name
    description
    bh_sellprice
    bh_buyprice
    bh_hasexpiration
    m_product_category {
      id
      name
    }
    quantityOnHand
    storageOnHand {
      qtyOnHand
      m_attributesetinstance {
        lot
        guaranteeDate
      }
    }
  }
}
```

#### B. POS Cashier Sale / Dispense Mutation
When a sale is completed at the POS counter:

```graphql
mutation CompleteOrder($orderInput: OrderInput!) {
  completeOrder(input: $orderInput) {
    order {
      id
      documentNo
      grandTotal
      lines {
        product {
          uu
          name
        }
        qtyOrdered
        priceActual
      }
    }
    success
  }
}
```

### 3.2 The First-Expired, First-Out (FEFO) Challenge

BandaGo tracks stock using iDempiere's `M_StorageOnHand` and `M_AttributeSetInstance`. A single medication (e.g., *Amoxicillin 500mg*) often has multiple inventory rows in BandaGo:
* **Batch A (Lot LOT-101):** 40 capsules, Expiry: `2024-01-15` (**EXPIRED**)
* **Batch B (Lot LOT-204):** 100 capsules, Expiry: `2027-03-31` (**VALID**)
* **Batch C (Lot LOT-308):** 150 capsules, Expiry: `2027-08-30` (**VALID**)

**The Critical Flaw of Flat Extraction:**
If you extract BandaGo's top-level `quantityOnHand`, it returns `290`. Dispensing expired medication violates Kenya Pharmacy and Poisons Board (PPB) guidelines. The transformer **must** iterate over `storageOnHand`, discard expired batches relative to current UTC time, sum only valid stock (`250`), and extract the nearest expiration date (`2027-03-31`).

---

## 4. Target Contract: `sphere_pharmacy` Ingestion Model

Sphere Pharmacy's backend (`prisma/schema.prisma` and storefront components) requires medication records matching the following schema:

```prisma
model Product {
  id                   String           @id @default(cuid())
  name                 String
  slug                 String           @unique
  sku                  String?          @unique
  barcode              String?
  description          String?
  price                Decimal          @db.Decimal(10, 2)
  compareAtPrice       Decimal?         @map("compare_at_price") @db.Decimal(10, 2)
  costPrice            Decimal?         @map("cost_price") @db.Decimal(10, 2)
  stock                Int              @default(0)
  inStock              Boolean          @default(true) @map("in_stock")
  lowStockThreshold    Int              @default(5) @map("low_stock_threshold")
  requiresPrescription Boolean          @default(false) @map("requires_prescription")
  dosageForm           String?          @map("dosage_form")
  strength             String?
  packSize             String?          @map("pack_size")
  category             ProductCategory  @relation(fields: [categoryId], references: [id])
  categoryId           String           @map("category_id")
  images               ProductImage[]
  
  // Dedicated POS Integration Fields
  externalPosId        String?          @unique @map("external_pos_id")
  posSource            String?          @default("BANDAGO") @map("pos_source")
  nearestExpiryDate    DateTime?        @map("nearest_expiry_date")
  lastSyncedAt         DateTime?        @map("last_synced_at")

  @@index([slug])
  @@index([externalPosId])
  @@map("products")
}
```

---

## 5. Architectural Enhancements for `api_data_transformer`

To make the integration seamless, five targeted modules must be introduced into `api_data_transformer`:

```
api_data_transformer/src/
├── background/
│   ├── cdp-adapter.ts              <-- [MODIFIED] Capture POST request bodies
│   ├── capture-controller.ts       <-- [MODIFIED] Route /graphql by operationName
│   ├── bandago-poller.ts           <-- [NEW] Active background GraphQL query worker
│   └── service-worker.ts           <-- [MODIFIED] Manage sync alarms and listeners
├── extraction/
│   ├── bandago-normalizer.ts       <-- [NEW] Pharmacy business logic, FEFO, Rx rules
│   └── path-selector.ts            <-- [MODIFIED] Support GraphQL root data paths
├── sync/
│   ├── sync-queue.ts               <-- [NEW] Offline-first queue with exponential backoff
│   └── sphere-client.ts            <-- [NEW] Authenticated HTTP client for Sphere API
├── data/
│   ├── db.ts                       <-- [MODIFIED] Add sync_queue Dexie table
│   └── repositories.ts             <-- [MODIFIED] Add sync ledger operations
└── dashboard/
    └── pages/
        └── Settings.tsx            <-- [MODIFIED] Add Sphere API configuration UI
```

---

## 6. Implementation Code

### 6.1 Database Upgrade: `src/data/db.ts`

Add an outbound sync queue table to Dexie so network interruptions never drop stock changes:

```typescript
// src/data/db.ts
import Dexie, { Table } from 'dexie';
import {
  CapturedSource,
  CapturedResponse,
  ExtractedRecord,
  InferredSchema,
  ExportHistoryItem,
} from '../shared/types';

export interface SyncQueueItem {
  id?: number;
  externalPosId: string;
  payload: Record<string, any>;
  status: 'PENDING' | 'SYNCING' | 'SUCCESS' | 'FAILED';
  retryCount: number;
  lastError?: string;
  createdAt: number;
  updatedAt: number;
}

export class TransformerDatabase extends Dexie {
  sources!: Table<CapturedSource, string>;
  responses!: Table<CapturedResponse, string>;
  records!: Table<ExtractedRecord, string>;
  schemas!: Table<InferredSchema, string>;
  exports!: Table<ExportHistoryItem, string>;
  sync_queue!: Table<SyncQueueItem, number>;

  constructor() {
    super('ApiDataTransformerDB');

    this.version(1).stores({
      sources: 'id, url, host, method, contentType, firstSeenAt, lastSeenAt',
      responses: 'id, sourceId, timestamp, status, size',
      records: 'id, sourceId, responseId, timestamp',
      schemas: 'id, sourceId, version, detectedAt',
      exports: 'id, sourceId, timestamp, format',
    });

    // Version 2: Add sync_queue for POS integration
    this.version(2).stores({
      sync_queue: '++id, externalPosId, status, createdAt, updatedAt',
    });
  }
}

export const db = new TransformerDatabase();
```

---

### 6.2 CDP Adapter Request Body Hook: `src/background/cdp-adapter.ts`

Modify `cdp-adapter.ts` to capture outgoing GraphQL request payloads (`requestWillBeSent`) so we know the `operationName` and variables:

```typescript
// Additions to src/background/cdp-adapter.ts
export interface RequestMetadata {
  requestId: string;
  url: string;
  method: string;
  postData?: string;
  headers: Record<string, string>;
}

export class CdpNetworkAdapter {
  private requestPayloadMap = new Map<string, string>();

  // Inside handleDebuggerEvent(source, method, params):
  private handleDebuggerEvent(
    debuggee: chrome.debugger.Debuggee,
    method: string,
    params: any
  ) {
    if (method === 'Network.requestWillBeSent') {
      const { requestId, request } = params;
      if (request.postData) {
        this.requestPayloadMap.set(requestId, request.postData);
      }
    }

    if (method === 'Network.responseReceived') {
      const { requestId, response } = params;
      const postData = this.requestPayloadMap.get(requestId);
      
      // Pass postData along to capture-controller
      this.emitResponse({
        requestId,
        url: response.url,
        method: response.requestMethod || 'GET',
        status: response.status,
        mimeType: response.mimeType,
        headers: response.headers,
        postData,
      });
    }

    if (method === 'Network.loadingFinished') {
      const { requestId } = params;
      // Clean up postData memory after processing
      setTimeout(() => this.requestPayloadMap.delete(requestId), 30000);
    }
  }
  
  // ... rest of existing cdp-adapter.ts implementation ...
}
```

---

### 6.3 The Pharmacy Normalizer: `src/extraction/bandago-normalizer.ts`

This is the core mapping engine that translates raw BandaGo iDempiere responses into clean `sphere_pharmacy` records.

```typescript
// src/extraction/bandago-normalizer.ts

export interface SphereProductInput {
  externalPosId: string;
  sku: string | null;
  name: string;
  slug: string;
  categorySlug: string;
  price: number;
  costPrice: number | null;
  stock: number;
  inStock: boolean;
  requiresPrescription: boolean;
  imageUrl: string;
  nearestExpiryDate: string | null;
  dosageForm?: string;
  strength?: string;
}

const CATEGORY_MAP: Record<string, { slug: string; defaultImage: string; rx: boolean }> = {
  allergy: { slug: 'allergy', defaultImage: '/images/categories/cat-allergy.webp', rx: false },
  cold: { slug: 'cold-flu', defaultImage: '/images/categories/cat-cold-flu.webp', rx: false },
  cough: { slug: 'cold-flu', defaultImage: '/images/categories/cat-cold-flu.webp', rx: false },
  flu: { slug: 'cold-flu', defaultImage: '/images/categories/cat-cold-flu.webp', rx: false },
  diabetes: { slug: 'diabetes', defaultImage: '/images/categories/cat-diabetes.webp', rx: true },
  diabetic: { slug: 'diabetes', defaultImage: '/images/categories/cat-diabetes.webp', rx: true },
  diagnostic: { slug: 'diagnostics', defaultImage: '/images/categories/cat-diagnostics.webp', rx: false },
  test: { slug: 'diagnostics', defaultImage: '/images/categories/cat-diagnostics.webp', rx: false },
  'first aid': { slug: 'first-aid', defaultImage: '/images/categories/cat-first-aid.webp', rx: false },
  bandage: { slug: 'first-aid', defaultImage: '/images/categories/cat-first-aid.webp', rx: false },
  gastro: { slug: 'gastro', defaultImage: '/images/categories/cat-gastro.webp', rx: false },
  stomach: { slug: 'gastro', defaultImage: '/images/categories/cat-gastro.webp', rx: false },
  antacid: { slug: 'gastro', defaultImage: '/images/categories/cat-gastro.webp', rx: false },
  heart: { slug: 'heart-health', defaultImage: '/images/categories/cat-heart-health.webp', rx: true },
  hypertension: { slug: 'heart-health', defaultImage: '/images/categories/cat-heart-health.webp', rx: true },
  cardio: { slug: 'heart-health', defaultImage: '/images/categories/cat-heart-health.webp', rx: true },
  bp: { slug: 'heart-health', defaultImage: '/images/categories/cat-heart-health.webp', rx: true },
  device: { slug: 'medical-devices', defaultImage: '/images/categories/cat-medical-devices.webp', rx: false },
  baby: { slug: 'mother-baby', defaultImage: '/images/categories/cat-mother-baby.webp', rx: false },
  infant: { slug: 'mother-baby', defaultImage: '/images/categories/cat-mother-baby.webp', rx: false },
  mother: { slug: 'mother-baby', defaultImage: '/images/categories/cat-mother-baby.webp', rx: false },
  pain: { slug: 'pain-fever', defaultImage: '/images/categories/cat-pain-fever.webp', rx: false },
  fever: { slug: 'pain-fever', defaultImage: '/images/categories/cat-pain-fever.webp', rx: false },
  analgesic: { slug: 'pain-fever', defaultImage: '/images/categories/cat-pain-fever.webp', rx: false },
  personal: { slug: 'personal-care', defaultImage: '/images/categories/cat-personal-care.webp', rx: false },
  hygiene: { slug: 'personal-care', defaultImage: '/images/categories/cat-personal-care.webp', rx: false },
  prescription: { slug: 'prescription', defaultImage: '/images/categories/cat-prescription.webp', rx: true },
  antibiotic: { slug: 'prescription', defaultImage: '/images/categories/cat-prescription.webp', rx: true },
  sexual: { slug: 'sexual-health', defaultImage: '/images/categories/cat-sexual-health.webp', rx: false },
  skin: { slug: 'skin-care', defaultImage: '/images/categories/cat-skin-care.webp', rx: false },
  dermatology: { slug: 'skin-care', defaultImage: '/images/categories/cat-skin-care.webp', rx: false },
  vitamin: { slug: 'vitamins', defaultImage: '/images/categories/cat-vitamins.webp', rx: false },
  supplement: { slug: 'vitamins', defaultImage: '/images/categories/cat-vitamins.webp', rx: false },
};

// Prescription-only keywords per PPB (Pharmacy & Poisons Board Kenya) schedule
const RX_SCHEDULE_REGEX = /\b(amoxicillin|amoxil|augmentin|co-amoxiclav|azithromycin|ciprofloxacin|metronidazole|flagyl|ceftriaxone|cefixime|doxycycline|erythromycin|metformin|glibenclamide|insulin|amlodipine|losartan|atenolol|enalapril|hydrochlorothiazide|salbutamol|ventolin|prednisolone|dexamethasone|tramadol|codeine|diazepam|fluoxetine|omeprazole|esomeprazole)\b/i;

const STRENGTH_REGEX = /(\d+(\.\d+)?\s*(mg|g|mcg|ml|iu|%))/i;
const DOSAGE_FORM_REGEX = /\b(tablet|tablets|tab|tabs|capsule|capsules|cap|caps|syrup|syr|suspension|susp|injection|inj|cream|ointment|drops|inhaler|gel|powder|sachet)\b/i;

function generateSlug(name: string, externalId: string): string {
  const base = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
  const suffix = externalId.slice(0, 6).toLowerCase();
  return `${base}-${suffix}`;
}

export class BandaGoNormalizer {
  /**
   * Identifies whether a raw record matches BandaGo product structures
   */
  static isProductRecord(raw: Record<string, any>): boolean {
    return Boolean(
      (raw.uu || raw.id) &&
      (raw.name || raw.Name) &&
      ('bh_sellprice' in raw || 'BH_SellPrice' in raw || 'quantityOnHand' in raw || 'storageOnHand' in raw)
    );
  }

  /**
   * Normalizes a single BandaGo medication node
   */
  static normalize(raw: Record<string, any>): SphereProductInput | null {
    const externalPosId = String(raw.uu || raw.id || '').trim();
    const name = String(raw.name || raw.Name || '').trim();

    if (!externalPosId || !name) return null;

    // Extract Strength and Form
    const strengthMatch = name.match(STRENGTH_REGEX);
    const strength = strengthMatch ? strengthMatch[0] : undefined;

    const formMatch = name.match(DOSAGE_FORM_REGEX);
    const dosageForm = formMatch ? formMatch[0].toLowerCase() : undefined;

    // Category Resolution
    const rawCategory = String(
      raw.m_product_category?.name ||
      raw.M_Product_Category?.Name ||
      raw.category ||
      'OTC'
    ).toLowerCase();

    let resolvedCategory = {
      slug: 'otc',
      defaultImage: '/images/categories/cat-otc.webp',
      rx: false,
    };

    for (const [key, mapping] of Object.entries(CATEGORY_MAP)) {
      if (rawCategory.includes(key) || name.toLowerCase().includes(key)) {
        resolvedCategory = mapping;
        break;
      }
    }

    // Prescription Classification (PPB Guidelines)
    const requiresPrescription =
      Boolean(raw.bh_hasexpiration && resolvedCategory.rx) ||
      resolvedCategory.rx ||
      RX_SCHEDULE_REGEX.test(name);

    // Batch & FEFO Expiry Calculation
    const now = Date.now();
    let validStock = 0;
    let nearestExpiryDate: string | null = null;

    const batches = raw.storageOnHand || raw.M_StorageOnHand;
    if (Array.isArray(batches) && batches.length > 0) {
      for (const batch of batches) {
        const qty = Number(batch.qtyOnHand ?? batch.QtyOnHand ?? 0);
        const expRaw =
          batch.m_attributesetinstance?.guaranteeDate ||
          batch.M_AttributeSetInstance?.GuaranteeDate ||
          batch.expiryDate;

        if (expRaw) {
          const expTime = new Date(expRaw).getTime();
          if (!isNaN(expTime)) {
            if (expTime < now) {
              // Expired stock is legally unsellable - do not count towards online stock!
              continue;
            }
            if (!nearestExpiryDate || expTime < new Date(nearestExpiryDate).getTime()) {
              nearestExpiryDate = new Date(expTime).toISOString();
            }
          }
        }
        if (qty > 0) {
          validStock += qty;
        }
      }
    } else {
      validStock = Math.max(
        0,
        Math.floor(Number(raw.quantityOnHand ?? raw.QuantityOnHand ?? raw.stock ?? 0))
      );
    }

    // Pricing
    const price = Number(raw.bh_sellprice ?? raw.BH_SellPrice ?? raw.price ?? 0);
    const costPriceRaw = raw.bh_buyprice ?? raw.BH_BuyPrice ?? raw.costPrice;
    const costPrice = costPriceRaw !== undefined && costPriceRaw !== null ? Number(costPriceRaw) : null;

    return {
      externalPosId,
      sku: raw.value || raw.Value || raw.sku || null,
      name,
      slug: generateSlug(name, externalPosId),
      categorySlug: resolvedCategory.slug,
      price: isNaN(price) ? 0 : price,
      costPrice: costPrice !== null && !isNaN(costPrice) ? costPrice : null,
      stock: validStock,
      inStock: validStock > 0,
      requiresPrescription,
      imageUrl: resolvedCategory.defaultImage,
      nearestExpiryDate,
      dosageForm,
      strength,
    };
  }
}
```

---

### 6.4 The Outbound Sync Engine: `src/sync/sphere-client.ts`

Manages network transmissions, error retries, and batching to `sphere_pharmacy`.

```typescript
// src/sync/sphere-client.ts
import { db, SyncQueueItem } from '../data/db';
import { SphereProductInput } from '../extraction/bandago-normalizer';

export interface SyncConfig {
  endpointUrl: string;
  apiKey: string;
  enabled: boolean;
  pharmacyId?: string;
}

export class SphereSyncClient {
  private static readonly BATCH_SIZE = 50;
  private static readonly MAX_RETRIES = 5;

  static async getConfig(): Promise<SyncConfig> {
    const data = await chrome.storage.local.get([
      'sphere_endpoint_url',
      'sphere_api_key',
      'sphere_sync_enabled',
      'sphere_pharmacy_id',
    ]);

    return {
      endpointUrl: data.sphere_endpoint_url || '',
      apiKey: data.sphere_api_key || '',
      enabled: Boolean(data.sphere_sync_enabled),
      pharmacyId: data.sphere_pharmacy_id || 'DEFAULT_STORE',
    };
  }

  /**
   * Enqueues normalized product items for sync
   */
  static async enqueue(items: SphereProductInput[]): Promise<void> {
    const now = Date.now();
    const queueEntries: SyncQueueItem[] = items.map((item) => ({
      externalPosId: item.externalPosId,
      payload: item,
      status: 'PENDING',
      retryCount: 0,
      createdAt: now,
      updatedAt: now,
    }));

    await db.transaction('rw', db.sync_queue, async () => {
      for (const entry of queueEntries) {
        // Upsert by externalPosId to avoid duplicate queue backlog
        const existing = await db.sync_queue
          .where('externalPosId')
          .equals(entry.externalPosId)
          .first();

        if (existing && existing.id) {
          await db.sync_queue.update(existing.id, {
            payload: entry.payload,
            status: 'PENDING',
            updatedAt: now,
          });
        } else {
          await db.sync_queue.add(entry);
        }
      }
    });

    // Attempt an immediate flush if online
    this.flushQueue().catch((err) => console.error('[Sync Queue Flush Error]:', err));
  }

  /**
   * Dispatches pending items to Sphere Pharmacy
   */
  static async flushQueue(): Promise<{ synced: number; failed: number }> {
    const config = await this.getConfig();
    if (!config.enabled || !config.endpointUrl || !config.apiKey) {
      return { synced: 0, failed: 0 };
    }

    const pendingItems = await db.sync_queue
      .where('status')
      .equals('PENDING')
      .limit(this.BATCH_SIZE)
      .toArray();

    if (pendingItems.length === 0) return { synced: 0, failed: 0 };

    const ids = pendingItems.map((p) => p.id!).filter(Boolean);
    await db.sync_queue.where('id').anyOf(ids).modify({ status: 'SYNCING' });

    try {
      const payloadItems = pendingItems.map((p) => p.payload);

      const response = await fetch(config.endpointUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${config.apiKey}`,
          'X-Pharmacy-Source': 'BANDAGO_POS',
        },
        body: JSON.stringify({
          source: 'BANDAGO_POS',
          pharmacyId: config.pharmacyId,
          timestamp: new Date().toISOString(),
          items: payloadItems,
        }),
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`HTTP ${response.status}: ${errorText}`);
      }

      // Mark as SUCCESS and delete completed items to save IndexedDB space
      await db.sync_queue.where('id').anyOf(ids).delete();

      return { synced: pendingItems.length, failed: 0 };
    } catch (err: any) {
      console.error('[Sync Transmission Failed]:', err);

      await db.transaction('rw', db.sync_queue, async () => {
        for (const item of pendingItems) {
          if (!item.id) continue;
          const nextRetry = item.retryCount + 1;
          if (nextRetry >= this.MAX_RETRIES) {
            await db.sync_queue.update(item.id, {
              status: 'FAILED',
              lastError: err.message,
              retryCount: nextRetry,
              updatedAt: Date.now(),
            });
          } else {
            await db.sync_queue.update(item.id, {
              status: 'PENDING',
              lastError: err.message,
              retryCount: nextRetry,
              updatedAt: Date.now(),
            });
          }
        }
      });

      return { synced: 0, failed: pendingItems.length };
    }
  }
}
```

---

### 6.5 Capture Controller Hook: `src/background/capture-controller.ts`

Route intercepted responses so GraphQL operations are recognized and piped into the normalizer:

```typescript
// Additions inside src/background/capture-controller.ts
import { BandaGoNormalizer } from '../extraction/bandago-normalizer';
import { SphereSyncClient } from '../sync/sphere-client';

export class CaptureController {
  // Inside the method that processes parsed JSON responses:
  async processCapturedResponse(
    sourceUrl: string,
    postData: string | undefined,
    responseJson: any
  ): Promise<void> {
    if (!responseJson || typeof responseJson !== 'object') return;

    // Detect if this is BandaGo GraphQL
    const isGraphQL = sourceUrl.includes('/graphql');

    if (isGraphQL && responseJson.data) {
      await this.handleBandaGoPayload(postData, responseJson.data);
    }

    // Continue with general transformer logic (path-selector, flatten, etc.)
  }

  private async handleBandaGoPayload(postData: string | undefined, dataNode: any): Promise<void> {
    // Determine operation from request postData or data keys
    let operationName = 'UnknownGraphQL';
    if (postData) {
      try {
        const parsedPost = JSON.parse(postData);
        if (parsedPost.operationName) operationName = parsedPost.operationName;
      } catch {}
    }

    // Collect all candidate product objects in the response tree
    const candidates: any[] = [];
    const traverse = (node: any) => {
      if (!node || typeof node !== 'object') return;
      if (Array.isArray(node)) {
        node.forEach(traverse);
      } else {
        if (BandaGoNormalizer.isProductRecord(node)) {
          candidates.push(node);
        } else {
          Object.values(node).forEach(traverse);
        }
      }
    };

    traverse(dataNode);

    if (candidates.length > 0) {
      const normalizedProducts = candidates
        .map(BandaGoNormalizer.normalize)
        .filter((item): item is NonNullable<typeof item> => item !== null);

      if (normalizedProducts.length > 0) {
        console.log(`[BandaGo POS] Intercepted ${normalizedProducts.length} medications. Queueing sync...`);
        await SphereSyncClient.enqueue(normalizedProducts);
      }
    }
  }
}
```

---

### 6.6 Active In-Tab Poller: `src/background/bandago-poller.ts`

This worker runs on a background alarm (e.g. every 10 minutes) and leverages an open BandaGo browser tab to run an active catalog check:

```typescript
// src/background/bandago-poller.ts
import { BandaGoNormalizer } from '../extraction/bandago-normalizer';
import { SphereSyncClient } from '../sync/sphere-client';

export class BandaGoActivePoller {
  private static readonly ALARM_NAME = 'BANDAGO_ACTIVE_POLL_ALARM';

  static init() {
    chrome.alarms.create(this.ALARM_NAME, {
      periodInMinutes: 10,
    });

    chrome.alarms.onAlarm.addListener((alarm) => {
      if (alarm.name === this.ALARM_NAME) {
        this.pollActiveTabs().catch(console.error);
      }
    });
  }

  static async pollActiveTabs(): Promise<void> {
    const config = await SphereSyncClient.getConfig();
    if (!config.enabled) return;

    // Find any open BandaGo tab
    const tabs = await chrome.tabs.query({ url: '*://go.bandahealth.org/*' });
    if (tabs.length === 0 || !tabs[0].id) return;

    const tabId = tabs[0].id;

    // Execute GraphQL query in page context to inherit active session cookies and tenant context
    const graphqlQuery = `
      query AutoSyncInventory {
        products(limit: 250, offset: 0) {
          id
          uu
          value
          name
          bh_sellprice
          bh_buyprice
          bh_hasexpiration
          quantityOnHand
          m_product_category { name }
          storageOnHand {
            qtyOnHand
            m_attributesetinstance { guaranteeDate lot }
          }
        }
      }
    `;

    try {
      const results = await chrome.scripting.executeScript({
        target: { tabId },
        func: async (queryStr: string) => {
          try {
            const res = await fetch('/graphql', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ query: queryStr }),
            });
            return await res.json();
          } catch (e: any) {
            return { error: e.message };
          }
        },
        args: [graphqlQuery],
      });

      const response = results[0]?.result;
      if (response?.data?.products && Array.isArray(response.data.products)) {
        const normalized = response.data.products
          .map(BandaGoNormalizer.normalize)
          .filter((p: any) => p !== null);

        if (normalized.length > 0) {
          console.log(`[BandaGo Poller] Active poll fetched ${normalized.length} products.`);
          await SphereSyncClient.enqueue(normalized);
        }
      }
    } catch (err) {
      console.warn('[BandaGo Poller execution failed]:', err);
    }
  }
}
```

---

### 6.7 Server-Side Endpoint in `sphere_pharmacy`: `src/app/api/integrations/bandago/sync/route.ts`

Add this endpoint inside the `sphere_pharmacy` project to ingest and upsert incoming medication stock from `api_data_transformer`:

```typescript
// sphere_pharmacy/src/app/api/integrations/bandago/sync/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db';

interface SyncItem {
  externalPosId: string;
  sku?: string | null;
  name: string;
  slug: string;
  categorySlug: string;
  price: number;
  costPrice?: number | null;
  stock: number;
  inStock: boolean;
  requiresPrescription: boolean;
  imageUrl: string;
  nearestExpiryDate?: string | null;
  dosageForm?: string;
  strength?: string;
}

export async function POST(req: NextRequest) {
  try {
    const authHeader = req.headers.get('authorization');
    const configuredKey = process.env.BANDAGO_SYNC_API_KEY;

    if (!configuredKey || authHeader !== `Bearer ${configuredKey}`) {
      return NextResponse.json({ error: 'Unauthorized POS Sync Request' }, { status: 401 });
    }

    const body = await req.json();
    const items: SyncItem[] = Array.isArray(body.items) ? body.items : [];

    if (items.length === 0) {
      return NextResponse.json({ message: 'No items in payload', count: 0 });
    }

    const now = new Date();
    const CHUNK_SIZE = 50;
    let totalUpserted = 0;

    // Cache categories to prevent N+1 lookups
    const existingCategories = await prisma.productCategory.findMany();
    const categoryMap = new Map(existingCategories.map((c) => [c.slug, c.id]));

    // Helper to get or create category
    const resolveCategoryId = async (slug: string): Promise<string> => {
      if (categoryMap.has(slug)) return categoryMap.get(slug)!;
      const created = await prisma.productCategory.create({
        data: {
          name: slug.charAt(0).toUpperCase() + slug.slice(1).replace('-', ' '),
          slug,
          icon: 'Pill',
        },
      });
      categoryMap.set(slug, created.id);
      return created.id;
    };

    for (let i = 0; i < items.length; i += CHUNK_SIZE) {
      const chunk = items.slice(i, i + CHUNK_SIZE);

      await prisma.$transaction(async (tx) => {
        for (const item of chunk) {
          const categoryId = await resolveCategoryId(item.categorySlug);

          await tx.product.upsert({
            where: { externalPosId: item.externalPosId },
            update: {
              name: item.name,
              price: item.price,
              costPrice: item.costPrice,
              stock: item.stock,
              inStock: item.stock > 0,
              requiresPrescription: item.requiresPrescription,
              nearestExpiryDate: item.nearestExpiryDate ? new Date(item.nearestExpiryDate) : null,
              lastSyncedAt: now,
            },
            create: {
              externalPosId: item.externalPosId,
              posSource: 'BANDAGO',
              sku: item.sku,
              name: item.name,
              slug: item.slug,
              price: item.price,
              costPrice: item.costPrice,
              stock: item.stock,
              inStock: item.stock > 0,
              requiresPrescription: item.requiresPrescription,
              dosageForm: item.dosageForm,
              strength: item.strength,
              categoryId,
              nearestExpiryDate: item.nearestExpiryDate ? new Date(item.nearestExpiryDate) : null,
              lastSyncedAt: now,
              images: {
                create: {
                  url: item.imageUrl,
                  alt: item.name,
                  isPrimary: true,
                  sortOrder: 0,
                },
              },
            },
          });
        }
      });

      totalUpserted += chunk.length;
    }

    return NextResponse.json({
      success: true,
      syncedCount: totalUpserted,
      timestamp: now.toISOString(),
    });
  } catch (error: any) {
    console.error('[BandaGo Ingestion Error]:', error);
    return NextResponse.json(
      { error: 'Internal server error while syncing inventory', message: error.message },
      { status: 500 }
    );
  }
}
```

---

## 7. Pharmacist Operations & Deployment Guide

```
+-----------------------------------------------------------------------------------------+
|                                PHARMACIST WORKFLOW SUMMARY                              |
|                                                                                         |
| 1. Install Extension        2. Configure Endpoint         3. One-Time Catalog Baseline  |
| Load unpacked in Chrome     Enter Sphere URL & API Key    Browse Inventory in BandaGo   |
|                                                                                         |
|                                           |                                             |
|                                           v                                             |
|                             4. Continuous Zero-Touch Sync                               |
|              - Cashier dispenses drug -> CDP intercepts stock delta                     |
|              - Background alarm executes periodic 10-min catalog refresh                |
|              - Outbound queue retries automatically during network drops                |
+-----------------------------------------------------------------------------------------+
```

### 7.1 Setup Steps for the Pharmacy Workstation
1. **Build `api_data_transformer`:**
   ```bash
   cd api_data_transformer
   npm install
   npm run build
   ```
2. **Load into Google Chrome:**
   * Open `chrome://extensions/` on the pharmacy desktop.
   * Enable **Developer mode** (top right).
   * Click **Load unpacked** and select `api_data_transformer/dist`.
3. **Configure Sphere Sync:**
   * Open the extension dashboard (`chrome-extension://<id>/dashboard.html#/settings`).
   * Enter:
     * **Sphere Ingestion URL:** `https://your-pharmacy-domain.com/api/integrations/bandago/sync`
     * **Sync API Key:** `(Match BANDAGO_SYNC_API_KEY set in sphere_pharmacy .env)`
     * **Auto Sync Enabled:** Toggle **ON**.
4. **Day-1 Baseline Ingestion:**
   * Log into `go.bandahealth.org`.
   * Navigate to the **Inventory / Products** table.
   * The extension will automatically capture the GraphQL response and populate the entire online catalog in `sphere_pharmacy`.
5. **Normal Day-to-Day Operation:**
   * The pharmacist does not need to click or open the extension again.
   * Sales, counter dispensations, and supplier receipts in BandaGo are intercepted via CDP in real-time and synced to `sphere_pharmacy` within 1 second.