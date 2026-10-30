import { Plan } from '../../../domain/Plan';

export class PlanMapper {
  static toDomain(row: Record<string, unknown>): Plan {
    return {
      id: row.id as number,
      code: row.code as string,
      name: row.name as string,
      description: (row.description as string | null) ?? null,
      maxUsers: row.max_users as number,
      maxConversations: row.max_conversations as number,
      maxMessagesPerMonth: row.max_messages_per_month as number,
      createdAt: row.created_at as Date,
      updatedAt: row.updated_at as Date,
    };
  }
}
