import {
  CreatePaymentVoucherInput,
  MarkFromMessageInput,
  PaymentFilters,
  PaymentMethod,
  PaymentVoucher,
  PaymentVoucherPage,
  PaymentVoucherStatus,
} from '../domain/payment.types';
import { PaymentRepositoryPg } from '../infra/db/PaymentRepositoryPg';

const VALID_METHODS: PaymentMethod[] = ['yape', 'plin', 'bank_transfer', 'cash', 'other'];
const VALID_STATUSES: PaymentVoucherStatus[] = ['pending', 'validated', 'rejected'];

export class PaymentService {
  constructor(private readonly repository: PaymentRepositoryPg) {}

  list(companyId: number, filters: PaymentFilters): Promise<PaymentVoucherPage> {
    return this.repository.list(companyId, {
      ...filters,
      limit: Math.min(Math.max(filters.limit || 50, 1), 200),
      offset: Math.max(filters.offset || 0, 0),
    });
  }

  countPending(companyId: number): Promise<number> {
    return this.repository.countPending(companyId);
  }

  get(companyId: number, voucherId: number): Promise<PaymentVoucher | null> {
    this.assertId(voucherId);
    return this.repository.get(companyId, voucherId);
  }

  create(input: CreatePaymentVoucherInput): Promise<PaymentVoucher> {
    if (!input.fileUrl?.trim()) throw this.validationError('fileUrl requerido');
    if (!VALID_METHODS.includes(input.paymentMethod)) throw this.validationError('paymentMethod invalido');
    this.assertAmount(input.amount);
    return this.repository.create(input);
  }

  markFromMessage(input: MarkFromMessageInput): Promise<PaymentVoucher> {
    if (!Number.isInteger(input.messageId) || input.messageId <= 0) {
      throw this.validationError('messageId invalido');
    }
    if (!VALID_METHODS.includes(input.paymentMethod)) throw this.validationError('paymentMethod invalido');
    this.assertAmount(input.amount);
    return this.repository.markFromMessage(input);
  }

  validate(companyId: number, voucherId: number, actorUserId: number | null): Promise<PaymentVoucher | null> {
    this.assertId(voucherId);
    return this.repository.updateStatus(companyId, voucherId, 'validated', actorUserId, null);
  }

  reject(
    companyId: number,
    voucherId: number,
    actorUserId: number | null,
    rejectionReason: string | null
  ): Promise<PaymentVoucher | null> {
    this.assertId(voucherId);
    const reason = (rejectionReason || '').trim();
    if (!reason) throw this.validationError('rejectionReason requerido');
    return this.repository.updateStatus(companyId, voucherId, 'rejected', actorUserId, reason);
  }

  assertStatus(value: unknown): asserts value is PaymentVoucherStatus {
    if (!VALID_STATUSES.includes(value as PaymentVoucherStatus)) {
      throw this.validationError('status invalido');
    }
  }

  private assertAmount(amount: number | null | undefined): void {
    if (amount != null && (!Number.isFinite(amount) || amount < 0 || amount > 9999999999.99)) {
      throw this.validationError('Monto inválido');
    }
  }

  private assertId(value: number): void {
    if (!Number.isInteger(value) || value <= 0) throw this.validationError('Comprobante invalido');
  }

  private validationError(message: string): Error & { statusCode?: number; code?: string } {
    const error = new Error(message) as Error & { statusCode?: number; code?: string };
    error.statusCode = 400;
    error.code = 'VALIDATION_ERROR';
    return error;
  }
}
