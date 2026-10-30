import { OutboundMessageRequestDTO } from '../dtos/conversation.dtos';

export interface SendResult {
  providerMessageId: string;
  status: string;
  raw?: Record<string, unknown>;
}

export interface MediaRef {
  externalUrl?: string;
  providerMediaId?: string;
  mimeType?: string;
}

export interface MediaResult {
  data: Buffer;
  mimeType: string;
  filename?: string;
}

export interface StatusResult {
  connected: boolean;
  authenticated: boolean;
  details?: Record<string, unknown>;
}

export interface MessageChannelPort {
  sendMessage(dto: OutboundMessageRequestDTO): Promise<SendResult>;
  downloadMedia(ref: MediaRef): Promise<MediaResult>;
  markAsRead(extConvId: string): Promise<void>;
  getStatus(): Promise<StatusResult>;
}
