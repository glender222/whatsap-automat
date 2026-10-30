import { MessageStatus } from '../../../domain/messageStatus.entity';

export class StatusMapper {
  static toDomain(row: Record<string, unknown>): MessageStatus {
    return {
      id: row.id as number,
      messageId: row.message_id as number,
      status: row.status as string,
      source: (row.source as string | null) ?? null,
      occurredAt: row.occurred_at as Date,
      metadataJson: (row.metadata_json as Record<string, unknown> | null) ?? null,
      createdAt: row.created_at as Date,
    };
  }
}
