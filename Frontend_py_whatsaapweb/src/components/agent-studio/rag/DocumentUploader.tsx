import React, { useState } from 'react';
import { Upload, FileText, Trash2 } from 'lucide-react';

export interface DocumentQueueItem {
  id: string;
  name: string;
  sizeBytes: number;
  format: 'pdf' | 'txt' | 'md' | 'json' | 'csv' | 'unknown';
  estimatedChunks: number;
  status: 'pending' | 'uploading' | 'completed' | 'error';
}

export interface DocumentUploaderProps {
  collectionId: string;
  onUploadDocuments?: (files: File[]) => Promise<void> | void;
}

export const DocumentUploader: React.FC<DocumentUploaderProps> = ({
  collectionId,
  onUploadDocuments: _onUploadDocuments,
}) => {
  const [queue, setQueue] = useState<DocumentQueueItem[]>([]);
  const [isDragging, setIsDragging] = useState(false);

  const handleFileSelection = (fileList: FileList | null) => {
    if (!fileList || fileList.length === 0) return;
    const items: DocumentQueueItem[] = Array.from(fileList).map((f) => {
      const ext = f.name.split('.').pop()?.toLowerCase();
      const format: DocumentQueueItem['format'] =
        ext === 'pdf'
          ? 'pdf'
          : ext === 'txt'
          ? 'txt'
          : ext === 'md'
          ? 'md'
          : ext === 'json'
          ? 'json'
          : ext === 'csv'
          ? 'csv'
          : 'unknown';

      // Rough chunk estimate: ~1 chunk per 2KB
      const estimatedChunks = Math.max(1, Math.ceil(f.size / 2048));

      return {
        id: `file_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
        name: f.name,
        sizeBytes: f.size,
        format,
        estimatedChunks,
        status: 'pending',
      };
    });

    setQueue((prev) => [...prev, ...items]);
  };

  const removeQueueItem = (id: string) => {
    setQueue((prev) => prev.filter((item) => item.id !== id));
  };

  return (
    <div className="space-y-4">
      {/* Drag & Drop Zone */}
      <div
        onDragOver={(e) => {
          e.preventDefault();
          setIsDragging(true);
        }}
        onDragLeave={() => setIsDragging(false)}
        onDrop={(e) => {
          e.preventDefault();
          setIsDragging(false);
          handleFileSelection(e.dataTransfer.files);
        }}
        className={`border-2 border-dashed rounded-xl p-6 text-center transition-colors cursor-pointer ${
          isDragging
            ? 'border-teal-500 bg-teal-50/50 dark:bg-teal-950/20'
            : 'border-slate-300 dark:border-slate-700 hover:border-teal-400 bg-slate-50/50 dark:bg-slate-900/40'
        }`}
        onClick={() => document.getElementById('rag-file-input')?.click()}
      >
        <input
          id="rag-file-input"
          type="file"
          multiple
          accept=".pdf,.txt,.md,.json,.csv"
          className="hidden"
          onChange={(e) => handleFileSelection(e.target.files)}
        />
        <div className="flex flex-col items-center space-y-2">
          <div className="p-3 rounded-full bg-teal-50 dark:bg-teal-950 text-teal-600 dark:text-teal-400">
            <Upload className="w-5 h-5" />
          </div>
          <div>
            <p className="text-xs font-semibold text-slate-800 dark:text-slate-200">
              Haz clic o arrastra documentos aquí
            </p>
            <p className="text-[11px] text-slate-500 dark:text-slate-400 mt-0.5">
              Formatos soportados: PDF, TXT, Markdown, JSON, CSV (máx 25 MB por archivo)
            </p>
          </div>
        </div>
      </div>

      {/* Queue Preview */}
      {queue.length > 0 && (
        <div className="space-y-2">
          <div className="flex items-center justify-between text-xs font-semibold text-slate-700 dark:text-slate-300">
            <span>Archivos listos para ingesta ({queue.length})</span>
            <span className="font-mono text-slate-400">Colección: {collectionId}</span>
          </div>

          <div className="space-y-1.5 max-h-48 overflow-y-auto">
            {queue.map((item) => (
              <div
                key={item.id}
                className="flex items-center justify-between p-2.5 bg-white dark:bg-[#131B2E] rounded-lg border border-slate-200 dark:border-slate-800 text-xs"
              >
                <div className="flex items-center space-x-2.5 min-w-0">
                  <FileText className="w-4 h-4 text-teal-600 dark:text-teal-400 shrink-0" />
                  <div className="min-w-0">
                    <p className="font-medium text-slate-800 dark:text-slate-200 truncate">
                      {item.name}
                    </p>
                    <p className="text-[10px] text-slate-400">
                      {(item.sizeBytes / 1024).toFixed(1)} KB · ~{item.estimatedChunks} fragmentos
                    </p>
                  </div>
                </div>

                <div className="flex items-center space-x-2">
                  <span className="px-1.5 py-0.5 rounded text-[10px] font-bold uppercase bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-400">
                    {item.format}
                  </span>
                  <button
                    type="button"
                    onClick={() => removeQueueItem(item.id)}
                    className="p-1 text-slate-400 hover:text-rose-500"
                    title="Quitar archivo"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
};
