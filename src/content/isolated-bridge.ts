/**
 * Zero-PHI ISOLATED-world relay bridging validated BandaGo catalog updates & mutation
 * signals to the Chrome extension background service worker.
 * MUST contain ZERO import/export statements so Vite emits a classic browser script.
 */
(function () {
  if ((window as unknown as Record<string, unknown>).__SPHERE_ISOLATED_BRIDGE__) {
    return;
  }
  (window as unknown as Record<string, unknown>).__SPHERE_ISOLATED_BRIDGE__ = true;

  window.addEventListener("message", (event: MessageEvent) => {
    if (event.source !== window) return;
    if (event.origin !== window.location.origin) return;
    const msg = event.data;
    if (!msg || typeof msg !== "object" || msg.source !== "SPHERE_BANDAGO_MAIN") {
      return;
    }

    if (msg.type === "BANDAGO_PASSIVE_CATALOG" && msg.payload) {
      try {
        chrome.runtime
          .sendMessage({
            type: "BANDAGO_PASSIVE_CATALOG",
            operationName: msg.operationName,
            payload: msg.payload,
          })
          .catch(() => {});
      } catch {}
    } else if (msg.type === "BANDAGO_PASSIVE_MUTATION" && msg.operationName) {
      try {
        chrome.runtime
          .sendMessage({
            type: "BANDAGO_PASSIVE_MUTATION",
            operationName: msg.operationName,
          })
          .catch(() => {});
      } catch {}
    }
  });

  if (typeof document !== "undefined" && typeof document.addEventListener === "function") {
    document.addEventListener("__SPHERE_BANDAGO_ENDPOINT__", (event: Event) => {
      const custom = event as CustomEvent<{
        endpointUrl?: string;
        usesBatchArray?: boolean;
      }>;
      const endpointUrl = custom?.detail?.endpointUrl;
      if (typeof endpointUrl !== "string" || !endpointUrl) return;
      try {
        chrome.runtime
          .sendMessage({
            type: "BANDAGO_DISCOVERED_ENDPOINT",
            payload: {
              endpointUrl,
              usesBatchArray: Boolean(custom.detail?.usesBatchArray),
            },
          })
          .catch(() => {});
      } catch {}
    });
  }
})();
