import React, { useState, useEffect, useId, useMemo } from 'react';
import { EndpointSchema, EndpointSource } from '../../shared/types';
import {
  ArrowUpDown,
  AlertCircle,
  CheckCircle2,
  Layers,
  Search,
  Tag,
} from 'lucide-react';
import { formatColumnHeader } from '../../extraction/flatten';

interface Props {
  schemas: EndpointSchema[];
  sources: EndpointSource[];
}

export const Schemas: React.FC<Props> = ({ schemas, sources }) => {
  const [selectedSourceId, setSelectedSourceId] = useState<string>(
    schemas[0]?.sourceId || sources[0]?.id || ''
  );
  const [fieldQuery, setFieldQuery] = useState('');
  const captionId = useId();

  useEffect(() => {
    if (!selectedSourceId && (schemas[0]?.sourceId || sources[0]?.id)) {
      setSelectedSourceId(schemas[0]?.sourceId || sources[0]?.id || '');
    }
  }, [schemas, sources, selectedSourceId]);

  const activeSchema =
    schemas.find((s) => s.sourceId === selectedSourceId) || schemas[0];
  const activeSource = sources.find(
    (s) => s.id === (activeSchema?.sourceId || selectedSourceId)
  );

  const allFields = useMemo(
    () => (activeSchema ? Object.values(activeSchema.fields) : []),
    [activeSchema]
  );

  const filteredFields = useMemo(() => {
    if (!fieldQuery.trim()) return allFields;
    const q = fieldQuery.toLowerCase();
    return allFields.filter(
      (f) =>
        f.path.toLowerCase().includes(q) ||
        f.types.some((t) => t.toLowerCase().includes(q)) ||
        f.sampleValues.some((v) => String(v).toLowerCase().includes(q))
    );
  }, [allFields, fieldQuery]);

  const conflictCount = useMemo(
    () => allFields.filter((f) => f.hasConflict).length,
    [allFields]
  );

  return (
    <div className="space-y-6">
      {/* Schemas Header & Dataset Selector */}
      <div className="bg-white rounded-2xl shadow-xs border border-stone-200 p-6 flex flex-col lg:flex-row lg:items-center justify-between gap-4">
        <div>
          <h2 className="text-xl font-bold text-stone-900 flex items-center gap-2.5">
            <span className="w-8 h-8 rounded-xl bg-brand-100 border border-brand-300 text-brand-800 flex items-center justify-center">
              <ArrowUpDown className="w-4 h-4" aria-hidden="true" />
            </span>
            Schema Inference & Field Discovery
          </h2>
          <p className="text-xs text-stone-500 mt-1">
            Inspect inferred field paths, data types, nullability, and cross-page schema drift per API dataset.
          </p>
        </div>

        {sources.length > 0 && (
          <div className="flex flex-wrap items-center gap-2">
            <label
              htmlFor="schema-dataset-select"
              className="text-xs font-semibold text-stone-600 flex items-center gap-1"
            >
              <Tag className="w-3.5 h-3.5 text-brand-700" aria-hidden="true" />
              API Dataset:
            </label>
            <select
              id="schema-dataset-select"
              value={activeSource?.id || selectedSourceId}
              onChange={(e) => setSelectedSourceId(e.target.value)}
              className="px-3 py-2 bg-stone-50 border border-stone-300 rounded-xl text-xs font-semibold text-stone-800 focus:outline-none focus:border-brand-600"
            >
              {sources.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.label} — {s.httpMethod} {s.normalizedEndpoint.replace(/^https?:\/\/[^/]+/, '')}
                </option>
              ))}
            </select>
          </div>
        )}
      </div>

      {/* Quick Dataset Switcher Pills */}
      {sources.length > 1 && (
        <div className="flex flex-wrap gap-2" role="tablist" aria-label="API Dataset Schemas">
          {sources.map((s) => {
            const isActive = (activeSource?.id || selectedSourceId) === s.id;
            const schemaForSource = schemas.find((sc) => sc.sourceId === s.id);
            const count = schemaForSource ? Object.keys(schemaForSource.fields).length : 0;
            return (
              <button
                key={s.id}
                type="button"
                role="tab"
                aria-selected={isActive}
                onClick={() => setSelectedSourceId(s.id)}
                className={`inline-flex items-center gap-2 px-3.5 py-2 rounded-xl text-xs font-semibold border transition ${
                  isActive
                    ? 'bg-obsidian-900 text-brand-300 border-obsidian-800 shadow-xs'
                    : 'bg-white text-stone-700 border-stone-200 hover:border-brand-400 hover:bg-brand-50/40'
                }`}
              >
                <span>{s.label}</span>
                <span
                  className={`px-1.5 py-0.5 rounded-md text-[10px] font-mono ${
                    isActive
                      ? 'bg-obsidian-800 text-brand-200'
                      : 'bg-stone-100 text-stone-600'
                  }`}
                >
                  {count} fields
                </span>
              </button>
            );
          })}
        </div>
      )}

      {!activeSchema ? (
        <div className="bg-white rounded-2xl shadow-xs border border-stone-200 p-12 text-center text-stone-500 text-xs">
          <Layers className="w-10 h-10 text-stone-300 mx-auto mb-3" aria-hidden="true" />
          <p className="font-semibold text-stone-700 text-sm mb-1">
            No schemas discovered yet
          </p>
          <p>Start capturing API responses to automatically infer field structures and types.</p>
        </div>
      ) : (
        <div className="space-y-6">
          {/* Schema Metadata Card */}
          <div className="bg-white rounded-2xl shadow-xs border border-stone-200 p-5 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-4 text-xs">
            <div>
              <span className="text-stone-400 font-medium block mb-1">Dataset Label</span>
              <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-brand-100 border border-brand-300 text-brand-900 font-bold">
                <Tag className="w-3.5 h-3.5 text-brand-700" aria-hidden="true" />
                {activeSource?.label || 'Dataset'}
              </span>
            </div>
            <div className="lg:col-span-2">
              <span className="text-stone-400 font-medium block mb-1">Normalized Endpoint</span>
              <span className="font-mono font-semibold text-stone-800 break-all">
                {activeSource ? `${activeSource.httpMethod} ${activeSource.normalizedEndpoint}` : activeSchema.sourceId}
              </span>
            </div>
            <div>
              <span className="text-stone-400 font-medium block mb-1">Extraction Path</span>
              <code className="inline-block bg-brand-50 border border-brand-200 text-brand-900 font-bold px-2 py-0.5 rounded-md font-mono">
                {activeSchema.inferredRecordPath}
              </code>
            </div>
            <div>
              <span className="text-stone-400 font-medium block mb-1">Fields & Samples</span>
              <span className="font-bold text-stone-900">
                {allFields.length} fields
              </span>
              <span className="text-stone-500 ml-1.5">
                ({activeSchema.detectedCount} records)
              </span>
              {conflictCount > 0 && (
                <span className="block text-[11px] text-amber-700 font-semibold mt-0.5">
                  {conflictCount} type drift {conflictCount === 1 ? 'warning' : 'warnings'}
                </span>
              )}
            </div>
          </div>

          {/* Search Filter Bar */}
          <div className="bg-white rounded-2xl shadow-xs border border-stone-200 overflow-hidden">
            <div className="p-4 border-b border-stone-200 bg-stone-50/70 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
              <div className="relative flex-1 max-w-md">
                <Search
                  className="w-4 h-4 text-stone-400 absolute left-3 top-1/2 -translate-y-1/2"
                  aria-hidden="true"
                />
                <input
                  type="search"
                  value={fieldQuery}
                  onChange={(e) => setFieldQuery(e.target.value)}
                  placeholder="Filter fields by name, type, or sample value..."
                  aria-label="Filter schema fields"
                  className="w-full pl-9 pr-3 py-1.5 bg-white border border-stone-300 rounded-xl text-xs text-stone-800 focus:outline-none focus:border-brand-600"
                />
              </div>
              <span className="text-xs text-stone-500 font-medium">
                Showing {filteredFields.length} of {allFields.length} fields
              </span>
            </div>

            {/* Accessible Responsive Table */}
            <div
              className="table-wrapper"
              tabIndex={0}
              role="region"
              aria-labelledby={captionId}
            >
              <table className="w-full text-left text-xs text-stone-700">
                <caption id={captionId} className="visually-hidden">
                  Inferred schema fields for {activeSource?.label || 'selected API dataset'}
                </caption>
                <thead className="bg-stone-100/90 text-[11px] font-bold uppercase tracking-wider text-stone-600 border-b border-stone-200">
                  <tr>
                    <th scope="col" className="px-5 py-3">Readable Column</th>
                    <th scope="col" className="px-5 py-3">JSON Dot Path</th>
                    <th scope="col" className="px-5 py-3">Detected Types</th>
                    <th scope="col" className="px-5 py-3">Optionality</th>
                    <th scope="col" className="px-5 py-3">Consistency</th>
                    <th scope="col" className="px-5 py-3">Observed Sample Values</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-stone-100">
                  {filteredFields.length === 0 ? (
                    <tr>
                      <td colSpan={6} className="px-6 py-10 text-center text-stone-400">
                        No fields match "{fieldQuery}".
                      </td>
                    </tr>
                  ) : (
                    filteredFields.map((field) => (
                      <tr key={field.path} className="hover:bg-brand-50/30 transition">
                        <td className="px-5 py-3 font-semibold text-stone-900 whitespace-nowrap">
                          {formatColumnHeader(field.path, 'readable')}
                        </td>
                        <td className="px-5 py-3 font-mono text-[11px] text-stone-700 whitespace-nowrap">
                          {field.path}
                        </td>
                        <td className="px-5 py-3">
                          <div className="flex flex-wrap gap-1">
                            {field.types.map((t) => (
                              <span
                                key={t}
                                className={`px-2 py-0.5 rounded-md text-[10px] font-bold border ${
                                  t === 'string'
                                    ? 'bg-sky-50 text-sky-800 border-sky-200'
                                    : t === 'number'
                                    ? 'bg-brand-50 text-brand-900 border-brand-300'
                                    : t === 'boolean'
                                    ? 'bg-teal-50 text-teal-800 border-teal-200'
                                    : t === 'array'
                                    ? 'bg-amber-50 text-amber-800 border-amber-200'
                                    : 'bg-stone-100 text-stone-700 border-stone-200'
                                }`}
                              >
                                {t}
                              </span>
                            ))}
                          </div>
                        </td>
                        <td className="px-5 py-3 whitespace-nowrap">
                          {field.optional ? (
                            <span className="text-amber-700 font-semibold text-[11px]">
                              Optional / Nullable
                            </span>
                          ) : (
                            <span className="text-brand-800 font-semibold text-[11px]">
                              Present in all rows
                            </span>
                          )}
                        </td>
                        <td className="px-5 py-3 whitespace-nowrap">
                          {field.hasConflict ? (
                            <span className="inline-flex items-center gap-1 text-[11px] font-bold text-rose-700">
                              <AlertCircle className="w-3.5 h-3.5" aria-hidden="true" /> Type Drift
                            </span>
                          ) : (
                            <span className="inline-flex items-center gap-1 text-[11px] font-medium text-brand-800">
                              <CheckCircle2 className="w-3.5 h-3.5 text-brand-700" aria-hidden="true" /> Consistent
                            </span>
                          )}
                        </td>
                        <td
                          className="px-5 py-3 font-mono text-[11px] text-stone-500 max-w-xs truncate"
                          title={field.sampleValues.map((v) => JSON.stringify(v)).join(', ')}
                        >
                          {field.sampleValues.map((v) => JSON.stringify(v)).join(', ')}
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
