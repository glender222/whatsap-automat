import { tenantScopedUoW, type TenantScopedUoW } from '../../../db/TenantScopedUoW';
import type { PaymentCheckoutDispatch, PaymentCheckoutDispatchOutcome } from '../domain/paymentCheckoutDispatch.types';
import { PaymentCheckoutDispatchRepositoryPg } from '../infra/db/PaymentCheckoutDispatchRepositoryPg';
import type { MercadoPagoOrdersAdapter } from '../infra/mercadopago/MercadoPagoOrdersAdapter';
import {
  assertCheckoutIntentRequest, assertCurrentCheckout, lockCheckoutIntent, PaymentCheckoutIntentError,
  requireCheckoutAdmin, type CheckoutActor,
} from './PaymentCheckoutIntentService';

type DispatchRequest = CheckoutActor & { intentId: string; expectedVersion: number };
type OrdersCreator = Pick<MercadoPagoOrdersAdapter, 'create'>;
type ProviderResult = Awaited<ReturnType<OrdersCreator['create']>>;

function dispatchOutcome(result: ProviderResult): PaymentCheckoutDispatchOutcome {
  switch (result.kind) {
    case 'created':
      return { state: 'created', providerOrderId: result.orderId, providerExpiresAt: result.expiresAt };
    case 'uncertain':
      return { state: 'uncertain', providerOrderId: result.orderId, outcomeCode: result.reason };
    case 'rejected':
      return { state: 'rejected', outcomeCode: result.code };
    case 'not_sent':
      return { state: 'not_sent', outcomeCode: result.reason };
  }
}

export class PaymentCheckoutDispatchService {
  constructor(
    private readonly provider: OrdersCreator,
    private readonly uow: Pick<TenantScopedUoW, 'run'> = tenantScopedUoW,
  ) {}

  async dispatch(request: DispatchRequest): Promise<PaymentCheckoutDispatch> {
    const { companyId, actorUserId, intentId, expectedVersion } = request;
    assertCheckoutIntentRequest(request, intentId, expectedVersion);
    const claim = await this.uow.run(companyId, async (client) => {
      await requireCheckoutAdmin(client, request);
      const checkout = await lockCheckoutIntent(client, companyId, intentId);
      const { intent } = checkout;
      const dispatches = new PaymentCheckoutDispatchRepositoryPg(client);
      const existing = await dispatches.byOrder(companyId, intent.orderId);
      if (existing?.intentId === intentId) return { dispatch: existing, intent: null };
      if (existing) {
        throw new PaymentCheckoutIntentError(409, 'CHECKOUT_ORDER_ALREADY_DISPATCHED', 'El pedido ya tiene un intento de envío registrado.');
      }
      if (intent.version !== expectedVersion) {
        throw new PaymentCheckoutIntentError(409, 'CHECKOUT_VERSION_CONFLICT', 'La versión de la intención cambió.');
      }
      await assertCurrentCheckout(companyId, checkout);
      const dispatch = await dispatches.claim(companyId, actorUserId, intent);
      if (!dispatch) {
        throw new PaymentCheckoutIntentError(409, 'CHECKOUT_DISPATCH_WINDOW_UNAVAILABLE', 'La reserva no permite abrir un checkout con vigencia suficiente.');
      }
      return { dispatch, intent };
    });
    if (!claim.intent) return claim.dispatch;

    let outcome: PaymentCheckoutDispatchOutcome;
    try {
      outcome = dispatchOutcome(await this.provider.create({
        companyId, intent: claim.intent, plannedAt: claim.dispatch.plannedAt, validUntil: claim.dispatch.validUntil,
      }));
    } catch {
      // An exception cannot prove that the provider never received the order.
      outcome = { state: 'uncertain', outcomeCode: 'adapter_error' };
    }
    return this.uow.run(companyId, async (client) => {
      const dispatches = new PaymentCheckoutDispatchRepositoryPg(client);
      const settled = await dispatches.finish(companyId, intentId, claim.dispatch.version, outcome);
      if (settled) return settled;
      const current = await dispatches.get(companyId, intentId);
      if (current) return current;
      throw new Error('El registro de despacho dejó de estar disponible.');
    });
  }
}
