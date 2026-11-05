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
    const config = await SphereSyncClient.getConfig();
    if (!config.enabled) {
      return {
        success: false,
        count: 0,
        message: "Sphere sync is currently disabled in settings",
      };
    }

    if (typeof chrome === "undefined" || !chrome.tabs || !chrome.scripting) {
      return {
        success: false,
        count: 0,
        message: "Chrome extension APIs not available",
      };
    }

    // Locate open BandaGo POS tabs
    const tabs = await chrome.tabs.query({ url: "*://go.bandahealth.org/*" });
    if (tabs.length === 0 || !tabs[0].id) {
      return {
        success: false,
        count: 0,
        message: "No active go.bandahealth.org tab found",
      };
    }

    const tabId = tabs[0].id;
    const tabUrl = tabs[0].url || "https://go.bandahealth.org";
    let origin = "https://go.bandahealth.org";
    try {
      origin = new URL(tabUrl).origin;
    } catch {}

    const cachedAuthHeader = await CdpNetworkAdapter.getAuthHeader(origin);

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
        func: async (
          gqlEndpoint: string,
          query: string,
          cachedAuthHeader: string | null,
        ) => {
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

            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 15000);

            try {
              const res = await fetch(gqlEndpoint, {
                method: "POST",
                credentials: "include",
                headers,
                signal: controller.signal,
                body: JSON.stringify({
                  // Must match the operation name declared in `query` below,
                  // otherwise GraphQL servers reject with "Unknown operation named ..."
                  operationName: "AutoSyncInventory",
                  query,
                }),
              });
              if (!res.ok) {
                const text = await res.text();
                return { error: `HTTP ${res.status}: ${text.slice(0, 200)}` };
              }
              return await res.json();
            } finally {
              clearTimeout(timeoutId);
            }
          } catch (e: any) {
            return {
              error:
                e?.name === "AbortError"
                  ? "BandaGo in-tab fetch timed out after 15 seconds"
                  : e.message || "Fetch failed",
            };
          }
        },
        args: ["/graphql", graphqlQuery, cachedAuthHeader],
      });

      const response = results[0]?.result;
      if (!response) {
        return {
          success: false,
          count: 0,
          message: "No response returned from BandaGo tab",
        };
      }

      if (response.error) {
        return {
          success: false,
          count: 0,
          message: `In-tab query failed: ${response.error}`,
        };
      }

      if (
        response.errors &&
        Array.isArray(response.errors) &&
        response.errors.length > 0
      ) {
        const errDetails = response.errors
          .map((e: any) => e.message || "GraphQL error")
          .join("; ");
        return {
          success: false,
          count: 0,
          message: `In-tab GraphQL error: ${errDetails}`,
        };
      }

      const products = response?.data?.products;
      const normalized =
        Array.isArray(products) && products.length > 0
          ? products
              .map(BandaGoNormalizer.normalize)
              .filter((p): p is NonNullable<typeof p> => p !== null)
          : BandaGoNormalizer.extractProductsFromPayload(response);

      if (normalized.length > 0) {
        await SphereSyncClient.enqueue(normalized);
        return {
          success: true,
          count: normalized.length,
          message: `Successfully captured and enqueued ${normalized.length} products from BandaGo`,
        };
      }

      return {
        success: true,
        count: 0,
        message: "BandaGo returned 0 products",
      };
    } catch (err: any) {
      console.warn("[BandaGo Poller execution failed]:", err);
      return {
        success: false,
        count: 0,
        message: err.message || "Script execution failed",
      };
    }
  }

  /**
   * Manually triggers an immediate poll of active tabs.
   */
  static async triggerManualPoll(): Promise<PollResult> {
    return this.pollActiveTabs();
  }
}
