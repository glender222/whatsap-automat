import { toPositiveInt } from '../../../middleware/jwtAuth';
import { OrderError } from '../domain/OrderError';
import type { CommercialOrderStatus, CreateDetectedOrderInput } from '../domain/order.types';
import { OrderRepositoryPg } from '../infra/db/OrderRepositoryPg';

const detectedStatuses = ['draft', 'quoted', 'pending_handoff'];
const orderStatuses = [...detectedStatuses, 'pending_approval', 'confirmed', 'reserved',
  'cancelled', 'completed', 'out_of_stock', 'unavailable'];

function invalid(message: string) { return new OrderError(400, 'VALIDATION_ERROR', message); }

export class OrderService {
  constructor(private readonly repository: OrderRepositoryPg) {}

  list(companyId: number, limit = 50, offset = 0) {
    return this.repository.list(companyId, Math.min(Math.max(Math.trunc(limit), 1), 200), Math.max(Math.trunc(offset), 0));
  }

  get(companyId: number, orderId: number) {
    this.assertId(orderId);
    return this.repository.get(companyId, orderId);
  }

  createDetected(input: CreateDetectedOrderInput) {
    if (typeof input.chatId !== 'string' || !input.chatId.trim() || input.chatId.trim().length > 255) {
      throw invalid('chatId invalido');
    }
    if (!Array.isArray(input.items) || !input.items.length || input.items.length > 100) {
      throw invalid('El prepedido requiere entre 1 y 100 items');
    }
    if (input.status !== undefined && !detectedStatuses.includes(input.status)) {
      throw invalid('El estado solicitado no corresponde a un prepedido');
    }
    for (const id of [input.agentId, input.sourceMessageId]) {
      if (id != null && (!Number.isSafeInteger(id) || id <= 0)) throw invalid('Referencia de pedido invalida');
    }
    if (input.sourceMessageId != null && input.sourceMessageId > 2_147_483_647) {
      throw invalid('Mensaje de origen invalido');
    }
    if (input.metadata != null && (typeof input.metadata !== 'object' || Array.isArray(input.metadata))) {
      throw invalid('Metadatos de pedido invalidos');
    }

    const items = input.items.map((item) => {
      if (!item || typeof item !== 'object') throw invalid('Item de pedido invalido');
      const commercialItemId = item.commercialItemId == null ? null : toPositiveInt(item.commercialItemId);
      if (item.commercialItemId != null && !Number.isSafeInteger(commercialItemId)) throw invalid('Item de catalogo invalido');
      const detectedName = typeof item.detectedName === 'string' ? item.detectedName.trim() : '';
      const productName = typeof item.productName === 'string' ? item.productName.trim() : '';
      if ((!commercialItemId && !productName && !detectedName) ||
          [detectedName, productName].some((value) => Array.from(value).length > 180)) throw invalid('Nombre de item invalido');
      const quantity = item.quantity === undefined ? 1 : toPositiveInt(item.quantity);
      if (!quantity || quantity > 2_147_483_647) throw invalid('Cantidad de pedido invalida');
      return { commercialItemId, detectedName, productName, quantity, ambiguous: item.ambiguous === true };
    });
    return this.repository.createDetected({ ...input, chatId: input.chatId.trim(), items });
  }

  updateStatus(companyId: number, orderId: number, status: CommercialOrderStatus, actorUserId: number | null) {
    this.assertId(orderId);
    if (!orderStatuses.includes(status)) throw invalid('Estado de pedido invalido');
    return this.repository.updateStatus(companyId, orderId, status, actorUserId);
  }

  private assertId(value: number): void {
    if (!Number.isSafeInteger(value) || value <= 0) throw invalid('Pedido invalido');
  }
}
