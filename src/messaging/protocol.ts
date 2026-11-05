import {
  AutoPaginateConfig,
  AutoPaginateState,
  CaptureSession,
  CaptureStatus,
  ScopeMode,
} from "../shared/types";

export type MessageType =
  | "START_CAPTURE"
  | "PAUSE_CAPTURE"
  | "RESUME_CAPTURE"
  | "STOP_CAPTURE"
  | "GET_CAPTURE_STATE"
  | "REPROCESS_SESSION"
  | "START_AUTO_PAGINATE"
  | "STOP_AUTO_PAGINATE"
  | "GET_AUTO_PAGINATE_STATE"
  | "FOCUS_TARGET_TAB"
  | "OPEN_DASHBOARD"
  | "OPEN_SIDEPANEL"
  | "CLEAR_TAB_DATA"
  | "CLEAR_ALL_DATA"
  | "SPHERE_GET_CONFIG"
  | "SPHERE_SAVE_CONFIG"
  | "SPHERE_FLUSH_QUEUE"
  | "SPHERE_GET_QUEUE_STATS"
  | "SPHERE_RETRY_FAILED"
  | "SPHERE_CLEAR_QUEUE"
  | "SPHERE_TEST_CONNECTION"
  | "BANDAGO_TRIGGER_POLL";

export interface ClearTabDataPayload {
  sessionId?: string;
  clearSyncQueue?: boolean;
}

export interface ClearAllDataPayload {
  clearSessions?: boolean;
  clearSyncQueue?: boolean;
}

export interface ClearTabDataResult {
  clearedResponses: number;
  clearedRecords: number;
  clearedSources: number;
  clearedSchemas: number;
  clearedErrors: number;
  targetSessionId?: string;
}

export interface StartCapturePayload {
  tabId: number;
  originalUrl: string;
  allowedHostnames: string[];
  scopeMode?: ScopeMode;
  label?: string;
}

export interface ExtensionMessage<T = unknown> {
  type: MessageType;
  payload?: T;
}

export interface CaptureStateResponse {
  activeSession: CaptureSession | null;
  status: CaptureStatus;
  autoPaginate?: AutoPaginateState;
}

export interface ReprocessPayload {
  sessionId: string;
}

export type StartAutoPaginatePayload = AutoPaginateConfig;

export interface ApiResponse<T = unknown> {
  success: boolean;
  data?: T;
  error?: string;
}

export async function sendExtensionMessage<T = unknown, R = unknown>(
  type: MessageType,
  payload?: T,
): Promise<ApiResponse<R>> {
  try {
    if (typeof chrome === "undefined" || !chrome.runtime?.sendMessage) {
      return {
        success: false,
        error: "Chrome extension runtime is not active in standalone preview.",
      };
    }
    const response = await chrome.runtime.sendMessage({ type, payload });
    // A service worker that predates the current build rejects newer message
    // types. Chrome keeps running the old worker after `npm run build` until the
    // extension is reloaded, so explain that instead of a cryptic error.
    if (
      response &&
      !response.success &&
      typeof response.error === "string" &&
      response.error.startsWith("Unknown message type")
    ) {
      return {
        ...response,
        error:
          `${response.error}. The extension's background service worker is running an outdated build. ` +
          `Open chrome://extensions and click Reload on "Live Network Data Collector", then reopen this page.`,
      };
    }
    return (
      response || {
        success: false,
        error: "No response from extension background service",
      }
    );
  } catch (err: any) {
    return {
      success: false,
      error:
        err.message || "Failed to communicate with extension service worker",
    };
  }
}
