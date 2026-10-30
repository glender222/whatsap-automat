export interface MessageStatus {
  id: number;
  messageId: number;
  status: string;
  source: string | null;
  occurredAt: Date;
  metadataJson: Record<string, unknown> | null;
  createdAt: Date;
}
