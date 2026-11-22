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

  const ALLOWED_RESPONSE_ROOT_KEYS: Record<string, true> = {
    M_StorageOnHandGet: true,
    M_ProductGet: true,
    M_ProductPriceGet: true,
    products: true,
  };

  const ALLOWED_MUTATION_SIGNALS: Record<string, true> = {
    C_OrderProcess: true,
    M_InOutProcess: true,
    M_InventoryProcess: true,
    M_MovementProcess: true,
    BH_VisitProcess: true,
  };

  let lastReportedEndpointKey = "";

  function isGraphqlEndpoint(url: string): boolean {
    if (!url) return false;
    return /(?:^|\/)graphql(?:\/|\?|$)/i.test(url);
  }

  function extractSingleOpName(item: unknown): string | null {
    if (!item || typeof item !== "object") return null;
    const obj = item as Record<string, unknown>;
    if (typeof obj.operationName === "string" && obj.operationName) {
      return obj.operationName;
    }
    if (typeof obj.query === "string") {
      const match = obj.query.match(/(?:query|mutation)\s+([A-Za-z0-9_]+)/);
      if (match && match[1]) return match[1];
    }
    return null;
  }

  function inspectGraphqlRequest(bodyText: string): {
    isBatched: boolean;
    hasMutation: boolean;
    mutationOps: string[];
    opNames: string[];
  } {
    const empty = {
      isBatched: false,
      hasMutation: false,
      mutationOps: [] as string[],
      opNames: [] as string[],
    };
    if (!bodyText) return empty;
    try {
      const parsed = JSON.parse(bodyText);
      const isBatched = Array.isArray(parsed);
      const items = isBatched ? parsed : [parsed];
      const opNames: string[] = [];
      const mutationOps: string[] = [];

      for (const item of items) {
        const op = extractSingleOpName(item);
        if (op) {
          opNames.push(op);
          if (ALLOWED_MUTATION_SIGNALS[op]) {
            mutationOps.push(op);
          }
        }
        const queryText =
          item && typeof item === "object" && typeof (item as any).query === "string"
            ? (item as any).query
            : "";
        if (!op && /\bmutation\b/i.test(queryText)) {
          mutationOps.push("GraphQLMutation");
        }
      }
      return {
        isBatched,
        hasMutation: mutationOps.length > 0,
        mutationOps,
        opNames,
      };
    } catch {}
    return empty;
  }

  function notifyDiscoveredEndpoint(url: string, isBatched: boolean): void {
    try {
      const parsed = new URL(url, window.location.origin);
      const safeEndpoint = `${parsed.origin}${parsed.pathname}`;
      const key = `${safeEndpoint}:${isBatched ? "1" : "0"}`;
      if (key === lastReportedEndpointKey) return;
      lastReportedEndpointKey = key;
      if (
        typeof document !== "undefined" &&
        typeof document.dispatchEvent === "function" &&
        typeof CustomEvent === "function"
      ) {
        document.dispatchEvent(
          new CustomEvent("__SPHERE_BANDAGO_ENDPOINT__", {
            detail: { endpointUrl: safeEndpoint, usesBatchArray: isBatched },
          }),
        );
      }
    } catch {}
  }

  function mergeCatalogRootValue(prevVal: any, nextVal: any): any {
    if (!prevVal) return nextVal;
    const prevArr = Array.isArray(prevVal)
      ? prevVal
      : Array.isArray(prevVal.Results)
        ? prevVal.Results
        : Array.isArray(prevVal.results)
          ? prevVal.results
          : null;
    const nextArr = Array.isArray(nextVal)
      ? nextVal
      : Array.isArray(nextVal.Results)
        ? nextVal.Results
        : Array.isArray(nextVal.results)
          ? nextVal.results
          : null;

    if (prevArr && nextArr) {
      if (Array.isArray(prevVal)) {
        return [...prevArr, ...nextArr];
      }
      if (Array.isArray(prevVal.Results)) {
        return {
          ...prevVal,
          PagingInfo: nextVal.PagingInfo || prevVal.PagingInfo,
          Results: [...prevArr, ...nextArr],
        };
      }
      return {
        ...prevVal,
        PagingInfo: nextVal.PagingInfo || prevVal.PagingInfo,
        results: [...prevArr, ...nextArr],
      };
    }
    return nextVal;
  }

  function extractSafeCatalogPayload(
    json: unknown,
    reqOpNames: string[],
  ): { opName: string; data: Record<string, unknown> } | null {
    const envelopes = Array.isArray(json) ? json : [json];
    const filteredData: Record<string, unknown> = {};
    const matchedOps: string[] = [];

    for (let i = 0; i < envelopes.length; i++) {
      const env = envelopes[i];
      if (!env || typeof env !== "object" || !(env as any).data) continue;
      const envData = (env as any).data;
      if (!envData || typeof envData !== "object" || Array.isArray(envData)) continue;

      const opHint = reqOpNames[i];
      for (const rootKey of Object.keys(envData)) {
        if (!ALLOWED_RESPONSE_ROOT_KEYS[rootKey]) continue;
        const val = envData[rootKey];
        if (!val || typeof val !== "object") continue;

        // Skip count-only queries (which have PagingInfo but NO Results array)
        const hasResults =
          Array.isArray(val) ||
          (Array.isArray(val.Results) && val.Results.length > 0) ||
          (Array.isArray(val.results) && val.results.length > 0);
        if (!hasResults) continue;

        filteredData[rootKey] = filteredData[rootKey]
          ? mergeCatalogRootValue(filteredData[rootKey], val)
          : val;
        if (opHint && ALLOWED_CATALOG_OPS[opHint]) {
          matchedOps.push(opHint);
        } else {
          matchedOps.push(rootKey);
        }
      }
    }

    if (Object.keys(filteredData).length === 0) return null;
    const uniqueOps = Array.from(new Set(matchedOps));
    return {
      opName: uniqueOps[0] || "M_ProductGet",
      data: filteredData,
    };
  }

  function dispatchCatalogPayload(opName: string, data: Record<string, unknown>): void {
    window.postMessage(
      {
        source: "SPHERE_BANDAGO_MAIN",
        type: "BANDAGO_PASSIVE_CATALOG",
        operationName: opName,
        payload: { data },
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
      const syncBodyStr = typeof init?.body === "string" ? init.body : "";
      const isGql = isGraphqlEndpoint(url);
      const syncReqInfo = isGql && syncBodyStr ? inspectGraphqlRequest(syncBodyStr) : null;
      const clonedReqPromise =
        isGql &&
        !syncBodyStr &&
        typeof Request !== "undefined" &&
        input instanceof Request &&
        typeof input.clone === "function"
          ? input
              .clone()
              .text()
              .then((txt) => inspectGraphqlRequest(txt))
              .catch(() => null)
          : null;

      return origFetch.call(this, input, init).then((response) => {
        if (isGql && response.ok) {
          if (syncReqInfo) {
            if (syncReqInfo.hasMutation) {
              for (const mOp of syncReqInfo.mutationOps) {
                dispatchMutationSignalIfAllowed(mOp);
              }
            }
          }

          const jsonPromise = response.clone().json().catch(() => null);
          const reqInfoPromise = clonedReqPromise || Promise.resolve(syncReqInfo);

          Promise.all([reqInfoPromise, jsonPromise])
            .then(([resolvedReqInfo, json]) => {
              const info = resolvedReqInfo || inspectGraphqlRequest("");
              if (!syncReqInfo && info.hasMutation) {
                for (const mOp of info.mutationOps) {
                  dispatchMutationSignalIfAllowed(mOp);
                }
              }
              const effectiveIsBatched =
                info.isBatched || Array.isArray(json);
              notifyDiscoveredEndpoint(url, effectiveIsBatched);
              if (!json) return;
              const safeCatalog = extractSafeCatalogPayload(json, info.opNames);
              if (safeCatalog) {
                dispatchCatalogPayload(safeCatalog.opName, safeCatalog.data);
              }
            })
            .catch(() => {});
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
      const isGql = isGraphqlEndpoint(url);
      const reqInfo = isGql ? inspectGraphqlRequest(bodyStr) : null;

      if (isGql && reqInfo) {
        this.addEventListener("load", () => {
          if (this.status >= 200 && this.status < 300) {
            notifyDiscoveredEndpoint(url, reqInfo.isBatched);
            if (reqInfo.hasMutation) {
              for (const mOp of reqInfo.mutationOps) {
                dispatchMutationSignalIfAllowed(mOp);
              }
            }
            try {
              const json = JSON.parse(this.responseText);
              const safeCatalog = extractSafeCatalogPayload(json, reqInfo.opNames);
              if (safeCatalog) {
                dispatchCatalogPayload(safeCatalog.opName, safeCatalog.data);
              }
            } catch {}
          }
        });
      }

      return origSend.apply(this, arguments as unknown as [Document | XMLHttpRequestBodyInit | null | undefined]);
    };
  }
})();
