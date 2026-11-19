/**
 * Zero-PHI MAIN-world passive GraphQL interceptor for go.bandahealth.org.
 * MUST contain ZERO import/export statements so Vite emits a classic browser script.
 */
(function () {
  if ((window as unknown as Record<string, unknown>).__SPHERE_MAIN_INTERCEPTOR__) {
    return;
  }
  (window as unknown as Record<string, unknown>).__SPHERE_MAIN_INTERCEPTOR__ = true;

  const ALLOWED_CATALOG_OPS: Record<string, true> = {
    M_StorageOnHandGet: true,
    M_StorageOnHandForInventoryList: true,
    M_ProductGet: true,
    M_ProductForProductListPage: true,
    M_ProductPriceGet: true,
  };

  const ALLOWED_MUTATION_SIGNALS: Record<string, true> = {
    C_OrderProcess: true,
    M_InOutProcess: true,
    M_InventoryProcess: true,
    M_MovementProcess: true,
    BH_VisitProcess: true,
  };

  function isGraphqlEndpoint(url: string): boolean {
    if (!url) return false;
    return /\/graphql\/?(\?|$)/i.test(url);
  }

  function extractOpName(bodyText: string): string | null {
    try {
      const parsed = JSON.parse(bodyText);
      if (parsed && typeof parsed.operationName === "string" && parsed.operationName) {
        return parsed.operationName;
      }
      if (parsed && typeof parsed.query === "string") {
        const match = parsed.query.match(/(?:query|mutation)\s+([A-Za-z0-9_]+)/);
        if (match && match[1]) return match[1];
      }
    } catch {}
    return null;
  }

  function dispatchCatalogIfAllowed(opName: string | null, data: unknown): void {
    if (!opName || !ALLOWED_CATALOG_OPS[opName]) return;
    if (!data || typeof data !== "object") return;
    window.postMessage(
      {
        source: "SPHERE_BANDAGO_MAIN",
        type: "BANDAGO_PASSIVE_CATALOG",
        operationName: opName,
        payload: data,
      },
      window.location.origin,
    );
  }

  function dispatchMutationSignalIfAllowed(opName: string | null): void {
    if (!opName || !ALLOWED_MUTATION_SIGNALS[opName]) return;
    // Strictly signal-only — zero patient/visit/order body forwarded
    window.postMessage(
      {
        source: "SPHERE_BANDAGO_MAIN",
        type: "BANDAGO_PASSIVE_MUTATION",
        operationName: opName,
      },
      window.location.origin,
    );
  }

  const origFetch = window.fetch;
  if (typeof origFetch === "function") {
    window.fetch = function (input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
      const url = typeof input === "string" ? input : input instanceof Request ? input.url : String(input);
      const bodyStr = typeof init?.body === "string" ? init.body : "";
      const opName = isGraphqlEndpoint(url) ? extractOpName(bodyStr) : null;

      return origFetch.call(this, input, init).then((response) => {
        if (opName && (ALLOWED_CATALOG_OPS[opName] || ALLOWED_MUTATION_SIGNALS[opName]) && response.ok) {
          if (ALLOWED_MUTATION_SIGNALS[opName]) {
            dispatchMutationSignalIfAllowed(opName);
          } else if (ALLOWED_CATALOG_OPS[opName]) {
            response
              .clone()
              .json()
              .then((json) => {
                if (json && json.data) {
                  dispatchCatalogIfAllowed(opName, { data: json.data });
                }
              })
              .catch(() => {});
          }
        }
        return response;
      });
    };
  }

  const XHR = window.XMLHttpRequest;
  if (XHR && XHR.prototype) {
    const origOpen = XHR.prototype.open;
    const origSend = XHR.prototype.send;

    XHR.prototype.open = function (_method: string, url: string | URL) {
      (this as unknown as Record<string, unknown>).__sphereUrl = String(url);
      return origOpen.apply(this, arguments as unknown as Parameters<typeof origOpen>);
    };

    XHR.prototype.send = function (body?: Document | XMLHttpRequestBodyInit | null) {
      const url = String((this as unknown as Record<string, unknown>).__sphereUrl || "");
      const bodyStr = typeof body === "string" ? body : "";
      const opName = isGraphqlEndpoint(url) ? extractOpName(bodyStr) : null;

      if (opName && (ALLOWED_CATALOG_OPS[opName] || ALLOWED_MUTATION_SIGNALS[opName])) {
        this.addEventListener("load", () => {
          if (this.status >= 200 && this.status < 300) {
            if (ALLOWED_MUTATION_SIGNALS[opName]) {
              dispatchMutationSignalIfAllowed(opName);
            } else if (ALLOWED_CATALOG_OPS[opName]) {
              try {
                const json = JSON.parse(this.responseText);
                if (json && json.data) {
                  dispatchCatalogIfAllowed(opName, { data: json.data });
                }
              } catch {}
            }
          }
        });
      }

      return origSend.apply(this, arguments as unknown as [Document | XMLHttpRequestBodyInit | null | undefined]);
    };
  }
})();
