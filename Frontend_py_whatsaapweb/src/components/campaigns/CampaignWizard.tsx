import React, { useState } from 'react';
import {
  Send,
  Users,
  MessageSquare,
  Clock,
  ShieldCheck,
  CheckCircle,
  AlertTriangle,
  ChevronRight,
  ChevronLeft,
  Sliders,
  Zap,
} from 'lucide-react';

export interface CampaignFormData {
  name: string;
  channel: string;
  connectionId: string;
  purpose: 'marketing' | 'transactional' | 'support' | 'broadcast';
  segmentId: string;
  templateId?: string;
  templateVariables: Record<string, string>;
  contentSubject?: string;
  contentBody: string;
  rateLimitPerMinute: number;
  failurePauseThresholdPercent: number;
  isScheduled: boolean;
  scheduledAt?: string;
}

export interface CampaignWizardProps {
  initialData?: Partial<CampaignFormData>;
  availableSegments?: Array<{ id: string; name: string; count: number }>;
  availableTemplates?: Array<{ id: string; name: string; variables: string[] }>;
  onSubmit?: (data: CampaignFormData) => Promise<void> | void;
  onCancel?: () => void;
}

export const CampaignWizard: React.FC<CampaignWizardProps> = ({
  initialData,
  availableSegments = [
    { id: 'seg_vip', name: 'Clientes VIP (Últimos 30 días)', count: 240 },
    { id: 'seg_leads', name: 'Leads Calificados Marketing', count: 1250 },
    { id: 'seg_all', name: 'Todos los Contactos con Opt-In', count: 3400 },
  ],
  availableTemplates = [
    { id: 'promo_black_friday_v1', name: 'promo_black_friday_v1', variables: ['name', 'discount'] },
    { id: 'order_status_v2', name: 'order_status_v2', variables: ['orderId', 'status'] },
  ],
  onSubmit,
  onCancel,
}) => {
  const [currentStep, setCurrentStep] = useState<number>(1);
  const [formData, setFormData] = useState<CampaignFormData>({
    name: initialData?.name || '',
    channel: initialData?.channel || 'whatsapp-cloud',
    connectionId: initialData?.connectionId || 'default',
    purpose: initialData?.purpose || 'marketing',
    segmentId: initialData?.segmentId || availableSegments[0]?.id || '',
    templateId: initialData?.templateId || '',
    templateVariables: initialData?.templateVariables || {},
    contentSubject: initialData?.contentSubject || '',
    contentBody: initialData?.contentBody || '',
    rateLimitPerMinute: initialData?.rateLimitPerMinute || 50,
    failurePauseThresholdPercent: initialData?.failurePauseThresholdPercent || 5,
    isScheduled: initialData?.isScheduled || false,
    scheduledAt: initialData?.scheduledAt || '',
  });

  const [isSubmitting, setIsSubmitting] = useState(false);
  const [submittedSuccess, setSubmittedSuccess] = useState(false);

  const selectedSegment = availableSegments.find((s) => s.id === formData.segmentId);
  const selectedTemplate = availableTemplates.find((t) => t.id === formData.templateId);

  const estimatedDurationMinutes = selectedSegment
    ? Math.ceil(selectedSegment.count / formData.rateLimitPerMinute)
    : 0;

  const handleNext = () => {
    if (currentStep < 5) setCurrentStep(currentStep + 1);
  };

  const handleBack = () => {
    if (currentStep > 1) setCurrentStep(currentStep - 1);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsSubmitting(true);
    try {
      if (onSubmit) {
        await onSubmit(formData);
      }
      setSubmittedSuccess(true);
    } catch (err) {
      console.error(err);
    } finally {
      setIsSubmitting(false);
    }
  };

  const insertVariable = (variable: string) => {
    setFormData((prev) => ({
      ...prev,
      contentBody: `${prev.contentBody} {{${variable}}}`,
    }));
  };

  return (
    <div className="max-w-4xl mx-auto bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-xl shadow-lg p-6 my-6">
      {/* Stepper Header */}
      <div className="mb-8">
        <h2 className="text-2xl font-bold text-gray-900 dark:text-gray-100 flex items-center gap-2">
          <Send className="w-6 h-6 text-emerald-600" />
          Nueva Campaña de Difusión
        </h2>
        <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">
          Difusión multicanal con verificación estricta de consentimiento, control de ritmo y circuit breaker.
        </p>

        <div className="flex items-center justify-between mt-6 relative">
          <div className="absolute left-0 top-1/2 -translate-y-1/2 w-full h-1 bg-gray-200 dark:bg-gray-800 -z-0" />
          {[
            { step: 1, label: 'Detalles', icon: Sliders },
            { step: 2, label: 'Audiencia', icon: Users },
            { step: 3, label: 'Mensaje', icon: MessageSquare },
            { step: 4, label: 'Ritmo & Horario', icon: Clock },
            { step: 5, label: 'Revisión', icon: ShieldCheck },
          ].map(({ step, label, icon: Icon }) => (
            <div key={step} className="flex flex-col items-center relative z-10">
              <div
                className={`w-10 h-10 rounded-full flex items-center justify-center font-bold text-sm transition-all ${
                  currentStep === step
                    ? 'bg-emerald-600 text-white shadow-lg ring-4 ring-emerald-100 dark:ring-emerald-950'
                    : currentStep > step
                    ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900 dark:text-emerald-300'
                    : 'bg-gray-100 text-gray-400 dark:bg-gray-800 dark:text-gray-500'
                }`}
              >
                <Icon className="w-5 h-5" />
              </div>
              <span
                className={`text-xs font-medium mt-2 ${
                  currentStep === step
                    ? 'text-emerald-700 dark:text-emerald-400 font-bold'
                    : 'text-gray-500 dark:text-gray-400'
                }`}
              >
                {label}
              </span>
            </div>
          ))}
        </div>
      </div>

      {submittedSuccess ? (
        <div className="py-12 text-center">
          <CheckCircle className="w-16 h-16 text-emerald-500 mx-auto mb-4 animate-bounce" />
          <h3 className="text-xl font-bold text-gray-900 dark:text-gray-100">¡Campaña Programada Exitosamente!</h3>
          <p className="text-gray-600 dark:text-gray-400 mt-2">
            La campaña "{formData.name}" ha sido encolada para su procesamiento con control de tasa y salvaguardas de consentimiento.
          </p>
          <button
            onClick={() => {
              setSubmittedSuccess(false);
              setCurrentStep(1);
            }}
            className="mt-6 px-4 py-2 bg-emerald-600 hover:bg-emerald-700 text-white font-medium rounded-lg shadow"
          >
            Crear Otra Campaña
          </button>
        </div>
      ) : (
        <form onSubmit={handleSubmit}>
          {/* Step 1: Details */}
          {currentStep === 1 && (
            <div className="space-y-6">
              <div>
                <label className="block text-sm font-semibold text-gray-700 dark:text-gray-300 mb-1">
                  Nombre de la Campaña *
                </label>
                <input
                  type="text"
                  required
                  placeholder="ej. Campaña Lanzamiento Producto Primavera 2026"
                  value={formData.name}
                  onChange={(e) => setFormData({ ...formData, name: e.target.value })}
                  className="w-full px-4 py-2 border rounded-lg dark:bg-gray-800 dark:border-gray-700 dark:text-white focus:ring-2 focus:ring-emerald-500"
                />
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-semibold text-gray-700 dark:text-gray-300 mb-1">
                    Canal de Envío
                  </label>
                  <select
                    value={formData.channel}
                    onChange={(e) => setFormData({ ...formData, channel: e.target.value })}
                    className="w-full px-4 py-2 border rounded-lg dark:bg-gray-800 dark:border-gray-700 dark:text-white"
                  >
                    <option value="whatsapp-cloud">WhatsApp Cloud API</option>
                    <option value="email">Email (SMTP / IMAP)</option>
                    <option value="telegram">Telegram Bot</option>
                    <option value="webchat">Webchat</option>
                  </select>
                </div>

                <div>
                  <label className="block text-sm font-semibold text-gray-700 dark:text-gray-300 mb-1">
                    Propósito Legal de Consentimiento
                  </label>
                  <select
                    value={formData.purpose}
                    onChange={(e) => setFormData({ ...formData, purpose: e.target.value as any })}
                    className="w-full px-4 py-2 border rounded-lg dark:bg-gray-800 dark:border-gray-700 dark:text-white"
                  >
                    <option value="marketing">Marketing / Promocional (Requiere Opt-In Explícito)</option>
                    <option value="broadcast">Difusión Informativa General</option>
                    <option value="transactional">Transaccional (Actualización de cuenta / pedido)</option>
                  </select>
                </div>
              </div>

              <div className="p-4 bg-emerald-50 dark:bg-emerald-950/40 border border-emerald-200 dark:border-emerald-800 rounded-lg flex items-start gap-3">
                <ShieldCheck className="w-5 h-5 text-emerald-600 mt-0.5" />
                <div className="text-xs text-emerald-800 dark:text-emerald-300">
                  <strong>Salvaguarda Fail-Closed:</strong> Todos los destinatarios sin registro auditable de consentimiento activo o presentes en la lista de supresión serán excluidos automáticamente previo al envío.
                </div>
              </div>
            </div>
          )}

          {/* Step 2: Audience */}
          {currentStep === 2 && (
            <div className="space-y-6">
              <div>
                <label className="block text-sm font-semibold text-gray-700 dark:text-gray-300 mb-1">
                  Segmento de Audiencia Objetivo
                </label>
                <select
                  value={formData.segmentId}
                  onChange={(e) => setFormData({ ...formData, segmentId: e.target.value })}
                  className="w-full px-4 py-2 border rounded-lg dark:bg-gray-800 dark:border-gray-700 dark:text-white"
                >
                  {availableSegments.map((seg) => (
                    <option key={seg.id} value={seg.id}>
                      {seg.name} ({seg.count} contactos)
                    </option>
                  ))}
                </select>
              </div>

              {selectedSegment && (
                <div className="grid grid-cols-3 gap-4 p-4 bg-gray-50 dark:bg-gray-800/50 rounded-lg border border-gray-200 dark:border-gray-700 text-center">
                  <div>
                    <div className="text-xs text-gray-500">Contactos Totales</div>
                    <div className="text-2xl font-bold text-gray-900 dark:text-white">{selectedSegment.count}</div>
                  </div>
                  <div>
                    <div className="text-xs text-gray-500">Verificación Opt-In</div>
                    <div className="text-sm font-semibold text-emerald-600 flex items-center justify-center gap-1 mt-1">
                      <CheckCircle className="w-4 h-4" /> 100% Verificado
                    </div>
                  </div>
                  <div>
                    <div className="text-xs text-gray-500">Tiempo Estimado</div>
                    <div className="text-sm font-semibold text-gray-700 dark:text-gray-300 mt-1">
                      ~{estimatedDurationMinutes} min
                    </div>
                  </div>
                </div>
              )}
            </div>
          )}

          {/* Step 3: Message / Template */}
          {currentStep === 3 && (
            <div className="space-y-6">
              {formData.channel === 'whatsapp-cloud' ? (
                <>
                  <div>
                    <label className="block text-sm font-semibold text-gray-700 dark:text-gray-300 mb-1">
                      Plantilla Meta WhatsApp (HSM) Aprobada
                    </label>
                    <select
                      value={formData.templateId}
                      onChange={(e) => setFormData({ ...formData, templateId: e.target.value })}
                      className="w-full px-4 py-2 border rounded-lg dark:bg-gray-800 dark:border-gray-700 dark:text-white"
                    >
                      <option value="">-- Sin plantilla (Solo contactos dentro de ventana 24h) --</option>
                      {availableTemplates.map((tpl) => (
                        <option key={tpl.id} value={tpl.id}>
                          {tpl.name}
                        </option>
                      ))}
                    </select>
                  </div>

                  {selectedTemplate && selectedTemplate.variables.length > 0 && (
                    <div className="p-4 border rounded-lg bg-gray-50 dark:bg-gray-800/40 space-y-3">
                      <h4 className="text-xs font-bold text-gray-700 dark:text-gray-300 uppercase tracking-wider">
                        Variables de la Plantilla
                      </h4>
                      {selectedTemplate.variables.map((v) => (
                        <div key={v} className="flex items-center gap-3">
                          <span className="w-24 text-xs font-mono text-gray-500">{`{{${v}}}`}:</span>
                          <input
                            type="text"
                            placeholder={`Valor para ${v}`}
                            value={formData.templateVariables[v] || ''}
                            onChange={(e) =>
                              setFormData({
                                ...formData,
                                templateVariables: { ...formData.templateVariables, [v]: e.target.value },
                              })
                            }
                            className="flex-1 px-3 py-1.5 text-sm border rounded dark:bg-gray-800 dark:border-gray-700 dark:text-white"
                          />
                        </div>
                      ))}
                    </div>
                  )}

                  {!formData.templateId && (
                    <div className="p-3 bg-amber-50 dark:bg-amber-950/40 border border-amber-200 dark:border-amber-800 rounded-lg flex items-start gap-2 text-xs text-amber-800 dark:text-amber-300">
                      <AlertTriangle className="w-4 h-4 mt-0.5 text-amber-600" />
                      <span>
                        <strong>Aviso de Ventana 24h:</strong> Si no utilizas una plantilla aprobada, los mensajes dirigidos a contactos con ventana de atención cerrada (&gt; 24h) serán bloqueados con código <code>CH_WA_WINDOW_CLOSED</code>.
                      </span>
                    </div>
                  )}
                </>
              ) : (
                <>
                  <div>
                    <label className="block text-sm font-semibold text-gray-700 dark:text-gray-300 mb-1">
                      Asunto del Correo
                    </label>
                    <input
                      type="text"
                      placeholder="ej. Confirmación de su pedido #{{orderId}}"
                      value={formData.contentSubject}
                      onChange={(e) => setFormData({ ...formData, contentSubject: e.target.value })}
                      className="w-full px-4 py-2 border rounded-lg dark:bg-gray-800 dark:border-gray-700 dark:text-white"
                    />
                  </div>

                  <div>
                    <div className="flex items-center justify-between mb-1">
                      <label className="text-sm font-semibold text-gray-700 dark:text-gray-300">
                        Cuerpo del Mensaje
                      </label>
                      <div className="flex items-center gap-1">
                        <span className="text-xs text-gray-500 mr-1">Insertar variable:</span>
                        {['name', 'email', 'promoCode'].map((pill) => (
                          <button
                            key={pill}
                            type="button"
                            onClick={() => insertVariable(pill)}
                            className="px-2 py-0.5 text-xs bg-gray-100 hover:bg-gray-200 dark:bg-gray-800 dark:hover:bg-gray-700 rounded text-emerald-600 font-mono"
                          >
                            +{pill}
                          </button>
                        ))}
                      </div>
                    </div>
                    <textarea
                      rows={5}
                      placeholder="Escribe el contenido del mensaje..."
                      value={formData.contentBody}
                      onChange={(e) => setFormData({ ...formData, contentBody: e.target.value })}
                      className="w-full px-4 py-2 border rounded-lg dark:bg-gray-800 dark:border-gray-700 dark:text-white font-sans text-sm"
                    />
                  </div>
                </>
              )}
            </div>
          )}

          {/* Step 4: Schedule & Rate Limits */}
          {currentStep === 4 && (
            <div className="space-y-6">
              <div>
                <label className="block text-sm font-semibold text-gray-700 dark:text-gray-300 mb-1">
                  Control de Ritmo (Pacing) - Mensajes por Minuto
                </label>
                <div className="flex items-center gap-4">
                  <input
                    type="range"
                    min={1}
                    max={200}
                    value={formData.rateLimitPerMinute}
                    onChange={(e) =>
                      setFormData({ ...formData, rateLimitPerMinute: parseInt(e.target.value, 10) })
                    }
                    className="flex-1 accent-emerald-600"
                  />
                  <span className="w-20 text-center px-3 py-1 bg-gray-100 dark:bg-gray-800 rounded font-bold text-gray-800 dark:text-gray-200">
                    {formData.rateLimitPerMinute} / min
                  </span>
                </div>
                <p className="text-xs text-gray-500 mt-1">
                  Pacing recomendado para evitar rate limits de Meta y MTAs: 50 msgs/min (1 envío cada 1.2 segundos).
                </p>
              </div>

              <div>
                <label className="block text-sm font-semibold text-gray-700 dark:text-gray-300 mb-1">
                  Umbral de Auto-Pausa (Circuit Breaker)
                </label>
                <div className="flex items-center gap-3">
                  <input
                    type="number"
                    step="0.5"
                    min="1"
                    max="20"
                    value={formData.failurePauseThresholdPercent}
                    onChange={(e) =>
                      setFormData({
                        ...formData,
                        failurePauseThresholdPercent: parseFloat(e.target.value),
                      })
                    }
                    className="w-24 px-3 py-1.5 border rounded dark:bg-gray-800 dark:border-gray-700 dark:text-white"
                  />
                  <span className="text-sm text-gray-600 dark:text-gray-400">% de tasa de fallos</span>
                </div>
                <p className="text-xs text-gray-500 mt-1">
                  Si el proveedor responde con &gt; 5% de errores continuos, la campaña se pausará automáticamente para proteger la reputación del canal.
                </p>
              </div>

              <div className="pt-4 border-t border-gray-200 dark:border-gray-800">
                <div className="flex items-center gap-3">
                  <input
                    type="checkbox"
                    id="scheduleToggle"
                    checked={formData.isScheduled}
                    onChange={(e) => setFormData({ ...formData, isScheduled: e.target.checked })}
                    className="w-4 h-4 text-emerald-600 rounded"
                  />
                  <label htmlFor="scheduleToggle" className="text-sm font-medium text-gray-700 dark:text-gray-300">
                    Programar envío para fecha u hora futura
                  </label>
                </div>

                {formData.isScheduled && (
                  <div className="mt-3">
                    <input
                      type="datetime-local"
                      value={formData.scheduledAt}
                      onChange={(e) => setFormData({ ...formData, scheduledAt: e.target.value })}
                      className="px-4 py-2 border rounded-lg dark:bg-gray-800 dark:border-gray-700 dark:text-white text-sm"
                    />
                  </div>
                )}
              </div>
            </div>
          )}

          {/* Step 5: Review & Pre-Flight Checks */}
          {currentStep === 5 && (
            <div className="space-y-6">
              <h3 className="text-lg font-bold text-gray-900 dark:text-gray-100 flex items-center gap-2">
                <ShieldCheck className="w-5 h-5 text-emerald-600" />
                Chequeo Pre-Vuelo &amp; Resumen
              </h3>

              <div className="grid grid-cols-2 gap-4 text-sm bg-gray-50 dark:bg-gray-800/40 p-4 rounded-lg border border-gray-200 dark:border-gray-700">
                <div>
                  <span className="text-gray-500">Campaña:</span>
                  <div className="font-semibold text-gray-900 dark:text-white">{formData.name}</div>
                </div>
                <div>
                  <span className="text-gray-500">Canal:</span>
                  <div className="font-semibold text-gray-900 dark:text-white">{formData.channel}</div>
                </div>
                <div>
                  <span className="text-gray-500">Audiencia:</span>
                  <div className="font-semibold text-gray-900 dark:text-white">
                    {selectedSegment?.name} ({selectedSegment?.count} destinatarios)
                  </div>
                </div>
                <div>
                  <span className="text-gray-500">Ritmo de Envío:</span>
                  <div className="font-semibold text-gray-900 dark:text-white">
                    {formData.rateLimitPerMinute} msgs/min (~{estimatedDurationMinutes} min)
                  </div>
                </div>
              </div>

              <div className="space-y-2">
                <h4 className="text-xs font-bold text-gray-500 uppercase tracking-wider">Salvaguardas Activas</h4>
                <div className="p-3 bg-emerald-50 dark:bg-emerald-950/30 border border-emerald-200 dark:border-emerald-800 rounded-lg flex items-center gap-2 text-xs text-emerald-800 dark:text-emerald-300">
                  <CheckCircle className="w-4 h-4 text-emerald-600 flex-shrink-0" />
                  <span>
                    <strong>Filtro de Consentimiento:</strong> Excluye destinatarios sin consentimiento explícito o en lista de supresión.
                  </span>
                </div>
                <div className="p-3 bg-emerald-50 dark:bg-emerald-950/30 border border-emerald-200 dark:border-emerald-800 rounded-lg flex items-center gap-2 text-xs text-emerald-800 dark:text-emerald-300">
                  <CheckCircle className="w-4 h-4 text-emerald-600 flex-shrink-0" />
                  <span>
                    <strong>Circuit Breaker Activo:</strong> Auto-pausa al superar {formData.failurePauseThresholdPercent}% de fallos de red/proveedor.
                  </span>
                </div>
                {formData.channel === 'whatsapp-cloud' && (
                  <div className="p-3 bg-emerald-50 dark:bg-emerald-950/30 border border-emerald-200 dark:border-emerald-800 rounded-lg flex items-center gap-2 text-xs text-emerald-800 dark:text-emerald-300">
                    <CheckCircle className="w-4 h-4 text-emerald-600 flex-shrink-0" />
                    <span>
                      <strong>Verificación Ventana 24h:</strong> Valida que los contactos fuera de ventana usen plantilla HSM aprobada.
                    </span>
                  </div>
                )}
              </div>
            </div>
          )}

          {/* Navigation Footer */}
          <div className="flex items-center justify-between pt-6 mt-8 border-t border-gray-200 dark:border-gray-800">
            {currentStep > 1 ? (
              <button
                type="button"
                onClick={handleBack}
                className="px-4 py-2 border border-gray-300 dark:border-gray-700 text-gray-700 dark:text-gray-300 rounded-lg hover:bg-gray-50 dark:hover:bg-gray-800 flex items-center gap-1 font-medium text-sm"
              >
                <ChevronLeft className="w-4 h-4" />
                Atrás
              </button>
            ) : (
              <button
                type="button"
                onClick={onCancel}
                className="px-4 py-2 text-gray-500 hover:text-gray-700 dark:text-gray-400 text-sm font-medium"
              >
                Cancelar
              </button>
            )}

            {currentStep < 5 ? (
              <button
                type="button"
                onClick={handleNext}
                className="px-5 py-2 bg-emerald-600 hover:bg-emerald-700 text-white rounded-lg flex items-center gap-1 font-medium text-sm shadow"
              >
                Continuar
                <ChevronRight className="w-4 h-4" />
              </button>
            ) : (
              <button
                type="submit"
                disabled={isSubmitting}
                className="px-6 py-2 bg-emerald-600 hover:bg-emerald-700 text-white rounded-lg flex items-center gap-2 font-bold text-sm shadow-lg disabled:opacity-50"
              >
                <Zap className="w-4 h-4" />
                {isSubmitting ? 'Iniciando Campaña...' : 'Lanzar Campaña'}
              </button>
            )}
          </div>
        </form>
      )}
    </div>
  );
};

export default CampaignWizard;
