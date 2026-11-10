import React, { useEffect, useRef, useState, type FormEvent } from 'react';
import { WhatsAppService } from '../services/whatsappService';
import { CompanyService, type CompanyOverview, type WhatsAppConnectionPayload } from '../services/companyService';

interface WhatsAppConnectionSectionProps {
  numeroAfiliado: string | null;
  afiliando: boolean;
  loggingOut: boolean;
  qrUrl: string | null;
  companyOverview?: CompanyOverview | null;
  loadingOverview?: boolean;
  canManageConnection?: boolean;
  onConnectionSaved?: () => Promise<void> | void;
  onAfiliar?: () => void;
  onDesafiliar?: () => void;
}

/**
 * Sección de configuración de número afiliado de WhatsApp
 */
const WhatsAppConnectionSection: React.FC<WhatsAppConnectionSectionProps> = ({
  numeroAfiliado,
  afiliando,
  loggingOut,
  qrUrl,
  companyOverview,
  loadingOverview,
  canManageConnection,
  onConnectionSaved,
  onAfiliar,
  onDesafiliar
}) => {
  const [form, setForm] = useState<WhatsAppConnectionPayload>({
    phoneNumberId: '',
    accessToken: '',
    wabaId: '',
    displayPhoneNumber: '',
    graphVersion: 'v25.0',
    appId: '',
    businessId: '',
    webhookVerifyToken: '',
  });
  const [saving, setSaving] = useState(false);
  const submitting = useRef(false);
  const [saveMessage, setSaveMessage] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const whatsapp = companyOverview?.whatsapp;
  const isMetaCloud = whatsapp?.provider === 'meta-cloud';
  const legacyUnavailable = whatsapp?.accountStatus === 'unavailable_for_company';
  const isLegacy = whatsapp?.provider === 'webjs' && !legacyUnavailable && !loadingOverview;
  const displayNumber = legacyUnavailable ? null : whatsapp?.displayPhoneNumber || numeroAfiliado;
  const statusLabel = isMetaCloud
    ? whatsapp?.accountStatus === 'disconnected' ? 'Desconectado' : whatsapp?.configured ? 'Configurado' : 'Pendiente'
    : legacyUnavailable ? 'No disponible' : whatsapp?.connected ? 'Conectado' : 'Pendiente';
  const statusClass = statusLabel === 'Conectado' || statusLabel === 'Configurado'
    ? 'bg-emerald-50 text-emerald-700 border-emerald-200 dark:bg-emerald-950/40 dark:text-emerald-300 dark:border-emerald-800'
    : 'bg-amber-50 text-amber-700 border-amber-200 dark:bg-amber-950/40 dark:text-amber-300 dark:border-amber-800';
  const tokenInfo = whatsapp?.tokenConfigured
    ? `Configurado${whatsapp.tokenLastFour ? ` · termina en ${whatsapp.tokenLastFour}` : ''}`
    : 'Pendiente';

  useEffect(() => {
    setForm((current) => ({
      ...current,
      phoneNumberId: whatsapp?.phoneNumberId || '',
      wabaId: whatsapp?.wabaId || '',
      displayPhoneNumber: whatsapp?.displayPhoneNumber || '',
      graphVersion: whatsapp?.graphVersion || 'v25.0',
      accessToken: '',
    }));
  }, [whatsapp?.phoneNumberId, whatsapp?.wabaId, whatsapp?.displayPhoneNumber, whatsapp?.graphVersion]);

  const updateField = (field: keyof WhatsAppConnectionPayload, value: string) => {
    setSaveMessage(null);
    setSaveError(null);
    setForm((current) => ({ ...current, [field]: value }));
  };

  const handleSaveConnection = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (submitting.current || loadingOverview || !isMetaCloud || !canManageConnection || !form.phoneNumberId.trim()) return;
    submitting.current = true;
    setSaving(true);
    setSaveMessage(null);
    setSaveError(null);
    try {
      const saved = await CompanyService.saveWhatsAppConnection({
        ...form,
        phoneNumberId: form.phoneNumberId.trim(),
        accessToken: form.accessToken?.trim() || undefined,
        wabaId: form.wabaId?.trim() || undefined,
        displayPhoneNumber: form.displayPhoneNumber?.trim() || undefined,
        graphVersion: form.graphVersion?.trim() || 'v25.0',
        appId: form.appId?.trim() || undefined,
        businessId: form.businessId?.trim() || undefined,
        webhookVerifyToken: form.webhookVerifyToken?.trim() || undefined,
      });
      if (saved.companyId !== companyOverview?.company.id) throw new Error('El servidor no confirmó el guardado para esta empresa.');
      setForm((current) => ({ ...current, accessToken: '' }));
      setSaveMessage('Datos de conexión guardados para esta empresa.');
      await onConnectionSaved?.();
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : 'No se pudo guardar la conexión.');
    } finally {
      submitting.current = false;
      setSaving(false);
    }
  };

  return (
    <div>
      {companyOverview && (
        <div className="mb-4 grid gap-3 md:grid-cols-3">
          <div className="rounded-lg border border-gray-200 dark:border-gray-700 p-3">
            <div className="text-xs uppercase text-gray-500 dark:text-gray-400">Empresa</div>
            <div className="mt-1 text-sm font-medium text-gray-900 dark:text-gray-100">
              {companyOverview.company.name}
            </div>
          </div>
          <div className="rounded-lg border border-gray-200 dark:border-gray-700 p-3">
            <div className="text-xs uppercase text-gray-500 dark:text-gray-400">Proveedor</div>
            <div className="mt-1 text-sm font-medium text-gray-900 dark:text-gray-100">
              {isMetaCloud ? 'Meta Cloud API' : whatsapp?.provider === 'webjs' ? 'WhatsApp Web' : whatsapp?.provider}
            </div>
          </div>
          <div className="rounded-lg border border-gray-200 dark:border-gray-700 p-3">
            <div className="text-xs uppercase text-gray-500 dark:text-gray-400">Estado</div>
            <div className={`mt-1 inline-flex rounded-full border px-2.5 py-1 text-xs font-semibold ${statusClass}`}>
              {statusLabel}
            </div>
          </div>
        </div>
      )}

      <div className="flex flex-col md:flex-row md:items-center md:justify-between border-b border-gray-200 dark:border-gray-700 py-3 md:py-4 gap-3 md:gap-0">
        <span className="text-gray-700 dark:text-gray-300 text-base md:text-lg font-medium">
          Número WhatsApp Business
        </span>
        <div className="flex items-center gap-2 flex-wrap">
          <span className="px-3 md:px-4 py-1 rounded-full bg-gray-50 dark:bg-gray-700 border border-gray-200 dark:border-gray-600 text-gray-800 dark:text-gray-200 text-base md:text-lg font-mono min-w-[100px] text-center">
            {loadingOverview ? <span role="status">Cargando…</span> : companyOverview
              ? WhatsAppService.formatNumeroAfiliado(displayNumber || null) : 'Estado no disponible'}
          </span>
          {isLegacy && !numeroAfiliado && onAfiliar && (
            <button
              className="px-3 md:px-4 py-1.5 md:py-1 rounded-lg bg-blue-600 dark:bg-blue-700 text-white text-sm md:text-base font-medium hover:bg-blue-700 dark:hover:bg-blue-800 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              onClick={onAfiliar}
              disabled={afiliando}
            >
              Afiliar
            </button>
          )}
          {isLegacy && numeroAfiliado && onDesafiliar && (
            <button
              className="px-3 md:px-4 py-1.5 md:py-1 rounded-lg bg-red-600 dark:bg-red-700 text-white text-sm md:text-base font-medium hover:bg-red-700 dark:hover:bg-red-800 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              onClick={onDesafiliar}
              disabled={loggingOut}
            >
              {loggingOut ? 'Desafiliando...' : 'Desafiliar'}
            </button>
          )}
        </div>
      </div>

      {legacyUnavailable && (
        <p className="mt-3 text-sm text-gray-600 dark:text-gray-300">
          El dispositivo de desarrollo está reservado para la empresa configurada en el servidor.
        </p>
      )}

      {isMetaCloud && whatsapp && (
        <div className="mt-4 grid gap-3 md:grid-cols-2">
          <div className="rounded-lg border border-gray-200 dark:border-gray-700 p-3">
            <div className="text-xs uppercase text-gray-500 dark:text-gray-400">Webhook</div>
            <div className="mt-1 break-all text-sm font-mono text-gray-800 dark:text-gray-200">
              {whatsapp.webhookPath || '/api/webhooks/meta/whatsapp'}
            </div>
          </div>
          <div className="rounded-lg border border-gray-200 dark:border-gray-700 p-3">
            <div className="text-xs uppercase text-gray-500 dark:text-gray-400">Token Meta</div>
            <div className="mt-1 text-sm font-medium text-gray-900 dark:text-gray-100">
              {tokenInfo}
            </div>
            {whatsapp.tokenConfiguredAt && (
              <div className="mt-1 text-xs text-gray-500 dark:text-gray-400">
                Actualizado: {new Date(whatsapp.tokenConfiguredAt).toLocaleString()}
              </div>
            )}
          </div>
        </div>
      )}

      {isMetaCloud && whatsapp?.lastErrorMessage && (
        <div className="mt-4 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700 dark:border-red-900/60 dark:bg-red-950/30 dark:text-red-300">
          <div className="font-semibold">Último error de Meta</div>
          <div className="mt-1">{whatsapp.lastErrorMessage}</div>
        </div>
      )}

      {isMetaCloud && canManageConnection && (
        <form onSubmit={handleSaveConnection} aria-labelledby="whatsapp-meta-settings" className="mt-5 rounded-lg border border-gray-200 dark:border-gray-700 p-4">
          <div className="mb-3">
            <h3 id="whatsapp-meta-settings" className="text-sm font-semibold text-gray-900 dark:text-gray-100">
              Meta Cloud API
            </h3>
            <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
              Actualiza las credenciales de esta empresa. El token se cifra, no se vuelve a mostrar y reemplaza el anterior solo si escribes uno nuevo.
            </p>
          </div>

          <div className="grid gap-3 md:grid-cols-2">
            <label className="block">
              <span className="text-xs font-medium text-gray-600 dark:text-gray-400">Id. número de teléfono</span>
              <input
                value={form.phoneNumberId}
                onChange={(event) => updateField('phoneNumberId', event.target.value)}
                inputMode="numeric"
                required
                className="mt-1 w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 focus:outline-none focus:ring-2 focus:ring-emerald-500 dark:border-gray-600 dark:bg-gray-700 dark:text-gray-100"
                placeholder="1141867852333596"
              />
            </label>
            <label className="block">
              <span className="text-xs font-medium text-gray-600 dark:text-gray-400">Id. cuenta WhatsApp Business</span>
              <input
                value={form.wabaId || ''}
                onChange={(event) => updateField('wabaId', event.target.value)}
                className="mt-1 w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 focus:outline-none focus:ring-2 focus:ring-emerald-500 dark:border-gray-600 dark:bg-gray-700 dark:text-gray-100"
                placeholder="1505923937599708"
              />
            </label>
            <label className="block">
              <span className="text-xs font-medium text-gray-600 dark:text-gray-400">Número visible</span>
              <input
                value={form.displayPhoneNumber || ''}
                onChange={(event) => updateField('displayPhoneNumber', event.target.value)}
                className="mt-1 w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 focus:outline-none focus:ring-2 focus:ring-emerald-500 dark:border-gray-600 dark:bg-gray-700 dark:text-gray-100"
                placeholder="15556478057"
              />
            </label>
            <label className="block">
              <span className="text-xs font-medium text-gray-600 dark:text-gray-400">Graph version</span>
              <input
                value={form.graphVersion || ''}
                onChange={(event) => updateField('graphVersion', event.target.value)}
                className="mt-1 w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 focus:outline-none focus:ring-2 focus:ring-emerald-500 dark:border-gray-600 dark:bg-gray-700 dark:text-gray-100"
                placeholder="v25.0"
              />
            </label>
            <label className="block md:col-span-2">
              <span className="text-xs font-medium text-gray-600 dark:text-gray-400">
                Token permanente
              </span>
              <input
                type="password"
                autoComplete="off"
                value={form.accessToken || ''}
                onChange={(event) => updateField('accessToken', event.target.value)}
                className="mt-1 w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 focus:outline-none focus:ring-2 focus:ring-emerald-500 dark:border-gray-600 dark:bg-gray-700 dark:text-gray-100"
                placeholder={whatsapp.tokenConfigured ? `Token actual configurado${whatsapp.tokenLastFour ? `, termina en ${whatsapp.tokenLastFour}` : ''}` : 'Pega el token de Meta'}
              />
            </label>
            <label className="block">
              <span className="text-xs font-medium text-gray-600 dark:text-gray-400">Id. aplicación Meta</span>
              <input
                value={form.appId || ''}
                onChange={(event) => updateField('appId', event.target.value)}
                className="mt-1 w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 focus:outline-none focus:ring-2 focus:ring-emerald-500 dark:border-gray-600 dark:bg-gray-700 dark:text-gray-100"
                placeholder="Opcional"
              />
            </label>
            <label className="block">
              <span className="text-xs font-medium text-gray-600 dark:text-gray-400">Id. negocio Meta</span>
              <input
                value={form.businessId || ''}
                onChange={(event) => updateField('businessId', event.target.value)}
                className="mt-1 w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 focus:outline-none focus:ring-2 focus:ring-emerald-500 dark:border-gray-600 dark:bg-gray-700 dark:text-gray-100"
                placeholder="Opcional"
              />
            </label>
          </div>

          <div className="mt-4 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
            <div className="min-w-0 text-xs text-gray-500 dark:text-gray-400">
              Webhook <span className="break-all font-mono">/api/webhooks/meta/whatsapp</span>. Guarda un token nuevo si ves errores 401.
            </div>
            <button
              type="submit"
              disabled={saving || loadingOverview || !form.phoneNumberId.trim()}
              className="min-h-11 rounded-lg bg-emerald-700 px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-emerald-800 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {saving ? 'Guardando...' : 'Guardar conexión'}
            </button>
          </div>

          {saveMessage && <div role="status" className="mt-3 text-sm text-emerald-700 dark:text-emerald-300">{saveMessage}</div>}
          {saveError && <div role="alert" className="mt-3 text-sm text-red-700 dark:text-red-300">{saveError}</div>}
        </form>
      )}
      
      {/* Modal QR */}
      {isLegacy && afiliando && (
        <div className="flex flex-col items-center mt-4 px-4 bg-gradient-to-br from-gray-50 to-gray-100 dark:from-gray-800 dark:to-gray-700 rounded-xl p-6 border-2 border-gray-200 dark:border-gray-600">
          <div className="text-gray-800 dark:text-gray-200 mb-4 text-base md:text-lg font-semibold">
            Conecta tu WhatsApp
          </div>
          <div className="text-gray-600 dark:text-gray-400 mb-4 text-sm md:text-base text-center max-w-md">
            Abre WhatsApp en tu teléfono, ve a <strong>Dispositivos vinculados</strong> y escanea este código QR
          </div>
          {qrUrl ? (
            <div className="bg-white dark:bg-gray-900 p-4 rounded-xl shadow-lg">
              <img 
                src={qrUrl} 
                alt="QR de WhatsApp" 
                className="w-48 h-48 md:w-56 md:h-56"
              />
            </div>
          ) : (
            <div className="bg-white dark:bg-gray-900 p-8 rounded-xl shadow-lg flex items-center justify-center">
              <div className="flex flex-col items-center gap-3">
                <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-emerald-500"></div>
                <div className="text-gray-600 dark:text-gray-400 text-sm md:text-base">Inicializando WhatsApp...</div>
              </div>
            </div>
          )}
          <div className="text-xs md:text-sm text-gray-500 dark:text-gray-400 mt-4 flex items-center gap-2">
            <div className="w-2 h-2 bg-emerald-500 rounded-full animate-pulse"></div>
            Esperando conexión...
          </div>
        </div>
      )}
    </div>
  );
};

export default WhatsAppConnectionSection;
