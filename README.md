# Live Network Data Collector

> **Capture JSON API responses while browsing normally in Chrome and export accumulated datasets locally.**

A production-grade Chrome extension (Manifest V3) that observes permitted network traffic using the **Chrome DevTools Protocol (CDP)** in real time. It enables data analysts, researchers, and developers to navigate websites (handling pagination, infinite scrolling, searches, and filters) while preserving raw API responses, inferring schemas, deduplicating records, and exporting clean CSV, JSON, or JSONL files.

> 📖 **Looking for a detailed walkthrough?** Check out the comprehensive [**User Guide & Platform Manual (USER_GUIDE.md)**](file:///home/elvin/Projects/tutorials/api-data-csv-extractor/USER_GUIDE.md).

---

## Key Features

- **Two-Tab Local Workflow:** Browse any website in your regular tab. Authentication, cookies, and navigation remain strictly on the site. The extension observes permitted API responses without stealing credentials or replaying requests.
- **Accurate Pagination & Accumulation:** Navigating pages 1, 2, and 3 accumulates records without losing earlier pages. Revisiting earlier pages does not inflate unique record counts.
- **Deduplication Engine:** Configurable identity key (`id`, `sku`, `uuid`, or custom) with **Keep Latest**, **Keep First**, or **Keep All Versions** consolidation policies. Fallback to deterministic canonical content hashing.
- **Dynamic Schema Discovery:** Analyzes response structures, tracks field types, identifies nullability/optionality, and flags schema type conflicts.
- **Enterprise-Grade CSV Export:**
  - Nested dot-path columns (e.g. `strength.value`, `strength.unit`).
  - Nested arrays serialized to JSON strings.
  - **Spreadsheet Formula Injection Defense:** Neutralizes dangerous prefixes (`=`, `+`, `-`, `@`, `\t`, `\r`) to ensure safe opening in Excel and Google Sheets.
  - Optional UTF-8 Byte Order Mark (BOM) for Excel compatibility.
- **Streaming & Raw Exports:** JSON Lines (`.jsonl`), raw response CSV with original JSON payloads, and full session JSON bundles.
- **Local-First Privacy:** Data resides exclusively in browser IndexedDB on your machine. Zero telemetry, zero external network uploads. Sensitive URL query parameters (tokens, keys, passwords) are automatically redacted.
- **Chrome Side Panel & Dashboard:** Control capture, monitor counters, and view active endpoints directly in Chrome's side panel or inside the full-featured 7-tab dashboard.
- **Built-in Demo Catalog:** Includes a mock medication catalog web application simulating pagination (page numbers, cursors, POST requests) for instant testing.
- **BandaGo POS to Sphere Pharmacy Bridge:** Specialized automated data transformer and live sync engine between BandaGo Pharmacy POS (`go.bandahealth.org`, OSGi GraphQL) and Sphere Pharmacy cloud storefronts:
  - **FEFO (First-Expired, First-Out) Inventory Engine:** Sums available unexpired batch stock across `storageOnHand` while discarding legally unsellable expired inventory.
  - **Kenya Pharmacy and Poisons Board (PPB) Scheduling:** Automatically classifies prescription-only medications (POM) vs OTC.
  - **Offline Sync Ledger:** Resilient IndexedDB queue (`sync_queue`) with exponential backoff retries and in-flight race-condition protection.
  - **Zero-Touch Background Poller:** Periodic Chrome alarm (every 10 minutes) leveraging open BandaGo tabs to execute non-intrusive catalog polls.

---

## Repository Structure

```text
api-data-csv-extractor/
├── dist/                          # Production unpacked extension build
│   ├── manifest.json
│   ├── background.js              # MV3 service worker
│   ├── dashboard.html             # Full collector dashboard
│   ├── sidepanel.html             # Side panel interface
│   ├── demo.html                  # Interactive test catalog
│   └── icons/                     # 16px, 48px, 128px PNG icons
├── public/
│   ├── manifest.json
│   └── icons/
├── src/
│   ├── background/                # Service worker, CDP adapter, poller, tab manager
│   │   ├── service-worker.ts
│   │   ├── capture-controller.ts
│   │   ├── cdp-adapter.ts
│   │   ├── bandago-poller.ts      # Active background in-tab GraphQL catalog poller
│   │   └── tab-manager.ts
│   ├── data/                      # IndexedDB database & repositories
│   │   ├── db.ts                  # Dexie schema v3 with sync_queue table
│   │   └── repositories.ts
│   ├── extraction/                # Extraction, deduplication & schema inference
│   │   ├── bandago-normalizer.ts  # BandaGo POS to Sphere Pharmacy FEFO normalizer
│   │   ├── flatten.ts
│   │   ├── deduplicate.ts
│   │   ├── schema-inference.ts
│   │   └── path-selector.ts
│   ├── sync/                      # Outbound live synchronization engine
│   │   ├── sphere-client.ts       # Authenticated Sphere Pharmacy API client
│   │   └── sync-queue.ts          # Offline-first queue manager with retry limits
│   ├── export/                    # CSV, JSON, JSONL generators & sanitization
│   │   ├── csv.ts
│   │   ├── json.ts
│   │   ├── jsonl.ts
│   │   ├── sanitize.ts
│   │   └── filenames.ts
│   ├── privacy/                   # URL redaction and host/endpoint policies
│   │   ├── url-redaction.ts
│   │   └── source-policy.ts
│   ├── messaging/                 # Extension message passing protocol
│   │   └── protocol.ts
│   ├── dashboard/                 # React Dashboard (7 tabs + Sphere Sync settings)
│   ├── sidepanel/                 # React Side Panel
│   ├── demo/                      # Interactive Demo Target
│   └── shared/                    # Types and constants
├── tests/                         # Unit tests (Vitest)
├── package.json
├── tsconfig.json
└── vite.config.ts
```

---

## Quick Start & Installation

### 1. Build the Extension

Ensure Node.js (v18+) is installed:

```bash
# Install dependencies
npm install

# Run unit tests
npm test

# Build the extension into the /dist folder
npm run build
```

### 2. Load Unpacked in Google Chrome

1. Open Google Chrome and navigate to `chrome://extensions/`.
2. Enable **Developer mode** using the toggle switch in the top-right corner.
3. Click the **Load unpacked** button in the top-left.
4. Select the `dist/` directory inside this repository (`api-data-csv-extractor/dist`).
5. The **Live Network Data Collector** extension is now installed.

---

## How to Test with the Built-in Demo Catalog

1. Start the local development server:
   ```bash
   npm run dev
   ```
2. Open the demo catalog page in Chrome:
   ```text
   http://localhost:5173/demo.html
   ```
3. Open the extension collector:
   - Click the extension icon in Chrome's toolbar (or open `chrome-extension://<EXTENSION_ID>/dashboard.html`).
4. In the dashboard:
   - Click **Start Capture**.
   - Select the `Medication Catalog` tab from the list.
   - Click **Start Capture**. The status will switch to **Recording** (green badge).
5. In the demo catalog tab:
   - Click **Next Page** (Page 1 -> Page 2 -> Page 3).
   - Click **Previous Page** to revisit Page 1.
6. In the collector dashboard:
   - Go to **Overview**: Observe counts updating in real time.
   - Go to **Records**: Verify that exactly 150 unique medications are materialized (revisiting Page 1 did not duplicate items).
   - Go to **Schemas**: Inspect the inferred field types and detected properties.
   - Go to **Exports**:
     - Select **Flattened CSV**.
     - Review the live preview.
     - Click **Download File** to save `collector_localhost_dataset_<timestamp>.csv`.

---

## Supported Export Formats

| Format                  | File Extension | Structure                                                                                                                                   |
| ----------------------- | -------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| **Flattened CSV**       | `.csv`         | Nested objects are flattened into dot paths (`strength.value`); arrays are serialized to JSON strings. Protected against formula injection. |
| **Raw CSV**             | `.csv`         | Metadata columns (`id`, `capturedAt`, `source`) plus one `raw_json` column.                                                                 |
| **JSON Lines**          | `.jsonl`       | One complete JSON record per line, preserving full hierarchical structure for streaming ETL pipelines.                                      |
| **Session JSON Bundle** | `.json`        | Comprehensive export containing session metadata, sources, schema mappings, and raw responses.                                              |

---

## Security & Privacy Protections

1. **Explicit Tab Scoping:** Captures traffic only from the explicitly selected browser tab.
2. **Credential Safety:** Never accesses `chrome.cookies`, browser password managers, or request `Authorization` headers.
3. **Sensitive URL Redaction:** Automatically scrubs query parameters matching `access_token`, `auth_token`, `api_key`, `token`, `secret`, `password`, `code`, and `jwt`.
4. **Endpoint Exclusions:** Automatically skips endpoints with keywords like `/login`, `/auth`, `/logout`, `/signup`, or `/credentials`.
5. **Formula Injection Sanitization:** Encodes cell values starting with `=`, `+`, `-`, `@`, `\t`, or `\r` by prefixing a single quote `'` to neutralize executable spreadsheet macros.

---

## Testing & Quality Assurance

Run the automated test suite with Vitest:

```bash
npm test
```

Tests cover:

- CSV RFC 4180 escaping and formula injection neutralization.
- Flattening logic and unique column ordering.
- Deduplication policies (Keep Latest, Keep First, Keep All) and 150-record accumulation.
- Schema inference and primitive type conflict detection.
- Path selector with candidate ranking.
- URL query parameter redaction and endpoint normalization.
