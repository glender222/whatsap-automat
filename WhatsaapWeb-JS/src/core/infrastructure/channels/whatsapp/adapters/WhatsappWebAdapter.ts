import {
  MessageChannelPort,
  SendResult,
  MediaRef,
  MediaResult,
  StatusResult,
} from '../../../../application/ports/messageChannel.port';
import {
  OutboundMessageRequestDTO,
  InboundMessageDTO,
  MessageStatusDTO,
  AttachmentDTO,
} from '../../../../application/dtos/conversation.dtos';
import { mapInboundMessage, mapMessageStatus } from '../mappers/whatsappWeb.mapper';

/**
 * Adaptador de infraestructura para whatsapp-web.js.
 * Envuelve el servicio legacy sin exponer sus tipos hacia application/core.
 */
export class WhatsappWebAdapter implements MessageChannelPort {
  constructor(
    private readonly legacyService: any,
    private readonly defaultCompanyId: number
  ) {}

  async sendMessage(dto: OutboundMessageRequestDTO): Promise<SendResult> {
    try {
      // El servicio legacy envía texto plano; adjuntos se delegarán en futuras iteraciones.
      const sentMessage = await this.legacyService.sendMessage(
        dto.externalConversationId,
        dto.body,
        null,
        { companyId: dto.companyId },
      );
      const id = sentMessage?.id;
      const providerMessageId = typeof id === 'string' ? id : id?._serialized;

      if (!providerMessageId) {
        throw new Error('Provider did not return a message ID');
      }
      return {
        providerMessageId,
        status: 'sent',
        raw: { whatsappWebId: providerMessageId },
      };
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      throw new Error(`WhatsApp send failed: ${err.message}`);
    }
  }

  async downloadMedia(ref: MediaRef): Promise<MediaResult> {
    if (!ref.providerMediaId) {
      throw new Error('providerMediaId is required to download media');
    }
    const media = await this.legacyService.downloadMedia(ref.providerMediaId);
    const data = media?.data ? Buffer.from(media.data as string, 'base64') : Buffer.alloc(0);
    return {
      data,
      mimeType: (media?.mimetype as string) || ref.mimeType || 'application/octet-stream',
      filename: (media?.filename as string) || undefined,
    };
  }

  async markAsRead(extConvId: string): Promise<void> {
    await this.legacyService.markAsRead(extConvId);
  }

  async getStatus(): Promise<StatusResult> {
    const status = await this.legacyService.getStatus();
    return {
      connected: !!status?.isConnected,
      authenticated: !!status?.isReady,
      details: status ?? {},
    };
  }

  normalizeInbound(msg: unknown, chat: unknown, companyId?: number): InboundMessageDTO {
    return mapInboundMessage(
      msg as Record<string, unknown>,
      chat as Record<string, unknown>,
      companyId ?? this.defaultCompanyId
    );
  }

  normalizeStatus(msg: unknown, ack: number, companyId?: number): MessageStatusDTO | null {
    return mapMessageStatus(
      msg as Record<string, unknown>,
      ack,
      companyId ?? this.defaultCompanyId
    );
  }

  normalizeMedia(msg: unknown): AttachmentDTO[] {
    const raw = msg as any;
    if (!raw?.hasMedia) return [];
    return [
      {
        filename: (raw._data?.filename as string) ?? null,
        mimeType: (raw._data?.mimetype as string) ?? null,
        sizeBytes: null,
        externalUrl: null,
        internalPath: null,
        metadata: { messageId: raw.id?._serialized },
      },
    ];
  }
}
