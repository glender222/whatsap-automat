import { api, type AuthRequestConfig } from '../../../shared/axios/http';
import { isAxiosError } from 'axios';

export interface CompanyOverview {
  company: {
    id: number;
    name: string;
    createdAt?: string | null;
  };
  user: {
    id: number;
    nombre: string;
    email: string;
    rol: 'ADMIN' | 'EMPLEADO';
    idPadre?: number | null;
    companyId: number;
    activo: boolean;
  } | null;
  whatsapp: {
    provider: string;
    configured: boolean;
    connected: boolean;
    requiresQr: boolean;
    hasQr: boolean;
    phoneNumberId?: string | null;
    wabaId?: string | null;
    displayPhoneNumber?: string | null;
    graphVersion?: string | null;
    accountStatus?: string | null;
    webhookPath?: string | null;
    tokenConfigured: boolean;
    tokenLastFour?: string | null;
    tokenConfiguredAt?: string | null;
    lastErrorMessage?: string | null;
    webhookVerifyTokenConfigured?: boolean;
    message?: string | null;
  };
}

export interface WhatsAppCompanyConnection {
  id?: number;
  companyId?: number;
  provider?: string;
  wabaId?: string | null;
  phoneNumberId?: string | null;
  displayPhoneNumber?: string | null;
  businessPhoneNumber?: string | null;
  graphVersion?: string | null;
  appId?: string | null;
  businessId?: string | null;
  status?: string | null;
  tokenConfigured?: boolean;
  tokenLastFour?: string | null;
  webhookVerifyTokenConfigured?: boolean;
  connectedAt?: string | null;
  updatedAt?: string | null;
}

export interface WhatsAppConnectionPayload {
  phoneNumberId: string;
  accessToken?: string;
  wabaId?: string;
  displayPhoneNumber?: string;
  graphVersion?: string;
  appId?: string;
  businessId?: string;
  webhookVerifyToken?: string;
}

export interface ConnectionHealth {
  configured: boolean;
  authorized: boolean;
  lastErrorCode: string | null;
  lastCheckedAt: string | null;
}

export interface MetaConnectionDiagnostic {
  id: string;
  tenantId: string;
  channel: string;
  externalAccountId: string;
  health: ConnectionHealth;
}

function isHealth(value: unknown): value is ConnectionHealth {
  if (!value || typeof value !== 'object') return false;
  const health = value as Partial<ConnectionHealth>;
  return typeof health.configured === 'boolean' && typeof health.authorized === 'boolean' &&
    (health.lastErrorCode === null || typeof health.lastErrorCode === 'string') &&
    (health.lastCheckedAt === null || typeof health.lastCheckedAt === 'string');
}

export class CompanyService {
  static async getOverview(): Promise<CompanyOverview> {
    const { data } = await api.get('/company/me');
    if (data?.success !== true || !data.data?.company?.id || !data.data?.whatsapp?.provider) {
      throw new Error('El servidor no confirmó la configuración de esta empresa.');
    }
    return data.data;
  }

  static async getWhatsAppConnection(): Promise<{
    connection: WhatsAppCompanyConnection | null;
    status: CompanyOverview['whatsapp'];
    webhook: { callbackPath: string; verifyTokenConfigured: boolean };
  }> {
    const { data } = await api.get('/company/whatsapp/connection');
    return data.data;
  }

  static async saveWhatsAppConnection(payload: WhatsAppConnectionPayload, sessionGeneration: number): Promise<WhatsAppCompanyConnection> {
    const messages: Record<string, string> = {
      META_PHONE_ACCESS_NOT_VERIFIED: 'La credencial no acredita acceso a esta línea. Revisa el ID, el token y sus permisos.',
      META_CONNECTION_INVALID: 'Ingresa un ID de línea y una versión de Graph válidos.',
      META_PHONE_VERIFICATION_UNAVAILABLE: 'Meta no está disponible para verificar la línea. Vuelve a intentar.',
    };
    const config: AuthRequestConfig = { sessionGeneration };
    const { data } = await api.post('/company/whatsapp/connection', payload, config).catch((cause: unknown) => {
      const response = isAxiosError<{ error?: unknown }>(cause) ? cause.response : undefined;
      const code = response?.data?.error;
      const message = typeof code === 'string' && Object.hasOwn(messages, code) ? messages[code]
        : response?.status === 403 ? 'Solo un administrador puede guardar la conexión.'
          : 'No pudimos confirmar el guardado. Actualiza la conexión antes de volver a intentar.';
      throw new Error(message);
    });
    if (data?.success !== true || data.data?.provider !== 'meta-cloud' || data.data.phoneNumberId !== payload.phoneNumberId) {
      throw new Error('El servidor no confirmó los datos de conexión guardados.');
    }
    return data.data;
  }

  static async disconnectWhatsAppConnection(sessionGeneration: number, signal: AbortSignal): Promise<void> {
    const config: AuthRequestConfig = { sessionGeneration, signal };
    const { data } = await api.delete('/company/whatsapp/connection', config);
    if (data?.success !== true) throw new Error('El servidor no confirmó la desconexión.');
  }

  static async getConnectionDiagnostic(companyId: number, phoneNumberId: string, signal: AbortSignal): Promise<MetaConnectionDiagnostic | null> {
    let after: string | undefined;
    const cursors = new Set<string>();
    do {
      const { data, headers } = await api.get<MetaConnectionDiagnostic[]>('/v1/channel-connections', {
        params: { limit: 100, after }, signal,
      });
      if (!Array.isArray(data) || data.some((entry) => !entry || entry.tenantId !== String(companyId) ||
          typeof entry.id !== 'string' || typeof entry.externalAccountId !== 'string' || !isHealth(entry.health))) {
        throw new Error('El servidor no confirmó las conexiones de esta empresa.');
      }
      const connection = data.find((entry) => entry.channel === 'whatsapp-cloud' && entry.externalAccountId === phoneNumberId);
      if (connection) return connection;
      const cursor = headers['x-next-cursor'];
      after = typeof cursor === 'string' && cursor ? decodeURIComponent(cursor) : undefined;
      if (after && cursors.has(after)) throw new Error('El servidor repitió una página de conexiones.');
      if (after) cursors.add(after);
    } while (after);
    return null;
  }

  static async checkConnection(id: string, signal: AbortSignal): Promise<ConnectionHealth> {
    const { data } = await api.post(`/v1/channel-connections/${encodeURIComponent(id)}/validate`, {}, { signal });
    if (!isHealth(data)) throw new Error('El servidor no confirmó el diagnóstico de la conexión.');
    return data;
  }
}
