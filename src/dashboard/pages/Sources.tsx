import React, { useState } from 'react';
import {
  EndpointSource,
  ConsolidationPolicy,
  RawResponse,
} from '../../shared/types';
import { sourceRepo } from '../../data/repositories';
import { findCandidatePaths, DetectedPath } from '../../extraction/path-selector';
import { parseApiJsonBody } from '../../privacy/source-policy';
import { getMissingPages } from '../../extraction/pagination-detector';
import {
  Layers,
  RefreshCw,
  Check,
  X,
  Edit2,
  Tag,
  FastForward,
  Sparkles,
  Database,
} from 'lucide-react';
import { useToast } from '../components/ToastProvider';

interface Props {
  sources: EndpointSource[];
  rawResponses: RawResponse[];
  sessionId?: string;
  canAutoPaginate: boolean;
  onRefreshSources: () => Promise<void>;
  onReprocess: () => Promise<void>;
  onOpenAutoPaginate: (sourceId: string) => void;
  onViewSourceRecords: (sourceId: string) => void;
  isReprocessing: boolean;
}

export const Sources: React.FC<Props> = ({
  sources,
  rawResponses,
  canAutoPaginate,
  onRefreshSources,
  onReprocess,
  onOpenAutoPaginate,
  onViewSourceRecords,
  isReprocessing,
}) => {
  const { notify } = useToast();
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editLabel, setEditLabel] = useState('');
  const [editRecordPath, setEditRecordPath] = useState('');
  const [editIdentityKey, setEditIdentityKey] = useState('');
  const [editPolicy, setEditPolicy] = useState<ConsolidationPolicy>('keep_latest');
  const [detectedPaths, setDetectedPaths] = useState<DetectedPath[]>([]);

  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [quickLabel, setQuickLabel] = useState('');

  const startEdit = (source: EndpointSource) => {
    setEditingId(source.id);
    setEditLabel(source.label);
    setEditRecordPath(source.recordPath);
    setEditIdentityKey(source.identityKeyField);
    setEditPolicy(source.consolidationPolicy);

    // Inspect latest raw response for this source to offer smart candidate paths!
    const sampleRaw = rawResponses.find(
      (r) =>
        r.parseStatus === 'parsed' &&
        r.httpMethod === source.httpMethod &&
        r.normalizedEndpoint === source.normalizedEndpoint
    );
    if (sampleRaw) {
      const parsed = parseApiJsonBody(sampleRaw.responseBody);
      if (parsed.ok) {
        setDetectedPaths(findCandidatePaths(parsed.data));
        return;
      }
    }
    setDetectedPaths([]);
  };

  const saveEdit = async (source: EndpointSource) => {
    const cleanLabel = editLabel.trim() || source.label;
    const pathChanged =
      editRecordPath !== source.recordPath ||
      editIdentityKey !== source.identityKeyField ||
      editPolicy !== source.consolidationPolicy;

    await sourceRepo.updateSource(source.id, {
      label: cleanLabel,
      customLabel: cleanLabel !== source.label ? true : source.customLabel,
      recordPath: editRecordPath.trim() || 'root',
      identityKeyField: editIdentityKey.trim() || 'id',
      consolidationPolicy: editPolicy,
    });
    setEditingId(null);
    await onRefreshSources();

    if (pathChanged) {
      await onReprocess();
      notify({
        title: `Updated "${cleanLabel}" & reprocessed records`,
        description: `Extracted via path "${editRecordPath}" with key "${editIdentityKey}".`,
        variant: 'success',
        actor: 'user',
      });
    } else {
      notify({
        title: `Saved label & configuration for "${cleanLabel}"`,
        variant: 'success',
        actor: 'user',
      });
    }
  };

  const handleQuickRename = async (source: EndpointSource) => {
    const trimmed = quickLabel.trim();
    if (trimmed && trimmed !== source.label) {
      await sourceRepo.renameSource(source.id, trimmed);
      await onRefreshSources();
      notify({
        title: `Renamed dataset to "${trimmed}"`,
        description: 'Exports and filters will now use this label.',
        variant: 'success',
        actor: 'user',
      });
    }
    setRenamingId(null);
  };

  const toggleInclude = async (source: EndpointSource) => {
    const nextIncluded = !source.included;
    await sourceRepo.updateSource(source.id, {
      included: nextIncluded,
    });
    await onRefreshSources();
    await onReprocess();
    notify({
      title: nextIncluded
        ? `Included "${source.label}" in extracted dataset`
        : `Excluded "${source.label}" from dataset`,
      variant: 'info',
      actor: 'user',
    });
  };

  return (
    <div className="space-y-6">
      {/* Header Toolbar */}
      <div className="card-surface bg-white rounded-2xl shadow-card border border-stone-200/90 p-6 flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div>
          <h2 className="text-xl font-extrabold text-obsidian-900 flex items-center gap-2">
            <Layers className="w-5 h-5 text-brand-700" aria-hidden="true" />
            API Datasets & Extraction Rules ({sources.length})
          </h2>
          <p className="text-xs text-stone-600 mt-1">
            Give each API a crystal-clear label (e.g., Customers, Medicines, Orders), verify detected JSON record paths, and track multi-page coverage.
          </p>
        </div>

        <button
          type="button"
          onClick={async () => {
            await onReprocess();
            notify({
              title: 'Reprocessed all stored API responses',
              description: 'Schemas and deduplicated records are up to date.',
              variant: 'success',
              actor: 'user',
            });
          }}
          disabled={isReprocessing || sources.length === 0}
          className="inline-flex items-center gap-2 px-4 py-2 bg-brand-50 hover:bg-brand-100 text-brand-950 text-xs font-bold rounded-xl border border-brand-300 transition disabled:opacity-50"
        >
          <RefreshCw
            className={`w-3.5 h-3.5 text-brand-700 ${isReprocessing ? 'animate-spin' : ''}`}
            aria-hidden="true"
          />
          {isReprocessing ? 'Reprocessing...' : 'Reprocess Stored Responses'}
        </button>
      </div>

      {/* Sources List */}
      {sources.length === 0 ? (
        <div className="card-surface bg-white rounded-2xl shadow-card border border-stone-200/90 p-12 text-center">
          <Layers className="w-10 h-10 text-stone-300 mx-auto mb-3" aria-hidden="true" />
          <h3 className="font-bold text-obsidian-900 mb-1">No API Endpoints Observed Yet</h3>
          <p className="text-xs text-stone-500 max-w-md mx-auto">
            Browse or paginate your target website tab. JSON APIs will be grouped, labeled, and analyzed here automatically.
          </p>
        </div>
      ) : (
        <div className="space-y-4">
          {sources.map((source) => {
            const isEditing = editingId === source.id;
            const isRenaming = renamingId === source.id;
            const pag = source.pagination;
            const missingPages = getMissingPages(pag);

            return (
              <div
                key={source.id}
                className={`card-surface bg-white rounded-2xl shadow-card border transition p-6 ${
                  source.included
                    ? 'border-stone-200/90'
                    : 'border-stone-200 bg-stone-50/70 opacity-75'
                }`}
              >
                <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-4 pb-4 border-b border-stone-100">
                  <div className="space-y-1.5 min-w-0">
                    <div className="flex items-center gap-2.5 flex-wrap">
                      {isRenaming ? (
                        <div className="inline-flex items-center gap-1.5">
                          <label htmlFor={`rename-src-${source.id}`} className="visually-hidden">
                            Dataset label
                          </label>
                          <input
                            id={`rename-src-${source.id}`}
                            type="text"
                            autoFocus
                            value={quickLabel}
                            onChange={(e) => setQuickLabel(e.target.value)}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter') handleQuickRename(source);
                              if (e.key === 'Escape') setRenamingId(null);
                            }}
                            className="px-2.5 py-1 bg-white border border-brand-500 rounded-lg text-xs font-bold text-obsidian-900"
                          />
                          <button
                            type="button"
                            onClick={() => handleQuickRename(source)}
                            aria-label="Save dataset label"
                            className="p-1 bg-brand-400 text-obsidian-950 rounded-md"
                          >
                            <Check className="w-3.5 h-3.5" aria-hidden="true" />
                          </button>
                          <button
                            type="button"
                            onClick={() => setRenamingId(null)}
                            aria-label="Cancel dataset rename"
                            className="p-1 bg-stone-100 text-stone-600 rounded-md"
                          >
                            <X className="w-3.5 h-3.5" aria-hidden="true" />
                          </button>
                        </div>
                      ) : (
                        <div className="inline-flex items-center gap-1.5">
                          <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-lg text-xs font-extrabold bg-brand-100 text-brand-950 border border-brand-300">
                            <Tag className="w-3 h-3 text-brand-700" aria-hidden="true" />
                            {source.label}
                          </span>
                          <button
                            type="button"
                            onClick={() => {
                              setRenamingId(source.id);
                              setQuickLabel(source.label);
                            }}
                            aria-label={`Rename ${source.label} dataset`}
                            className="p-1 text-stone-400 hover:text-obsidian-900 rounded-md hover:bg-stone-100 transition"
                          >
                            <Edit2 className="w-3.5 h-3.5" aria-hidden="true" />
                          </button>
                        </div>
                      )}

                      <span className="px-2 py-0.5 rounded-md text-[11px] font-mono font-bold bg-obsidian-900 text-brand-300">
                        {source.httpMethod}
                      </span>
                      <h3 className="text-xs sm:text-sm font-mono font-semibold text-stone-700 break-all">
                        {source.normalizedEndpoint}
                      </h3>
                    </div>

                    <div className="flex flex-wrap items-center gap-3 text-xs text-stone-500">
                      <span className="tabular-nums">
                        Observed: <strong className="text-obsidian-900">{source.observedCount}</strong> response(s)
                      </span>
                      <span>•</span>
                      <span className="tabular-nums">
                        Last seen: {new Date(source.lastObservedAt).toLocaleTimeString()}
                      </span>
                      {pag && (pag.totalPages || pag.totalRecords) && (
                        <>
                          <span>•</span>
                          <span className="font-semibold text-brand-800 tabular-nums">
                            {pag.totalPages
                              ? `Pages: ${pag.observedPages.join(', ') || '1'} of ${pag.totalPages}`
                              : `${pag.totalRecords} total items reported`}
                          </span>
                        </>
                      )}
                    </div>
                  </div>

                  <div className="flex items-center gap-2 flex-wrap">
                    <button
                      type="button"
                      onClick={() => onViewSourceRecords(source.id)}
                      className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-white hover:bg-stone-50 text-obsidian-900 border border-stone-200 text-xs font-semibold rounded-xl transition"
                    >
                      <Database className="w-3.5 h-3.5 text-brand-700" aria-hidden="true" />
                      Records
                    </button>

                    {(missingPages.length > 0 || pag?.hasNextPage) && canAutoPaginate && (
                      <button
                        type="button"
                        onClick={() => onOpenAutoPaginate(source.id)}
                        className="btn-lime inline-flex items-center gap-1.5 px-3 py-1.5 bg-brand-400 hover:bg-brand-300 text-obsidian-950 border border-brand-500 text-xs font-bold rounded-xl transition"
                      >
                        <FastForward className="w-3.5 h-3.5" aria-hidden="true" />
                        Fetch Pages
                      </button>
                    )}

                    <button
                      type="button"
                      aria-pressed={source.included}
                      onClick={() => toggleInclude(source)}
                      className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-bold transition border ${
                        source.included
                          ? 'bg-brand-50 text-brand-900 border-brand-300 hover:bg-brand-100'
                          : 'bg-stone-100 text-stone-600 border-stone-300 hover:bg-stone-200'
                      }`}
                    >
                      {source.included ? (
                        <Check className="w-3.5 h-3.5 text-brand-700" aria-hidden="true" />
                      ) : (
                        <X className="w-3.5 h-3.5" aria-hidden="true" />
                      )}
                      {source.included ? 'Included' : 'Excluded'}
                    </button>

                    {!isEditing && (
                      <button
                        type="button"
                        onClick={() => startEdit(source)}
                        className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-stone-100 hover:bg-stone-200 text-obsidian-900 text-xs font-semibold rounded-xl transition"
                      >
                        <Edit2 className="w-3.5 h-3.5" aria-hidden="true" /> Extraction Rules
                      </button>
                    )}
                  </div>
                </div>

                {/* Configuration Drawer */}
                {isEditing ? (
                  <div className="pt-4 grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4 bg-stone-50 p-4 rounded-xl mt-4 border border-stone-200">
                    <div>
                      <label
                        htmlFor={`label-input-${source.id}`}
                        className="block text-xs font-bold text-obsidian-900 mb-1"
                      >
                        Dataset Label (Export Name)
                      </label>
                      <input
                        id={`label-input-${source.id}`}
                        type="text"
                        value={editLabel}
                        onChange={(e) => setEditLabel(e.target.value)}
                        placeholder="e.g. Customers, Medicines"
                        className="w-full px-3 py-1.5 bg-white border border-stone-300 rounded-lg text-xs font-semibold text-obsidian-900"
                      />
                    </div>

                    <div>
                      <label
                        htmlFor={`path-input-${source.id}`}
                        className="block text-xs font-bold text-obsidian-900 mb-1"
                      >
                        Record Collection JSON Path
                      </label>
                      <input
                        id={`path-input-${source.id}`}
                        type="text"
                        value={editRecordPath}
                        onChange={(e) => setEditRecordPath(e.target.value)}
                        placeholder="e.g. data.items, results, root, single_object"
                        className="w-full px-3 py-1.5 bg-white border border-stone-300 rounded-lg text-xs font-mono text-obsidian-900"
                      />
                      <div className="mt-1.5 flex flex-wrap gap-1">
                        {(detectedPaths.length > 0
                          ? detectedPaths.map((d) => ({ path: d.path, tag: `${d.path} (${d.count})` }))
                          : ['root', 'data', 'results', 'data.items', 'single_object'].map((p) => ({
                              path: p,
                              tag: p,
                            }))
                        ).map((cand) => (
                          <button
                            key={cand.path}
                            type="button"
                            onClick={() => setEditRecordPath(cand.path)}
                            className={`text-[10px] px-1.5 py-0.5 rounded font-mono font-semibold border transition ${
                              editRecordPath === cand.path
                                ? 'bg-brand-200 border-brand-500 text-obsidian-950'
                                : 'bg-white hover:bg-stone-100 border-stone-300 text-stone-700'
                            }`}
                          >
                            {detectedPaths.length > 0 && (
                              <Sparkles className="w-2.5 h-2.5 inline mr-0.5 text-brand-700" aria-hidden="true" />
                            )}
                            {cand.tag}
                          </button>
                        ))}
                      </div>
                    </div>

                    <div>
                      <label
                        htmlFor={`key-input-${source.id}`}
                        className="block text-xs font-bold text-obsidian-900 mb-1"
                      >
                        Unique Identity Key
                      </label>
                      <input
                        id={`key-input-${source.id}`}
                        type="text"
                        value={editIdentityKey}
                        onChange={(e) => setEditIdentityKey(e.target.value)}
                        placeholder="e.g. id, customerId, sku, __hash__"
                        className="w-full px-3 py-1.5 bg-white border border-stone-300 rounded-lg text-xs font-mono text-obsidian-900"
                      />
                      <div className="mt-1.5 flex flex-wrap gap-1">
                        {['id', '_id', 'uuid', 'sku', 'code', '__hash__'].map((k) => (
                          <button
                            key={k}
                            type="button"
                            onClick={() => setEditIdentityKey(k)}
                            className="text-[10px] bg-white hover:bg-stone-100 border border-stone-300 px-1.5 py-0.5 rounded font-mono text-stone-700"
                          >
                            {k}
                          </button>
                        ))}
                      </div>
                    </div>

                    <div className="flex flex-col justify-between">
                      <div>
                        <label
                          htmlFor={`policy-select-${source.id}`}
                          className="block text-xs font-bold text-obsidian-900 mb-1"
                        >
                          Deduplication Policy
                        </label>
                        <select
                          id={`policy-select-${source.id}`}
                          value={editPolicy}
                          onChange={(e) => setEditPolicy(e.target.value as ConsolidationPolicy)}
                          className="w-full px-3 py-1.5 bg-white border border-stone-300 rounded-lg text-xs font-medium text-obsidian-900"
                        >
                          <option value="keep_latest">Keep Latest (Update duplicates)</option>
                          <option value="keep_first">Keep First (Ignore duplicates)</option>
                          <option value="keep_all">Keep All Versions</option>
                        </select>
                      </div>

                      <div className="mt-3 flex items-center justify-end gap-2">
                        <button
                          type="button"
                          onClick={() => setEditingId(null)}
                          className="px-3 py-1.5 bg-white border border-stone-300 hover:bg-stone-50 text-xs font-semibold text-stone-700 rounded-lg"
                        >
                          Cancel
                        </button>
                        <button
                          type="button"
                          onClick={() => saveEdit(source)}
                          className="btn-lime px-3.5 py-1.5 bg-brand-400 hover:bg-brand-300 border border-brand-500 text-xs font-bold text-obsidian-950 rounded-lg"
                        >
                          Apply & Reprocess
                        </button>
                      </div>
                    </div>
                  </div>
                ) : (
                  <div className="pt-4 grid grid-cols-1 sm:grid-cols-3 gap-4 text-xs">
                    <div>
                      <span className="text-stone-400 font-medium block mb-0.5">Extraction Path</span>
                      <code className="bg-brand-50 border border-brand-200 px-2 py-0.5 rounded text-brand-900 font-bold font-mono">
                        {source.recordPath}
                      </code>
                    </div>
                    <div>
                      <span className="text-stone-400 font-medium block mb-0.5">Identity Key</span>
                      <code className="bg-stone-100 border border-stone-200 px-2 py-0.5 rounded text-obsidian-900 font-bold font-mono">
                        {source.identityKeyField}
                      </code>
                    </div>
                    <div>
                      <span className="text-stone-400 font-medium block mb-0.5">Deduplication</span>
                      <span className="font-bold capitalize text-obsidian-900">
                        {source.consolidationPolicy.replace('_', ' ')}
                      </span>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
};
