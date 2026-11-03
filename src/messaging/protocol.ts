import {
  AutoPaginateConfig,
  AutoPaginateState,
  CaptureSession,
  CaptureStatus,
  ScopeMode,
} from '../shared/types';

export type MessageType =
  | 'START_CAPTURE'
  | 'PAUSE_CAPTURE'
  | 'RESUME_CAPTURE'
  | 'STOP_CAPTURE'
  | 'GET_CAPTURE_STATE'
  | 'REPROCESS_SESSION'
  | 'START_AUTO_PAGINATE'
  | 'STOP_AUTO_PAGINATE'
  | 'GET_AUTO_PAGINATE_STATE'
  | 'FOCUS_TARGET_TAB'
  | 'OPEN_DASHBOARD'
  | 'OPEN_SIDEPANEL';

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
  payload?: T
): Promise<ApiResponse<R>> {
  try {
    if (typeof chrome === 'undefined' || !chrome.runtime?.sendMessage) {
      return { success: false, error: 'Chrome extension runtime is not active in standalone preview.' };
    }
    const response = await chrome.runtime.sendMessage({ type, payload });
    return response || { success: false, error: 'No response from extension background service' };
  } catch (err: any) {
    return { success: false, error: err.message || 'Failed to communicate with extension service worker' };
  }
}
