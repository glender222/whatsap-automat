import React, { useState } from 'react';
import type {
  OmnichannelConversation,
  AiToolTraceItem,
  CustomerOrderSummary,
  InternalNote,
} from '../types';
import {
  X,
  Plus,
  Tag,
  Wrench,
  ShoppingBag,
  FileText,
  Clock,
  CheckCircle2,
  AlertCircle,
} from 'lucide-react';

export interface ContextPanelProps {
  isOpen: boolean;
  conversation: OmnichannelConversation | null;
  agentTraces?: AiToolTraceItem[];
  activeOrder?: CustomerOrderSummary;
  internalNotes?: InternalNote[];
  onAddInternalNote: (text: string) => void;
  onAddTag: (tagName: string) => void;
  onRemoveTag: (tagId: string) => void;
  onClose: () => void;
  className?: string;
}

export const ContextPanel: React.FC<ContextPanelProps> = ({
  isOpen,
  conversation,
  agentTraces = [],
  activeOrder,
  internalNotes = [],
  onAddInternalNote,
  onAddTag,
  onRemoveTag,
  onClose,
  className = '',
}) => {
  const [newTagInput, setNewTagInput] = useState('');
  const [newNoteInput, setNewNoteInput] = useState('');
  const [isAddingTag, setIsAddingTag] = useState(false);

  if (!isOpen || !conversation) {
    return null;
  }

  const handleAddTagSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (newTagInput.trim()) {
      onAddTag(newTagInput.trim());
      setNewTagInput('');
      setIsAddingTag(false);
    }
  };

  const handleAddNoteSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (newNoteInput.trim()) {
      onAddInternalNote(newNoteInput.trim());
      setNewNoteInput('');
    }
  };

  const getInitials = (name: string) => {
    const parts = name.trim().split(/\s+/);
    if (parts.length >= 2) {
      return (parts[0][0] + parts[1][0]).toUpperCase();
    }
    return name.slice(0, 2).toUpperCase();
  };

  return (
    <aside
      id="context-panel-inspector"
      role="complementary"
      aria-label="Información del cliente y contexto de la conversación"
      aria-hidden={!isOpen}
      className={`flex w-[300px] shrink-0 flex-col border-l bg-white dark:bg-[#131B2E] border-slate-200 dark:border-slate-800 overflow-y-auto ${className}`}
    >
      {/* Top Header */}
      <div className="flex h-14 shrink-0 items-center justify-between border-b px-4 border-inherit">
        <h3 className="text-xs font-bold uppercase tracking-wider text-slate-700 dark:text-slate-300">
          Contexto del Contacto
        </h3>
        <button
          type="button"
          onClick={onClose}
          aria-label="Cerrar panel de contexto"
          className="rounded p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-600 dark:hover:bg-slate-800 dark:hover:text-slate-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-teal-500"
        >
          <X size={16} />
        </button>
      </div>

      <div className="p-4 space-y-5 text-xs">
        {/* Section 1: Customer Profile */}
        <section aria-label="Perfil del contacto">
          <div className="flex items-center gap-3">
            <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full bg-slate-200 text-slate-700 font-bold text-sm dark:bg-slate-700 dark:text-slate-200">
              {getInitials(conversation.participant.name)}
            </div>
            <div className="min-w-0 flex-1">
              <h4 className="truncate font-semibold text-slate-900 dark:text-slate-100">
                {conversation.participant.name}
              </h4>
              <p className="truncate text-[11px] text-slate-500">
                {conversation.participant.phoneNumber ||
                  conversation.participant.username ||
                  'Usuario web'}
              </p>
              <span className="inline-block mt-0.5 rounded bg-slate-100 dark:bg-slate-800 px-1.5 py-0.2 text-[10px] capitalize text-slate-600 dark:text-slate-300">
                {conversation.channel}
              </span>
            </div>
          </div>
        </section>

        {/* Section 2: Tags Manager */}
        <section className="border-t pt-3 border-inherit" aria-label="Etiquetas de la conversación">
          <div className="flex items-center justify-between mb-2">
            <span className="flex items-center gap-1 font-semibold text-slate-700 dark:text-slate-300">
              <Tag size={13} aria-hidden="true" />
              <span>Etiquetas</span>
            </span>
            <button
              type="button"
              onClick={() => setIsAddingTag(!isAddingTag)}
              className="text-teal-600 dark:text-teal-400 hover:underline flex items-center gap-0.5 font-medium"
              aria-label="Añadir nueva etiqueta"
            >
              <Plus size={12} />
              <span>Añadir</span>
            </button>
          </div>

          {isAddingTag && (
            <form onSubmit={handleAddTagSubmit} className="flex gap-1.5 mb-2">
              <input
                type="text"
                value={newTagInput}
                onChange={(e) => setNewTagInput(e.target.value)}
                placeholder="Nombre de etiqueta..."
                aria-label="Nombre de etiqueta"
                className="flex-1 rounded border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-900/40 px-2 py-1 text-xs text-slate-900 dark:text-slate-100 focus:outline-none focus:ring-1 focus:ring-teal-500"
                autoFocus
              />
              <button
                type="submit"
                className="rounded bg-teal-600 px-2 py-1 font-semibold text-white hover:bg-teal-700"
              >
                Guardar
              </button>
            </form>
          )}

          <div className="flex flex-wrap gap-1.5">
            {conversation.tags.length === 0 ? (
              <span className="text-slate-400 italic">Sin etiquetas asignadas</span>
            ) : (
              conversation.tags.map((t) => (
                <span
                  key={t.id}
                  className="inline-flex items-center gap-1 rounded px-2 py-0.5 text-xs font-medium"
                  style={{ backgroundColor: `${t.color}20`, color: t.color }}
                >
                  <span>{t.name}</span>
                  <button
                    type="button"
                    onClick={() => onRemoveTag(t.id)}
                    className="hover:opacity-75 focus:outline-none"
                    aria-label={`Eliminar etiqueta ${t.name}`}
                  >
                    <X size={11} />
                  </button>
                </span>
              ))
            )}
          </div>
        </section>

        {/* Section 3: AI Agent Tool Traces Inspector */}
        <section
          role="region"
          aria-label="Trazas de herramientas ejecutadas por IA"
          className="border-t pt-3 border-inherit"
        >
          <div className="flex items-center gap-1 mb-2 font-semibold text-slate-700 dark:text-slate-300">
            <Wrench size={13} aria-hidden="true" />
            <span>Trazas del Agente IA</span>
          </div>

          <div role="list" className="space-y-2">
            {agentTraces.length === 0 ? (
              <p className="text-slate-400 italic">No hay herramientas ejecutadas recientemente.</p>
            ) : (
              agentTraces.map((tr) => (
                <div
                  key={tr.id}
                  role="listitem"
                  className="rounded-lg border border-slate-200 dark:border-slate-800 p-2.5 bg-slate-50 dark:bg-slate-900/40 space-y-1"
                >
                  <div className="flex items-center justify-between">
                    <span className="font-mono font-semibold text-teal-600 dark:text-teal-400">
                      {tr.functionName || tr.toolName}
                    </span>
                    <span
                      className={`inline-flex items-center gap-0.5 rounded px-1.5 py-0.2 text-[9px] font-bold ${
                        tr.status === 'completed'
                          ? 'bg-emerald-100 text-emerald-800 dark:bg-emerald-950/60 dark:text-emerald-300'
                          : 'bg-red-100 text-red-800 dark:bg-red-950/60 dark:text-red-300'
                      }`}
                    >
                      {tr.status === 'completed' ? (
                        <CheckCircle2 size={9} aria-hidden="true" />
                      ) : (
                        <AlertCircle size={9} aria-hidden="true" />
                      )}
                      <span>{tr.status}</span>
                    </span>
                  </div>
                  <p className="text-[11px] text-slate-600 dark:text-slate-300">
                    {tr.resultSummary || tr.outputSummary}
                  </p>
                  {(tr.latencyMs || tr.executionMs) && (
                    <p className="text-[10px] text-slate-400 flex items-center gap-1">
                      <Clock size={10} aria-hidden="true" />
                      <span>{tr.latencyMs || tr.executionMs} ms</span>
                    </p>
                  )}
                </div>
              ))
            )}
          </div>
        </section>

        {/* Section 4: Customer Active Order Summary */}
        <section
          role="region"
          aria-label="Resumen de pedido activo"
          className="border-t pt-3 border-inherit"
        >
          <div className="flex items-center gap-1 mb-2 font-semibold text-slate-700 dark:text-slate-300">
            <ShoppingBag size={13} aria-hidden="true" />
            <span>Pedido Activo</span>
          </div>

          {activeOrder ? (
            <div className="rounded-lg border border-slate-200 dark:border-slate-800 p-2.5 bg-slate-50 dark:bg-slate-900/40 space-y-1.5">
              <div className="flex items-center justify-between">
                <span className="font-bold text-slate-900 dark:text-slate-100">
                  {activeOrder.orderNumber}
                </span>
                <span className="rounded bg-teal-100 dark:bg-teal-950/60 px-1.5 py-0.5 text-[10px] font-bold text-teal-800 dark:text-teal-200">
                  ${activeOrder.amount} {activeOrder.currency}
                </span>
              </div>
              <p className="text-[11px] text-slate-600 dark:text-slate-300">
                {activeOrder.itemsSummary}
              </p>
              <div className="flex items-center justify-between text-[10px] text-slate-400 pt-1">
                <span>Estado: {activeOrder.status}</span>
                <span>{activeOrder.createdAt}</span>
              </div>
            </div>
          ) : (
            <p className="text-slate-400 italic">Sin pedidos activos asociados.</p>
          )}
        </section>

        {/* Section 5: Private Internal Notes */}
        <section
          role="region"
          aria-label="Notas internas privadas"
          className="border-t pt-3 border-inherit"
        >
          <div className="flex items-center gap-1 mb-2 font-semibold text-slate-700 dark:text-slate-300">
            <FileText size={13} aria-hidden="true" />
            <span>Notas Internas (Privadas)</span>
          </div>

          <form onSubmit={handleAddNoteSubmit} className="space-y-1.5 mb-3">
            <textarea
              value={newNoteInput}
              onChange={(e) => setNewNoteInput(e.target.value)}
              placeholder="Escribe una nota visible solo para el equipo..."
              aria-label="Nueva nota interna"
              rows={2}
              className="w-full rounded-md border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-900/40 p-2 text-xs text-slate-900 dark:text-slate-100 focus:outline-none focus:ring-1 focus:ring-teal-500"
            />
            <button
              type="submit"
              disabled={!newNoteInput.trim()}
              className="rounded bg-slate-800 dark:bg-slate-700 px-2.5 py-1 text-xs font-semibold text-white hover:bg-slate-900 dark:hover:bg-slate-600 disabled:opacity-40"
            >
              Guardar Nota
            </button>
          </form>

          <div className="space-y-2">
            {internalNotes.length === 0 ? (
              <p className="text-slate-400 italic">No hay notas registradas.</p>
            ) : (
              internalNotes.map((note) => (
                <div
                  key={note.id}
                  className="rounded border border-amber-200/60 bg-amber-50/50 dark:border-amber-900/40 dark:bg-amber-950/20 p-2 text-slate-800 dark:text-slate-200"
                >
                  <p className="text-[11px] leading-relaxed">{note.text || note.content}</p>
                  <div className="flex items-center justify-between text-[9px] text-slate-400 mt-1">
                    <span>{note.authorName}</span>
                    <span>{new Date(note.timestamp || note.createdAt || Date.now()).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
                  </div>
                </div>
              ))
            )}
          </div>
        </section>
      </div>
    </aside>
  );
};
