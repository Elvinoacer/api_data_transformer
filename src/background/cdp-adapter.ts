export interface CdpResponseBodyResult {
  body: string;
  base64Encoded: boolean;
}

export interface DomPaginationResult {
  clicked: boolean;
  label?: string;
  reason?: string;
}

export interface ScrollPaginationResult {
  scrolled: boolean;
  reachedBottom: boolean;
}

export interface RequestMetadata {
  requestId: string;
  url: string;
  method: string;
  postData?: string;
  headers: Record<string, string>;
}

export interface EmittedCdpResponse {
  requestId: string;
  url: string;
  method: string;
  status: number;
  mimeType: string;
  headers?: Record<string, any>;
  postData?: string;
}

interface CachedPayload {
  postData: string;
  timestamp: number;
}

export class CdpNetworkAdapter {
  private requestPayloadMap = new Map<string, CachedPayload>();
  private listeners: ((response: EmittedCdpResponse) => void)[] = [];
  private static inMemoryAuthHeaders = new Map<string, string>();

  /**
   * Retrieves captured BandaGo Bearer Authorization token for origin.
   */
  static async getAuthHeader(
    origin = "https://go.bandahealth.org",
  ): Promise<string | null> {
    try {
      if (typeof chrome !== "undefined" && chrome.storage?.session) {
        const key = `bandago_auth_${origin}`;
        const res = await chrome.storage.session.get([key]);
        if (res && res[key]) return res[key];
      }
    } catch {}
    return this.inMemoryAuthHeaders.get(origin) || null;
  }

  /**
   * Caches BandaGo Bearer Authorization token for origin into chrome.storage.session.
   */
  static async setAuthHeader(
    origin: string,
    authHeader: string,
  ): Promise<void> {
    this.inMemoryAuthHeaders.set(origin, authHeader);
    try {
      if (typeof chrome !== "undefined" && chrome.storage?.session) {
        await chrome.storage.session.set({
          [`bandago_auth_${origin}`]: authHeader,
        });
      }
    } catch {}
  }

  onResponse(listener: (response: EmittedCdpResponse) => void): () => void {
    this.listeners.push(listener);
    return () => {
      this.listeners = this.listeners.filter((l) => l !== listener);
    };
  }

  handleDebuggerEvent(
    _debuggee: chrome.debugger.Debuggee,
    method: string,
    params: any,
  ): void {
    // TTL Eviction: clean up any pending entries older than 60s
    this.pruneStale(60000);

    if (method === "Network.requestWillBeSent") {
      const { requestId, request } = params || {};
      if (requestId && request?.postData) {
        this.requestPayloadMap.set(requestId, {
          postData: request.postData,
          timestamp: Date.now(),
        });
      }

      // Fix 2: Capture Authorization token on /graphql requests
      const url = request?.url || "";
      if (url.includes("/graphql")) {
        const auth =
          request?.headers?.Authorization || request?.headers?.authorization;
        if (auth && typeof auth === "string") {
          try {
            const origin = new URL(url).origin;
            CdpNetworkAdapter.setAuthHeader(origin, auth).catch(() => {});
          } catch {}
        }
      }
    }

    if (method === "Network.responseReceived") {
      const { requestId, response } = params || {};
      if (requestId && response) {
        const postData = this.getRequestPayload(requestId);
        this.emitResponse({
          requestId,
          url: response.url || "",
          method: response.requestMethod || response.method || "GET",
          status: response.status || 200,
          mimeType: response.mimeType || "",
          headers: response.headers,
          postData,
        });
      }
    }

    if (method === "Network.loadingFinished") {
      const { requestId } = params || {};
      if (requestId) {
        this.requestPayloadMap.delete(requestId);
      }
    }

    // Fix 5: Listen for Network.loadingFailed and immediately delete requestId
    if (method === "Network.loadingFailed") {
      const { requestId } = params || {};
      if (requestId) {
        this.requestPayloadMap.delete(requestId);
      }
    }
  }

