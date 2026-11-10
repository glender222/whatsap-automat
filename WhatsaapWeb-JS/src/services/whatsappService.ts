import path from 'path';
import { existsSync } from 'fs';
import { promises as fs } from 'fs';
import { randomUUID } from 'node:crypto';
import type { Server } from 'socket.io';
import { MetaCloudClient, MetaMediaMessageType } from './whatsapp/meta/MetaCloudClient';
import { MetaAccountStore } from './whatsapp/meta/MetaAccountStore';
import { MetaInboxStore, type MetaMediaAttachment } from './whatsapp/meta/MetaInboxStore';
import { MetaInboundWorker, type MetaInboundAuthority, type MetaInboundExecution, type MetaInboundOutcome } from './whatsapp/meta/MetaInboundWorker';
import type { MetaInboundWorkRepository } from './whatsapp/meta/MetaInboundWorkRepository';
import { ConversationSendError, conversationSendService, type AgentSendAnchor, type AgentSendResult } from './conversations/ConversationSendService';
import { withCompatibleVideo } from './whatsapp/VideoTranscode';
import { removeTemporaryUpload } from '../shared/temporaryUpload';
import AgentService from './ai/AgentService';
import config from '../config/index';
import pool from '../config/database';
import { queryInTenantScope } from '../db/TenantScopedUoW';
import type { AgentRuntimeLogInput } from '../modules/ai/domain/runtime.types';
import { AiRuntimeOrchestrator, getAiRuntimeOrchestrator } from '../modules/ai';
import type { ProductCardSendPayload } from '../modules/ai';
import { emitDashboard, emitConversation } from '../sockets/socketEmitter';


type Provider = 'webjs' | 'meta-cloud';

const META_MAX_VIDEO_BYTES = 16_000_000;

type MetaWebhookError = Error & {
  statusCode?: number;
  code?: string;
};

function createMetaWebhookError(statusCode: number, code: string, message: string): MetaWebhookError {
  const error = new Error(message) as MetaWebhookError;
  error.statusCode = statusCode;
  error.code = code;
  return error;
}

function sanitizeToolTrace(toolResults: unknown): Array<{ toolName: string; status: string }> {
  if (!Array.isArray(toolResults)) return [];
  return toolResults.slice(0, 50).map((result: any) => ({
    toolName: String(result?.toolName || 'unknown').slice(0, 120),
    status: String(result?.status || 'unknown').slice(0, 80),
  }));
}

function extensionFromMime(mimeType: string | null | undefined, filename: string | null | undefined): string {
  const fromName = filename ? path.extname(filename) : '';
  if (fromName) return fromName;
  const map: Record<string, string> = {
    'image/jpeg': '.jpg',
    'image/png': '.png',
    'image/webp': '.webp',
    'image/gif': '.gif',
    'video/mp4': '.mp4',
    'audio/mpeg': '.mp3',
    'audio/ogg': '.ogg',
    'audio/aac': '.aac',
    'application/pdf': '.pdf',
  };
  return map[mimeType || ''] || '.bin';
}

function inferMetaMediaType(mimeType: string | undefined, options: any = {}): MetaMediaMessageType {
  if (options.asSticker) return 'sticker';
  if (options.forceDocument) return 'document';
  if (mimeType?.startsWith('image/')) return 'image';
  if (mimeType?.startsWith('video/')) return 'video';
  if (mimeType?.startsWith('audio/')) return 'audio';
  return 'document';
}

function mimeFromImageFilename(filename: string): string {
  const ext = path.extname(filename).toLowerCase();
  const map: Record<string, string> = {
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.png': 'image/png',
    '.webp': 'image/webp',
    '.gif': 'image/gif',
  };
  return map[ext] || 'image/jpeg';
}

export class WhatsAppService {
  readonly provider: Provider;
  readonly whatsappClient: any | null;
  readonly metaClient: MetaCloudClient | null;
  readonly metaStore: MetaInboxStore | null;
  readonly metaAccountStore: MetaAccountStore | null;
  private readonly agentService: AgentService;
  private readonly conversationSender = conversationSendService;
  private conversationCore: any;

  constructor() {
    this.provider = (config.whatsapp.provider || 'webjs') as Provider;
    this.whatsappClient = this.provider === 'meta-cloud' ? null : new (require('./whatsapp/WhatsAppClient'))();
    this.metaClient = this.provider === 'meta-cloud' ? new MetaCloudClient({ ...config.meta, accessToken: '' }) : null;
    this.metaAccountStore = this.provider === 'meta-cloud' ? new MetaAccountStore() : null;
    this.agentService = new AgentService();
    this.metaStore = this.provider === 'meta-cloud'
      ? new MetaInboxStore({ companyId: config.defaultCompanyId || 1 })
      : null;
  }

  setSocketIO(io: Server): void {
    if (this.whatsappClient) {
      const companyId = config.defaultCompanyId;
      this.whatsappClient.setSocketIO({
        emit: (event: string, payload: unknown) =>
          io.to(event === 'qr' ? `whatsapp-link-admin:${companyId}` : `tenant:${companyId}`).emit(event, payload),
        to: (chatId: string) => io.to(`conversation:${companyId}:${chatId}`),
      });
    }
    if (this.metaStore) this.metaStore.setSocketIO(io);
  }

  getMetaStore(companyId = config.defaultCompanyId || 1): MetaInboxStore | null {
    if (!this.metaStore) return null;
    return this.metaStore.withCompany(companyId || config.defaultCompanyId || 1);
  }

