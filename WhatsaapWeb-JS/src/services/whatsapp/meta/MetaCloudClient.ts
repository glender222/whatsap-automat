import crypto from 'crypto';
import { openAsBlob } from 'node:fs';

const mediaDownloadOrigins = new Set(['https://graph.facebook.com', 'https://lookaside.fbsbx.com']);
const maxMediaDownloadBytes = 100_000_000;

function mediaDownloadError(code: string, statusCode: number, message: string) {
  return Object.assign(new Error(message), { code, statusCode });
}

function oversizedMediaError() {
  return mediaDownloadError('META_MEDIA_TOO_LARGE', 413, 'El archivo supera el límite de descarga de WhatsApp.');
}

async function readMediaBytes(response: Response): Promise<Buffer> {
  if (Number(response.headers.get('content-length')) > maxMediaDownloadBytes) {
    await response.body?.cancel().catch(() => undefined);
    throw oversizedMediaError();
  }
  const reader = response.body?.getReader();
  if (!reader) return Buffer.alloc(0);

  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      length += chunk.value.byteLength;
      if (length > maxMediaDownloadBytes) {
        await reader.cancel().catch(() => undefined);
        throw oversizedMediaError();
      }
      chunks.push(chunk.value);
    }
    return Buffer.concat(chunks, length);
  } finally {
    reader.releaseLock();
  }
}

export interface MetaCloudConfig {
  graphVersion: string;
  accessToken: string;
  phoneNumberId: string;
  wabaId?: string;
  displayPhoneNumber?: string;
  webhookVerifyToken?: string;
  appSecret?: string;
  requestTimeoutMs?: number;
}

export interface MetaSendResult {
  providerMessageId: string | null;
  raw: Record<string, unknown>;
}

export interface MetaTemplate {
  id?: string | null;
  name: string;
  language: string;
  status?: string | null;
  category?: string | null;
  components?: unknown[];
}

export type MetaMediaMessageType = 'image' | 'video' | 'audio' | 'document' | 'sticker';

export interface MetaUploadResult {
  mediaId: string;
  raw: Record<string, unknown>;
}

export interface MetaDownloadResult {
  mediaId: string;
  mimeType: string | null;
  sha256: string | null;
  fileSize: number | null;
  bytes: Buffer;
  raw: Record<string, unknown>;
}

export function isDefiniteMetaMessageRejection(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const provider = error as { providerStatusCode?: number; meta?: { error?: { code?: unknown } } };
  return [400, 401, 403, 404].includes(provider.providerStatusCode ?? 0) &&
    Number.isSafeInteger(provider.meta?.error?.code);
}

export class MetaCloudClient {
  private readonly baseUrl: string;

  constructor(
    private readonly config: MetaCloudConfig,
    private readonly fetchGraph?: typeof fetch,
  ) {
    this.baseUrl = `https://graph.facebook.com/${this.config.graphVersion}`;
  }

  isConfigured(): boolean {
    return Boolean(this.config.accessToken && this.config.phoneNumberId);
  }

  get phoneNumberId(): string {
    return this.config.phoneNumberId;
  }

  getMaskedConfig(): Record<string, unknown> {
    return {
      graphVersion: this.config.graphVersion,
      phoneNumberId: this.config.phoneNumberId || null,
      wabaId: this.config.wabaId || null,
      displayPhoneNumber: this.config.displayPhoneNumber || null,
      hasAccessToken: Boolean(this.config.accessToken),
      hasAppSecret: Boolean(this.config.appSecret),
    };
  }

  verifySignature(rawBody: Buffer | undefined, signatureHeader: string | string[] | undefined): boolean {
    if (!this.config.appSecret) return true;
    if (!rawBody || !signatureHeader || Array.isArray(signatureHeader)) return false;

    const expected = `sha256=${crypto
      .createHmac('sha256', this.config.appSecret)
      .update(rawBody)
      .digest('hex')}`;

    const expectedBuffer = Buffer.from(expected);
    const actualBuffer = Buffer.from(signatureHeader);
    return (
      expectedBuffer.length === actualBuffer.length &&
      crypto.timingSafeEqual(expectedBuffer, actualBuffer)
    );
  }

  normalizeRecipient(to: string): string {
    return String(to || '')
      .replace('@c.us', '')
      .replace('@s.whatsapp.net', '')
      .replace(/[^\d]/g, '');
  }

