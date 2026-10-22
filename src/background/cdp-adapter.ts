export interface CdpResponseBodyResult {
  body: string;
  base64Encoded: boolean;
}

export const cdpAdapter = {
  async attach(tabId: number): Promise<void> {
    await chrome.debugger.attach({ tabId }, '1.3');
  },

  async enableNetwork(tabId: number): Promise<void> {
    await chrome.debugger.sendCommand({ tabId }, 'Network.enable', {
      maxTotalBufferSize: 100_000_000,
      maxResourceBufferSize: 10_000_000,
    });
  },

  async getResponseBody(tabId: number, requestId: string): Promise<string> {
    const result = (await chrome.debugger.sendCommand(
      { tabId },
      'Network.getResponseBody',
      { requestId }
    )) as CdpResponseBodyResult;

    if (!result || typeof result.body !== 'string') {
      throw new Error('Empty response body returned by debugger');
    }

    if (result.base64Encoded) {
      // Decode base64 to UTF-8
      const binaryString = atob(result.body);
      const bytes = new Uint8Array(binaryString.length);
      for (let i = 0; i < binaryString.length; i++) {
        bytes[i] = binaryString.charCodeAt(i);
      }
      return new TextDecoder('utf-8').decode(bytes);
    }

    return result.body;
  },

  async detach(tabId: number): Promise<void> {
    try {
      await chrome.debugger.detach({ tabId });
    } catch {
      // Ignore if already detached
    }
  },
};
