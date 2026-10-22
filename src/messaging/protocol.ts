import { CaptureSession, CaptureStatus } from '../shared/types';

export type MessageType =
  | 'START_CAPTURE'
  | 'PAUSE_CAPTURE'
  | 'RESUME_CAPTURE'
  | 'STOP_CAPTURE'
  | 'GET_CAPTURE_STATE'
  | 'REPROCESS_SESSION'
  | 'OPEN_DASHBOARD'
  | 'OPEN_SIDEPANEL';

export interface StartCapturePayload {
  tabId: number;
  originalUrl: string;
  allowedHostnames: string[];
}

export interface ExtensionMessage<T = unknown> {
  type: MessageType;
  payload?: T;
}

export interface CaptureStateResponse {
  activeSession: CaptureSession | null;
  status: CaptureStatus;
}

export interface ReprocessPayload {
  sessionId: string;
}

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
    const response = await chrome.runtime.sendMessage({ type, payload });
    return response || { success: false, error: 'No response from service worker' };
  } catch (err: any) {
    return { success: false, error: err.message || 'Failed to send message' };
  }
}