  private buildMetaError(response: Response, payload: any): Error & {
    statusCode?: number;
    code?: string;
    meta?: unknown;
    metaErrorCode?: string;
    metaErrorSubcode?: string;
    metaErrorMessage?: string;
    metaErrorType?: string;
    metaTraceId?: string;
    providerStatusCode?: number;
    userMessage?: string;
    action?: string;
  } {
    const metaError = payload?.error || {};
    const metaMessage =
      metaError?.message ||
      metaError?.error_data?.details ||
      response.statusText;
    const metaCode = String(metaError?.code || '');
    const metaSubcode = String(metaError?.error_subcode || '');
    const lowerMessage = String(metaMessage || '').toLowerCase();

    const error = new Error(`Meta API error ${response.status}: ${metaMessage}`) as Error & {
      statusCode?: number;
      code?: string;
      meta?: unknown;
      metaErrorCode?: string;
      metaErrorSubcode?: string;
      metaErrorMessage?: string;
      metaErrorType?: string;
      metaTraceId?: string;
      providerStatusCode?: number;
      userMessage?: string;
      action?: string;
    };

    error.code = 'META_API_ERROR';
    error.statusCode = response.status;
    error.userMessage = 'WhatsApp Business no pudo completar la solicitud.';
    error.action = 'Revisa la respuesta de Meta y vuelve a intentar.';

    if (response.status === 401 || metaCode === '190') {
      error.code = 'META_AUTH_ERROR';
      error.statusCode = 502;
      error.userMessage = 'El token de Meta no es valido o expiro.';
      error.action = 'Renueva META_WA_ACCESS_TOKEN y reinicia el backend.';
    } else if (response.status === 403 || metaCode === '200') {
      error.code = 'META_PERMISSION_ERROR';
      error.statusCode = 502;
      error.userMessage = 'La app o el token de Meta no tiene permisos para esta cuenta.';
      error.action = 'Verifica permisos whatsapp_business_messaging y acceso al WABA/numero.';
    } else if (['132001', '132005', '132007', '132012', '132015'].includes(metaCode)) {
      error.code = 'META_TEMPLATE_ERROR';
      error.statusCode = 400;
      error.userMessage = 'La plantilla no existe, no esta aprobada o no coincide con el idioma/componentes.';
      error.action = 'Usa una plantilla aprobada en Meta con el idioma correcto.';
    } else if (['131026', '131045'].includes(metaCode)) {
      error.code = 'META_RECIPIENT_ERROR';
      error.statusCode = 400;
      error.userMessage = 'Meta no pudo entregar el mensaje a ese numero.';
      error.action = 'Verifica que el numero tenga codigo de pais y pueda recibir WhatsApp.';
    } else if (metaCode === '131030') {
      error.code = 'META_RECIPIENT_ERROR';
      error.statusCode = 400;
      error.userMessage = 'Meta no permite enviar mensajes a ese numero desde esta app o cuenta.';
      error.action = 'Si la app esta en modo desarrollo, agrega ese numero como destinatario permitido o pasa la app a produccion.';
    } else if (
      lowerMessage.includes('24-hour') ||
      lowerMessage.includes('24 hour') ||
      lowerMessage.includes('outside the allowed window') ||
      lowerMessage.includes('customer care window')
    ) {
      error.code = 'SERVICE_WINDOW_CLOSED';
      error.statusCode = 409;
      error.userMessage = 'La ventana de 24 horas esta cerrada.';
      error.action = 'Envia una plantilla aprobada de Meta.';
    }

    if (metaSubcode && error.code === 'META_API_ERROR') {
      error.action = `Revisa el subcodigo Meta ${metaSubcode}.`;
    }

    error.meta = payload;
    error.metaErrorCode = metaCode || undefined;
    error.metaErrorSubcode = metaSubcode || undefined;
    error.metaErrorMessage = metaMessage ? String(metaMessage) : undefined;
    error.metaErrorType = metaError?.type ? String(metaError.type) : undefined;
    error.metaTraceId = metaError?.fbtrace_id ? String(metaError.fbtrace_id) : undefined;
    error.providerStatusCode = response.status;
    return error;
  }

