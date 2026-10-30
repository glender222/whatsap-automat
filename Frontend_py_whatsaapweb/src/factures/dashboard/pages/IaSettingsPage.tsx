import { useCallback, useEffect, useState } from 'react';
import {
  AlertCircle,
  Check,
  CreditCard,
  Loader2,
  Plus,
  Save,
  Star,
  Trash2,
  X,
  Zap,
} from 'lucide-react';
import {
  iaService,
  type AutomatorMode,
  type PaymentGateway,
  type PaymentGatewayInput,
  type PaymentGatewayProvider,
} from '../services/iaService';

const MODE_DESCRIPTIONS: Record<AutomatorMode, string> = {
  normal: 'La IA queda en silencio. El equipo responde manualmente y puede consultar el historial operativo.',
  mixed: 'La IA sugiere respuestas, registra intención comercial y prepara prepedidos, pero el empleado revisa antes de enviar.',
  automator: 'La IA responde con tools seguras, recomienda ofertas reales y deriva a handoff cuando el cliente quiere comprar. No confirma ventas, pagos ni reservas.',
};

const MODE_LABELS: Record<AutomatorMode, string> = {
  normal: 'Manual',
  mixed: 'Asistido',
  automator: 'Automatico',
};

const PROVIDER_LABELS: Record<PaymentGatewayProvider, string> = {
  mercadopago: 'Mercado Pago',
  stripe: 'Stripe',
  paypal: 'PayPal',
  manual: 'Manual',
  other: 'Otro',
};

const PROVIDER_OPTIONS: Array<{ value: PaymentGatewayProvider; label: string }> = [
  { value: 'mercadopago', label: 'Mercado Pago' },
  { value: 'manual', label: 'Manual' },
  { value: 'stripe', label: 'Stripe' },
  { value: 'paypal', label: 'PayPal' },
  { value: 'other', label: 'Otro' },
];

