import React, { useState } from 'react';
import { Copy, Check, Search, ChevronRight, ChevronDown } from 'lucide-react';

export interface JsonViewerProps {
  data: unknown;
  title?: string;
  className?: string;
}

export const JsonViewer: React.FC<JsonViewerProps> = ({
  data,
  title = 'Variables',
  className = '',
}) => {
  const [searchTerm, setSearchTerm] = useState('');
  const [copied, setCopied] = useState(false);
  const [collapsedKeys, setCollapsedKeys] = useState<Set<string>>(new Set());

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(JSON.stringify(data, null, 2));
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Fallback if clipboard API is unavailable
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  const toggleCollapse = (path: string) => {
    setCollapsedKeys((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  };

  const renderValue = (val: unknown, path: string, _keyName?: string): React.ReactNode => {
    if (val === null) {
      return <span className="text-slate-400 italic">null</span>;
    }
    if (val === undefined) {
      return <span className="text-slate-400 italic">undefined</span>;
    }
    if (typeof val === 'boolean') {
      return (
        <span className="text-purple-600 dark:text-purple-400 font-bold">
          {val ? 'true' : 'false'}
        </span>
      );
    }
    if (typeof val === 'number') {
      return <span className="text-amber-600 dark:text-amber-400">{val}</span>;
    }
    if (typeof val === 'string') {
      return <span className="text-emerald-600 dark:text-emerald-400">"{val}"</span>;
    }

    if (Array.isArray(val)) {
      const isCollapsed = collapsedKeys.has(path);
      if (val.length === 0) return <span className="text-slate-400">[]</span>;

      return (
        <div className="inline-flex flex-col">
          <button
            type="button"
            onClick={() => toggleCollapse(path)}
            className="inline-flex items-center gap-1 text-slate-500 hover:text-slate-700 dark:hover:text-slate-300"
          >
            {isCollapsed ? <ChevronRight size={12} /> : <ChevronDown size={12} />}
            <span className="text-[10px] text-slate-400">Array({val.length})</span>
          </button>
          {!isCollapsed && (
            <div className="pl-3 border-l border-slate-200 dark:border-slate-800 flex flex-col gap-0.5">
              {val.map((item, idx) => (
                <div key={idx} className="flex items-start gap-1">
                  <span className="text-slate-400 text-[10px]">{idx}:</span>
                  {renderValue(item, `${path}[${idx}]`)}
                </div>
              ))}
            </div>
          )}
        </div>
      );
    }

    if (typeof val === 'object') {
      const isCollapsed = collapsedKeys.has(path);
      const entries = Object.entries(val as Record<string, unknown>);
      if (entries.length === 0) return <span className="text-slate-400">{'{}'}</span>;

      // Filter entries if search term is active
      const filteredEntries = searchTerm
        ? entries.filter(
            ([k, v]) =>
              k.toLowerCase().includes(searchTerm.toLowerCase()) ||
              JSON.stringify(v).toLowerCase().includes(searchTerm.toLowerCase())
          )
        : entries;

      return (
        <div className="inline-flex flex-col">
          <button
            type="button"
            onClick={() => toggleCollapse(path)}
            className="inline-flex items-center gap-1 text-slate-500 hover:text-slate-700 dark:hover:text-slate-300"
          >
            {isCollapsed ? <ChevronRight size={12} /> : <ChevronDown size={12} />}
            <span className="text-[10px] text-slate-400">
              Object({entries.length})
            </span>
          </button>
          {!isCollapsed && (
            <div className="pl-3 border-l border-slate-200 dark:border-slate-800 flex flex-col gap-0.5">
              {filteredEntries.map(([k, v]) => (
                <div key={k} className="flex items-start gap-1">
                  <span className="text-slate-600 dark:text-slate-300 font-semibold text-[11px]">
                    {k}:
                  </span>
                  {renderValue(v, `${path}.${k}`, k)}
                </div>
              ))}
            </div>
          )}
        </div>
      );
    }

    return <span>{String(val)}</span>;
  };

  return (
    <div className={`json-viewer flex flex-col bg-slate-50 dark:bg-slate-950/60 rounded-lg border border-slate-200 dark:border-slate-800 p-2.5 font-mono text-xs ${className}`}>
      {/* Header controls: Search & Copy */}
      <div className="flex items-center justify-between pb-2 mb-2 border-b border-slate-200 dark:border-slate-800">
        <span className="text-[11px] font-bold uppercase tracking-wider text-slate-500">
          {title}
        </span>
        <div className="flex items-center gap-2">
          <div className="relative">
            <Search size={12} className="absolute left-1.5 top-1/2 -translate-y-1/2 text-slate-400" />
            <input
              type="text"
              placeholder="Filtrar..."
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              className="pl-5 pr-2 py-0.5 text-[10px] rounded bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 text-slate-700 dark:text-slate-300 focus:outline-none focus:ring-1 focus:ring-teal-500"
            />
          </div>
          <button
            type="button"
            onClick={handleCopy}
            title="Copiar JSON"
            className="flex items-center gap-1 text-[10px] text-slate-500 hover:text-slate-800 dark:hover:text-slate-200 p-1 rounded hover:bg-slate-200 dark:hover:bg-slate-800"
          >
            {copied ? <Check size={12} className="text-emerald-500" /> : <Copy size={12} />}
            <span>{copied ? '¡Copiado!' : 'Copiar'}</span>
          </button>
        </div>
      </div>

      {/* Rendered JSON Tree */}
      <div className="overflow-x-auto max-h-60 overflow-y-auto">
        {data ? renderValue(data, 'root') : <span className="text-slate-400 italic">Sin datos</span>}
      </div>
    </div>
  );
};