  private async request(
    path: string,
    options: { method?: string; body?: unknown; headers?: Record<string, string>; redirect?: RequestRedirect } = {},
  ): Promise<Record<string, any>> {
    if (!this.isConfigured()) {
      const error = new Error('Meta Cloud API is not configured') as Error & { statusCode?: number };
      error.statusCode = 503;
      throw error;
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.config.requestTimeoutMs || 20000);

    try {
      const response = await (this.fetchGraph ?? fetch)(`${this.baseUrl}${path}`, {
        method: options.method || 'GET',
        ...(options.redirect ? { redirect: options.redirect } : {}),
        signal: controller.signal,
        headers: {
          Authorization: `Bearer ${this.config.accessToken}`,
          ...(options.body ? { 'Content-Type': 'application/json' } : {}),
          ...(options.headers || {}),
        },
        body: options.body ? JSON.stringify(options.body) : undefined,
      });

      const text = await response.text();
      const payload = text ? JSON.parse(text) : {};

      if (!response.ok) throw this.buildMetaError(response, payload);

      return payload;
    } finally {
      clearTimeout(timeout);
    }
  }

  async verifyPhoneAccess(): Promise<boolean> {
    const phoneId = this.config.phoneNumberId;
    if (!/^\d+$/.test(phoneId) || !/^v\d+\.\d+$/.test(this.config.graphVersion)) return false;
    const result = await this.request(`/${phoneId}?fields=id`, { redirect: 'error' });
    return result?.id === phoneId && !result.error;
  }

  async sendText(to: string, body: string, options: { redirect?: RequestRedirect; callbackData?: string } = {}): Promise<MetaSendResult> {
    const result = await this.request(`/${this.config.phoneNumberId}/messages`, {
      method: 'POST',
      redirect: options.redirect,
      body: {
        messaging_product: 'whatsapp',
        to: this.normalizeRecipient(to),
        type: 'text',
        ...(options.callbackData && { biz_opaque_callback_data: options.callbackData }),
        text: {
          preview_url: false,
          body,
        },
      },
    });

    return {
      providerMessageId: result?.messages?.[0]?.id || null,
      raw: result,
    };
  }

  async sendTemplate(
    to: string,
    templateName: string,
    languageCode = 'en_US',
    components?: unknown[],
    options: { redirect?: RequestRedirect } = {},
  ): Promise<MetaSendResult> {
    const template: Record<string, unknown> = {
      name: templateName,
      language: { code: languageCode },
    };
    if (components) template.components = components;

    const result = await this.request(`/${this.config.phoneNumberId}/messages`, {
      method: 'POST',
      redirect: options.redirect,
      body: {
        messaging_product: 'whatsapp',
        to: this.normalizeRecipient(to),
        type: 'template',
        template,
      },
    });

    return {
      providerMessageId: result?.messages?.[0]?.id || null,
      raw: result,
    };
  }

  async listMessageTemplates(): Promise<MetaTemplate[]> {
    if (!this.config.wabaId) {
      const error = new Error('META_WABA_ID no esta configurado') as Error & { statusCode?: number; code?: string };
      error.statusCode = 400;
      error.code = 'META_WABA_MISSING';
      throw error;
    }

    const result = await this.request(
      `/${this.config.wabaId}/message_templates?fields=id,name,language,status,category,components&limit=100`
    );

    return (result?.data || []).map((template: any) => ({
      id: template.id || null,
      name: template.name,
      language: template.language,
      status: template.status || null,
      category: template.category || null,
      components: Array.isArray(template.components) ? template.components : [],
    }));
  }

  async uploadMedia(
    file: { path: string; mimetype?: string; originalname?: string }, options: { redirect?: RequestRedirect } = {},
  ): Promise<MetaUploadResult> {
    const mimeType = file.mimetype || 'application/octet-stream';
    const filename = file.originalname || 'upload';
    const blob = await openAsBlob(file.path, { type: mimeType });
    const formData = new FormData();
    formData.append('messaging_product', 'whatsapp');
    formData.append('type', mimeType);
    formData.append('file', blob, filename);

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.config.requestTimeoutMs || 20000);

