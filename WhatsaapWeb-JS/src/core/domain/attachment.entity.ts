export interface Attachment {
  id: number;
  messageId: number;
  filename: string | null;
  mimeType: string | null;
  sizeBytes: number | null;
  externalUrl: string | null;
  internalPath: string | null;
  metadataJson: Record<string, unknown> | null;
  createdAt: Date;
}