  setConversationCore(core: any): void {
    this.conversationCore = core;
  }

  getConversationCore(): any {
    return this.conversationCore || null;
  }

  private webClientForCompany(companyId: number) {
    if (companyId !== config.defaultCompanyId) {
      throw Object.assign(new Error('WhatsApp Web.js solo está disponible para la empresa configurada.'), {
        code: 'WEBJS_COMPANY_FORBIDDEN', statusCode: 403,
      });
    }
    return this.whatsappClient;
  }

  async initialize(companyId = config.defaultCompanyId): Promise<boolean> {
    if (this.provider === 'meta-cloud') {
      if (companyId !== config.defaultCompanyId) return true;
      await this.metaAccountStore?.ensureEnvAccount(companyId, config.meta);
      console.log('✅ WhatsApp provider meta-cloud inicializado sin QR');
      return true;
    }
    await this.webClientForCompany(companyId).initialize();
    return true;
  }

  getQR(companyId: number): string | null {
    if (this.provider === 'meta-cloud') return null;
    return this.webClientForCompany(companyId).getQR();
  }

  async getStatus(): Promise<Record<string, unknown>> {
    return this.getCompanyStatus();
  }

  async getCompanyStatus(companyId = config.defaultCompanyId || 1): Promise<Record<string, unknown>> {
    if (this.provider === 'webjs') {
      if (companyId !== config.defaultCompanyId) {
        return {
          provider: 'webjs', status: 'DISCONNECTED', accountStatus: 'unavailable_for_company',
          configured: false, connected: false, isReady: false, isConnected: false, hasQR: false,
        };
      }
      const status = this.whatsappClient.getStatus();
      return { ...status, provider: 'webjs', configured: Boolean(status.isReady), connected: Boolean(status.isConnected) };
    }

    const account = await this.metaAccountStore?.getAccountForCompany(companyId);
    const clientConfig = this.metaAccountStore?.toClientConfig(account || null, true);
    const configured = Boolean(clientConfig?.accessToken && clientConfig?.phoneNumberId);
    const verificationRequired = account?.status === 'verification_required';

    return {
      provider: 'meta-cloud',
      configured,
      connected: configured,
      isReady: configured,
      isConnected: configured,
      authenticated: configured,
      hasQR: false,
      qr: null,
      phoneNumberId: clientConfig?.phoneNumberId || null,
      wabaId: clientConfig?.wabaId || null,
      phoneNumber: clientConfig?.displayPhoneNumber || null,
      graphVersion: clientConfig?.graphVersion || config.meta.graphVersion,
      accountStatus: account?.status || (configured ? 'connected' : 'missing_config'),
      tokenConfigured: Boolean(clientConfig?.accessToken),
      message: verificationRequired
        ? 'Guarda una credencial autorizada para verificar esta línea.'
        : configured ? 'Meta Cloud API configurado para la empresa' : 'Conecta WhatsApp Business para esta empresa',
    };
  }

  async getCompanyConnection(companyId = config.defaultCompanyId || 1): Promise<Record<string, unknown> | null> {
    const account = await this.metaAccountStore?.getAccountForCompany(companyId);
    return account?.status !== 'disconnected' ? this.metaAccountStore?.sanitize(account || null) ?? null : null;
  }

  async saveCompanyConnection(companyId: number, input: Record<string, any>): Promise<Record<string, unknown> | null> {
    if (!this.metaAccountStore) return null;
    const phoneNumberId = String(input.phoneNumberId || input.phone_number_id || '').trim();
    const graphVersion = String(input.graphVersion || input.graph_version || config.meta.graphVersion || 'v25.0').trim();
    if (!/^\d{1,100}$/.test(phoneNumberId) || !/^v\d{1,3}\.\d{1,3}$/.test(graphVersion)) {
      throw Object.assign(new Error('Ingresa un ID de línea y una versión de Graph válidos.'), {
        statusCode: 400, code: 'META_CONNECTION_INVALID',
      });
    }
    const accessToken = typeof input.accessToken === 'string' ? input.accessToken.trim() : '';
    if (accessToken) {
      const rejected = () => Object.assign(new Error('La credencial no acredita acceso a esta línea de WhatsApp.'), {
        statusCode: 403, code: 'META_PHONE_ACCESS_NOT_VERIFIED',
      });
      let verified: boolean;
      try {
        verified = await new MetaCloudClient({ ...config.meta, phoneNumberId, graphVersion, accessToken }).verifyPhoneAccess();
      } catch (error) {
        const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined;
        if (code === 'META_AUTH_ERROR' || code === 'META_PERMISSION_ERROR') throw rejected();
        throw Object.assign(new Error('No pudimos verificar la línea con Meta. Intenta de nuevo.'), {
          statusCode: 503, code: 'META_PHONE_VERIFICATION_UNAVAILABLE',
        });
      }
      if (!verified) throw rejected();
    }

    const account = await this.metaAccountStore.upsertConnection(companyId, {
      phoneNumberId,
      accessToken: accessToken || null,
      wabaId: input.wabaId || input.waba_id || null,
      displayPhoneNumber: input.displayPhoneNumber || input.display_phone_number || null,
      businessPhoneNumber: input.businessPhoneNumber || input.business_phone_number || input.displayPhoneNumber || null,
      graphVersion: input.graphVersion || input.graph_version || config.meta.graphVersion,
      appId: input.appId || input.app_id || null,
      businessId: input.businessId || input.business_id || null,
      webhookVerifyToken: input.webhookVerifyToken || input.webhook_verify_token || null,
      status: accessToken ? 'connected' : 'missing_token',
      metadata: { source: 'manual_settings' },
    });
    return this.metaAccountStore.sanitize(account);
  }

