import React, { useState, useEffect } from 'react';
import { tabManager, TabInfo } from '../../background/tab-manager';
import { ScopeMode } from '../../shared/types';
import { ModalDialog } from './ModalDialog';
import { Globe, ExternalLink, ShieldCheck, Check, RefreshCw, Sparkles } from 'lucide-react';

interface Props {
  isOpen: boolean;
  onClose: () => void;
  onSelectTab: (
    tabId: number,
    url: string,
    allowedHostnames: string[],
    scopeMode: ScopeMode,
    sessionLabel?: string
  ) => void;
}

export const TabPickerModal: React.FC<Props> = ({ isOpen, onClose, onSelectTab }) => {
  const [tabs, setTabs] = useState<TabInfo[]>([]);
  const [selectedTabId, setSelectedTabId] = useState<number | null>(null);
  const [scopeMode, setScopeMode] = useState<ScopeMode>('all_tab_apis');
  const [sessionLabel, setSessionLabel] = useState('');
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
        if (selectable.length > 0) {
          const initial = selectable.find((t) => t.id === selectedTabId) || selectable[0];
          setSelectedTabId(initial.id);
          if (!sessionLabel) {
            setSessionLabel(initial.title?.slice(0, 40) || `${initial.hostname} capture`);
          }
        }
      } else {
        const demoTab: TabInfo = {
          id: 101,
          title: 'Multi-API Catalog Sandbox — Live Demo Target',
          url: 'http://localhost:5173/demo.html',
          hostname: 'localhost',
        };
        setTabs([demoTab]);
        setSelectedTabId(101);
        if (!sessionLabel) setSessionLabel('Demo Multi-API Catalog');
      }
    } catch (err: any) {
      setError(err.message || 'Could not load open browser tabs');
    } finally {
      setLoading(false);
    }
  };

  const handleSelectRow = (tab: TabInfo) => {
    setSelectedTabId(tab.id);
    setSessionLabel(tab.title?.slice(0, 42) || `${tab.hostname} capture`);
  };

  const handleOpenNewTab = async () => {
    if (!customUrl.trim()) return;
    setError('');
    try {
      let formatted = customUrl.trim();
      if (formatted.startsWith('/')) {
        formatted = `${window.location.origin}${formatted}`;
      } else if (!formatted.startsWith('http://') && !formatted.startsWith('https://')) {
        formatted = `https://${formatted}`;
      }
      const newTab = await tabManager.openWebsiteInNewTab(formatted);
      if (newTab) {
        await loadTabs();
        setSelectedTabId(newTab.id);
        setSessionLabel(`${newTab.hostname} capture`);
        setCustomUrl('');
      }
    } catch (err: any) {
      setError(err.message || 'Failed to open URL in new tab');
    }
  };

  const handleConfirm = () => {
    const selected = tabs.find((t) => t.id === selectedTabId);
    if (!selected) return;

    const allowed = [selected.hostname];
    onSelectTab(
      selected.id,
      selected.url,
      allowed,
      scopeMode,
      sessionLabel.trim() || `${selected.hostname} capture`
    );
    onClose();
  };

  return (
    <ModalDialog
      isOpen={isOpen}
      onClose={onClose}
      title="Start Live API Capture Session"
      subtitle="Select the website tab you want to observe. You browse normally while JSON API responses are extracted and labeled."
      maxWidthClass="max-w-2xl"
      headerActions={
        <button
          type="button"
          onClick={loadTabs}
          aria-label="Refresh open browser tabs"
          className="p-1.5 text-stone-500 hover:text-obsidian-900 rounded-lg hover:bg-stone-200/60 transition"
        >
          <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} aria-hidden="true" />
        </button>
      }
      footer={
        <>
          <button
            type="button"
            onClick={onClose}
            className="px-4 py-2 text-xs font-semibold text-stone-700 bg-white border border-stone-300 hover:bg-stone-50 rounded-xl transition"
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={!selectedTabId}
            onClick={handleConfirm}
            className="btn-lime px-5 py-2 bg-brand-400 hover:bg-brand-300 disabled:opacity-50 text-obsidian-950 border border-brand-500 text-xs font-bold rounded-xl shadow-lime-glow transition"
          >
            Attach & Start Capture
          </button>
        </>
      }
    >
      <div className="p-6 space-y-5">
        {error && (
          <div role="alert" className="p-3 bg-rose-50 border border-rose-200 rounded-xl text-xs text-rose-800 font-medium">
            {error}
          </div>
        )}

        {/* Privacy & Local-First Assurance */}
        <div className="p-3.5 bg-brand-50/70 border border-brand-200 rounded-xl flex gap-3 text-xs text-brand-950">
          <ShieldCheck className="w-5 h-5 text-brand-700 flex-shrink-0 mt-0.5" aria-hidden="true" />
          <div>
            <p className="font-bold mb-0.5">Local-First Tab Observation</p>
            <p className="text-stone-700 leading-relaxed">
              Observes JSON API responses only from the single tab you select. Passwords, cookies, and Authorization headers are never read or uploaded.
            </p>
          </div>
        </div>

        {/* 1. Open Browser Tabs */}
        <div>
          <span className="block text-xs font-bold text-obsidian-900 mb-2">
            1. Choose Open Browser Tab ({tabs.length})
          </span>
          {loading ? (
            <div className="text-xs text-stone-500 py-6 text-center bg-stone-50 rounded-xl border border-stone-200">
              Scanning open HTTP/HTTPS tabs...
            </div>
          ) : tabs.length === 0 ? (
            <div className="text-xs text-stone-500 py-6 text-center bg-stone-50 rounded-xl border border-stone-200">
              No HTTP/HTTPS tabs open yet. Open a target website below to begin.
            </div>
          ) : (
            <div className="space-y-2 max-h-52 overflow-y-auto pr-1">
              {tabs.map((tab) => {
                const isSelected = tab.id === selectedTabId;
                return (
                  <button
                    key={tab.id}
                    type="button"
                    onClick={() => handleSelectRow(tab)}
                    aria-pressed={isSelected}
                    className={`w-full text-left p-3 rounded-xl border flex items-center justify-between transition ${
                      isSelected
                        ? 'border-brand-600 bg-brand-50/80 ring-1 ring-brand-600 shadow-xs'
                        : 'border-stone-200 hover:border-stone-300 hover:bg-stone-50 bg-white'
                    }`}
                  >
                    <div className="flex items-center gap-3 min-w-0 pr-3">
                      {tab.favIconUrl ? (
                        <img src={tab.favIconUrl} alt="" className="w-4 h-4 rounded-sm flex-shrink-0" />
                      ) : (
                        <Globe
                          className={`w-4 h-4 flex-shrink-0 ${
                            isSelected ? 'text-brand-700' : 'text-stone-400'
                          }`}
                          aria-hidden="true"
                        />
                      )}
                      <div className="min-w-0">
                        <p className="text-xs font-bold text-obsidian-900 truncate">
                          {tab.title}
                        </p>
                        <p className="text-[11px] text-stone-500 truncate font-mono">{tab.url}</p>
                      </div>
                    </div>
                    <div className="flex-shrink-0">
                      {isSelected && (
                        <span className="w-5 h-5 rounded-full bg-brand-500 text-obsidian-950 flex items-center justify-center">
                          <Check className="w-3.5 h-3.5 stroke-[2.5]" aria-hidden="true" />
                        </span>
                      )}
                    </div>
                  </button>
                );
              })}
            </div>
          )}
        </div>

        {/* 2. API Detection Scope & Session Label */}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 pt-2 border-t border-stone-100">
          <div>
            <label
              htmlFor="session-scope-select"
              className="block text-xs font-bold text-obsidian-900 mb-1"
            >
              2. API Host Scope
            </label>
            <select
              id="session-scope-select"
              value={scopeMode}
              onChange={(e) => setScopeMode(e.target.value as ScopeMode)}
              className="w-full px-3 py-2 bg-stone-50 border border-stone-300 rounded-xl text-xs font-semibold text-obsidian-900"
            >
              <option value="all_tab_apis">
                All JSON APIs Called by Tab (Recommended)
              </option>
              <option value="same_domain">
                Same Root Domain & Subdomains (e.g. api.*)
              </option>
              <option value="selected_hosts">Strict Tab Hostname Only</option>
            </select>
            <p className="text-[11px] text-stone-500 mt-1 flex items-center gap-1">
              <Sparkles className="w-3 h-3 text-brand-700 flex-shrink-0" aria-hidden="true" />
              Captures cross-domain API backends while blocking analytics noise.
            </p>
          </div>

          <div>
            <label
              htmlFor="session-custom-label"
              className="block text-xs font-bold text-obsidian-900 mb-1"
            >
              3. Session Label
            </label>
            <input
              id="session-custom-label"
              type="text"
              value={sessionLabel}
              onChange={(e) => setSessionLabel(e.target.value)}
              placeholder="e.g. Pharmacy Inventory & Customers"
              className="w-full px-3 py-2 bg-stone-50 border border-stone-300 rounded-xl text-xs font-medium text-obsidian-900 focus:bg-white"
            />
          </div>
        </div>

        {/* 3. Open New URL Helper */}
        <div className="pt-2 border-t border-stone-100">
          <label
            htmlFor="open-new-tab-url"
            className="block text-xs font-bold text-obsidian-900 mb-1.5"
          >
            Or Open a Website URL in a New Tab
          </label>
          <div className="flex gap-2">
            <input
              id="open-new-tab-url"
              type="text"
              placeholder="https://example.com/catalog or /demo.html"
              value={customUrl}
              onChange={(e) => setCustomUrl(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  handleOpenNewTab();
                }
              }}
              className="flex-1 px-3 py-2 bg-stone-50 border border-stone-300 rounded-xl text-xs font-mono text-obsidian-900 focus:bg-white"
            />
            <button
              type="button"
              onClick={handleOpenNewTab}
              className="px-3.5 py-2 bg-stone-100 hover:bg-stone-200 text-obsidian-900 border border-stone-300 text-xs font-semibold rounded-xl inline-flex items-center gap-1.5 transition"
            >
              <ExternalLink className="w-3.5 h-3.5" aria-hidden="true" />
              Open Tab
            </button>
          </div>
        </div>
      </div>
    </ModalDialog>
  );
};
