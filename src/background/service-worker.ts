import { captureController } from "./capture-controller";
import { BandaGoActivePoller } from "./bandago-poller";
import { SphereSyncClient } from "../sync/sphere-client";
import {
  ExtensionMessage,
  StartAutoPaginatePayload,
  StartCapturePayload,
} from "../messaging/protocol";

// Initialize state from IndexedDB when service worker boots up
captureController.init().catch(console.error);
BandaGoActivePoller.init();

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

          case "BANDAGO_TRIGGER_POLL": {
            const pollResult = await BandaGoActivePoller.triggerManualPoll();
            sendResponse({ success: true, data: pollResult });
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
