export interface TabInfo {
  id: number;
  title: string;
  url: string;
  favIconUrl?: string;
  hostname: string;
}

export const tabManager = {
  /**
   * Returns all eligible HTTP/HTTPS browser tabs for selection.
   */
  async getSelectableTabs(): Promise<TabInfo[]> {
    const tabs = await chrome.tabs.query({});
    const selectable: TabInfo[] = [];

    for (const tab of tabs) {
      if (!tab.id || !tab.url) continue;

      try {
        const parsed = new URL(tab.url);
        if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
          selectable.push({
            id: tab.id,
            title: tab.title || tab.url,
            url: tab.url,
            favIconUrl: tab.favIconUrl,
            hostname: parsed.hostname,
          });
        }
      } catch {
        // Skip invalid URL
      }
    }

    return selectable;
  },

  async openWebsiteInNewTab(urlStr: string): Promise<TabInfo | null> {
    try {
      const tab = await chrome.tabs.create({ url: urlStr });
      if (!tab.id) return null;
      const parsed = new URL(urlStr);
      return {
        id: tab.id,
        title: tab.title || urlStr,
        url: urlStr,
        hostname: parsed.hostname,
      };
    } catch {
      return null;
    }
  },
};
