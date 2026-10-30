import { api } from '../../../shared/axios/http';

export interface WhatsAppTemplate {
  id: string;
  name: string;
  languageCode: string;
  category?: string | null;
  status?: string | null;
  components?: unknown[];
  source?: string;
}

const TEMPLATE_CACHE_TTL_MS = 60_000;
let templatesCache: { expiresAt: number; value: WhatsAppTemplate[] } | null = null;
let templatesRequest: Promise<WhatsAppTemplate[]> | null = null;

export async function getWhatsAppTemplates(sync = false): Promise<WhatsAppTemplate[]> {
  if (!sync && templatesCache && templatesCache.expiresAt > Date.now()) {
    return templatesCache.value;
  }

  if (!sync && templatesRequest) {
    return templatesRequest;
  }

  const request = api
    .get<{ success: boolean; data: WhatsAppTemplate[] }>('/whatsapp/templates', {
      params: sync ? { sync: true } : undefined,
    })
    .then((response) => {
      const templates = response.data?.data || [];
      if (!sync) {
        templatesCache = {
          value: templates,
          expiresAt: Date.now() + TEMPLATE_CACHE_TTL_MS,
        };
      }
      return templates;
    })
    .finally(() => {
      if (!sync) templatesRequest = null;
    });

  if (!sync) templatesRequest = request;
  return request;
}
