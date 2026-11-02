import React, { useState } from 'react';
import { AlertTriangle, Trash2, X } from 'lucide-react';

export interface RightToBeForgottenModalProps {
  isOpen: boolean;
  onClose: () => void;
  tenantSlug?: string;
  onConfirmPurge: (params: {
    scope: 'customer' | 'document' | 'collection' | 'tenant';
    targetId: string;
    reason?: string;
  }) => Promise<void> | void;
}

export const RightToBeForgottenModal: React.FC<RightToBeForgottenModalProps> = ({
  isOpen,
  onClose,
  tenantSlug = 'tenant_automations',
  onConfirmPurge,
}) => {
  const [scope, setScope] = useState<'customer' | 'document' | 'collection' | 'tenant'>('customer');
  const [targetId, setTargetId] = useState('');
  const [reason, setReason] = useState('Solicitud GDPR Artículo 17 - Derecho al Olvido');
  const [confirmationInput, setConfirmationInput] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);

  if (!isOpen) return null;

  const requiredConfirmText = tenantSlug;
  const isConfirmed = confirmationInput.trim() === requiredConfirmText;

  const handlePurge = async () => {
    if (!isConfirmed || !targetId.trim()) return;
    try {
      setIsSubmitting(true);
      await onConfirmPurge({
        scope,
        targetId: targetId.trim(),
        reason: reason.trim(),
      });
      onClose();
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="rtbf-modal-title"
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm"
    >
      <div className="w-full max-w-lg bg-white dark:bg-[#131B2E] rounded-2xl shadow-xl border border-rose-200 dark:border-rose-900/60 overflow-hidden text-slate-900 dark:text-slate-100 animate-in fade-in zoom-in-95 duration-150">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 bg-rose-50 dark:bg-rose-950/40 border-b border-rose-100 dark:border-rose-900/50">
          <div className="flex items-center space-x-2.5">
            <div className="p-2 rounded-xl bg-rose-100 dark:bg-rose-900/80 text-rose-600 dark:text-rose-300">
              <AlertTriangle className="w-5 h-5" />
            </div>
            <div>
              <h2 id="rtbf-modal-title" className="text-sm font-bold text-rose-900 dark:text-rose-100">
                GDPR: Derecho al Olvido (Purga de Vectores)
              </h2>
              <p className="text-[11px] text-rose-700 dark:text-rose-300">
                Eliminación permanente e irreversible de fragmentos y embeddings
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="p-1 rounded-lg text-slate-400 hover:text-slate-600 dark:hover:text-slate-200"
            aria-label="Cerrar modal"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Body */}
        <div className="p-6 space-y-4 text-xs">
          <div>
            <label className="block font-semibold text-slate-700 dark:text-slate-300 mb-1">
              Alcance de la Purga (Scope)
            </label>
            <select
              value={scope}
              onChange={(e) =>
                setScope(e.target.value as 'customer' | 'document' | 'collection' | 'tenant')
              }
              className="w-full px-3 py-2 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900"
            >
              <option value="customer">Cliente Individual (Customer ID)</option>
              <option value="document">Documento Específico (Document ID)</option>
              <option value="collection">Colección Completa (Collection ID)</option>
              <option value="tenant">Todo el Inquilino (Tenant Wide)</option>
            </select>
          </div>

          <div>
            <label className="block font-semibold text-slate-700 dark:text-slate-300 mb-1">
              Identificador del Objetivo (Target ID / Slug)
            </label>
            <input
              type="text"
              placeholder={
                scope === 'customer'
                  ? 'Ej: cust_551029'
                  : scope === 'document'
                  ? 'Ej: doc_faq_2026'
                  : 'ID de la entidad'
              }
              value={targetId}
              onChange={(e) => setTargetId(e.target.value)}
              className="w-full px-3 py-2 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 font-mono"
            />
          </div>

          <div>
            <label className="block font-semibold text-slate-700 dark:text-slate-300 mb-1">
              Motivo Legal / Auditoría
            </label>
            <input
              type="text"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              className="w-full px-3 py-2 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900"
            />
          </div>

          {/* Hard Confirmation Requirement */}
          <div className="p-3 bg-amber-50 dark:bg-amber-950/40 rounded-xl border border-amber-200 dark:border-amber-900/60 space-y-2">
            <p className="text-[11px] text-amber-900 dark:text-amber-200 font-medium">
              Esta acción no se puede deshacer. Para confirmar la purga permanente de los vectores en
              pgvector, escribe el slug del inquilino exacto:{' '}
              <span className="font-mono font-bold select-all bg-amber-200/60 dark:bg-amber-900/80 px-1 py-0.5 rounded">
                {requiredConfirmText}
              </span>
            </p>
            <input
              type="text"
              placeholder={`Escribe "${requiredConfirmText}" para confirmar`}
              value={confirmationInput}
              onChange={(e) => setConfirmationInput(e.target.value)}
              className="w-full px-3 py-1.5 text-xs rounded-lg border border-amber-300 dark:border-amber-800 bg-white dark:bg-slate-900 font-mono"
            />
          </div>
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end space-x-2 px-6 py-4 bg-slate-50 dark:bg-slate-900/50 border-t border-slate-200 dark:border-slate-800">
          <button
            type="button"
            onClick={onClose}
            className="px-4 py-2 text-xs font-medium text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 rounded-lg"
          >
            Cancelar
          </button>
          <button
            type="button"
            onClick={handlePurge}
            disabled={!isConfirmed || !targetId.trim() || isSubmitting}
            className="flex items-center space-x-1.5 px-4 py-2 text-xs font-semibold text-white bg-rose-600 hover:bg-rose-700 disabled:bg-slate-400 dark:disabled:bg-slate-700 disabled:cursor-not-allowed rounded-lg shadow-sm"
          >
            <Trash2 className="w-3.5 h-3.5" />
            <span>{isSubmitting ? 'Purgando...' : 'Purgar Datos Vectoriales'}</span>
          </button>
        </div>
      </div>
    </div>
  );
};
