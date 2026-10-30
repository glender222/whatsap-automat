import { CustomerHistory, CustomerHistoryLimits } from '../../domain/customerHistory.types';

export interface CustomerHistoryRepositoryPort {
  findByContactId(companyId: number, contactId: number, limits: CustomerHistoryLimits): Promise<CustomerHistory | null>;
  findByChatId(companyId: number, chatId: string, limits: CustomerHistoryLimits): Promise<CustomerHistory | null>;
}