export default function IaSettingsPage() {
  const [mode, setMode] = useState<AutomatorMode>('normal');
  const [originalMode, setOriginalMode] = useState<AutomatorMode>('normal');
  const [modeLoading, setModeLoading] = useState(true);
  const [modeSaving, setModeSaving] = useState(false);
  const [modeError, setModeError] = useState<string | null>(null);
  const [modeSaved, setModeSaved] = useState(false);

  const [gateways, setGateways] = useState<PaymentGateway[]>([]);
  const [gatewaysLoading, setGatewaysLoading] = useState(true);
  const [gatewaysError, setGatewaysError] = useState<string | null>(null);
  const [showGatewayModal, setShowGatewayModal] = useState(false);
  const [editingGateway, setEditingGateway] = useState<PaymentGateway | null>(null);
  const [gatewayForm, setGatewayForm] = useState<PaymentGatewayInput>({
    provider: 'mercadopago',
    displayName: '',
    credentials: {},
    webhookSecret: '',
    isDefault: false,
    status: 'active',
  });
  const [gatewaySaving, setGatewaySaving] = useState(false);

  const loadMode = useCallback(async () => {
    setModeLoading(true);
    try {
      const current = await iaService.getCompanyMode();
      setMode(current);
      setOriginalMode(current);
      setModeError(null);
    } catch (err: unknown) {
      setModeError(err instanceof Error ? err.message : 'No se pudo cargar el modo IA');
    } finally {
      setModeLoading(false);
    }
  }, []);

  const loadGateways = useCallback(async () => {
    setGatewaysLoading(true);
    try {
      const data = await iaService.listGateways();
      setGateways(data);
      setGatewaysError(null);
    } catch (err: unknown) {
      setGatewaysError(err instanceof Error ? err.message : 'No se pudieron cargar las pasarelas');
    } finally {
      setGatewaysLoading(false);
    }
  }, []);

  useEffect(() => {
    loadMode();
    loadGateways();
  }, [loadMode, loadGateways]);

  const handleSaveMode = async () => {
    setModeSaving(true);
    setModeError(null);
    setModeSaved(false);
    try {
      await iaService.setCompanyMode(mode);
      setOriginalMode(mode);
      setModeSaved(true);
      setTimeout(() => setModeSaved(false), 3000);
    } catch (err: unknown) {
      setModeError(err instanceof Error ? err.message : 'No se pudo guardar el modo');
    } finally {
      setModeSaving(false);
    }
  };

  const openCreateGateway = () => {
    setEditingGateway(null);
    setGatewayForm({
      provider: 'mercadopago',
      displayName: '',
      credentials: {},
      webhookSecret: '',
      isDefault: gateways.length === 0,
      status: 'active',
    });
    setShowGatewayModal(true);
  };

  const openEditGateway = (gateway: PaymentGateway) => {
    setEditingGateway(gateway);
    setGatewayForm({
      provider: gateway.provider,
      displayName: gateway.displayName,
      credentials: gateway.credentials,
      webhookSecret: gateway.webhookSecret || '',
      isDefault: gateway.isDefault,
      status: gateway.status as 'active' | 'inactive',
      metadata: gateway.metadata,
    });
    setShowGatewayModal(true);
  };

  const handleSaveGateway = async () => {
    if (!gatewayForm.displayName.trim()) return;
    setGatewaySaving(true);
    try {
      if (editingGateway) {
        await iaService.updateGateway(editingGateway.id, gatewayForm);
      } else {
        await iaService.createGateway(gatewayForm);
      }
      setShowGatewayModal(false);
      await loadGateways();
    } catch (err: unknown) {
      setGatewaysError(err instanceof Error ? err.message : 'No se pudo guardar la pasarela');
    } finally {
      setGatewaySaving(false);
    }
  };

  const handleArchiveGateway = async (id: number) => {
    if (!confirm('¿Archivar esta pasarela de pago?')) return;
    try {
      await iaService.archiveGateway(id);
      await loadGateways();
    } catch (err: unknown) {
      setGatewaysError(err instanceof Error ? err.message : 'No se pudo archivar');
    }
  };

  return (
    <div className="min-h-full bg-[#F7FAF8] p-6 lg:p-10">
      <div className="mx-auto w-full max-w-5xl space-y-8 pb-20">
        <section className="border-b border-[#D9E5DF] pb-5">
          <p className="text-sm font-semibold uppercase text-[#128C7E]">Configuración IA</p>
          <h2 className="mt-1 text-3xl font-bold text-[#10231C]">Modo IA</h2>
          <p className="mt-2 max-w-3xl text-sm text-[#5B6F66]">
            Define cómo coopera la IA con tu equipo. Solo administradores pueden cambiar este modo.
          </p>
        </section>

        <section className="rounded-2xl border border-[#D9E5DF] bg-white p-6 shadow-sm">
          <div className="mb-4 flex items-center gap-2">
            <Zap className="h-5 w-5 text-[#128C7E]" />
            <h3 className="text-base font-bold text-[#10231C]">Modo de operación</h3>
          </div>

          {modeLoading ? (
            <div className="flex h-24 items-center justify-center text-[#5B6F66]">
              <Loader2 className="h-5 w-5 animate-spin text-[#128C7E]" />
            </div>
          ) : (
            <div className="space-y-3">
              {(['normal', 'mixed', 'automator'] as AutomatorMode[]).map((option) => {
                const isSelected = mode === option;
                const label = MODE_LABELS[option];
                return (
                  <button
                    key={option}
                    type="button"
                    onClick={() => setMode(option)}
                    className={`flex w-full items-start gap-3 rounded-xl border p-4 text-left transition ${
                      isSelected
                        ? 'border-[#128C7E] bg-[#DDF4EF]'
                        : 'border-[#D9E5DF] bg-white hover:bg-[#EEF4F1]'
                    }`}
                  >
                    <div
                      className={`mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full border-2 ${
                        isSelected ? 'border-[#128C7E] bg-[#128C7E]' : 'border-[#D9E5DF]'
                      }`}
                    >
                      {isSelected && <Check className="h-3 w-3 text-white" />}
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="text-sm font-bold text-[#10231C]">{label}</div>
                      <p className="mt-1 text-xs text-[#5B6F66]">{MODE_DESCRIPTIONS[option]}</p>
                    </div>
                  </button>
                );
              })}

              {modeError && (
                <div className="flex items-center gap-2 rounded-lg bg-red-50 p-3 text-sm text-red-700">
                  <AlertCircle className="h-4 w-4" />
                  {modeError}
                </div>
              )}

              <div className="flex items-center gap-3 pt-2">
                <button
                  type="button"
                  onClick={handleSaveMode}
                  disabled={modeSaving || mode === originalMode}
                  className="inline-flex items-center gap-2 rounded-[10px] bg-[#128C7E] px-4 py-2 text-sm font-semibold text-white transition hover:bg-[#0E766A] disabled:opacity-60"
                >
                  {modeSaving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
                  Guardar modo
                </button>
                {modeSaved && (
                  <span className="text-sm font-semibold text-[#006d2f]">Modo actualizado</span>
                )}
              </div>
            </div>
          )}
        </section>

        <section className="rounded-2xl border border-[#D9E5DF] bg-white p-6 shadow-sm">
          <div className="mb-4 flex items-center justify-between">
            <div className="flex items-center gap-2">
              <CreditCard className="h-5 w-5 text-[#128C7E]" />
              <h3 className="text-base font-bold text-[#10231C]">Pasarelas de pago</h3>
            </div>
            <button
              type="button"
              onClick={openCreateGateway}
              className="inline-flex items-center gap-2 rounded-[10px] bg-[#128C7E] px-3 py-2 text-sm font-semibold text-white transition hover:bg-[#0E766A]"
            >
              <Plus className="h-4 w-4" />
              Nueva pasarela
            </button>
          </div>

          <p className="mb-4 text-xs text-[#5B6F66]">
            Configura las pasarelas que la IA puede usar para generar links de pago on-demand. Solo una puede ser la default.
          </p>

          {gatewaysLoading ? (
            <div className="flex h-24 items-center justify-center text-[#5B6F66]">
              <Loader2 className="h-5 w-5 animate-spin text-[#128C7E]" />
            </div>
          ) : gatewaysError ? (
            <div className="flex items-center gap-2 rounded-lg bg-red-50 p-3 text-sm text-red-700">
              <AlertCircle className="h-4 w-4" />
              {gatewaysError}
            </div>
          ) : gateways.length === 0 ? (
            <div className="flex h-24 flex-col items-center justify-center text-center text-sm text-[#5B6F66]">
              <CreditCard className="mb-2 h-6 w-6 text-[#128C7E]/60" />
              Sin pasarelas configuradas. Crea una para habilitar links de pago.
            </div>
          ) : (
            <ul className="divide-y divide-[#D9E5DF]">
              {gateways.map((gateway) => (
                <li key={gateway.id} className="flex items-center justify-between gap-3 py-3 first:pt-0 last:pb-0">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-semibold text-[#10231C]">{gateway.displayName}</span>
                      {gateway.isDefault && (
                        <span className="inline-flex items-center gap-1 rounded-full bg-[#DDF4EF] px-2 py-0.5 text-xs font-semibold text-[#128C7E]">
                          <Star className="h-3 w-3" />
                          Default
                        </span>
                      )}
                      <span className="rounded-full bg-[#EEF4F1] px-2 py-0.5 text-xs font-semibold text-[#5B6F66]">
                        {PROVIDER_LABELS[gateway.provider] || gateway.provider}
                      </span>
                    </div>
                    <div className="mt-1 text-xs text-[#5B6F66]">
                      {gateway.status === 'active' ? 'Activa' : 'Inactiva'}
                    </div>
                  </div>
                  <div className="flex gap-2">
                    <button
                      type="button"
                      onClick={() => openEditGateway(gateway)}
                      className="rounded-md border border-[#D9E5DF] bg-white px-3 py-1.5 text-xs font-semibold text-[#10231C] hover:bg-[#EEF4F1]"
                    >
                      Editar
                    </button>
                    <button
                      type="button"
                      onClick={() => handleArchiveGateway(gateway.id)}
                      className="rounded-md border border-red-200 bg-white px-3 py-1.5 text-xs font-semibold text-red-600 hover:bg-red-50"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>

      {showGatewayModal && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
          onClick={() => setShowGatewayModal(false)}
        >
          <div
            className="w-full max-w-md rounded-2xl bg-white p-6 shadow-xl"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="mb-4 flex items-center justify-between">
              <h3 className="text-lg font-bold text-[#10231C]">
                {editingGateway ? 'Editar pasarela' : 'Nueva pasarela'}
              </h3>
              <button
                type="button"
                onClick={() => setShowGatewayModal(false)}
                className="rounded-md p-1 text-[#5B6F66] hover:bg-[#EEF4F1]"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <div className="space-y-4">
              <div>
                <label className="mb-1 block text-xs font-semibold uppercase text-[#5B6F66]">Proveedor</label>
                <select
                  value={gatewayForm.provider}
                  onChange={(e) => setGatewayForm({ ...gatewayForm, provider: e.target.value as PaymentGatewayProvider })}
                  className="admin-select"
                  disabled={Boolean(editingGateway)}
                >
                  {PROVIDER_OPTIONS.map((opt) => (
                    <option key={opt.value} value={opt.value}>{opt.label}</option>
                  ))}
                </select>
              </div>

              <div>
                <label className="mb-1 block text-xs font-semibold uppercase text-[#5B6F66]">Nombre</label>
                <input
                  type="text"
                  value={gatewayForm.displayName}
                  onChange={(e) => setGatewayForm({ ...gatewayForm, displayName: e.target.value })}
                  placeholder="Ej: Mercado Pago Peru"
                  className="admin-control"
                  autoFocus
                />
              </div>

              <div>
                <label className="mb-1 block text-xs font-semibold uppercase text-[#5B6F66]">
                  Webhook secret (opcional)
                </label>
                <input
                  type="text"
                  value={gatewayForm.webhookSecret || ''}
                  onChange={(e) => setGatewayForm({ ...gatewayForm, webhookSecret: e.target.value })}
                  placeholder="Token de verificación de webhook"
                  className="admin-control"
                />
              </div>

              <label className="flex items-center gap-2 text-sm text-[#10231C]">
                <input
                  type="checkbox"
                  checked={Boolean(gatewayForm.isDefault)}
                  onChange={(e) => setGatewayForm({ ...gatewayForm, isDefault: e.target.checked })}
                  className="h-4 w-4 rounded border-[#D9E5DF]"
                />
                Usar como pasarela default
              </label>

              {gatewayForm.provider === 'mercadopago' && (
                <div className="rounded-lg bg-[#EEF4F1] p-3 text-xs text-[#5B6F66]">
                  Para Mercado Pago necesitarás configurar access_token y public_key en los credenciales. La implementación del webhook llega en F5.
                </div>
              )}
            </div>

            <div className="mt-6 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setShowGatewayModal(false)}
                className="admin-button-secondary"
              >
                Cancelar
              </button>
              <button
                type="button"
                onClick={handleSaveGateway}
                disabled={gatewaySaving || !gatewayForm.displayName.trim()}
                className="inline-flex h-11 items-center justify-center gap-2 rounded-[10px] bg-[#128C7E] px-4 text-sm font-semibold text-white transition hover:bg-[#0E766A] disabled:opacity-60"
              >
                {gatewaySaving && <Loader2 className="h-4 w-4 animate-spin" />}
                {editingGateway ? 'Guardar cambios' : 'Crear pasarela'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
