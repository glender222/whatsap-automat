import { CommercialOrderStatus, CreateDetectedOrderInput } from '../domain/order.types';
import { OrderRepositoryPg } from '../infra/db/OrderRepositoryPg';

export class OrderService {
  constructor(private readonly repository: OrderRepositoryPg) {}

  list(companyId: number, limit = 50, offset = 0) {
    return this.repository.list(companyId, Math.min(Math.max(limit, 1), 200), Math.max(offset, 0));
  }

  get(companyId: number, orderId: number) {
    this.assertId(orderId);
    return this.repository.get(companyId, orderId);
  }

  createDetected(input: CreateDetectedOrderInput) {
    if (!input.chatId?.trim()) throw this.validationError('chatId requerido');
    if (!Array.isArray(input.items) || input.items.length === 0) throw this.validationError('Items de pedido requeridos');
    return this.repository.createDetected({
      ...input,
      items: input.items.map((item) => ({
        commercialItemId: item.commercialItemId ? Number(item.commercialItemId) : null,
        detectedName: String(item.detectedName || item.productName || '').trim(),
        productName: String(item.productName || item.detectedName || '').trim(),
        quantity: Math.max(1, Math.trunc(Number(item.quantity || 1))),
        confidence: item.confidence === undefined ? undefined : Number(item.confidence),
        ambiguous: Boolean(item.ambiguous),
      })).filter((item) => item.commercialItemId || item.productName),
    });
  }

  updateStatus(companyId: number, orderId: number, status: CommercialOrderStatus, actorUserId: number | null) {
    this.assertId(orderId);
    if (!['draft', 'quoted', 'pending_handoff', 'pending_approval', 'confirmed', 'reserved', 'cancelled', 'completed', 'out_of_stock', 'unavailable'].includes(status)) {
      throw this.validationError('Estado de pedido invalido');
    }
    return this.repository.updateStatus(companyId, orderId, status, actorUserId);
  }

  private assertId(value: number): void {
    if (!Number.isInteger(value) || value <= 0) throw this.validationError('Pedido invalido');
  }

  private validationError(message: string): Error & { statusCode?: number; code?: string } {
    const error = new Error(message) as Error & { statusCode?: number; code?: string };
    error.statusCode = 400;
    error.code = 'VALIDATION_ERROR';
    return error;
  }
}
