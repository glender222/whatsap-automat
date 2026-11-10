import { randomUUID } from 'node:crypto';
import { tenantScopedUoW, type TenantScopedUoW } from '../../../db/TenantScopedUoW';
import { readCurrentWorkspace } from '../../../services/workspaces/WorkspaceQueryService';
import type { Queryable } from '../../../shared/UnitOfWorkPort';
import { OrderRepositoryPg } from '../../orders/infra/db/OrderRepositoryPg';
import type { CheckoutIntentSnapshot, PaymentCheckoutIntent } from '../domain/paymentCheckoutIntent.types';
import { PaymentCheckoutIntentRepositoryPg } from '../infra/db/PaymentCheckoutIntentRepositoryPg';

type CheckoutActor = { companyId: number; actorUserId: number; sessionRole: string | undefined };
type PrepareCheckout = CheckoutActor & { orderId: number; gatewayId: number; idempotencyKey: string };
type CheckoutItems = Awaited<ReturnType<OrderRepositoryPg['checkoutItems']>>;
const requestKey = /^[A-Za-z0-9_.:-]{1,128}$/;
const intentIdPattern = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const maxDatabaseInt = 2_147_483_647;
const maxAmountCents = 999_999_999_999n;

export class PaymentCheckoutIntentError extends Error {
  constructor(readonly statusCode: number, readonly code: string, message: string) {
    super(message);
  }
}

function amountAndItems(source: CheckoutItems, orderStatus: CheckoutIntentSnapshot['orderStatus']) {
  if (!source.items.length) {
    throw new PaymentCheckoutIntentError(409, 'CHECKOUT_ORDER_ITEMS_REQUIRED', 'El pedido requiere ítems para preparar el cobro.');
  }
  const balances = new Map(source.reservations.map((item) => [String(item.itemId), item]));
  if (balances.size !== source.reservations.length) {
    throw new PaymentCheckoutIntentError(409, 'CHECKOUT_STOCK_UNVERIFIED', 'El pedido tiene reservas que requieren conciliación.');
  }
  let cents = 0n;
  const items = source.items.map((item) => {
    const balance = balances.get(item.id);
    const tracked = item.availabilityType === 'stock' || item.availabilityType === 'capacity';
    if (!item.catalogItemId || item.status !== orderStatus ||
        (tracked
          ? item.availability !== 'reserved' || String(balance?.productId) !== item.catalogItemId || balance?.quantity !== item.quantity
          : item.availabilityType !== 'unlimited' || item.availability !== 'unlimited' || balance)) {
      throw new PaymentCheckoutIntentError(409, 'CHECKOUT_STOCK_UNVERIFIED', 'El pedido contiene ítems sin disponibilidad confirmada.');
    }
    balances.delete(item.id);
    if (item.currency !== 'PEN') {
      throw new PaymentCheckoutIntentError(409, 'CHECKOUT_CURRENCY_UNSUPPORTED', 'El cobro requiere una sola moneda PEN.');
    }
    if (!item.title.trim() || !Number.isSafeInteger(item.quantity) || item.quantity <= 0 ||
        !item.unitAmount || !/^\d+\.\d{2}$/.test(item.unitAmount) || item.unitAmount === '0.00') {
      throw new PaymentCheckoutIntentError(409, 'CHECKOUT_AMOUNT_INVALID', 'El pedido tiene ítems con importes incompletos o inválidos.');
    }
    cents += BigInt(item.unitAmount.replace('.', '')) * BigInt(item.quantity);
    return { id: item.id, catalogItemId: item.catalogItemId, title: item.title, quantity: item.quantity, unitAmount: item.unitAmount };
  });
  if (balances.size) {
    throw new PaymentCheckoutIntentError(409, 'CHECKOUT_STOCK_UNVERIFIED', 'El pedido tiene reservas que requieren conciliación.');
  }
  if (cents <= 0n || cents > maxAmountCents) {
    throw new PaymentCheckoutIntentError(409, 'CHECKOUT_AMOUNT_INVALID', 'El total del pedido excede el rango de cobro.');
  }
  const amount = `${cents / 100n}.${String(cents % 100n).padStart(2, '0')}`;
  return { amount, items };
}

function assertKeyScope(intent: PaymentCheckoutIntent, input: PrepareCheckout) {
  if (intent.orderId !== String(input.orderId) || intent.gatewayId !== String(input.gatewayId)) {
    throw new PaymentCheckoutIntentError(409, 'CHECKOUT_KEY_CONFLICT', 'La clave ya corresponde a otra orden o pasarela.');
  }
}

function assertSnapshot(intent: PaymentCheckoutIntent, snapshot: CheckoutIntentSnapshot) {
  const sameItems = intent.items.length === snapshot.items.length && intent.items.every((item, index) => {
    const line = snapshot.items[index];
    return item.id === line.id && item.catalogItemId === line.catalogItemId && item.title === line.title &&
      item.quantity === line.quantity && item.unitAmount === line.unitAmount;
  });
  if (!sameItems || intent.amount !== snapshot.amount || intent.orderRevision !== snapshot.orderRevision ||
      intent.orderStatus !== snapshot.orderStatus || intent.reservationExpiresAt !== snapshot.reservationExpiresAt ||
      intent.gatewayRevision !== snapshot.gatewayRevision) {
    throw new PaymentCheckoutIntentError(409, 'CHECKOUT_SNAPSHOT_CHANGED', 'El pedido o la pasarela cambiaron desde la preparación.');
  }
}

export class PaymentCheckoutIntentService {
  constructor(private readonly uow: TenantScopedUoW = tenantScopedUoW) {}

