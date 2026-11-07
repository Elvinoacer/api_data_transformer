import { BandaGoNormalizer } from "../extraction/bandago-normalizer";
import { SphereSyncClient } from "../sync/sphere-client";
import { CdpNetworkAdapter } from "./cdp-adapter";

export interface PollResult {
  success: boolean;
  count: number;
  message: string;
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
    const finishPoll = async (res: PollResult): Promise<PollResult> => {
      await SphereSyncClient.recordPollStatus(res).catch(() => {});
      return res;
    };

    const config = await SphereSyncClient.getConfig();
    if (!config.enabled) {
      return finishPoll({
        success: false,
        count: 0,
        message: "Sphere sync is currently disabled in settings",
      });
    }

    if (typeof chrome === "undefined" || !chrome.tabs || !chrome.scripting) {
      return finishPoll({
        success: false,
        count: 0,
        message: "Chrome extension APIs not available",
      });
    }

    // Locate open BandaGo POS tabs
    const tabs = await chrome.tabs.query({ url: "*://go.bandahealth.org/*" });
    if (tabs.length === 0 || !tabs[0].id) {
      return finishPoll({
        success: false,
        count: 0,
        message: "No active go.bandahealth.org tab found",
      });
    }

    const tabId = tabs[0].id;
    const tabUrl = tabs[0].url || "https://go.bandahealth.org";
    let origin = "https://go.bandahealth.org";
    try {
      origin = new URL(tabUrl).origin;
    } catch {}