    try {
      const response = await (this.fetchGraph ?? fetch)(`${this.baseUrl}/${this.config.phoneNumberId}/media`, {
        method: 'POST',
        redirect: options.redirect,
        signal: controller.signal,
        headers: {
          Authorization: `Bearer ${this.config.accessToken}`,
        },
        body: formData,
      });
      const text = await response.text();
      const payload = text ? JSON.parse(text) : {};

      if (!response.ok) throw this.buildMetaError(response, payload);

      if (!payload.id) {
        const error = new Error('Meta Cloud API no devolvio media id') as Error & { statusCode?: number };
        error.statusCode = 502;
        throw error;
      }

      return { mediaId: String(payload.id), raw: payload };
    } finally {
      clearTimeout(timeout);
    }
  }

  async sendMedia(
    to: string,
    mediaId: string,
    mediaType: MetaMediaMessageType,
    options: { caption?: string | null; filename?: string | null; redirect?: RequestRedirect; callbackData?: string } = {}
  ): Promise<MetaSendResult> {
    const mediaPayload: Record<string, unknown> = { id: mediaId };
    if (options.caption && ['image', 'video', 'document'].includes(mediaType)) {
      mediaPayload.caption = options.caption;
    }
    if (options.filename && mediaType === 'document') {
      mediaPayload.filename = options.filename;
    }

    const result = await this.request(`/${this.config.phoneNumberId}/messages`, {
      method: 'POST',
      redirect: options.redirect,
      body: {
        messaging_product: 'whatsapp',
        to: this.normalizeRecipient(to),
        type: mediaType,
        ...(options.callbackData && { biz_opaque_callback_data: options.callbackData }),
        [mediaType]: mediaPayload,
      },
    });

    return {
      providerMessageId: result?.messages?.[0]?.id || null,
      raw: result,
    };
  }

  async downloadMedia(mediaId: string, phoneNumberId?: string): Promise<MetaDownloadResult> {
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(mediaId)) {
      throw mediaDownloadError('MEDIA_NOT_FOUND', 404, 'No se encontró el archivo asociado al mensaje.');
    }
    const phoneScope = phoneNumberId ? `?${new URLSearchParams({ phone_number_id: phoneNumberId })}` : '';
    const { url: downloadLocation, ...metadata } = await this.request(`/${mediaId}${phoneScope}`, { redirect: 'error' });
    if (typeof downloadLocation !== 'string' || !downloadLocation) {
      throw mediaDownloadError('MEDIA_NOT_FOUND', 404, 'Meta Cloud API no devolvió una URL de media.');
    }
    const url = URL.canParse(downloadLocation) ? new URL(downloadLocation) : null;
    if (!url || !mediaDownloadOrigins.has(url.origin) || url.username || url.password) {
      throw mediaDownloadError('META_MEDIA_URL_UNTRUSTED', 502, 'Meta devolvió una ubicación de archivo no permitida.');
    }
    if (Number(metadata.file_size) > maxMediaDownloadBytes) throw oversizedMediaError();

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.config.requestTimeoutMs || 20000);
    try {
      const response = await (this.fetchGraph ?? fetch)(url, {
        method: 'GET',
        redirect: 'error',
        signal: controller.signal,
        headers: {
          Authorization: `Bearer ${this.config.accessToken}`,
        },
      });

      if (!response.ok) {
        const text = await response.text();
        let payload: any = null;
        try {
          payload = text ? JSON.parse(text) : null;
        } catch {
          payload = null;
        }

        if (payload?.error) {
          throw this.buildMetaError(response, payload);
        }

        const error = new Error(`Meta media download error ${response.status}: ${text || response.statusText}`) as Error & {
          statusCode?: number;
          code?: string;
          providerStatusCode?: number;
          userMessage?: string;
          action?: string;
        };
        error.statusCode = response.status === 401 || response.status === 403 ? 502 : response.status;
        error.code = response.status === 401 || response.status === 403 ? 'META_AUTH_ERROR' : 'META_MEDIA_DOWNLOAD_ERROR';
        error.providerStatusCode = response.status;
        error.userMessage = response.status === 401 || response.status === 403
          ? 'El token de Meta no es valido o expiro.'
          : 'No se pudo descargar el archivo desde Meta.';
        error.action = response.status === 401 || response.status === 403
          ? 'Renueva META_WA_ACCESS_TOKEN y reinicia el backend.'
          : 'Intenta nuevamente o revisa si el media sigue disponible en Meta.';
        throw error;
      }

      const bytes = await readMediaBytes(response);
      return {
        mediaId,
        mimeType: (metadata?.mime_type as string | undefined) || response.headers.get('content-type'),
        sha256: (metadata?.sha256 as string | undefined) || null,
        fileSize: bytes.length,
        bytes,
        raw: metadata,
      };
    } finally {
      clearTimeout(timeout);
    }
  }

  async markAsRead(providerMessageId: string): Promise<void> {
    if (!providerMessageId || providerMessageId.startsWith('local-')) return;
    await this.request(`/${this.config.phoneNumberId}/messages`, {
      method: 'POST',
      body: {
        messaging_product: 'whatsapp',
        status: 'read',
        message_id: providerMessageId,
      },
    });
  }
}