  async disconnectCompanyConnection(companyId: number): Promise<void> {
    await this.metaAccountStore?.disconnect(companyId);
  }

  private async getCompanyMetaClient(companyId = config.defaultCompanyId || 1, phoneNumberId?: string): Promise<MetaCloudClient> {
    const account = phoneNumberId
      ? await this.metaAccountStore?.getAccountForCompanyPhone(companyId, phoneNumberId)
      : await this.metaAccountStore?.getAccountForCompany(companyId);
    const clientConfig = this.metaAccountStore?.toClientConfig(account || null, true);

    if (!clientConfig?.accessToken || !clientConfig?.phoneNumberId) {
      const error = new Error('WhatsApp Business no esta conectado para esta empresa') as Error & {
        statusCode?: number;
        code?: string;
        userMessage?: string;
        action?: string;
      };
      error.statusCode = 409;
      error.code = 'WHATSAPP_ACCOUNT_NOT_CONNECTED';
      error.userMessage = 'Esta empresa no tiene WhatsApp Business conectado.';
      error.action = 'Conecta WhatsApp Business en configuracion de empresa.';
      throw error;
    }

    return new MetaCloudClient(clientConfig);
  }

  async getMyInfo(companyId = config.defaultCompanyId || 1): Promise<Record<string, unknown> | null> {
    if (this.provider === 'meta-cloud') {
      const status = await this.getCompanyStatus(companyId);
      if (!status.configured) return null;
      return {
        id: status.phoneNumberId,
        user: status.phoneNumber || status.phoneNumberId,
        provider: 'meta-cloud',
        wabaId: status.wabaId,
      };
    }
    return this.webClientForCompany(companyId).getMyInfo();
  }

  async logout(companyId: number): Promise<boolean> {
    if (this.provider === 'meta-cloud') {
      await this.disconnectCompanyConnection(companyId);
      return true;
    }
    return this.webClientForCompany(companyId).logout();
  }

  async destroy(): Promise<boolean> {
    if (this.provider === 'meta-cloud') return true;
    await this.whatsappClient.destroy();
    return true;
  }

  async getChatsList(companyId = config.defaultCompanyId || 1): Promise<unknown[]> {
    if (this.provider === 'meta-cloud') {
      return this.getMetaStore(companyId)?.getChats() || [];
    }
    return this.webClientForCompany(companyId).getChats();
  }

  async getChatMessages(chatId: string, limit = 50, before = 0, companyId = config.defaultCompanyId || 1): Promise<unknown[]> {
    if (this.provider === 'meta-cloud') {
      return this.getMetaStore(companyId)?.getMessages(chatId, limit, before) || [];
    }
    return this.webClientForCompany(companyId).messageHandler.getChatMessages(chatId, limit, before);
  }

  async getChatSessionStatus(chatId: string, companyId = config.defaultCompanyId || 1): Promise<any> {
    if (this.provider === 'meta-cloud') {
      const status = await this.getMetaStore(companyId)?.getServiceWindowStatus(chatId);
      return status || {
        hasActiveSession: false,
        status: 'closed',
        serviceWindowExpiresAt: null,
        lastCustomerMessageAt: null,
        reason: 'store_unavailable',
      };
    }

    this.webClientForCompany(companyId);
    return {
      hasActiveSession: true,
      status: 'open',
      serviceWindowExpiresAt: null,
      lastCustomerMessageAt: null,
      reason: 'legacy_webjs',
    };
  }

  async listTemplates(companyId = config.defaultCompanyId || 1, options: { sync?: boolean } = {}): Promise<unknown[]> {
    if (this.provider !== 'meta-cloud') return [];
    const store = this.getMetaStore(companyId);
    if (!store) return [];

    if (options.sync) {
      const metaClient = await this.getCompanyMetaClient(companyId);
      const templates = await metaClient.listMessageTemplates();
      if (templates?.length) {
        const account = await this.metaAccountStore?.getAccountForCompany(companyId);
        await store.upsertTemplates(templates, account?.waba_id || config.meta.wabaId || null);
      }
    }

    return store.listTemplates({ approvedOnly: true });
  }

