import { BandaGoNormalizer } from "../extraction/bandago-normalizer";
import { SphereSyncClient } from "../sync/sphere-client";
import { CdpNetworkAdapter } from "./cdp-adapter";

export interface PollResult {
  success: boolean;
  count: number;
  message: string;
}

function selectBestBandaGoTab(tabs: chrome.tabs.Tab[]): chrome.tabs.Tab | null {
  const valid = tabs.filter((t) => typeof t.id === "number");
  if (valid.length === 0) return null;
  const nonDiscarded = valid.filter((t) => !t.discarded);
  const pool = nonDiscarded.length > 0 ? nonDiscarded : valid;
  return [...pool].sort((a, b) => {
    const score = (t: chrome.tabs.Tab) => {
      const u = (t.url || "").toLowerCase();
      let s = 0;
      if (!/\/(login|signin|auth)\b/.test(u)) s += 100;
      if (/\/(products|inventory|dispense|sales)/.test(u)) s += 50;
      if (t.active) s += 20;
      if (t.status === "complete") s += 10;
      return s;
    };
    return score(b) - score(a);
  })[0];
}

export class BandaGoActivePoller {
  public static readonly ALARM_NAME = "BANDAGO_ACTIVE_POLL_ALARM";
  public static readonly POLL_INTERVAL_MINUTES = 10;
  private static isInitialized = false;

  /**
   * Initializes periodic background alarm for active catalog polling.
   */
  static init(): void {
    if (this.isInitialized) return;
    this.isInitialized = true;

    try {
      if (typeof chrome !== "undefined" && chrome.alarms) {
        chrome.alarms.onAlarm.addListener((alarm) => {
          if (alarm.name === this.ALARM_NAME) {
            (async () => {
              try {
                const result = await this.pollActiveTabs();
                // pollActiveTabs reports failures via its return value rather than
                // throwing, so surface them here; otherwise scheduled polls fail silently.
                if (result.success) {
                  console.info(`[BandaGo Poller] ${result.message}`);
                } else {
                  console.warn(`[BandaGo Poller] Poll skipped/failed: ${result.message}`);
                }
              } catch (err) {
                console.warn(
                  "[BandaGo Poller] Scheduled poll execution failed:",
                  err,
                );
              } finally {
                // Drain any pending items in offline sync queue after poll completes
                SphereSyncClient.flushQueue().catch(console.error);
              }
            })();
          }
        });

        if (typeof chrome.alarms.get === "function") {
          chrome.alarms.get(this.ALARM_NAME, (existing) => {
            if (!existing) {
              chrome.alarms.create(this.ALARM_NAME, {
                periodInMinutes: this.POLL_INTERVAL_MINUTES,
              });
            }
          });
        } else {
          chrome.alarms.create(this.ALARM_NAME, {
            periodInMinutes: this.POLL_INTERVAL_MINUTES,
          });
        }
      }
    } catch (err) {
      console.warn("[BandaGo Poller] Could not register alarm:", err);
    }
  }

