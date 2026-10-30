import { PaymentRepositoryPg } from '../../payments';
import { emitDashboard, emitToRoom } from '../../../sockets/socketEmitter';

const PAYMENT_METHOD_REGEX = /(yape|plin|banco|bcp|interbank|bbva|transferencia|deposito)/i;
const PAYMENT_TEXT_REGEX = /\b(comprobante|pago enviado|adjunto el pago|realic.*pago|transferencia realizada|envie el dinero)\b/i;

export type VoucherDetection = {
  detected: boolean;
  paymentMethod: 'yape' | 'plin' | 'bank_transfer' | 'cash' | 'other';
  fileUrl: string | null;
  mimeType: string | null;
  fileSize: number | null;
  reason: string;
};

export class AgentVoucherService {
  constructor(private readonly paymentRepo: PaymentRepositoryPg) {}

  detect(input: {
    messageBody: string;
    attachments: Array<{ fileUrl: string; mimeType: string | null; fileSize: number | null }>;
  }): VoucherDetection {
    const body = String(input.messageBody || '');
    const textHit = PAYMENT_TEXT_REGEX.test(body);
    const methodMatch = body.match(PAYMENT_METHOD_REGEX);
    const attachment = input.attachments?.[0] || null;
    const isImageOrPdf = attachment
      ? /^(image\/(jpeg|png|webp|gif)|application\/pdf)/i.test(String(attachment.mimeType || ''))
      : false;

    if (textHit || (attachment && isImageOrPdf)) {
      const method = methodMatch
        ? this.inferMethod(methodMatch[1])
        : attachment
          ? 'other'
          : 'other';
      return {
        detected: true,
        paymentMethod: method,
        fileUrl: attachment?.fileUrl || null,
        mimeType: attachment?.mimeType || null,
        fileSize: attachment?.fileSize || null,
        reason: textHit ? 'Mencion de pago en texto' : 'Attachment compatible con comprobante',
      };
    }

    return {
      detected: false,
      paymentMethod: 'other',
      fileUrl: null,
      mimeType: null,
      fileSize: null,
      reason: 'Sin señal de pago',
    };
  }

  async createFromMessage(input: {
    companyId: number;
    chatId: string;
    conversationId: number | null;
    contactId: number | null;
    sourceMessageId: number | null;
    detection: VoucherDetection;
    agentId: number | null;
    notes?: string | null;
  }): Promise<{ voucherId: number } | null> {
    if (!input.detection.detected) return null;
    const voucher = await this.paymentRepo.create({
      companyId: input.companyId,
      chatId: input.chatId,
      contactId: input.contactId,
      conversationId: input.conversationId,
      sourceMessageId: input.sourceMessageId,
      fileUrl: input.detection.fileUrl || '(comprobante-sin-archivo)',
      mimeType: input.detection.mimeType,
      fileSize: input.detection.fileSize,
      paymentMethod: input.detection.paymentMethod,
      uploadedBy: null,
      notes: input.notes ?? input.detection.reason,
      metadata: { origin: 'agent_detected', agentId: input.agentId },
    });
    emitDashboard('payment-created', {
      companyId: input.companyId,
      voucherId: voucher.id,
      chatId: input.chatId,
      origin: 'agent',
    });
    emitDashboard('agent:voucher_created', {
      companyId: input.companyId,
      voucherId: voucher.id,
      chatId: input.chatId,
      agentId: input.agentId,
    });
    if (input.chatId) emitToRoom(input.chatId, 'payment-created', { voucherId: voucher.id });
    return { voucherId: voucher.id };
  }

  private inferMethod(token: string): 'yape' | 'plin' | 'bank_transfer' | 'cash' | 'other' {
    const lower = String(token || '').toLowerCase();
    if (lower === 'yape') return 'yape';
    if (lower === 'plin') return 'plin';
    if (['banco', 'bcp', 'interbank', 'bbva', 'transferencia', 'deposito'].includes(lower)) return 'bank_transfer';
    return 'other';
  }
}