  async sendMessage(chatId: string, message: string, media: any = null, options: any = {}): Promise<any> {
    if (this.provider === 'meta-cloud') {
      if (!this.metaStore) {
        const error = new Error('Meta Cloud API no esta inicializado') as Error & { statusCode?: number };
        error.statusCode = 503;
        throw error;
      }

      const templateName = options.templateName || options.template || null;
      const templateLanguage = options.templateLanguage || options.language || 'en_US';
      const store = this.getMetaStore(options.companyId);
      const metaClient = await this.getCompanyMetaClient(options.companyId);
      if (!store) {
        const error = new Error('Meta Cloud inbox store no esta inicializado') as Error & { statusCode?: number };
        error.statusCode = 503;
        throw error;
      }
      let result;

      if (media) {
        try {
          const mediaType = inferMetaMediaType(media.mimetype, options);
          const sendMedia = async (attachment: typeof media) => {
            const size = mediaType === 'video' ? (await fs.stat(attachment.path)).size : attachment.size;
            if (mediaType === 'video' && size > META_MAX_VIDEO_BYTES) {
              throw Object.assign(new Error('El video final supera los 16 MB permitidos por WhatsApp.'), {
                code: 'META_VIDEO_TOO_LARGE',
                statusCode: 413,
              });
            }
            const upload = await metaClient.uploadMedia(attachment);
            const sent = await metaClient.sendMedia(chatId, upload.mediaId, mediaType, {
              caption: message || null,
              filename: attachment.originalname || null,
            });
            await store.persistOutbound({
              chatId,
              body: message || null,
              messageType: mediaType,
              providerMessageId: sent.providerMessageId,
              phoneNumberId: metaClient.phoneNumberId,
              raw: { upload: upload.raw, send: sent.raw },
              media: {
                providerMediaId: upload.mediaId,
                mimeType: attachment.mimetype || null,
                filename: attachment.originalname || null,
                sizeBytes: typeof size === 'number' ? size : null,
                caption: message || null,
                metadata: { upload: upload.raw, send: sent.raw },
              },
            });
            return sent;
          };
          result = mediaType === 'video'
            ? await withCompatibleVideo(media, sendMedia, { inspectInput: true })
            : await sendMedia(media);
        } finally {
          await removeTemporaryUpload(media.path);
        }
      } else if (templateName) {
        result = await metaClient.sendTemplate(chatId, templateName, templateLanguage, options.components);
        await store.persistOutbound({
          chatId,
          body: message || null,
          messageType: 'template',
          providerMessageId: result.providerMessageId,
          phoneNumberId: metaClient.phoneNumberId,
          raw: result.raw,
          template: { name: templateName, language: templateLanguage },
        });
      } else {
        const canSend = await store.canSendFreeForm(chatId);
        if (!canSend) {
          const error = new Error('La ventana de servicio de 24 horas esta cerrada. Usa una plantilla aprobada de Meta.') as Error & {
            statusCode?: number;
            code?: string;
            userMessage?: string;
            action?: string;
          };
          error.statusCode = 409;
          error.code = 'SERVICE_WINDOW_CLOSED';
          error.userMessage = 'La ventana de 24 horas esta cerrada.';
          error.action = 'Envia una plantilla aprobada para iniciar o reabrir la conversacion.';
          throw error;
        }

        result = await metaClient.sendText(chatId, message || '');
        await store.persistOutbound({
          chatId,
          body: message || '',
          messageType: 'text',
          providerMessageId: result.providerMessageId,
          phoneNumberId: metaClient.phoneNumberId,
          raw: result.raw,
        });
      }

      return {
        id: result.providerMessageId,
        timestamp: Math.floor(Date.now() / 1000),
        raw: result.raw,
      };
    }

    return this.webClientForCompany(options.companyId ?? config.defaultCompanyId).messageHandler.sendMessage(chatId, message, media, options);
  }

  async getMediaInfo(messageId: string, companyId = config.defaultCompanyId || 1): Promise<unknown | null> {
    if (this.provider === 'meta-cloud') {
      const attachment = await this.getMetaStore(companyId)?.findMediaAttachment(messageId);
      if (!attachment) return null;
      return {
        hasMedia: true,
        messageId: attachment.provider_message_id || attachment.message_id,
        providerMediaId: attachment.provider_media_id,
        mediaUrl: `/api/media/${encodeURIComponent(String(attachment.provider_message_id || attachment.message_id))}`,
        mimetype: attachment.mime_type,
        filename: attachment.filename,
        fileSize: attachment.size_bytes,
        sha256: attachment.sha256 || null,
        caption: attachment.caption || attachment.body || null,
        localPath: attachment.internal_path || null,
        storageStatus: attachment.storage_status,
      };
    }
    const { mediaHandler } = this.webClientForCompany(companyId);
    if (typeof mediaHandler.getMediaInfo === 'function') {
      return mediaHandler.getMediaInfo(messageId);
    }
    return null;
  }

  async getMediaThumbnail(messageId: string, companyId: number): Promise<unknown | null> {
    if (this.provider === 'meta-cloud') return null;
    const { mediaHandler } = this.webClientForCompany(companyId);
    if (typeof mediaHandler.getMediaThumbnail === 'function') {
      return mediaHandler.getMediaThumbnail(messageId);
    }
    return null;
  }

  async markAsRead(chatId: string, companyId = config.defaultCompanyId || 1): Promise<void> {
    if (this.provider === 'meta-cloud') {
      const store = this.getMetaStore(companyId);
      const latestInboundMessageId = await store?.findLatestInboundProviderMessageId(chatId);
      if (latestInboundMessageId) {
        const metaClient = await this.getCompanyMetaClient(companyId).catch(() => null);
        await metaClient?.markAsRead(latestInboundMessageId).catch((error: any) => {
          console.warn('No se pudo marcar como leido en Meta', {
            code: String(error?.code || 'META_MARK_READ_FAILED'),
            statusCode: error?.statusCode || null,
            providerStatusCode: error?.providerStatusCode || null,
          });
        });
      }
      await store?.markConversationRead(chatId);
      return;
    }
    await this.webClientForCompany(companyId).messageHandler.markAsRead(chatId);
  }