    const cachedAuthHeader = await CdpNetworkAdapter.getAuthHeader(origin);

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
              M_Warehouse {
                UU
                Name
              }
            }
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
              BH_SoonToExpireDays {
                Name
                UU
                Value
              }
              C_UOM {
                StdPrecision
                UU
              }
              Created
              M_AttributeSet {
                IsGuaranteeDate
                IsLot
              }
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
            Description
            BH_BuyPrice
            BH_SellPrice
            BH_PriceMargin
            BH_HasExpiration
            HasExpirationDate
            IsActive
            TotalQuantity
            LastPurchasePrice
            Created
            bh_reorder_level
            bh_reorder_quantity
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

    try {
      const results = await chrome.scripting.executeScript({
        target: { tabId },
        func: async (
          gqlEndpoint: string,
          storageOrSingleQuery: string,
          param3?: string | null,
          param4?: string | null,
          param5?: string | null,
        ) => {
          let cachedAuthHeader: string | null = null;
          let storageQuery = storageOrSingleQuery;
          let productQuery: string | null = null;
          let legacyQuery: string | null = null;

          if (param5 !== undefined || param4 !== undefined) {
            productQuery = param3 ?? null;
            legacyQuery = param4 ?? null;
            cachedAuthHeader = param5 ?? null;
          } else {
            cachedAuthHeader = param3 ?? null;
          }

          try {
            // Fallback: look for JWT token in localStorage/sessionStorage if CDP hasn't captured a header yet
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

                    const trimmed = val.trim();
                    let rawToken: string | null = null;

                    if (
                      /^"?eyJ[A-Za-z0-9-_]+\.[A-Za-z0-9-_]+\.[A-Za-z0-9-_]+"?$/.test(
                        trimmed,
                      )
                    ) {
                      rawToken = trimmed.replace(/^"|"$/g, "");
                    } else if (trimmed.startsWith("{")) {
                      try {
                        const obj = JSON.parse(trimmed);
                        for (const k of [
                          "token",
                          "accessToken",
                          "access_token",
                          "jwt",
                          "id_token",
                          "idToken",
                          "authToken",
                        ]) {
                          if (
                            typeof obj[k] === "string" &&
                            /^eyJ[A-Za-z0-9-_]+\.[A-Za-z0-9-_]+\.[A-Za-z0-9-_]+$/.test(
                              obj[k],
                            )
                          ) {
                            rawToken = obj[k];
                            break;
                          }
                        }
                      } catch {}
                    }

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
            ) => {
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
                  body: JSON.stringify(bodyObj),
                });
                if (!res.ok) {
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
                if (contentType && !contentType.includes("application/json")) {
                  return {
                    error: `Non-JSON response (${contentType})`,
                    status: res.status,
                    nonJson: true,
                  };
                }
                try {
                  return await res.json();
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

            // BandaGo iDempiere Inventory Polling
            let endpointToUse = gqlEndpoint;
            let storageRes: any = await executeGql(endpointToUse, storageQuery, {
              Page: 1,
              Size: 500,
              Filter: JSON.stringify({}),
            });

            // Fallback to alternate trailing slash on 404, non-JSON SPA response, or error
            if (
              storageRes?.status === 404 ||
              storageRes?.nonJson ||
              (storageRes?.error && storageRes?.status !== 401)
            ) {
              const altEndpoint = endpointToUse.endsWith("/")
                ? endpointToUse.slice(0, -1)
                : `${endpointToUse}/`;
              const altRes = await executeGql(altEndpoint, storageQuery, {
                Page: 1,
                Size: 500,
                Filter: JSON.stringify({}),
              });
              if (!altRes?.error) {
                endpointToUse = altEndpoint;
                storageRes = altRes;
              }
            }

            // If credentials expired (HTTP 401), exit early immediately
            if (storageRes?.status === 401) {
              return storageRes;
            }

            // Multi-page pagination support for storage on hand (up to 10 pages / 5000 records)
            if (storageRes?.data?.M_StorageOnHandGet?.PagingInfo?.TotalPages > 1) {
              const totalPages = Math.min(
                storageRes.data.M_StorageOnHandGet.PagingInfo.TotalPages,
                10,
              );
              for (let page = 2; page <= totalPages; page++) {
                const nextPage = await executeGql(endpointToUse, storageQuery, {
                  Page: page,
                  Size: 500,
                  Filter: JSON.stringify({}),
                });
                if (Array.isArray(nextPage?.data?.M_StorageOnHandGet?.Results)) {
                  storageRes.data.M_StorageOnHandGet.Results.push(
                    ...nextPage.data.M_StorageOnHandGet.Results,
                  );
                }
              }
            }

            // Fetch catalog product list even if storage query encountered errors
            let productRes: any = null;
            if (productQuery) {
              productRes = await executeGql(endpointToUse, productQuery, {
                Page: 1,
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
                const altRes = await executeGql(altEndpoint, productQuery, {
                  Page: 1,
                  Size: 500,
                  Filter: JSON.stringify({}),
                });
                if (!altRes?.error) {
                  endpointToUse = altEndpoint;
                  productRes = altRes;
                }
              }

              // Multi-page pagination support for product catalog
              if (productRes?.data?.M_ProductGet?.PagingInfo?.TotalPages > 1) {
                const totalPages = Math.min(
                  productRes.data.M_ProductGet.PagingInfo.TotalPages,
                  10,
                );
                for (let page = 2; page <= totalPages; page++) {
                  const nextPage = await executeGql(endpointToUse, productQuery, {
                    Page: page,
                    Size: 500,
                    Filter: JSON.stringify({}),
                  });
                  if (Array.isArray(nextPage?.data?.M_ProductGet?.Results)) {
                    productRes.data.M_ProductGet.Results.push(
                      ...nextPage.data.M_ProductGet.Results,
                    );
                  }
                }
              }
            }

            if (storageRes?.data || productRes?.data) {
              return {
                data: {
                  ...(storageRes?.data || {}),
                  ...(productRes?.data || {}),
                },
              };
            }

            // Fallback to legacy query if iDempiere queries fail or aren't supported
            if (legacyQuery) {
              return await executeGql(endpointToUse, legacyQuery);
            }

            return storageRes?.error ? storageRes : (productRes || storageRes);
          } catch (e: any) {
            return {
              error: e.message || "Fetch failed",
            };
          }
        },
        args: [
          "/graphql/",
          storageOnHandQuery,
          productListQuery,
          fallbackInventoryQuery,
          cachedAuthHeader,
        ],
      });

      const response = results[0]?.result;
      if (!response) {
        return finishPoll({
          success: false,
          count: 0,
          message: "No response returned from BandaGo tab",
        });
      }

      if (response.error) {
        return finishPoll({
          success: false,
          count: 0,
          message: `In-tab query failed: ${response.error}`,
        });
      }

      if (
        response.errors &&
        Array.isArray(response.errors) &&
        response.errors.length > 0
      ) {
        const errDetails = response.errors
          .map((e: any) => e.message || "GraphQL error")
          .join("; ");
        return finishPoll({
          success: false,
          count: 0,
          message: `In-tab GraphQL error: ${errDetails}`,
        });
      }

      const products = response?.data?.products;
      const normalized =
        Array.isArray(products) && products.length > 0
          ? products
              .map(BandaGoNormalizer.normalize)
              .filter((p): p is NonNullable<typeof p> => p !== null)
          : BandaGoNormalizer.extractProductsFromPayload(response);

      if (normalized.length > 0) {
        await SphereSyncClient.enqueue(normalized, "BACKGROUND_POLL");
        return finishPoll({
          success: true,
          count: normalized.length,
          message: `Successfully captured and enqueued ${normalized.length} products from BandaGo`,
        });
      }

      return finishPoll({
        success: true,
        count: 0,
        message: "BandaGo returned 0 products",
      });
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
