import { captureController } from './capture-controller';
import { ExtensionMessage, StartCapturePayload } from '../messaging/protocol';

// Initialize state from IndexedDB when service worker boots up
captureController.init().catch(console.error);

// 1. Top-level Debugger Event Listener
chrome.debugger.onEvent.addListener((source, method, params) => {
  captureController.onCdpEvent(source, method, params).catch((err) => {
    console.error('Error handling CDP event:', err);
  });
});

// 2. Top-level Debugger Detach Listener
chrome.debugger.onDetach.addListener((source, reason) => {
  if (source.tabId) {
    captureController.handleDebuggerDetach(source.tabId, reason).catch(console.error);
  }
});

// 3. Top-level Tab Removed Listener
chrome.tabs.onRemoved.addListener((tabId) => {
  captureController.handleTabRemoved(tabId).catch(console.error);
});

// 4. Action Icon Click: Open full collector dashboard
chrome.action.onClicked.addListener(async () => {
  const dashboardUrl = chrome.runtime.getURL('dashboard.html');
  const existingTabs = await chrome.tabs.query({ url: dashboardUrl });

  if (existingTabs.length > 0 && existingTabs[0].id) {
    await chrome.tabs.update(existingTabs[0].id, { active: true });
  } else {
    await chrome.tabs.create({ url: dashboardUrl });
  }
});

// 5. Top-level Extension Messaging Listener
chrome.runtime.onMessage.addListener((message: ExtensionMessage, sender, sendResponse) => {
  (async () => {
    try {
      switch (message.type) {
        case 'START_CAPTURE': {
          const payload = message.payload as StartCapturePayload;
          const session = await captureController.startCapture(payload);
          sendResponse({ success: true, data: session });
          break;
        }

        case 'PAUSE_CAPTURE': {
          const { sessionId } = (message.payload as { sessionId?: string }) || {};
          await captureController.pauseCapture(sessionId);
          sendResponse({ success: true });
          break;
        }

        case 'RESUME_CAPTURE': {
          const { sessionId } = (message.payload as { sessionId?: string }) || {};
          await captureController.resumeCapture(sessionId);
          sendResponse({ success: true });
          break;
        }

        case 'STOP_CAPTURE': {
          const { sessionId } = (message.payload as { sessionId?: string }) || {};
          await captureController.stopCapture(sessionId);
          sendResponse({ success: true });
          break;
        }

        case 'GET_CAPTURE_STATE': {
          const activeSession = captureController.getActiveSession();
          const status = captureController.getStatus();
          sendResponse({ success: true, data: { activeSession, status } });
          break;
        }

        case 'REPROCESS_SESSION': {
          const { sessionId } = message.payload as { sessionId: string };
          await captureController.reprocessSession(sessionId);
          sendResponse({ success: true });
          break;
        }

        case 'OPEN_DASHBOARD': {
          const dashboardUrl = chrome.runtime.getURL('dashboard.html');
          const existingTabs = await chrome.tabs.query({ url: dashboardUrl });
          if (existingTabs.length > 0 && existingTabs[0].id) {
            await chrome.tabs.update(existingTabs[0].id, { active: true });
          } else {
            await chrome.tabs.create({ url: dashboardUrl });
          }
          sendResponse({ success: true });
          break;
        }

        case 'OPEN_SIDEPANEL': {
          if (sender.tab?.windowId) {
            await (chrome as any).sidePanel.open({ windowId: sender.tab.windowId });
          }
          sendResponse({ success: true });
          break;
        }

        default:
          sendResponse({ success: false, error: `Unknown message type: ${message.type}` });
          break;
      }
    } catch (err: any) {
      console.error('Message handler error:', err);
      sendResponse({ success: false, error: err.message || 'Operation failed' });
    }
  })();

  return true; // Keeps message channel open for async sendResponse
});