  async downloadMedia(messageId: string, companyId = config.defaultCompanyId || 1): Promise<unknown> {
    if (this.provider === 'meta-cloud') {
      if (!this.metaStore) {
        const error = new Error('Meta Cloud API no esta inicializado') as Error & { statusCode?: number };
        error.statusCode = 503;
        throw error;
      }

      const store = this.getMetaStore(companyId);
      if (!store) {
        const error = new Error('Meta Cloud inbox store no esta inicializado') as Error & { statusCode?: number };
        error.statusCode = 503;
        throw error;
      }

      const attachment = await store.findMediaAttachment(messageId);
      if (!attachment?.provider_media_id) {
        const error = new Error('Media no encontrado en PostgreSQL') as Error & { statusCode?: number };
        error.statusCode = 404;
        (error as any).code = 'MEDIA_NOT_FOUND';
        (error as any).userMessage = 'No se encontro el archivo asociado al mensaje.';
        throw error;
      }

      return this.loadMetaAttachment(store, attachment, attachment.provider_media_id);
    }
    return this.webClientForCompany(companyId).mediaHandler.downloadMedia(messageId);
  }

  async downloadConversationAttachment(companyId: number, conversationId: number, messageId: number, attachmentId: number) {
    const store = this.getMetaStore(companyId);
    const attachment = await store?.findConversationAttachment(conversationId, messageId, attachmentId);
    if (!store || !attachment?.provider_media_id) return null;
    return this.loadMetaAttachment(store, attachment, attachment.provider_media_id, true);
  }

  private async loadMetaAttachment(store: MetaInboxStore, attachment: MetaMediaAttachment, mediaId: string, scopedCache = false) {
    const companyId = store.getCompanyId();
    const uploadDir = path.join(config.whatsapp.uploadDir, 'tenants', String(companyId), 'meta-cloud');
    const cachedPath = attachment.internal_path;
    if (cachedPath && (!scopedCache || (path.dirname(cachedPath) === uploadDir &&
      (await fs.lstat(cachedPath).catch(() => null))?.isFile())) && existsSync(cachedPath)) {
      return {
        localPath: cachedPath,
        mimetype: attachment.mime_type || 'application/octet-stream',
        filename: attachment.filename || path.basename(cachedPath),
      };
    }

    const phoneNumberId = attachment.phone_number_id || undefined;
    const metaClient = await this.getCompanyMetaClient(companyId, phoneNumberId);
    const downloaded = await metaClient.downloadMedia(mediaId, phoneNumberId);
    await fs.mkdir(uploadDir, { recursive: true });
    const filename = `${mediaId.replace(/[^\w.-]/g, '_')}${extensionFromMime(downloaded.mimeType, attachment.filename)}`;
    const localPath = path.join(uploadDir, `${attachment.attachment_id}-${filename}`);
    const temporaryPath = path.join(uploadDir, `.${randomUUID()}.tmp`);
    try {
      await fs.writeFile(temporaryPath, downloaded.bytes, { flag: 'wx' });
      await fs.rename(temporaryPath, localPath);
    } finally {
      await fs.rm(temporaryPath, { force: true });
    }
    await store.markMediaDownloaded({
      attachmentId: attachment.attachment_id,
      internalPath: localPath,
      mimeType: downloaded.mimeType,
      sizeBytes: downloaded.fileSize,
      sha256: downloaded.sha256,
      metadata: { download: downloaded.raw },
    });
    return {
      localPath,
      mimetype: downloaded.mimeType || attachment.mime_type || 'application/octet-stream',
      filename: attachment.filename || filename,
    };
  }

  async getProfilePhoto(chatId: string, companyId: number): Promise<unknown> {
    if (this.provider === 'meta-cloud') {
      throw new Error('Foto de perfil no disponible via Meta Cloud API');
    }
    return this.webClientForCompany(companyId).mediaHandler.getProfilePhoto(chatId);
  }

  verifyMetaWebhook(mode: unknown, verifyToken: unknown, challenge: unknown): unknown | null {
    if (mode === 'subscribe' && verifyToken === config.meta.webhookVerifyToken) {
      return challenge;
    }
    return null;
  }

  async handleMetaWebhook(payload: any): Promise<Record<string, unknown>> {
    if (this.provider !== 'meta-cloud') {
      return { ignored: true, reason: 'provider_not_meta_cloud' };
    }
    if (!this.metaStore) return { processed: 0, results: [] };

    const results: unknown[] = [];
    const entries = Array.isArray(payload?.entry) ? payload.entry : [];

    for (const entry of entries) {
      const changes = Array.isArray(entry?.changes) ? entry.changes : [];
      for (const change of changes) {
        if (change?.field !== 'messages') continue;
        const value = change.value || {};
        const metadata = value.metadata || {};
        const phoneNumberId = metadata?.phone_number_id ? String(metadata.phone_number_id) : '';
        if (!phoneNumberId) {
          throw createMetaWebhookError(
            400,
            'META_PHONE_NUMBER_ID_REQUIRED',
            'El webhook Meta no incluye phone_number_id'
          );
        }
        const account = await this.metaAccountStore?.findByPhoneNumberId(phoneNumberId);
        const companyId = Number(account?.company_id || 0);
        if (!Number.isInteger(companyId) || companyId <= 0) {
          throw createMetaWebhookError(
            404,
            'META_WEBHOOK_TENANT_NOT_FOUND',
            'El phone_number_id del webhook no esta asociado a una empresa'
          );
        }
        const store = this.getMetaStore(companyId);
        if (!store) continue;
        const contactsByWaId = new Map(
          (value.contacts || []).map((contact: any) => [String(contact.wa_id), contact])
        );

        for (const message of value.messages || []) {
          const contact = contactsByWaId.get(String(message.from)) || null;
          const persisted = await store.persistInboundMessage({ message, contact, metadata, value });
          results.push(persisted);
          await this.logAgentRuntime({
            companyId,
            chatId: message?.from,
            inboundProviderMessageId: message?.id,
            stage: 'webhook_message_received',
            summary: persisted?.duplicate
              ? 'Mensaje inbound duplicado recibido desde Meta.'
              : 'Mensaje inbound recibido desde Meta y persistido.',
            status: persisted?.duplicate ? 'skipped' : 'ok',
            payload: {
              duplicate: Boolean(persisted?.duplicate),
              messageType: message?.type || 'unknown',
              hasText: Boolean(message?.text?.body || message?.button?.text || message?.interactive),
            },
          });
        }

        for (const status of value.statuses || []) {
          results.push(await store.persistStatus({ status, metadata, value }));
        }
      }
    }

    return { processed: results.length, results };
  }

