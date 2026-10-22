import React, { useState, useEffect } from 'react';
import { tabManager, TabInfo } from '../../background/tab-manager';
import { X, Globe, ExternalLink, ShieldAlert, Check } from 'lucide-react';

interface Props {
  isOpen: boolean;
  onClose: () => void;
  onSelectTab: (tabId: number, url: string, allowedHostnames: string[]) => void;
}

export const TabPickerModal: React.FC<Props> = ({ isOpen, onClose, onSelectTab }) => {
  const [tabs, setTabs] = useState<TabInfo[]>([]);
  const [selectedTabId, setSelectedTabId] = useState<number | null>(null);
  const [customUrl, setCustomUrl] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (isOpen) {
      loadTabs();
    }
  }, [isOpen]);

  const loadTabs = async () => {
    setLoading(true);
    setError('');
    try {
      if (typeof chrome !== 'undefined' && chrome.tabs) {
        const selectable = await tabManager.getSelectableTabs();
        setTabs(selectable);
        if (selectable.length > 0 && selectedTabId === null) {
          setSelectedTabId(selectable[0].id);
        }
      } else {
        // Fallback demo mock
        setTabs([
          {
            id: 101,
            title: 'Medication Catalog — Live API Demo Target',
            url: 'http://localhost:5173/demo.html',
            hostname: 'localhost',
          },
        ]);
        setSelectedTabId(101);
      }
    } catch (err: any) {
      setError(err.message || 'Could not load open tabs');
    } finally {
      setLoading(false);
    }
  };

  const handleOpenNewTab = async () => {
    if (!customUrl) return;
    try {
      let formatted = customUrl;
      if (!formatted.startsWith('http://') && !formatted.startsWith('https://')) {
        formatted = `https://${formatted}`;
      }
      const newTab = await tabManager.openWebsiteInNewTab(formatted);
      if (newTab) {
        await loadTabs();
        setSelectedTabId(newTab.id);
      }
    } catch (err: any) {
      setError(err.message || 'Failed to open new tab');
    }
  };

  const handleConfirm = () => {
    const selected = tabs.find((t) => t.id === selectedTabId);
    if (!selected) return;

    const allowed = [selected.hostname];
    onSelectTab(selected.id, selected.url, allowed);
    onClose();
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 backdrop-blur-sm p-4">
      <div className="bg-white rounded-xl shadow-xl border border-slate-200 w-full max-w-2xl overflow-hidden flex flex-col">
        {/* Header */}
        <div className="px-6 py-4 border-b border-slate-200 flex items-center justify-between bg-slate-50">
          <div>
            <h3 className="font-bold text-slate-800 text-lg">Select Browser Tab to Capture</h3>
            <p className="text-xs text-slate-500">
              Choose an open website tab. The extension will observe JSON responses in that tab.
            </p>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 text-slate-400 hover:text-slate-600 rounded-lg hover:bg-slate-200/60"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Security Notice */}
        {error && (
          <div className="mx-6 mt-4 p-3 bg-red-50 border border-red-200 rounded-lg text-xs text-red-700">
            {error}
          </div>
        )}
        <div className="mx-6 mt-4 p-3 bg-amber-50 border border-amber-200 rounded-lg flex gap-3 text-xs text-amber-800">
          <ShieldAlert className="w-5 h-5 text-amber-600 flex-shrink-0" />
          <div>
            <p className="font-semibold mb-0.5">Chrome Debugger Permission</p>
            <p>
              Attaching enables network observation only for the selected tab. Your session stays on your machine and credentials are not saved.
            </p>
          </div>
        </div>

        {/* Tabs List */}
        <div className="p-6 space-y-4 max-h-[50vh] overflow-y-auto">
          <div>
            <label className="block text-xs font-semibold text-slate-700 uppercase tracking-wider mb-2">
              Open Website Tabs
            </label>
            {loading ? (
              <div className="text-sm text-slate-500 py-4 text-center">Loading browser tabs...</div>
            ) : tabs.length === 0 ? (
              <div className="text-sm text-slate-500 py-4 text-center">
                No eligible HTTP/HTTPS tabs found. Open a website or enter a URL below.
              </div>
            ) : (
              <div className="space-y-2">
                {tabs.map((tab) => {
                  const isSelected = tab.id === selectedTabId;
                  return (
                    <div
                      key={tab.id}
                      onClick={() => setSelectedTabId(tab.id)}
                      className={`p-3 rounded-lg border cursor-pointer flex items-center justify-between transition ${
                        isSelected
                          ? 'border-indigo-600 bg-indigo-50/50 shadow-sm'
                          : 'border-slate-200 hover:border-slate-300 hover:bg-slate-50'
                      }`}
                    >
                      <div className="flex items-center gap-3 truncate pr-4">
                        <Globe className={`w-4 h-4 flex-shrink-0 ${isSelected ? 'text-indigo-600' : 'text-slate-400'}`} />
                        <div className="truncate">
                          <p className={`text-sm font-medium truncate ${isSelected ? 'text-indigo-900' : 'text-slate-800'}`}>
                            {tab.title}
                          </p>
                          <p className="text-xs text-slate-500 truncate font-mono">{tab.url}</p>
                        </div>
                      </div>
                      <div className="flex-shrink-0">
                        {isSelected && (
                          <div className="w-6 h-6 rounded-full bg-indigo-600 text-white flex items-center justify-center">
                            <Check className="w-4 h-4" />
                          </div>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          {/* Open New URL input */}
          <div className="pt-2 border-t border-slate-100">
            <label className="block text-xs font-semibold text-slate-700 uppercase tracking-wider mb-2">
              Or Open Website in New Tab
            </label>
            <div className="flex gap-2">
              <input
                type="text"
                placeholder="https://example.com/catalog or /demo.html"
                value={customUrl}
                onChange={(e) => setCustomUrl(e.target.value)}
                className="flex-1 px-3 py-2 bg-slate-50 border border-slate-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:bg-white"
              />
              <button
                type="button"
                onClick={handleOpenNewTab}
                className="px-3 py-2 bg-slate-100 hover:bg-slate-200 text-slate-700 text-xs font-semibold rounded-lg inline-flex items-center gap-1.5 transition"
              >
                <ExternalLink className="w-3.5 h-3.5" />
                Open Tab
              </button>
            </div>
          </div>
        </div>

        {/* Footer */}
        <div className="px-6 py-4 border-t border-slate-200 bg-slate-50 flex items-center justify-end gap-3">
          <button
            onClick={onClose}
            className="px-4 py-2 text-sm font-medium text-slate-600 hover:text-slate-800 transition"
          >
            Cancel
          </button>
          <button
            disabled={!selectedTabId}
            onClick={handleConfirm}
            className="px-5 py-2 bg-indigo-600 hover:bg-indigo-700 disabled:opacity-50 text-white text-sm font-semibold rounded-lg shadow-sm transition"
          >
            Start Capture
          </button>
        </div>
      </div>
    </div>
  );
};
