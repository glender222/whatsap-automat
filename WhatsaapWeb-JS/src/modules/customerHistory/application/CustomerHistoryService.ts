import { CustomerHistory, CustomerHistoryLimits } from '../domain/customerHistory.types';
import { CustomerHistoryRepositoryPort } from './ports/CustomerHistoryRepositoryPort';

const DEFAULT_CONVERSATION_LIMIT = 10;
const DEFAULT_MESSAGE_LIMIT = 50;
const MAX_CONVERSATION_LIMIT = 25;
const MAX_MESSAGE_LIMIT = 100;

export class CustomerHistoryNotFoundError extends Error {
  readonly statusCode = 404;
  readonly code = 'CUSTOMER_HISTORY_NOT_FOUND';

  constructor(message = 'No se encontro historial para este cliente') {
    super(message);
  }
}

export class CustomerHistoryService {
  constructor(private readonly repository: CustomerHistoryRepositoryPort) {}

  async getByContactId(companyId: number, contactId: number, inputLimits: Partial<CustomerHistoryLimits>): Promise<CustomerHistory> {
    const history = await this.repository.findByContactId(companyId, contactId, this.normalizeLimits(inputLimits));
    if (!history) throw new CustomerHistoryNotFoundError();
    return history;
  }

  async getByChatId(companyId: number, chatId: string, inputLimits: Partial<CustomerHistoryLimits>): Promise<CustomerHistory> {
    const history = await this.repository.findByChatId(companyId, chatId, this.normalizeLimits(inputLimits));
    if (!history) throw new CustomerHistoryNotFoundError();
    return history;
  }

  private normalizeLimits(input: Partial<CustomerHistoryLimits>): CustomerHistoryLimits {
    return {
      conversationLimit: this.clamp(input.conversationLimit, DEFAULT_CONVERSATION_LIMIT, MAX_CONVERSATION_LIMIT),
      messageLimit: this.clamp(input.messageLimit, DEFAULT_MESSAGE_LIMIT, MAX_MESSAGE_LIMIT),
    };
  }

  private clamp(value: number | undefined, fallback: number, max: number): number {
    if (value === undefined || !Number.isInteger(value) || value <= 0) return fallback;
    return Math.min(value, max);
  }
}