  private async logAgentRuntime(input: AgentRuntimeLogInput): Promise<void> {
    await this.agentService.logRuntimeEvent({
      ...input,
      chatId: input.chatId ? String(input.chatId).replace('@c.us', '').replace('@s.whatsapp.net', '').replace(/[^\d]/g, '') : null,
      inboundProviderMessageId: input.inboundProviderMessageId ? String(input.inboundProviderMessageId) : null,
      outboundProviderMessageId: input.outboundProviderMessageId ? String(input.outboundProviderMessageId) : null,
    }).catch((error: any) => {
      console.warn('No se pudo guardar log de agente', {
        code: String(error?.code || 'AGENT_LOG_WRITE_FAILED'),
      });
    });
  }

  private getRuntimeOrchestrator(): AiRuntimeOrchestrator {
    return getAiRuntimeOrchestrator(pool);
  }

  startMetaInboundWorker(repository?: MetaInboundWorkRepository): () => Promise<void> {
    if (this.provider !== 'meta-cloud') return async () => {};
    const worker = new MetaInboundWorker({
      repository,
      execute: (work, authority) => this.processMetaInbound(work, authority),
      onError: (error) => console.error('No se pudo procesar el trabajo de mensajes entrantes', {
        code: error instanceof Error ? error.name : 'META_INBOUND_WORKER_ERROR',
      }),
    });
    worker.start();
    return () => worker.stop();
  }