  async prepare(input: PrepareCheckout): Promise<PaymentCheckoutIntent> {
    const { companyId, actorUserId, orderId, gatewayId, idempotencyKey } = input;
    if (!validActor(input) || ![orderId, gatewayId].every((id) => Number.isSafeInteger(id) && id > 0) ||
        typeof idempotencyKey !== 'string' || !requestKey.test(idempotencyKey)) {
      throw new PaymentCheckoutIntentError(422, 'CHECKOUT_INPUT_INVALID', 'La orden, la pasarela y la clave deben ser válidas.');
    }
    return this.uow.run(companyId, async (client) => {
      await this.requireAdmin(client, input);
      const orders = new OrderRepositoryPg(client);
      const order = await orders.lockForCheckout(companyId, orderId);
      if (!order) throw new PaymentCheckoutIntentError(404, 'CHECKOUT_ORDER_NOT_FOUND', 'Pedido comercial no encontrado.');
      const intents = new PaymentCheckoutIntentRepositoryPg(client);
      const existing = await intents.byKey(companyId, actorUserId, idempotencyKey);
      if (existing) {
        assertKeyScope(existing, input);
        if (existing.state === 'voided') return existing;
      }
      const voucher = await intents.voucherStatus(companyId, orderId);
      if (voucher === 'validated') {
        throw new PaymentCheckoutIntentError(409, 'CHECKOUT_PAYMENT_ALREADY_VALIDATED', 'El pedido ya tiene un comprobante validado.');
      }
      if (voucher === 'pending') {
        throw new PaymentCheckoutIntentError(409, 'CHECKOUT_VOUCHER_PENDING', 'Hay un comprobante pendiente de revisión para el pedido.');
      }
      if (order.expired) throw this.expiredReservation();
      if (!order.confirmed || (order.status !== 'confirmed' && order.status !== 'reserved')) {
        throw new PaymentCheckoutIntentError(409, 'CHECKOUT_ORDER_NOT_READY', 'El pedido requiere una confirmación vigente.');
      }
      if (!existing && await intents.hasPrepared(companyId, orderId)) throw this.preparedConflict();
      const gatewayRevision = await intents.lockGateway(companyId, gatewayId);
      if (!gatewayRevision) {
        throw new PaymentCheckoutIntentError(404, 'CHECKOUT_GATEWAY_UNAVAILABLE', 'La pasarela Mercado Pago no está disponible.');
      }
      const snapshot: CheckoutIntentSnapshot = {
        ...amountAndItems(await orders.checkoutItems(companyId, orderId), order.status),
        currency: 'PEN', orderStatus: order.status, orderRevision: order.revision,
        reservationExpiresAt: order.deadline, gatewayRevision,
      };
      if (!await intents.deadlineIsLive(order.deadline)) throw this.expiredReservation();
      if (existing) {
        assertSnapshot(existing, snapshot);
        return existing;
      }
      const intent = await intents.insert({ ...input, id: randomUUID(), externalReference: randomUUID(), snapshot });
      if (intent) return intent;
      if (!await intents.deadlineIsLive(order.deadline)) throw this.expiredReservation();
      const conflict = await intents.byKey(companyId, actorUserId, idempotencyKey);
      if (conflict) assertKeyScope(conflict, input);
      throw this.preparedConflict();
    });
  }

  async void(input: CheckoutActor & { intentId: string; expectedVersion: number }): Promise<PaymentCheckoutIntent> {
    if (!validActor(input) || typeof input.intentId !== 'string' || !intentIdPattern.test(input.intentId) ||
        !Number.isInteger(input.expectedVersion) || input.expectedVersion < 1 || input.expectedVersion > maxDatabaseInt) {
      throw new PaymentCheckoutIntentError(422, 'CHECKOUT_INPUT_INVALID', 'La intención y la versión deben ser válidas.');
    }
    return this.uow.run(input.companyId, async (client) => {
      await this.requireAdmin(client, input);
      const intents = new PaymentCheckoutIntentRepositoryPg(client);
      const intent = await intents.get(input.companyId, input.intentId);
      if (!intent || !await new OrderRepositoryPg(client).lockForCheckout(input.companyId, Number(intent.orderId))) {
        throw new PaymentCheckoutIntentError(404, 'CHECKOUT_INTENT_NOT_FOUND', 'Intención de cobro no encontrada.');
      }
      const updated = await intents.void(input.companyId, input.intentId, input.expectedVersion);
      if (!updated) {
        throw new PaymentCheckoutIntentError(409, 'CHECKOUT_VERSION_CONFLICT', 'El estado o la versión de la intención cambiaron.');
      }
      return updated;
    });
  }

  private async requireAdmin(client: Queryable, actor: CheckoutActor) {
    const workspace = await readCurrentWorkspace(client, actor.companyId, actor.actorUserId, actor.sessionRole, true);
    if (!workspace?.capabilities.includes('approvals.review')) {
      throw new PaymentCheckoutIntentError(403, 'CHECKOUT_ADMIN_REQUIRED', 'Preparar el cobro requiere un administrador activo.');
    }
  }

  private preparedConflict() {
    return new PaymentCheckoutIntentError(409, 'CHECKOUT_ALREADY_PREPARED', 'El pedido ya tiene una intención de cobro vigente.');
  }

  private expiredReservation() {
    return new PaymentCheckoutIntentError(409, 'CHECKOUT_RESERVATION_EXPIRED', 'El plazo de reserva del pedido terminó.');
  }
}

function validActor({ companyId, actorUserId }: CheckoutActor): boolean {
  return [companyId, actorUserId].every((id) => Number.isInteger(id) && id > 0 && id <= maxDatabaseInt);
}
