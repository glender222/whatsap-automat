import { CompanyLimits } from '../../../domain/CompanyLimits';

export class CompanyLimitsMapper {
  static toDomain(row: Record<string, unknown>): CompanyLimits {
    return {
      companyId: row.company_id as number,
      maxUsers: row.max_users as number,
      maxConversations: row.max_conversations as number,
      maxMessagesPerMonth: row.max_messages_per_month as number,
    };
  }
}
