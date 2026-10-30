import { Attachment } from '../../../domain/attachment.entity';

export class AttachmentMapper {
  static toDomain(row: Record<string, unknown>): Attachment {
    return {
      id: row.id as number,
      messageId: row.message_id as number,
      filename: (row.filename as string | null) ?? null,
      mimeType: (row.mime_type as string | null) ?? null,
      sizeBytes: (row.size_bytes as number | null) ?? null,
      externalUrl: (row.external_url as string | null) ?? null,
      internalPath: (row.internal_path as string | null) ?? null,
      metadataJson: (row.metadata_json as Record<string, unknown> | null) ?? null,
      createdAt: row.created_at as Date,
    };
  }
}