  async processMetaInbound(work: MetaInboundExecution, authority: MetaInboundAuthority): Promise<MetaInboundOutcome> {
    const { companyId, message, inboundProviderMessageId } = work;
    const chatId = typeof message.from === 'string' ? message.from : '';
    let agentId: number | null = null;

    try {
      const text: unknown = message?.text?.body || message?.button?.text || message?.interactive?.button_reply?.title;
      if (typeof text !== 'string' || !text.trim() || !chatId) {
        await this.logAgentRuntime({
          companyId,
          chatId,
          inboundProviderMessageId,
          stage: 'agent_skipped_unsupported_message',
          level: 'warn',
          status: 'skipped',
          summary: 'Mensaje inbound sin texto util para el agente automatico.',
          payload: { messageType: message?.type || 'unknown' },
        });
        return { status: 'skipped', code: 'META_INBOUND_UNSUPPORTED' };
      }

      const isPaused = await this.agentService.isConversationPaused(companyId, chatId);
      if (isPaused) {
        await this.logAgentRuntime({
          companyId,
          chatId,
          inboundProviderMessageId,
          stage: 'agent_skipped_paused',
          level: 'info',
          status: 'skipped',
          summary: 'IA pausada en este chat por un empleado. No se envia respuesta automatica.',
        });
        return { status: 'skipped', code: 'AGENT_REPLY_DISABLED' };
      }

      await this.logAgentRuntime({
        companyId,
        chatId,
        inboundProviderMessageId,
        stage: 'agent_runtime_started',
        summary: 'Iniciando runtime de tools reales IA (router + loop).',
        payload: { messageType: message?.type || 'unknown' },
      });

      const history = await this.agentService.getConversationContext(companyId, chatId, {
        windowHours: 24,
        limit: 12,
        excludeProviderMessageId: inboundProviderMessageId,
        inbound: { conversationId: Number(work.conversationId), messageId: Number(work.messageId) },
      });

      authority.signal.throwIfAborted();
      if (!await authority.isCurrent()) return { status: 'uncertain', code: 'AGENT_WORK_EXPIRED' };
      const orchestrator = this.getRuntimeOrchestrator();
      const result = await orchestrator.processInbound({
        companyId,
        chatId,
        conversationId: Number(work.conversationId),
        message: text,
        history: history.map((h) => ({ fromMe: h.fromMe, body: h.body })),
        inboundProviderMessageId,
        signal: authority.signal,
        sender: { sendProductCard: (payload) => this.sendProductCard(work, authority, payload) },
      });
      authority.signal.throwIfAborted();

      agentId = result.agentId;
      const toolTrace = sanitizeToolTrace(result.toolResults);

      await this.logAgentRuntime({
        companyId,
        agentId,
        chatId,
        inboundProviderMessageId,
        stage: 'agent_runtime_completed',
        status: ['auto_reply', 'suggest', 'handoff'].includes(result.action) ? 'ok' : 'skipped',
        summary: `Runtime finalizo: intent=${result.route} action=${result.action} rounds=${result.rounds} tools=${toolTrace.length}.`,
        confidence: result.confidence,
        action: result.action === 'none' ? null : result.action,
        relatedHandoffId: result.handoffTicketId,
        payload: {
          routerMissing: result.routerMissing,
          intent: result.route,
          action: result.action,
          confidence: result.confidence,
          handoffTicketId: result.handoffTicketId,
          tools: toolTrace,
          rounds: result.rounds,
        },
      });

      if ((result.action === 'auto_reply' || result.action === 'handoff') && result.reply) {
        return await this.sendAgentReply(work, authority, chatId, agentId, result);
      }
      if (result.action === 'suggest') {
        await this.logAgentRuntime({
          companyId,
          agentId,
          chatId,
          inboundProviderMessageId,
          stage: 'agent_suggestion_emitted',
          status: 'ok',
          summary: 'Sugerencia emitida al frontend; el humano envia.',
          payload: { intent: result.route, action: result.action },
        });
      }
      return { status: 'completed' };
    } catch (error: any) {
      const safeErrorCode = error instanceof ConversationSendError ? error.reasonCode : 'AGENT_RUNTIME_FAILED';
      const skipped = error instanceof ConversationSendError && (error.code === 'POLICY_DENIED' ||
        ['SERVICE_WINDOW_CLOSED', 'CONVERSATION_CLOSED', 'DELIVERY_UNRESOLVED', 'SENDING_ACCOUNT_UNAVAILABLE'].includes(safeErrorCode));
      await this.logAgentRuntime({
        companyId,
        agentId,
        chatId,
        inboundProviderMessageId,
        stage: skipped ? 'meta_send_skipped' : 'meta_runtime_unconfirmed',
        level: skipped ? 'warn' : 'error',
        status: skipped ? 'skipped' : 'failed',
        summary: skipped ? 'El estado de la conversación impidió el envío automático.'
          : 'La ejecución automática no pudo confirmarse.',
        errorCode: safeErrorCode,
        errorMessage: error?.userMessage || 'Fallo el runtime automatico de WhatsApp.',
        payload: {
          providerStatusCode: error?.providerStatusCode || null,
          statusCode: error?.statusCode || null,
          metaErrorCode: error?.metaErrorCode || null,
          metaErrorSubcode: error?.metaErrorSubcode || null,
          metaErrorType: error?.metaErrorType || null,
          metaTraceId: error?.metaTraceId || null,
        },
      });
      if (!skipped) await this.metaAccountStore?.recordLastError(
        companyId,
        error?.userMessage || safeErrorCode
      ).catch(() => undefined);
      console.error('⚠️ Auto-respuesta de agente omitida:', {
        code: safeErrorCode,
        providerStatusCode: error?.providerStatusCode || null,
        metaErrorCode: error?.metaErrorCode || null,
      });
      return { status: skipped ? 'skipped' : 'uncertain', code: safeErrorCode };
    }
  }

  private agentSendAnchor(work: MetaInboundExecution, authority: MetaInboundAuthority, effect: AgentSendAnchor['effect']): AgentSendAnchor {
    return {
      tenantId: work.companyId, conversationId: Number(work.conversationId), inboundMessageId: Number(work.messageId),
      phoneNumberId: work.phoneNumberId, effect, authority,
    };
  }

  private async sendProductCard(
    work: MetaInboundExecution, authority: MetaInboundAuthority, payload: ProductCardSendPayload,
  ): Promise<{ providerMessageId: string | null }> {
    if (payload.companyId !== work.companyId || payload.chatId !== work.message.from) {
      throw new Error('Product card does not belong to the inbound work');
    }
    const card = await this.resolveProductCardMedia(work.companyId, payload.commercialItemId);
    if (!card) throw new Error('Product card is unavailable');
    try {
      const result = await this.conversationSender.sendAgentAttachment({
        ...this.agentSendAnchor(work, authority, 'card:' + card.productId as `card:${string}`),
        file: card.media, caption: this.fitImageCaption(payload.caption || payload.productName), forceDocument: false,
      });
      await this.notifyAgentDelivery(work.companyId, payload.chatId, result);
      return { providerMessageId: result.accepted && result.deliveryState !== 'failed' ? result.providerMessageId : null };
    } finally {
      await removeTemporaryUpload(card.media.path);
    }
  }