  emitResponse(response: EmittedCdpResponse): void {
    for (const listener of this.listeners) {
      try {
        listener(response);
      } catch (err) {
        console.error("[CdpNetworkAdapter] Listener error:", err);
      }
    }
  }

  getRequestPayload(requestId: string): string | undefined {
    return this.requestPayloadMap.get(requestId)?.postData;
  }

  /**
   * Prunes request payloads older than the TTL (default 60,000ms)
   */
  pruneStale(ttlMs = 60000): number {
    const now = Date.now();
    let evicted = 0;
    for (const [id, item] of this.requestPayloadMap.entries()) {
      if (now - item.timestamp > ttlMs) {
        this.requestPayloadMap.delete(id);
        evicted++;
      }
    }
    return evicted;
  }

  clear(): void {
    this.requestPayloadMap.clear();
  }
}

export const cdpAdapter = {
  async attach(tabId: number): Promise<void> {
    await chrome.debugger.attach({ tabId }, "1.3");
  },

  async enableNetwork(tabId: number): Promise<void> {
    await chrome.debugger.sendCommand({ tabId }, "Network.enable", {
      maxTotalBufferSize: 100_000_000,
      maxResourceBufferSize: 15_000_000,
    });
  },

  async getResponseBody(tabId: number, requestId: string): Promise<string> {
    const result = (await chrome.debugger.sendCommand(
      { tabId },
      "Network.getResponseBody",
      { requestId },
    )) as CdpResponseBodyResult;

    if (!result || typeof result.body !== "string") {
      throw new Error("Empty response body returned by debugger");
    }

    if (result.base64Encoded) {
      const binaryString = atob(result.body);
      const bytes = new Uint8Array(binaryString.length);
      for (let i = 0; i < binaryString.length; i++) {
        bytes[i] = binaryString.charCodeAt(i);
      }
      return new TextDecoder("utf-8").decode(bytes);
    }

    return result.body;
  },

  /**
   * Locates and activates the "Next Page" / "Load More" control inside the attached target tab.
   */
  async clickNextPageInTab(
    tabId: number,
    customSelector?: string,
  ): Promise<DomPaginationResult> {
    const safeSelectorJson = JSON.stringify(customSelector?.trim() || "");
    const expression = `(() => {
      const customSel = ${safeSelectorJson};
      const isUsable = (el) => {
        if (!el || !(el instanceof HTMLElement)) return false;
        if (el.hasAttribute('disabled') || el.getAttribute('aria-disabled') === 'true') return false;
        if (el.classList.contains('disabled') || el.closest('[aria-disabled="true"], .disabled')) return false;
        const style = window.getComputedStyle(el);
        if (style.display === 'none' || style.visibility === 'hidden' || parseFloat(style.opacity || '1') === 0) return false;
        const rect = el.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      };

      let target = null;
      if (customSel) {
        try {
          const found = document.querySelector(customSel);
          if (isUsable(found)) target = found;
          else return { clicked: false, reason: 'Custom selector element is disabled or not visible' };
        } catch (e) {
          return { clicked: false, reason: 'Invalid CSS selector: ' + customSel };
        }
      }

      if (!target) {
        const directSelectors = [
          'a[rel="next"]',
          'button[rel="next"]',
          '[aria-label*="next page" i]',
          'button[aria-label="Next" i]',
          'a[aria-label="Next" i]',
          '[data-testid*="next" i]'
        ];
        for (const sel of directSelectors) {
          const nodes = Array.from(document.querySelectorAll(sel));
          const valid = nodes.find(isUsable);
          if (valid) { target = valid; break; }
        }
      }

      if (!target) {
        const candidates = Array.from(document.querySelectorAll('button, a, [role="button"]')).filter(isUsable);
        const patterns = [
          /^next\\s*page$/i,
          /^next\\s*[›»→>]?$/i,
          /^load\\s*more/i,
          /^show\\s*more/i,
          /^more\\s*results/i,
          /^[›»→]$/
        ];
        for (const rx of patterns) {
          const match = candidates.find((el) => {
            const txt = (el.innerText || el.textContent || '').replace(/\\s+/g, ' ').trim();
            return txt.length <= 28 && rx.test(txt);
          });
          if (match) { target = match; break; }
        }
      }

      if (!target) {
        const activeCurrent = document.querySelector('[aria-current="page"]');
        if (activeCurrent && activeCurrent.nextElementSibling && isUsable(activeCurrent.nextElementSibling)) {
          target = activeCurrent.nextElementSibling;
        }
      }

      if (!target) {
        return { clicked: false, reason: 'No enabled Next Page or Load More control found on the page.' };
      }

      target.scrollIntoView({ behavior: 'smooth', block: 'center' });
      const label = (target.innerText || target.getAttribute('aria-label') || 'Next').replace(/\\s+/g, ' ').trim().slice(0, 32);
      target.click();
      return { clicked: true, label };
    })()`;

    const evalRes = (await chrome.debugger.sendCommand(
      { tabId },
      "Runtime.evaluate",
      {
        expression,
        returnByValue: true,
        awaitPromise: true,
      },
    )) as any;

    return (
      evalRes?.result?.value || {
        clicked: false,
        reason: "Could not evaluate pagination controls in target tab",
      }
    );
  },

  /**
   * Scrolls the attached target tab downward to trigger infinite-scroll API requests.
   */
  async scrollPageInTab(tabId: number): Promise<ScrollPaginationResult> {
    const expression = `(() => {
      const prevY = window.scrollY;
      const docHeight = Math.max(document.body.scrollHeight, document.documentElement.scrollHeight);
      const step = Math.max(window.innerHeight * 0.85, 600);
      window.scrollBy({ top: step, behavior: 'smooth' });
      const reachedBottom = window.innerHeight + prevY + step >= docHeight - 20;
      return { scrolled: docHeight > window.innerHeight, reachedBottom };
    })()`;

    const evalRes = (await chrome.debugger.sendCommand(
      { tabId },
      "Runtime.evaluate",
      {
        expression,
        returnByValue: true,
      },
    )) as any;

    return evalRes?.result?.value || { scrolled: false, reachedBottom: true };
  },

  /**
   * Triggers an in-tab authenticated GET fetch so the browser's own session cookies are used
   * inside the page without ever exposing credentials to the extension, while CDP captures the response.
   */
  async fetchUrlInTab(
    tabId: number,
    targetUrl: string,
  ): Promise<{ ok: boolean; status?: number; error?: string }> {
    const safeUrl = JSON.stringify(targetUrl);
    const expression = `(async () => {
      try {
        const res = await window.fetch(${safeUrl}, {
          method: 'GET',
          credentials: 'include',
          headers: { 'Accept': 'application/json, text/plain, */*' }
        });
        await res.text();
        return { ok: res.ok, status: res.status };
      } catch (err) {
        return { ok: false, error: err && err.message ? err.message : 'Fetch failed' };
      }
    })()`;

    const evalRes = (await chrome.debugger.sendCommand(
      { tabId },
      "Runtime.evaluate",
      {
        expression,
        returnByValue: true,
        awaitPromise: true,
      },
    )) as any;

    return (
      evalRes?.result?.value || {
        ok: false,
        error: "In-tab fetch evaluation failed",
      }
    );
  },

  async detach(tabId: number): Promise<void> {
    try {
      await chrome.debugger.detach({ tabId });
    } catch {
      // Ignore if already detached
    }
  },

  async getAuthHeader(origin?: string): Promise<string | null> {
    return CdpNetworkAdapter.getAuthHeader(origin);
  },

  async setAuthHeader(origin: string, auth: string): Promise<void> {
    return CdpNetworkAdapter.setAuthHeader(origin, auth);
  },
};