  /**
   * Finds any open BandaGo tab and queries products in page context
   * to inherit existing authenticated session cookies & tenant context.
   */
  static async pollActiveTabs(): Promise<PollResult> {
    const finishPoll = async (
      res: PollResult,
      errorCode?: string,
      tenantUU?: string | null,
    ): Promise<PollResult> => {
      await SphereSyncClient.recordPollStatus(res).catch(() => {});
      await SphereSyncClient.reportTelemetry({
        heartbeat: {
          bandagoTabOpen:
            errorCode !== "NO_POS_TAB" &&
            !res.message.includes("No active go.bandahealth.org tab"),
          tenantUU: tenantUU ?? null,
          lastInboundPollAt: new Date().toISOString(),
          lastInboundPollOk: res.success,
          lastInboundPollMessage: res.message,
        },
        errors:
          !res.success && errorCode
            ? [
                {
                  direction: "INBOUND",
                  source: "BANDAGO_POLLER",
                  severity:
                    errorCode === "AUTH_EXPIRED" ||
                    errorCode === "TENANT_MISMATCH"
                      ? "CRITICAL"
                      : errorCode === "NETWORK_TIMEOUT" ||
                          errorCode === "NO_POS_TAB"
                        ? "WARNING"
                        : "ERROR",
                  code: errorCode,
                  message: res.message,
                },
              ]
            : undefined,
      }).catch(() => {});
      return res;
    };

    const config = await SphereSyncClient.getConfig();
    if (!config.enabled) {
      await SphereSyncClient.recordPollStatus({
        success: false,
        count: 0,
        message: "Sphere sync is currently disabled in settings",
      }).catch(() => {});
      return {
        success: false,
        count: 0,
        message: "Sphere sync is currently disabled in settings",
      };
    }

    if (typeof chrome === "undefined" || !chrome.tabs || !chrome.scripting) {
      return finishPoll({
        success: false,
        count: 0,
        message: "Chrome extension APIs not available",
      });
    }

    // Locate open BandaGo POS tabs (preferring loaded /products or /inventory tabs over /login)
    const tabs = await chrome.tabs.query({ url: "*://go.bandahealth.org/*" });
    const bestTab = selectBestBandaGoTab(tabs);
    if (!bestTab || !bestTab.id) {
      return finishPoll(
        {
          success: false,
          count: 0,
          message: "No active go.bandahealth.org tab found",
        },
        "NO_POS_TAB",
      );
    }

    const tabId = bestTab.id;
    const tabUrl = bestTab.url || "https://go.bandahealth.org";
    let origin = "https://go.bandahealth.org";
    try {
      origin = new URL(tabUrl).origin;
    } catch {}

    const cachedAuthHeader = await CdpNetworkAdapter.getAuthHeader(origin);
    const discoveredGql = await CdpNetworkAdapter.getGraphqlEndpoint(origin);
    const gqlEndpointArg = discoveredGql?.endpointUrl || "/graphql/";

    const storageOnHandQuery = `
      query M_StorageOnHandForInventoryList($Page: Int, $Size: Int, $Filter: String) {
        M_StorageOnHandGet(Page: $Page, Size: $Size, Filter: $Filter) {
          PagingInfo {
            Page
            PageSize
            TotalCount
            TotalPages
          }
          Results {
            QtyOnHand
            UU
            AD_Client {
              UU
            }
            AD_Org {
              UU
              Name
            }
            M_AttributeSetInstance {
              UU
              GuaranteeDate
              Lot
              SerNo
              PurchaseDate
              PurchasePrice
            }
            M_Locator {
              UU
              Value
              IsActive
              M_Warehouse {
                UU
                Name
              }
            }
            M_Product {
              UU
              Name
              Value
              SKU
              UPC
              Description
              BH_BuyPrice
              BH_SellPrice
              BH_PriceMargin
              IsActive
              IsStocked
              IsSold
              Discontinued
              ProductType {
                Value
              }
              C_UOM {
                StdPrecision
                UU
                Name
                UOMSymbol
              }
              M_AttributeSet {
                IsGuaranteeDate
                IsLot
              }
              M_Product_Category {
                UU
                Name
              }
              BH_Concept {
                UU
                BH_Display_Name
                BH_ExternalID
              }
              M_ProductPrices {
                PriceStd
                PriceList
                IsActive
                M_PriceList_Version {
                  ValidFrom
                  IsActive
                  M_PriceList {
                    IsSOPriceList
                    IsDefault
                  }
                }
              }
            }
          }
        }
      }
    `;

    const productListQuery = `
      query M_ProductForProductListPage($Filter: String, $Page: Int, $Size: Int, $Sort: String) {
        M_ProductGet(Filter: $Filter, Page: $Page, Size: $Size, Sort: $Sort) {
          PagingInfo {
            Page
            PageSize
            TotalCount
            TotalPages
          }
          Results {
            UU
            Name
            Value
            SKU
            UPC
            Description
            BH_BuyPrice
            BH_SellPrice
            BH_PriceMargin
            IsActive
            IsStocked
            IsSold
            Discontinued
            TotalQuantity
            LastPurchasePrice
            ProductType {
              Value
            }
            AD_Client {
              UU
            }
            AD_Org {
              UU
              Name
            }
            C_UOM {
              StdPrecision
              UU
              Name
              UOMSymbol
            }
            M_AttributeSet {
              IsGuaranteeDate
              IsLot
            }
            M_Product_Category {
              UU
              Name
            }
            BH_Concept {
              UU
              BH_Display_Name
              BH_ExternalID
            }
            M_ProductPrices {
              PriceStd
              PriceList
              IsActive
              M_PriceList_Version {
                ValidFrom
                IsActive
                M_PriceList {
                  IsSOPriceList
                  IsDefault
                }
              }
            }
          }
        }
      }
    `;

    const fallbackInventoryQuery = `
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

    const args: [
      string,
      string,
      string | null,
      string | null,
      string | null,
      boolean?,
    ] = discoveredGql?.usesBatchArray
      ? [
          gqlEndpointArg,
          storageOnHandQuery,
          productListQuery,
          fallbackInventoryQuery,
          cachedAuthHeader,
          true,
        ]
      : [
          gqlEndpointArg,
          storageOnHandQuery,
          productListQuery,
          fallbackInventoryQuery,
          cachedAuthHeader,
        ];

    try {
      const results = await chrome.scripting.executeScript({
        target: { tabId },
        func: async (
          gqlEndpoint: string,
          storageOrSingleQuery: string,
          param3?: string | null,
          param4?: string | null,
          param5?: string | null,
          param6?: boolean,
        ) => {
          let cachedAuthHeader: string | null = null;
          let storageQuery = storageOrSingleQuery;
          let productQuery: string | null = null;
          let legacyQuery: string | null = null;
          const defaultUseBatch = Boolean(param6);

          if (param5 !== undefined || param4 !== undefined) {
            productQuery = param3 ?? null;
            legacyQuery = param4 ?? null;
            cachedAuthHeader = param5 ?? null;
          } else {
            cachedAuthHeader = param3 ?? null;
          }

          try {
            // Fallback: look for JWT token in localStorage/sessionStorage (handles raw, Bearer prefixed, and nested Zustand/Redux JSON)
            const jwtRegex = /^eyJ[A-Za-z0-9-_]+\.[A-Za-z0-9-_]+\.[A-Za-z0-9-_]+$/;
            const extractJwt = (val: unknown, depth = 0): string | null => {
              if (depth > 3 || val == null) return null;
              if (typeof val === "string") {
                const cleaned = val
                  .trim()
                  .replace(/^"|"$/g, "")
                  .replace(/^Bearer\s+/i, "")
                  .trim();
                if (jwtRegex.test(cleaned)) return cleaned;
                if (cleaned.startsWith("{") || cleaned.startsWith("[")) {
                  try {
                    return extractJwt(JSON.parse(cleaned), depth + 1);
                  } catch {}
                }
                return null;
              }
              if (Array.isArray(val)) {
                for (const el of val) {
                  const hit = extractJwt(el, depth + 1);
                  if (hit) return hit;
                }
                return null;
              }
              if (typeof val === "object") {
                const obj = val as Record<string, any>;
                for (const k of [
                  "token",
                  "accessToken",
                  "access_token",
                  "jwt",
                  "id_token",
                  "idToken",
                  "authToken",
                  "authorization",
                ]) {
                  const hit = extractJwt(obj[k], depth + 1);
                  if (hit) return hit;
                }
                for (const sub of ["state", "auth", "user", "session", "data"]) {
                  if (obj[sub] && typeof obj[sub] === "object") {
                    const hit = extractJwt(obj[sub], depth + 1);
                    if (hit) return hit;
                  }
                }
              }
              return null;
            };

            let authHeader = cachedAuthHeader;
            if (!authHeader) {
              try {
                for (const store of [
                  window.localStorage,
                  window.sessionStorage,
                ]) {
                  if (!store) continue;
                  for (let i = 0; i < store.length; i++) {
                    const key = store.key(i);
                    const val = key ? store.getItem(key) : null;
                    if (!val) continue;
                    const rawToken = extractJwt(val, 0);
                    if (rawToken) {
                      authHeader = `Bearer ${rawToken}`;
                      break;
                    }
                  }
                  if (authHeader) break;
                }
              } catch {}
            }

            if (authHeader && !authHeader.toLowerCase().startsWith("bearer ")) {
              authHeader = `Bearer ${authHeader}`;
            }

            const headers: Record<string, string> = {
              "Content-Type": "application/json",
              Accept: "application/json",
            };
            if (authHeader) {
              headers["Authorization"] = authHeader;
            }

            const executeGql = async (
              endpoint: string,
              queryStr: string,
              variables?: Record<string, any>,
              asBatch = defaultUseBatch,
              allowBatchFlip = true,
            ): Promise<any> => {
              const opMatch = queryStr.match(/(?:query|mutation)\s+([A-Za-z0-9_]+)/);
              const opName = opMatch ? opMatch[1] : undefined;
              const bodyObj: Record<string, any> = { query: queryStr };
              if (opName) bodyObj.operationName = opName;
              if (variables) bodyObj.variables = variables;

              const controller = new AbortController();
              const timeoutId = setTimeout(() => controller.abort(), 15000);

              try {
                const res = await fetch(endpoint, {
                  method: "POST",
                  credentials: "include",
                  headers,
                  signal: controller.signal,
                  body: JSON.stringify(asBatch ? [bodyObj] : bodyObj),
                });
                if (!res.ok) {
                  if (
                    allowBatchFlip &&
                    (res.status === 400 ||
                      res.status === 415 ||
                      res.status === 422 ||
                      res.status === 500)
                  ) {
                    const batchRetry = await executeGql(
                      endpoint,
                      queryStr,
                      variables,
                      !asBatch,
                      false,
                    );
                    if (!batchRetry?.error) return batchRetry;
                  }
                  const text = await res.text();
                  return {
                    error: `HTTP ${res.status}: ${text.slice(0, 200)}`,
                    status: res.status,
                  };
                }
                const contentType =
                  (typeof res.headers?.get === "function"
                    ? res.headers.get("content-type")
                    : (res.headers as any)?.["content-type"]) || "";
                if (contentType && !contentType.toLowerCase().includes("json")) {
                  return {
                    error: `Non-JSON response (${contentType})`,
                    status: res.status,
                    nonJson: true,
                  };
                }
                try {
                  const parsed = await res.json();
                  if (!parsed || typeof parsed !== "object") {
                    return {
                      error: "Empty or null JSON response from BandaGo",
                      status: res.status,
                      nonJson: true,
                    };
                  }
                  return Array.isArray(parsed)
                    ? parsed[0] || { error: "Empty batched GraphQL response" }
                    : parsed;
                } catch (parseErr: any) {
                  return {
                    error: `Invalid JSON response: ${parseErr.message}`,
                    status: res.status,
                    nonJson: true,
                  };
                }
              } catch (e: any) {
                return {
                  error:
                    e?.name === "AbortError"
                      ? "BandaGo in-tab fetch timed out after 15 seconds"
                      : e.message || "Fetch failed",
                };
              } finally {
                clearTimeout(timeoutId);
              }
            };

            // Single query invocation (direct or mock tests)
            if (!productQuery && !legacyQuery) {
              return await executeGql(gqlEndpoint, storageQuery);
            }

            // BandaGo iDempiere Inventory Polling (0-indexed pagination per idemp-plugins)
            const MAX_PAGES = 150;
            const pollDeadline = Date.now() + 22000;
            const compactRow = (val: unknown, depth = 0): any => {
              if (depth > 6 || val == null || typeof val !== "object") return val;
              if (Array.isArray(val)) {
                return val.map((el) => compactRow(el, depth + 1));
              }
              const out: Record<string, any> = {};
              for (const [key, v] of Object.entries(val as Record<string, any>)) {
                if (key === "__typename" || v === undefined) continue;
                out[key] = compactRow(v, depth + 1);
              }
              return out;
            };
            const leanStorageQuery = `
              query M_StorageOnHandForInventoryList($Page: Int, $Size: Int, $Filter: String) {
                M_StorageOnHandGet(Page: $Page, Size: $Size, Filter: $Filter) {
                  PagingInfo { Page PageSize TotalCount TotalPages }
                  Results {
                    QtyOnHand
                    UU
                    AD_Client { UU }
                    M_AttributeSetInstance { UU GuaranteeDate Lot SerNo PurchasePrice }
                    M_Locator { UU Value M_Warehouse { UU Name } }
                    M_Product {
                      UU
                      Name
                      Value
                      BH_BuyPrice
                      BH_SellPrice
                      IsActive
                      IsStocked
                      M_Product_Category { UU Name }
                    }
                  }
                }
              }
            `;
            const minimalStorageNoFilterQuery = `
              query M_StorageOnHandForInventoryList($Page: Int, $Size: Int) {
                M_StorageOnHandGet(Page: $Page, Size: $Size) {
                  PagingInfo { Page PageSize TotalCount TotalPages }
                  Results {
                    QtyOnHand
                    UU
                    M_AttributeSetInstance { UU GuaranteeDate Lot }
                    M_Product {
                      UU
                      Name
                      BH_SellPrice
                      LastPurchasePrice
                      TotalQuantity
                      IsActive
                    }
                  }
                }
              }
            `;
            const minimalStorageQuery = `
              query M_StorageOnHandForInventoryList($Page: Int, $Size: Int, $Filter: String) {
                M_StorageOnHandGet(Page: $Page, Size: $Size, Filter: $Filter) {
                  PagingInfo { Page PageSize TotalCount TotalPages }
                  Results {
                    QtyOnHand
                    UU
                    M_AttributeSetInstance { UU GuaranteeDate Lot }
                    M_Product {
                      UU
                      Name
                      BH_SellPrice
                      LastPurchasePrice
                      TotalQuantity
                      IsActive
                    }
                  }
                }
              }
            `;
            const leanProductQuery = `
              query M_ProductForProductListPage($Filter: String, $Page: Int, $Size: Int, $Sort: String) {
                M_ProductGet(Filter: $Filter, Page: $Page, Size: $Size, Sort: $Sort) {
                  PagingInfo { Page PageSize TotalCount TotalPages }
                  Results {
                    UU
                    Name
                    Value
                    BH_BuyPrice
                    LastPurchasePrice
                    BH_SellPrice
                    IsActive
                    IsStocked
                    TotalQuantity
                    AD_Client { UU }
                    M_Product_Category { UU Name }
                  }
                }
              }
            `;
            const minimalProductQuery = `
              query M_ProductForProductListPage($Filter: String, $Page: Int, $Size: Int, $Sort: String) {
                M_ProductGet(Filter: $Filter, Page: $Page, Size: $Size, Sort: $Sort) {
                  PagingInfo { Page PageSize TotalCount TotalPages }
                  Results {
                    UU
                    Name
                    BH_SellPrice
                    LastPurchasePrice
                    TotalQuantity
                    IsActive
                    bh_reorder_level
                    bh_reorder_quantity
                    Created
                  }
                }
              }
            `;
            const minimalProductNoFilterQuery = `
              query M_ProductForProductListPage($Page: Int, $Size: Int) {
                M_ProductGet(Page: $Page, Size: $Size) {
                  PagingInfo { Page PageSize TotalCount TotalPages }
                  Results {
                    UU
                    Name
                    BH_SellPrice
                    LastPurchasePrice
                    TotalQuantity
                    IsActive
                    bh_reorder_level
                    bh_reorder_quantity
                    Created
                  }
                }
              }
            `;

            const isSubfieldValidationError = (res: any, rootField: string): boolean => {
              if (!Array.isArray(res?.errors) || res.errors.length === 0) return false;
              const msg = res.errors.map((e: any) => String(e?.message || "")).join(" ");
              if (msg.includes(`Cannot query field ${rootField}`) || msg.includes(`Cannot query field '${rootField}'`)) {
                return false;
              }
              return /Cannot query field|Validation\s*error|FieldUndefined|is undefined|Unknown field|Unknown argument|Invalid argument|does not exist/i.test(msg);
            };

            let endpointToUse = gqlEndpoint;
            let activeStorageQuery = storageQuery;
            let includeStorageFilterVar = true;
            let storageRes: any = await executeGql(endpointToUse, activeStorageQuery, {
              Page: 0,
              Size: 500,
              Filter: JSON.stringify({}),
            });

            // Fallback to alternate trailing slash on 404, non-JSON SPA response, or HTTP error
            if (
              storageRes?.status === 404 ||
              storageRes?.nonJson ||
              (storageRes?.error && storageRes?.status !== 401)
            ) {
              const altEndpoint = endpointToUse.endsWith("/")
                ? endpointToUse.slice(0, -1)
                : `${endpointToUse}/`;
              const altRes = await executeGql(altEndpoint, activeStorageQuery, {
                Page: 0,
                Size: 500,
                Filter: JSON.stringify({}),
              });
              if (!altRes?.error) {
                endpointToUse = altEndpoint;
                storageRes = altRes;
              }
            }

            // Tier 2 & Tier 3 progressive schema fallback for M_StorageOnHandGet
            if (isSubfieldValidationError(storageRes, "M_StorageOnHandGet")) {
              const leanRes = await executeGql(endpointToUse, leanStorageQuery, {
                Page: 0,
                Size: 500,
                Filter: JSON.stringify({}),
              });
              if (leanRes?.data?.M_StorageOnHandGet) {
                activeStorageQuery = leanStorageQuery;
                storageRes = leanRes;
              } else {
                const minRes = await executeGql(endpointToUse, minimalStorageQuery, {
                  Page: 0,
                  Size: 500,
                  Filter: JSON.stringify({}),
                });
                if (minRes?.data?.M_StorageOnHandGet) {
                  activeStorageQuery = minimalStorageQuery;
                  storageRes = minRes;
                } else if (
                  isSubfieldValidationError(minRes, "M_StorageOnHandGet") ||
                  minRes?.errors?.some((e: any) =>
                    /Filter|Unknown argument|Invalid argument/i.test(String(e?.message || "")),
                  )
                ) {
                  const noFilterStorageRes = await executeGql(
                    endpointToUse,
                    minimalStorageNoFilterQuery,
                    { Page: 0, Size: 500 },
                  );
                  if (noFilterStorageRes?.data?.M_StorageOnHandGet) {
                    activeStorageQuery = minimalStorageNoFilterQuery;
                    includeStorageFilterVar = false;
                    storageRes = noFilterStorageRes;
                  }
                }
              }
            }

            // If credentials expired (HTTP 401), exit early immediately
            if (storageRes?.status === 401) {
              return storageRes;
            }

            // Adaptive pagination: handles both 0-indexed (live BandaGo: Page 0..N-1) and 1-indexed mocks (Page 1..N)
            const storagePaging = storageRes?.data?.M_StorageOnHandGet?.PagingInfo;
            if (storagePaging?.TotalPages > 1) {
              const totalPages = Math.min(storagePaging.TotalPages, MAX_PAGES);
              const firstPageIndex = typeof storagePaging.Page === "number" ? storagePaging.Page : 0;
              const nextStart = firstPageIndex === 0 ? 1 : firstPageIndex + 1;
              const lastPage = firstPageIndex === 0 ? totalPages - 1 : totalPages;
              const combined = Array.isArray(storageRes?.data?.M_StorageOnHandGet?.Results)
                ? [...storageRes.data.M_StorageOnHandGet.Results]
                : [];
              for (let page = nextStart; page <= lastPage; page++) {
                if (Date.now() > pollDeadline) break;
                const storageVars: Record<string, any> = includeStorageFilterVar
                  ? { Page: page, Size: 500, Filter: JSON.stringify({}) }
                  : { Page: page, Size: 500 };
                const nextPage = await executeGql(
                  endpointToUse,
                  activeStorageQuery,
                  storageVars,
                );
                const nextResults = nextPage?.data?.M_StorageOnHandGet?.Results;
                if (Array.isArray(nextResults)) {
                  for (const row of nextResults) {
                    combined.push(row);
                  }
                }
              }
              if (storageRes?.data?.M_StorageOnHandGet) {
                storageRes.data.M_StorageOnHandGet.Results = combined;
              }
            }

            // Fetch catalog product list even if storage query encountered errors
            let productRes: any = null;
            if (productQuery) {
              let activeProductQuery = productQuery;
              let includeFilterVar = true;
              productRes = await executeGql(endpointToUse, activeProductQuery, {
                Page: 0,
                Size: 500,
                Filter: JSON.stringify({}),
              });

              // If initial endpoint gave 404, non-JSON or error and wasn't flipped yet, try alternate slash
              if (
                (productRes?.status === 404 ||
                  productRes?.nonJson ||
                  (productRes?.error && productRes?.status !== 401)) &&
                endpointToUse === gqlEndpoint
              ) {
                const altEndpoint = endpointToUse.endsWith("/")
                  ? endpointToUse.slice(0, -1)
                  : `${endpointToUse}/`;
                const altRes = await executeGql(altEndpoint, activeProductQuery, {
                  Page: 0,
                  Size: 500,
                  Filter: JSON.stringify({}),
                });
                if (!altRes?.error) {
                  endpointToUse = altEndpoint;
                  productRes = altRes;
                }
              }

              // Tier 2, Tier 3, and Filter-less progressive fallback for M_ProductGet
              if (isSubfieldValidationError(productRes, "M_ProductGet")) {
                const leanProdRes = await executeGql(endpointToUse, leanProductQuery, {
                  Page: 0,
                  Size: 500,
                  Filter: JSON.stringify({}),
                });
                if (leanProdRes?.data?.M_ProductGet) {
                  activeProductQuery = leanProductQuery;
                  productRes = leanProdRes;
                } else {
                  const minProdRes = await executeGql(endpointToUse, minimalProductQuery, {
                    Page: 0,
                    Size: 500,
                    Filter: JSON.stringify({}),
                  });
                  if (minProdRes?.data?.M_ProductGet) {
                    activeProductQuery = minimalProductQuery;
                    productRes = minProdRes;
                  } else if (
                    isSubfieldValidationError(minProdRes, "M_ProductGet") ||
                    minProdRes?.errors?.some((e: any) =>
                      /Filter|Unknown argument/i.test(String(e?.message || "")),
                    )
                  ) {
                    const noFilterRes = await executeGql(
                      endpointToUse,
                      minimalProductNoFilterQuery,
                      { Page: 0, Size: 500 },
                    );
                    if (noFilterRes?.data?.M_ProductGet) {
                      activeProductQuery = minimalProductNoFilterQuery;
                      includeFilterVar = false;
                      productRes = noFilterRes;
                    }
                  }
                }
              }

              const prodPaging = productRes?.data?.M_ProductGet?.PagingInfo;
              if (prodPaging?.TotalPages > 1) {
                const totalPages = Math.min(prodPaging.TotalPages, MAX_PAGES);
                const firstPageIndex = typeof prodPaging.Page === "number" ? prodPaging.Page : 0;
                const nextStart = firstPageIndex === 0 ? 1 : firstPageIndex + 1;
                const lastPage = firstPageIndex === 0 ? totalPages - 1 : totalPages;
                const combined = Array.isArray(productRes?.data?.M_ProductGet?.Results)
                  ? [...productRes.data.M_ProductGet.Results]
                  : [];
                for (let page = nextStart; page <= lastPage; page++) {
                  if (Date.now() > pollDeadline) break;
                  const vars: Record<string, any> = includeFilterVar
                    ? { Page: page, Size: 500, Filter: JSON.stringify({}) }
                    : { Page: page, Size: 500 };
                  const nextPage = await executeGql(
                    endpointToUse,
                    activeProductQuery,
                    vars,
                  );
                  const nextResults = nextPage?.data?.M_ProductGet?.Results;
                  if (Array.isArray(nextResults)) {
                    for (const row of nextResults) {
                      combined.push(row);
                    }
                  }
                }
                if (productRes?.data?.M_ProductGet) {
                  productRes.data.M_ProductGet.Results = combined;
                }
              }
            }

            if (storageRes?.data || productRes?.data) {
              if (Array.isArray(storageRes?.data?.M_StorageOnHandGet?.Results)) {
                storageRes.data.M_StorageOnHandGet.Results = compactRow(
                  storageRes.data.M_StorageOnHandGet.Results,
                );
              }
              if (Array.isArray(productRes?.data?.M_ProductGet?.Results)) {
                productRes.data.M_ProductGet.Results = compactRow(
                  productRes.data.M_ProductGet.Results,
                );
              }
              return {
                data: {
                  ...(storageRes?.data || {}),
                  ...(productRes?.data || {}),
                },
              };
            }

            const primaryIdempiereError = productRes?.error
              ? productRes
              : storageRes?.error
                ? storageRes
                : Array.isArray(productRes?.errors) && productRes.errors.length > 0
                  ? productRes
                  : Array.isArray(storageRes?.errors) && storageRes.errors.length > 0
                    ? storageRes
                    : null;

            // Fallback to legacy query only if iDempiere queries failed; preserve real iDempiere error if legacy fails
            if (legacyQuery) {
              const legRes = await executeGql(endpointToUse, legacyQuery);
              if (legRes?.data?.products) {
                return legRes;
              }
              if (primaryIdempiereError) {
                return primaryIdempiereError;
              }
              return legRes || { error: "BandaGo GraphQL returned an empty response" };
            }

            return (
              primaryIdempiereError ||
              storageRes ||
              productRes || { error: "BandaGo GraphQL returned an empty response" }
            );
          } catch (e: any) {
            return {
              error: e.message || "Fetch failed",
            };
          }
        },
        args,
      });

      let response = results?.[0]?.result;
      if (!response) {
        try {
          const mainWorldResults = await chrome.scripting.executeScript({
            target: { tabId },
            world: "MAIN",
            func: async (
              gqlEndpoint: string,
              storageOrSingleQuery: string,
              param3?: string | null,
              param4?: string | null,
              param5?: string | null,
              param6?: boolean,
            ) => {
              // Reuse same self-contained poller inside MAIN world when ISOLATED world returns empty
              let cachedAuthHeader: string | null = param5 ?? null;
              let productQuery = param3 ?? null;
              let legacyQuery = param4 ?? null;
              if (param5 === undefined && param4 === undefined) {
                cachedAuthHeader = param3 ?? null;
                productQuery = null;
                legacyQuery = null;
              }
              void legacyQuery;
              try {
                if (!cachedAuthHeader) {
                  const jwtRegex = /^eyJ[A-Za-z0-9-_]+\.[A-Za-z0-9-_]+\.[A-Za-z0-9-_]+$/;
                  const scan = (val: unknown, depth = 0): string | null => {
                    if (depth > 3 || val == null) return null;
                    if (typeof val === "string") {
                      const c = val.trim().replace(/^"|"$/g, "").replace(/^Bearer\s+/i, "").trim();
                      if (jwtRegex.test(c)) return c;
                      if (c.startsWith("{") || c.startsWith("[")) {
                        try { return scan(JSON.parse(c), depth + 1); } catch {}
                      }
                      return null;
                    }
                    if (typeof val === "object") {
                      for (const v of Object.values(val as Record<string, unknown>)) {
                        const hit = scan(v, depth + 1);
                        if (hit) return hit;
                      }
                    }
                    return null;
                  };
                  for (const store of [window.localStorage, window.sessionStorage]) {
                    if (!store) continue;
                    for (let i = 0; i < store.length; i++) {
                      const k = store.key(i);
                      const v = k ? store.getItem(k) : null;
                      const tok = v ? scan(v) : null;
                      if (tok) { cachedAuthHeader = `Bearer ${tok}`; break; }
                    }
                    if (cachedAuthHeader) break;
                  }
                }
                const headers: Record<string, string> = {
                  "Content-Type": "application/json",
                  Accept: "application/json",
                };
                if (cachedAuthHeader) {
                  headers.Authorization = cachedAuthHeader.toLowerCase().startsWith("bearer ")
                    ? cachedAuthHeader
                    : `Bearer ${cachedAuthHeader}`;
                }
                const run = async (query: string, vars?: Record<string, any>) => {
                  const opMatch = query.match(/(?:query|mutation)\s+([A-Za-z0-9_]+)/);
                  const body = { query, ...(opMatch ? { operationName: opMatch[1] } : {}), ...(vars ? { variables: vars } : {}) };
                  const res = await fetch(gqlEndpoint, {
                    method: "POST",
                    credentials: "include",
                    headers,
                    body: JSON.stringify(param6 ? [body] : body),
                  });
                  if (!res.ok) return { error: `HTTP ${res.status}`, status: res.status };
                  const ct = res.headers?.get("content-type") || "";
                  if (ct && !ct.toLowerCase().includes("json")) return { error: `Non-JSON (${ct})`, status: res.status };
                  const json = await res.json();
                  return Array.isArray(json) ? json[0] || { error: "Empty response" } : json;
                };
                const sRes = await run(storageOrSingleQuery, { Page: 0, Size: 200, Filter: JSON.stringify({}) });
                const pRes = productQuery ? await run(productQuery, { Page: 0, Size: 200, Filter: JSON.stringify({}) }) : null;
                if (sRes?.data || pRes?.data) {
                  return { data: { ...(sRes?.data || {}), ...(pRes?.data || {}) } };
                }
                return pRes || sRes || { error: "MAIN world GraphQL returned no data" };
              } catch (err: any) {
                return { error: err?.message || "MAIN world fetch failed" };
              }
            },
            args,
          });
          response = mainWorldResults?.[0]?.result;
        } catch {
          // Ignore MAIN world injection errors
        }
      }

      if (!response) {
        return finishPoll(
          {
            success: false,
            count: 0,
            message: `No response returned from BandaGo tab (tab #${tabId}, status=${bestTab.status || "unknown"}, endpoint=${gqlEndpointArg}) — refresh the BandaGo tab and ensure you are signed in`,
          },
          "NETWORK_TIMEOUT",
        );
      }

      if (response.error) {
        const errText = String(response.error);
        const errorCode =
          response.status === 401 || /401|unauth|expired/i.test(errText)
            ? "AUTH_EXPIRED"
            : /timed out|timeout|network/i.test(errText)
              ? "NETWORK_TIMEOUT"
              : "INBOUND_ITEM_FAILED";
        return finishPoll(
          {
            success: false,
            count: 0,
            message: `In-tab query failed: ${response.error}`,
          },
          errorCode,
        );
      }

      if (
        response.errors &&
        Array.isArray(response.errors) &&
        response.errors.length > 0
      ) {
        const errDetails = response.errors
          .map((e: any) => e.message || "GraphQL error")
          .join("; ");
        return finishPoll(
          {
            success: false,
            count: 0,
            message: `In-tab GraphQL error: ${errDetails}`,
          },
          "GRAPHQL_SCHEMA_ERROR",
        );
      }

      const products = response?.data?.products;
      const normalized =
        Array.isArray(products) && products.length > 0
          ? products
              .map(BandaGoNormalizer.normalize)
              .filter((p): p is NonNullable<typeof p> => p !== null)
          : BandaGoNormalizer.extractProductsFromPayload(response);

      const detectedTenantUU =
        normalized.find((item) => Boolean(item.tenantUU))?.tenantUU ?? null;
      const expectedTenantUU = config.expectedTenantUU?.trim();
      if (
        expectedTenantUU &&
        detectedTenantUU &&
        expectedTenantUU !== detectedTenantUU
      ) {
        return finishPoll(
          {
            success: false,
            count: 0,
            message: `Tenant mismatch: expected BandaGo AD_Client_UU ${expectedTenantUU}, got ${detectedTenantUU}`,
          },
          "TENANT_MISMATCH",
          detectedTenantUU,
        );
      }

      if (normalized.length > 0) {
        if (detectedTenantUU) {
          await SphereSyncClient.enqueue(
            normalized,
            "BACKGROUND_POLL",
            detectedTenantUU,
          );
        } else {
          await SphereSyncClient.enqueue(normalized, "BACKGROUND_POLL");
        }
        return finishPoll(
          {
            success: true,
            count: normalized.length,
            message: `Successfully captured and enqueued ${normalized.length} products from BandaGo`,
          },
          undefined,
          detectedTenantUU,
        );
      }

      return finishPoll(
        {
          success: true,
          count: 0,
          message: "BandaGo returned 0 products",
        },
        undefined,
        detectedTenantUU,
      );
    } catch (err: any) {
      console.warn("[BandaGo Poller execution failed]:", err);
      return finishPoll({
        success: false,
        count: 0,
        message: err.message || "Script execution failed",
      });
    }
  }

  /**
   * Manually triggers an immediate poll of active tabs.
   */
  static async triggerManualPoll(): Promise<PollResult> {
    return this.pollActiveTabs();
  }
}
