import { api } from '../../../shared/axios/http';

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

  static async saveWhatsAppConnection(payload: WhatsAppConnectionPayload): Promise<WhatsAppCompanyConnection> {
    const { data } = await api.post('/company/whatsapp/connection', payload);
    if (data?.success !== true || data.data?.provider !== 'meta-cloud' || data.data.phoneNumberId !== payload.phoneNumberId) {
      throw new Error('El servidor no confirmó los datos de conexión guardados.');
    }
    return data.data;
  }

  static async disconnectWhatsAppConnection(): Promise<void> {
    await api.delete('/company/whatsapp/connection');
  }
}
