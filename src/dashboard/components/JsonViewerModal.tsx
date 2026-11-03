import React, { useMemo, useState } from 'react';
import { Copy, Check, Search } from 'lucide-react';
import { ModalDialog } from './ModalDialog';

interface Props {
  title: string;
  data: unknown;
  isOpen: boolean;
  onClose: () => void;
}

export const JsonViewerModal: React.FC<Props> = ({ title, data, isOpen, onClose }) => {
  const [copied, setCopied] = useState(false);
  const [filterQuery, setFilterQuery] = useState('');

  const formattedJson = useMemo(() => {
    if (typeof data === 'string') {
      try {
        return JSON.stringify(JSON.parse(data), null, 2);
      } catch {
        return data;
      }
    }
    return JSON.stringify(data, null, 2);
  }, [data]);

  const displayedJson = useMemo(() => {
    if (!filterQuery.trim()) return formattedJson;
    const lower = filterQuery.toLowerCase();
    const matchingLines = formattedJson
      .split('\n')
      .filter((line) => line.toLowerCase().includes(lower));
    return matchingLines.length > 0
      ? matchingLines.join('\n')
      : `// No JSON lines matched "${filterQuery}"`;
  }, [formattedJson, filterQuery]);

  const handleCopy = async () => {
    await navigator.clipboard.writeText(formattedJson);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <ModalDialog
      isOpen={isOpen}
      onClose={onClose}
      title={title}
      maxWidthClass="max-w-4xl"
      headerActions={
        <button
          type="button"
          onClick={handleCopy}
          className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-white border border-stone-300 rounded-xl text-xs font-semibold text-obsidian-900 hover:bg-stone-50 transition"
        >
          {copied ? (
            <Check className="w-3.5 h-3.5 text-brand-700" aria-hidden="true" />
          ) : (
            <Copy className="w-3.5 h-3.5 text-stone-600" aria-hidden="true" />
          )}
          {copied ? 'Copied JSON' : 'Copy JSON'}
        </button>
      }
    >
      <div className="bg-obsidian-950 text-stone-200 flex flex-col">
        <div className="px-4 py-2.5 border-b border-obsidian-800 flex items-center gap-2 bg-obsidian-900">
          <Search className="w-3.5 h-3.5 text-brand-400" aria-hidden="true" />
          <label htmlFor="json-viewer-search" className="visually-hidden">
            Filter JSON lines
          </label>
          <input
            id="json-viewer-search"
            type="text"
            placeholder="Filter keys or values inside JSON..."
            value={filterQuery}
            onChange={(e) => setFilterQuery(e.target.value)}
            className="w-full bg-transparent text-xs font-mono text-stone-100 placeholder:text-stone-500 focus:outline-none"
          />
        </div>
        <div className="p-5 overflow-auto max-h-[65vh] font-mono text-xs leading-relaxed text-brand-100/95">
          <pre className="whitespace-pre-wrap break-words">{displayedJson}</pre>
        </div>
      </div>
    </ModalDialog>
  );
};