  private async sendAgentReply(
    work: MetaInboundExecution,
    authority: MetaInboundAuthority,
    chatId: string,
    agentId: number | null,
    result: Pick<Awaited<ReturnType<AiRuntimeOrchestrator['processInbound']>>, 'reply' | 'action' | 'confidence' | 'delivery'>,
  ): Promise<MetaInboundOutcome> {
    const { companyId, inboundProviderMessageId } = work;
    const logContext = { companyId, agentId, chatId, inboundProviderMessageId, confidence: result.confidence,
      action: result.action === 'none' ? null : result.action };
    await this.logAgentRuntime({
      ...logContext, stage: 'meta_send_started', summary: 'Iniciando el envío de la respuesta automática.',
    });

    const productId = result.delivery?.productCards?.[0]?.commercialItemId;
    const card = productId ? await this.resolveProductCardMedia(companyId, productId) : null;
    const anchor = this.agentSendAnchor(work, authority, 'reply');
    let sent: AgentSendResult;
    try {
      sent = card ? await this.conversationSender.sendAgentAttachment({
        ...anchor, file: card.media, caption: this.fitImageCaption(result.reply), forceDocument: false,
      }) : await this.conversationSender.sendAgentText({ ...anchor, text: result.reply });
    } finally {
      if (card) await removeTemporaryUpload(card.media.path);
    }
    await this.notifyAgentDelivery(companyId, chatId, sent);
    if (sent.deliveryState === 'unknown_delivery') {
      await this.logAgentRuntime({ ...logContext, stage: 'meta_send_unconfirmed', level: 'warn', status: 'failed',
        summary: 'La respuesta tiene un intento persistido y su entrega sigue sin confirmarse.' });
      return { status: 'uncertain', code: 'META_REPLY_DELIVERY_UNCONFIRMED' };
    }
    if (!sent.accepted || !sent.providerMessageId || sent.deliveryState === 'failed') {
      await this.logAgentRuntime({ ...logContext, stage: 'meta_send_failed', level: 'warn', status: 'failed',
        summary: 'El envío de la respuesta automática terminó sin entrega confirmada.' });
      return { status: 'skipped', code: 'META_REPLY_FAILED' };
    }
    await this.logAgentRuntime({
      ...logContext, outboundProviderMessageId: sent.providerMessageId, stage: 'meta_send_success',
      summary: 'Meta aceptó la respuesta automática y se persistió el mensaje saliente.',
      payload: { providerMessageId: sent.providerMessageId, ...(card && { productId: card.productId }) },
    });
    const notification = { companyId, chatId, agentId, messageId: sent.providerMessageId,
      reply: result.reply, confidence: result.confidence };
    emitDashboard(companyId, 'agent:auto_reply_sent', notification);
    emitConversation(companyId, chatId, 'agent:auto_reply_sent', notification);
    await this.metaAccountStore?.recordLastError(companyId, null).catch(() => undefined);
    return { status: 'completed' };
  }

  private async notifyAgentDelivery(companyId: number, chatId: string, sent: AgentSendResult): Promise<void> {
    if (sent.messageId === null) return;
    if (sent.accepted && sent.deliveryState !== 'failed') {
      await this.getMetaStore(companyId)?.publishCanonicalOutbound(chatId, sent.messageId).catch(() => undefined);
    }
    emitConversation(companyId, chatId, 'conversation.delivery_changed', { chatId });
  }

  private async resolveProductCardMedia(companyId: number, productId: number): Promise<{
    productId: number;
    imageUrl: string;
    media: { path: string; mimetype: string; originalname: string; size: number };
  } | null> {
    if (!Number.isSafeInteger(productId) || productId <= 0) return null;
    const result = await queryInTenantScope(pool, companyId,
      `SELECT p.id,
              COALESCE(
                (
                  SELECT pi.image_url
                  FROM product_images pi
                  WHERE pi.company_id = p.company_id AND pi.product_id = p.id
                  ORDER BY pi.is_primary DESC, pi.sort_order ASC, pi.id ASC
                  LIMIT 1
                ),
                p.image_url
              ) AS image_url
       FROM products p
       WHERE p.company_id = $1 AND p.id = $2 AND p.status = 'active' AND p.ai_enabled
       LIMIT 1`,
      [companyId, productId]
    );
    const imageUrl = String(result.rows[0]?.image_url || '');
    if (!imageUrl.startsWith('/uploads/commercial-items/')) return null;
    const filename = path.basename(imageUrl);
    if (!filename) return null;
    const mimetype = mimeFromImageFilename(filename);
    if (mimetype !== 'image/jpeg' && mimetype !== 'image/png') return null;
    const sourcePath = path.join(config.whatsapp.uploadDir, 'commercial-items', filename);
    if (!existsSync(sourcePath)) return null;
    const tempDir = path.join(config.whatsapp.uploadDir, 'agent-product-cards');
    await fs.mkdir(tempDir, { recursive: true });
    const tempPath = path.join(tempDir, `${Date.now()}-${Math.random().toString(36).slice(2, 8)}-${filename}`);
    await fs.copyFile(sourcePath, tempPath);
    const stat = await fs.stat(tempPath);
    return {
      productId,
      imageUrl,
      media: {
        path: tempPath,
        mimetype,
        originalname: filename,
        size: stat.size,
      },
    };
  }

  private fitImageCaption(text: string): string {
    const value = String(text || '').trim();
    return value.length <= 1000 ? value : `${value.slice(0, 997)}...`;
  }

  private extractMessageAttachments(message: any, persisted: any): Array<{ fileUrl: string; mimeType: string | null; fileSize: number | null }> {
    const attachments: Array<{ fileUrl: string; mimeType: string | null; fileSize: number | null }> = [];
    const image = message?.image;
    const document = message?.document;
    if (image?.id || image?.caption !== undefined) {
      attachments.push({
        fileUrl: persisted?.mediaUrl || `/api/media/${image?.id || persisted?.messageId || 'unknown'}`,
        mimeType: image?.mime_type || 'image/jpeg',
        fileSize: image?.file_size ? Number(image.file_size) : null,
      });
    }
    if (document?.id) {
      attachments.push({
        fileUrl: persisted?.mediaUrl || `/api/media/${document.id}`,
        mimeType: document?.mime_type || 'application/pdf',
        fileSize: document?.file_size ? Number(document.file_size) : null,
      });
    }
    return attachments;
  }
}

export default WhatsAppService;
