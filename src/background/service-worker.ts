import { captureController } from "./capture-controller";
import { BandaGoActivePoller } from "./bandago-poller";
import { BandaGoWritebackEngine } from "./bandago-writeback";
import { cdpAdapter } from "./cdp-adapter";
import { rawResponseRepo, recordRepo, sourceRepo } from "../data/repositories";
import { parseApiJsonBody } from "../privacy/source-policy";
import {
  BandaGoNormalizer,
  isBandaGoCatalogSource,
  type SphereProductInput,
} from "../extraction/bandago-normalizer";
import { SphereSyncClient } from "../sync/sphere-client";
import {
  ExtensionMessage,
  StartAutoPaginatePayload,
  StartCapturePayload,
} from "../messaging/protocol";

// Initialize state from IndexedDB when service worker boots up
captureController.init().catch(console.error);
BandaGoActivePoller.init();
BandaGoWritebackEngine.init();

let passiveMutationDebounceTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * Re-injects the MAIN/ISOLATED passive interceptors into already-open go.bandahealth.org
 * tabs after extension install/update/reload so existing SPA tabs don't go silent.
 */
async function injectBandaGoInterceptorsIntoOpenTabs(): Promise<void> {
  try {
    if (
      typeof chrome === "undefined" ||
      !chrome.tabs?.query ||
      !chrome.scripting?.executeScript
    ) {
      return;
    }
    const tabs = await chrome.tabs.query({ url: "*://go.bandahealth.org/*" });
    for (const tab of tabs) {
      if (typeof tab.id !== "number") continue;
      await chrome.scripting
        .executeScript({
          target: { tabId: tab.id },
          files: ["isolated-bridge.js"],
          world: "ISOLATED",
        })
        .catch(() => {});
      await chrome.scripting
        .executeScript({
          target: { tabId: tab.id },
          files: ["main-interceptor.js"],
          world: "MAIN",
        })
        .catch(() => {});
    }
  } catch {
    // Non-fatal in non-browser test runs
  }
}

if (typeof chrome !== "undefined" && chrome.runtime?.onInstalled?.addListener) {
  chrome.runtime.onInstalled.addListener(() => {
    injectBandaGoInterceptorsIntoOpenTabs().catch(() => {});
  });
}

if (typeof chrome !== "undefined" && chrome.runtime?.onStartup?.addListener) {
  chrome.runtime.onStartup.addListener(() => {
    injectBandaGoInterceptorsIntoOpenTabs().catch(() => {});
  });
}

// 1. Top-level Debugger Event Listener
chrome.debugger.onEvent.addListener((source, method, params) => {
  captureController.onCdpEvent(source, method, params).catch((err) => {
    console.error("Error handling CDP event:", err);
  });
});

// 2. Top-level Debugger Detach Listener
chrome.debugger.onDetach.addListener((source, reason) => {
  if (source.tabId) {
    captureController
      .handleDebuggerDetach(source.tabId, reason)
      .catch(console.error);
  }
});

// 3. Top-level Tab Removed Listener
chrome.tabs.onRemoved.addListener((tabId) => {
  captureController.handleTabRemoved(tabId).catch(console.error);
});

// 4. Action Icon Click: Open full collector dashboard
chrome.action.onClicked.addListener(async () => {
  const dashboardUrl = chrome.runtime.getURL("dashboard.html");
  const existingTabs = await chrome.tabs.query({ url: dashboardUrl });

  if (existingTabs.length > 0 && existingTabs[0].id) {
    await chrome.tabs.update(existingTabs[0].id, { active: true });
    if (existingTabs[0].windowId) {
      await chrome.windows.update(existingTabs[0].windowId, { focused: true });
    }
  } else {
    await chrome.tabs.create({ url: dashboardUrl });
  }
});

// 5. Top-level Extension Messaging Listener
chrome.runtime.onMessage.addListener(
  (message: ExtensionMessage, sender, sendResponse) => {
    // Handle OPEN_SIDEPANEL synchronously before any `await` so Chrome preserves the user gesture
    if (message.type === "OPEN_SIDEPANEL" && sender.tab?.windowId) {
      const openPromise = chrome.sidePanel.open({
        windowId: sender.tab.windowId,
      });
      (async () => {
        try {
          await openPromise;
          sendResponse({ success: true });
        } catch (err: any) {
          sendResponse({
            success: false,
            error: err?.message || "Could not open side panel",
          });
        }
      })();
      return true;
    }

    (async () => {
      try {
        await captureController.init();

        switch (message.type) {
          case "START_CAPTURE": {
            const payload = message.payload as StartCapturePayload;
            const session = await captureController.startCapture(payload);
            sendResponse({ success: true, data: session });
            break;
          }

          case "PAUSE_CAPTURE": {
            const { sessionId } =
              (message.payload as { sessionId?: string }) || {};
            await captureController.pauseCapture(sessionId);
            sendResponse({ success: true });
            break;
          }

          case "RESUME_CAPTURE": {
            const { sessionId } =
              (message.payload as { sessionId?: string }) || {};
            await captureController.resumeCapture(sessionId);
            sendResponse({ success: true });
            break;
          }

          case "STOP_CAPTURE": {
            const { sessionId } =
              (message.payload as { sessionId?: string }) || {};
            await captureController.stopCapture(sessionId);
            sendResponse({ success: true });
            break;
          }

          case "GET_CAPTURE_STATE": {
            const activeSession = captureController.getActiveSession();
            const status = captureController.getStatus();
            const autoPaginate = captureController.getAutoPaginateState();
            sendResponse({
              success: true,
              data: { activeSession, status, autoPaginate },
            });
            break;
          }

          case "REPROCESS_SESSION": {
            const { sessionId } = message.payload as { sessionId: string };
            await captureController.reprocessSession(sessionId);
            sendResponse({ success: true });
            break;
          }

          case "START_AUTO_PAGINATE": {
            const payload = message.payload as StartAutoPaginatePayload;
            const state = await captureController.startAutoPaginate(payload);
            sendResponse({ success: true, data: state });
            break;
          }

          case "STOP_AUTO_PAGINATE": {
            const state = await captureController.stopAutoPaginate();
            sendResponse({ success: true, data: state });
            break;
          }

          case "GET_AUTO_PAGINATE_STATE": {
            const state = captureController.getAutoPaginateState();
            sendResponse({ success: true, data: state });
            break;
          }

          case "FOCUS_TARGET_TAB": {
            const { tabId } = (message.payload as { tabId?: number }) || {};
            const targetId =
              tabId || captureController.getActiveSession()?.targetTabId;
            if (targetId) {
              const tab = await chrome.tabs.update(targetId, { active: true });
              if (tab?.windowId) {
                await chrome.windows.update(tab.windowId, { focused: true });
              }
            }
            sendResponse({ success: true });
            break;
          }

          case "OPEN_DASHBOARD": {
            const dashboardUrl = chrome.runtime.getURL("dashboard.html");
            const existingTabs = await chrome.tabs.query({ url: dashboardUrl });
            if (existingTabs.length > 0 && existingTabs[0].id) {
              await chrome.tabs.update(existingTabs[0].id, { active: true });
              if (existingTabs[0].windowId) {
                await chrome.windows.update(existingTabs[0].windowId, {
                  focused: true,
                });
              }
            } else {
              await chrome.tabs.create({ url: dashboardUrl });
            }
            sendResponse({ success: true });
            break;
          }

          case "OPEN_SIDEPANEL": {
            const winId =
              sender.tab?.windowId ??
              (await chrome.windows.getLastFocused()).id;
            if (winId) {
              await chrome.sidePanel.open({ windowId: winId });
            }
            sendResponse({ success: true });
            break;
          }

          case "CLEAR_TAB_DATA": {
            const payload =
              (message.payload as {
                sessionId?: string;
                clearSyncQueue?: boolean;
              }) || {};
            const result = await captureController.clearTabData(
              payload.sessionId,
              payload.clearSyncQueue,
            );
            sendResponse({ success: true, data: result });
            break;
          }

          case "CLEAR_ALL_DATA": {
            const payload =
              (message.payload as {
                clearSessions?: boolean;
                clearSyncQueue?: boolean;
              }) || {};
            const result = await captureController.clearAllData(payload);
            sendResponse({ success: true, data: result });
            break;
          }

          case "SPHERE_GET_CONFIG": {
            const config = await SphereSyncClient.getConfig();
            sendResponse({ success: true, data: config });
            break;
          }

          case "SPHERE_SAVE_CONFIG": {
            const updated = await SphereSyncClient.saveConfig(
              (message.payload as any) || {},
            );
            sendResponse({ success: true, data: updated });
            break;
          }

          case "SPHERE_FLUSH_QUEUE": {
            const result = await SphereSyncClient.flushQueue();
            sendResponse({ success: true, data: result });
            break;
          }

          case "SPHERE_GET_QUEUE_STATS": {
            const stats = await SphereSyncClient.getQueueStats();
            sendResponse({ success: true, data: stats });
            break;
          }

          case "SPHERE_RETRY_FAILED": {
            const retriedCount = await SphereSyncClient.retryFailed();
            sendResponse({ success: true, data: { retriedCount } });
            break;
          }

          case "SPHERE_CLEAR_QUEUE": {
            await SphereSyncClient.clearQueue();
            sendResponse({ success: true });
            break;
          }

          case "SPHERE_TEST_CONNECTION": {
            const result = await SphereSyncClient.testConnection(
              (message.payload as any) || {},
            );
            sendResponse({ success: true, data: result });
            break;
          }

          case "SPHERE_GET_DIAGNOSTICS": {
            const diagnostics = await SphereSyncClient.getDiagnostics();
            sendResponse({ success: true, data: diagnostics });
            break;
          }

          case "SPHERE_CLEAR_ERRORS": {
            await SphereSyncClient.clearErrorHistory();
            sendResponse({ success: true });
            break;
          }

          case "SPHERE_DISMISS_ERRORS": {
            await SphereSyncClient.dismissActiveErrors();
            sendResponse({ success: true });
            break;
          }

          case "BANDAGO_TRIGGER_POLL": {
            const pollResult = await BandaGoActivePoller.triggerManualPoll();
            sendResponse({ success: true, data: pollResult });
            break;
          }

          case "BANDAGO_SYNC_OUTBOUND_NOW": {
            const writebackResult = await BandaGoWritebackEngine.syncOutboundNow({
              trigger: "MANUAL",
            });
            sendResponse({ success: true, data: writebackResult });
            break;
          }

          case "BANDAGO_PASSIVE_CATALOG": {
            const passiveMsg = message as any;
            const ingestRes = await captureController
              .ingestPassiveBandaGoCatalog({
                tabId: sender.tab?.id,
                endpointUrl:
                  typeof passiveMsg.endpointUrl === "string"
                    ? passiveMsg.endpointUrl
                    : undefined,
                operationName:
                  typeof passiveMsg.operationName === "string"
                    ? passiveMsg.operationName
                    : undefined,
                payload: message.payload,
              })
              .catch(() => ({ captured: false, extractedCount: 0 }));

            const cfg = await SphereSyncClient.getConfig();
            if (!cfg.enabled) {
              sendResponse({
                success: true,
                data: {
                  skipped: true,
                  capturedToSession: ingestRes.captured,
                  extractedCount: ingestRes.extractedCount,
                },
              });
              break;
            }
            const normalized = BandaGoNormalizer.extractProductsFromPayload(
              message.payload,
            );
            const detectedTenantUU =
              normalized.find((item) => Boolean(item.tenantUU))?.tenantUU ??
              null;
            if (
              cfg.expectedTenantUU?.trim() &&
              detectedTenantUU &&
              cfg.expectedTenantUU.trim() !== detectedTenantUU
            ) {
              await SphereSyncClient.reportTelemetry({
                errors: [
                  {
                    direction: "INBOUND",
                    source: "PASSIVE_CONTENT_SCRIPT",
                    severity: "CRITICAL",
                    code: "TENANT_MISMATCH",
                    message: `Passive interceptor blocked payload from unexpected BandaGo tenant ${detectedTenantUU}`,
                  },
                ],
              }).catch(() => {});
              sendResponse({ success: false, error: "Tenant mismatch" });
              break;
            }
            if (normalized.length > 0) {
              await SphereSyncClient.enqueue(
                normalized,
                "EXTENSION_STREAM",
                detectedTenantUU,
              );
            }
            sendResponse({
              success: true,
              data: {
                captured: normalized.length,
                capturedToSession: ingestRes.captured,
                extractedCount: ingestRes.extractedCount,
              },
            });
            break;
          }

          case "BANDAGO_PASSIVE_MUTATION": {
            if (passiveMutationDebounceTimer) {
              clearTimeout(passiveMutationDebounceTimer);
            }
            passiveMutationDebounceTimer = setTimeout(() => {
              passiveMutationDebounceTimer = null;
              BandaGoActivePoller.pollActiveTabs().catch((err) => {
                console.warn("[Passive Mutation Follow-up Poll]:", err);
              });
            }, 2000);
            sendResponse({ success: true, data: { scheduled: true } });
            break;
          }

          case "BANDAGO_DISCOVERED_ENDPOINT": {
            const payload = (message.payload || {}) as {
              endpointUrl?: string;
              usesBatchArray?: boolean;
            };
            if (payload.endpointUrl) {
              let tabOrigin = "https://go.bandahealth.org";
              let endpointOrigin: string | null = null;
              try {
                if (sender.tab?.url) {
                  tabOrigin = new URL(sender.tab.url).origin;
                }
              } catch {}
              try {
                endpointOrigin = new URL(payload.endpointUrl, tabOrigin).origin;
              } catch {}
              await cdpAdapter.setGraphqlEndpoint(
                tabOrigin,
                payload.endpointUrl,
                payload.usesBatchArray,
              );
              if (endpointOrigin && endpointOrigin !== tabOrigin) {
                await cdpAdapter.setGraphqlEndpoint(
                  endpointOrigin,
                  payload.endpointUrl,
                  payload.usesBatchArray,
                );
              }
            }
            sendResponse({ success: true });
            break;
          }

          case "SPHERE_SYNC_DISCOVERED_SOURCE": {
            const cfg = await SphereSyncClient.getConfig();
            if (!cfg.enabled || !cfg.endpointUrl || !cfg.apiKey) {
              sendResponse({
                success: false,
                error:
                  "Configure Sphere API endpoint, API key, and enable sync in Settings first.",
              });
              break;
            }
            const { sourceId, sessionId } = (message.payload || {}) as {
              sourceId?: string;
              sessionId?: string;
            };
            const targetSessionId =
              sessionId || captureController.getActiveSession()?.id;
            const targetSources = sourceId
              ? await sourceRepo.getSource(sourceId).then((s) => (s ? [s] : []))
              : targetSessionId
                ? (await sourceRepo.getSourcesBySession(targetSessionId)).filter(
                    (s) => isBandaGoCatalogSource(s),
                  )
                : [];

            const mergedById = new Map<string, SphereProductInput>();
            for (const src of targetSources) {
              const sid = src.sessionId || targetSessionId;
              if (!sid) continue;
              const recs = await recordRepo.getRecordsBySource(sid, src.id);
              const fromRecords = BandaGoNormalizer.extractProductsFromPayload(
                recs.map((r) => r.rawRecord),
              );
              const candidates =
                fromRecords.length > 0
                  ? fromRecords
                  : await (async () => {
                      const rawResps = await rawResponseRepo.getAllBySession(sid);
                      const collected: SphereProductInput[] = [];
                      for (const resp of rawResps) {
                        if (
                          resp.normalizedEndpoint !== src.normalizedEndpoint &&
                          resp.operationName !== src.operationName
                        ) {
                          continue;
                        }
                        const parsed = parseApiJsonBody(resp.responseBody);
                        if (parsed.ok) {
                          collected.push(
                            ...BandaGoNormalizer.extractProductsFromPayload(
                              parsed.data,
                            ),
                          );
                        }
                      }
                      return collected;
                    })();

              for (const item of candidates) {
                const prev = mergedById.get(item.externalPosId);
                mergedById.set(
                  item.externalPosId,
                  prev ? BandaGoNormalizer.mergeProducts(prev, item) : item,
                );
              }
            }

            const products = Array.from(mergedById.values());
            if (products.length === 0) {
              sendResponse({
                success: false,
                error:
                  "No BandaGo product or stock rows found in this captured dataset yet.",
              });
              break;
            }

            const detectedTenantUU =
              products.find((p) => Boolean(p.tenantUU))?.tenantUU ?? null;
            if (
              cfg.expectedTenantUU?.trim() &&
              detectedTenantUU &&
              cfg.expectedTenantUU.trim() !== detectedTenantUU
            ) {
              sendResponse({
                success: false,
                error: `Tenant mismatch: expected ${cfg.expectedTenantUU.trim()}, got ${detectedTenantUU}`,
              });
              break;
            }

            await SphereSyncClient.enqueue(
              products,
              "CDP_INTERCEPT",
              detectedTenantUU,
            );
            const flush = await SphereSyncClient.flushQueue(
              "CDP_INTERCEPT",
              detectedTenantUU,
            );
            sendResponse({
              success: true,
              data: {
                normalizedCount: products.length,
                synced: flush.synced,
                failed: flush.failed,
                error: flush.error,
              },
            });
            break;
          }

          case "SPHERE_REPORT_TELEMETRY": {
            const reportRes = await SphereSyncClient.reportTelemetry(
              (message.payload as any) || {},
            );
            sendResponse({ success: true, data: reportRes });
            break;
          }

          case "SPHERE_GET_OUTBOUND_STATUS": {
            const [status, policy] = await Promise.all([
              SphereSyncClient.getOutboundStatus(),
              SphereSyncClient.getServerPolicy(),
            ]);
            sendResponse({ success: true, data: { status, policy } });
            break;
          }

          default:
            sendResponse({
              success: false,
              error: `Unknown message type: ${message.type}`,
            });
            break;
        }
      } catch (err: any) {
        console.error("Message handler error:", err);
        sendResponse({
          success: false,
          error: err.message || "Operation failed",
        });
      }
    })();

    return true; // Keeps message channel open for async sendResponse
  },
);
