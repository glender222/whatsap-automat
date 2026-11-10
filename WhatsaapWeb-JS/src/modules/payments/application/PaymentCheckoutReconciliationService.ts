import { tenantScopedUoW, type TenantScopedUoW } from '../../../db/TenantScopedUoW';
import { OrderError } from '../../orders';
import { PaymentCheckoutDispatchRepositoryPg } from '../infra/db/PaymentCheckoutDispatchRepositoryPg';
import { PaymentCheckoutIntentRepositoryPg } from '../infra/db/PaymentCheckoutIntentRepositoryPg';
import {
  PaymentCheckoutReconciliationRepositoryPg,
  type CheckoutReconciliation,
  type ObservationDecision,
} from '../infra/db/PaymentCheckoutReconciliationRepositoryPg';
import { isMercadoPagoOrderId, type MercadoPagoOrdersAdapter } from '../infra/mercadopago/MercadoPagoOrdersAdapter';
import {
  assertCurrentCheckout,
  lockCheckoutIntent,
  PaymentCheckoutIntentError,
  requireCheckoutAdmin,
  type CheckoutActor,
} from './PaymentCheckoutIntentService';

type ReconcileInput = CheckoutActor & { intentId: string; providerOrderId?: string };
type Lookup = Awaited<ReturnType<MercadoPagoOrdersAdapter['lookup']>>;
type Observed = Extract<Lookup, { kind: 'observed' }>;
type ReconcileResult =
  | { kind: 'observed'; reconciliation: CheckoutReconciliation }
  | { kind: 'retry'; reason: 'provider_unavailable' | 'observation_superseded' };
type LockedCheckout = Awaited<ReturnType<typeof lockCheckoutIntent>>;
const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const claimGraceMs = 30_000;

function requireInput(input: ReconcileInput) {
  if (![input.companyId, input.actorUserId].every((id) => Number.isInteger(id) && id > 0 && id <= 2_147_483_647) ||
      typeof input.intentId !== 'string' || !uuid.test(input.intentId) ||
      (input.providerOrderId !== undefined && !isMercadoPagoOrderId(input.providerOrderId))) {
    throw new PaymentCheckoutIntentError(422, 'CHECKOUT_INPUT_INVALID', 'La intención o la referencia de proveedor no son válidas.');
  }
}

function unavailableDispatch() {
  return new PaymentCheckoutIntentError(409, 'CHECKOUT_DISPATCH_NOT_RECONCILABLE', 'El intento de cobro aún no admite conciliación.');
}

function review(reviewCode: Extract<ObservationDecision, { state: 'review_required' }>['reviewCode']): ObservationDecision {
  return { state: 'review_required', reviewCode };
}

export class PaymentCheckoutReconciliationService {
  constructor(
    private readonly adapter: Pick<MercadoPagoOrdersAdapter, 'lookup'>,
    private readonly uow: Pick<TenantScopedUoW, 'run'> = tenantScopedUoW,
  ) {}

  async reconcile(input: ReconcileInput): Promise<ReconcileResult> {
    requireInput(input);
    const plan = await this.begin(input);
    const evidence = await this.adapter.lookup(plan.lookup);
    if (evidence.kind !== 'observed' || evidence.orderId !== plan.lookup.orderId) return { kind: 'retry', reason: 'provider_unavailable' };
    try {
      return await this.record(input, plan.lookupVersion, evidence);
    } catch (error) {
      if (!(error instanceof OrderError) || error.code !== 'ORDER_RESERVATION_EXPIRED') throw error;
      return this.record(input, plan.lookupVersion, evidence, true);
    }
  }

  private begin(input: ReconcileInput) {
    const { companyId, intentId } = input;
    return this.uow.run(companyId, async (client) => {
      await requireCheckoutAdmin(client, input);
      const intent = await new PaymentCheckoutIntentRepositoryPg(client).get(companyId, intentId);
      if (!intent) throw new PaymentCheckoutIntentError(404, 'CHECKOUT_INTENT_NOT_FOUND', 'Intención de cobro no encontrada.');
      const dispatch = await new PaymentCheckoutDispatchRepositoryPg(client).get(companyId, intentId);
      if (!dispatch || dispatch.state === 'not_sent' || dispatch.state === 'rejected') throw unavailableDispatch();
      if (dispatch.providerOrderId && input.providerOrderId && dispatch.providerOrderId !== input.providerOrderId) {
        throw new PaymentCheckoutIntentError(409, 'CHECKOUT_PROVIDER_ORDER_CONFLICT', 'La orden del proveedor difiere de la registrada.');
      }
      const orderId = dispatch.providerOrderId ?? input.providerOrderId;
      if (!orderId) {
        throw new PaymentCheckoutIntentError(409, 'CHECKOUT_PROVIDER_ORDER_REQUIRED', 'Identifica la orden en el proveedor antes de conciliar.');
      }
      if (dispatch.state === 'claimed' && !dispatch.providerOrderId) {
        const { rows: [clock] } = await client.query('SELECT clock_timestamp() >= $1::timestamptz AS elapsed',
          [new Date(dispatch.plannedAt + claimGraceMs)]);
        if (!clock.elapsed) throw unavailableDispatch();
      }
      const lookupVersion = await new PaymentCheckoutReconciliationRepositoryPg(client).begin(companyId, intentId);
      return { lookupVersion, lookup: { companyId, intent, orderId, validUntil: dispatch.validUntil } };
    });
  }

  private record(input: ReconcileInput, lookupVersion: number, evidence: Observed, reservationExpired = false): Promise<ReconcileResult> {
    const { companyId, intentId } = input;
    return this.uow.run(companyId, async (client) => {
      await requireCheckoutAdmin(client, input);
      const locked = await lockCheckoutIntent(client, companyId, intentId);
      const repository = new PaymentCheckoutReconciliationRepositoryPg(client);
      const prior = await repository.lock(companyId, intentId, lookupVersion);
      if (!prior) return { kind: 'retry', reason: 'observation_superseded' };

      const dispatches = new PaymentCheckoutDispatchRepositoryPg(client);
      const dispatch = await dispatches.get(companyId, intentId);
      if (!dispatch || dispatch.state === 'not_sent' || dispatch.state === 'rejected') throw unavailableDispatch();
      if (dispatch.providerOrderId !== evidence.orderId) {
        if (dispatch.providerOrderId ||
            !await dispatches.attachVerifiedOrder(companyId, intentId, dispatch.version, evidence.orderId)) {
          return { kind: 'retry', reason: 'observation_superseded' };
        }
      }
      const storedExpiry = dispatch.providerExpiresAt === null ? null : Date.parse(dispatch.providerExpiresAt);
      const settleBefore = storedExpiry !== null && storedExpiry !== evidence.providerExpiresAt
        ? null : this.settleBefore(locked, dispatch.validUntil, evidence.providerExpiresAt);
      const decision = await this.decide(companyId, locked, prior, evidence, settleBefore, reservationExpired);
      const observation = {
        companyId, intentId, lookupVersion, decision, settleBefore, amountPaid: evidence.amountPaid,
        providerStatus: evidence.status, providerStatusDetail: evidence.statusDetail,
      };
      let reconciliation = await repository.record(observation);
      if (!reconciliation && decision.state === 'settled' && prior.settledAt === null) {
        reconciliation = await repository.record({ ...observation, decision: review('checkout_expired') });
      }
      if (!reconciliation) throw new Error('La observación bloqueada de Mercado Pago dejó de estar disponible.');
      if (reconciliation.state === 'settled' && prior.settledAt === null) {
        await this.confirmOrder(client, locked, input, evidence);
      }
      return { kind: 'observed', reconciliation };
    });
  }

  private settleBefore(locked: LockedCheckout, validUntil: number, providerExpiresAt: number | undefined): number | null {
    const deadline = locked.intent.reservationExpiresAt === null ? validUntil : Date.parse(locked.intent.reservationExpiresAt);
    if (providerExpiresAt === undefined || !Number.isFinite(deadline) || providerExpiresAt > Math.min(validUntil, deadline)) return null;
    return providerExpiresAt;
  }

  private async decide(
    companyId: number, locked: LockedCheckout, prior: CheckoutReconciliation, evidence: Observed,
    settleBefore: number | null, reservationExpired: boolean,
  ): Promise<ObservationDecision> {
    if (prior.reviewCode) return review(prior.reviewCode);
    if (prior.settledAt) {
      if (locked.order.status === 'cancelled') return review('order_changed');
      return evidence.providerPayment === 'paid_candidate' && settleBefore !== null
        ? { state: 'settled' } : review('settled_payment_changed');
    }
    if (evidence.providerPayment === 'reconciliation_required') return review('provider_inconsistent');
    if (prior.amountPaid !== null && BigInt(evidence.amountPaid.replace('.', '')) < BigInt(prior.amountPaid.replace('.', ''))) {
      return review('provider_credit_decreased');
    }
    if (evidence.providerPayment !== 'paid_candidate' && evidence.providerPayment !== 'partial') {
      return { state: evidence.providerPayment };
    }
    if (locked.intent.state !== 'prepared') {
      return review(locked.intent.voidReason === 'voucher_validated' ? 'voucher_validated' : 'intent_changed');
    }
    if (reservationExpired || locked.order.expired || settleBefore === null ||
        !await locked.intents.deadlineIsLive(new Date(settleBefore).toISOString())) return review('checkout_expired');

    try {
      await assertCurrentCheckout(companyId, locked);
    } catch (error) {
      if (!(error instanceof PaymentCheckoutIntentError)) throw error;
      switch (error.code) {
        case 'CHECKOUT_VOUCHER_PENDING': return review('voucher_pending');
        case 'CHECKOUT_PAYMENT_ALREADY_VALIDATED': return review('voucher_validated');
        case 'CHECKOUT_GATEWAY_UNAVAILABLE': return review('gateway_changed');
        case 'CHECKOUT_RESERVATION_EXPIRED': return review('checkout_expired');
        default: return review('order_changed');
      }
    }
    return { state: evidence.providerPayment === 'paid_candidate' ? 'settled' : 'partial' };
  }

  private async confirmOrder(
    client: Parameters<typeof requireCheckoutAdmin>[0], locked: LockedCheckout, input: ReconcileInput, evidence: Observed,
  ) {
    const orderId = Number(locked.intent.orderId);
    const order = await locked.orders.updateStatus(input.companyId, orderId, 'confirmed', input.actorUserId);
    if (!order) throw new Error('El pedido bloqueado dejó de estar disponible.');
    await client.query(`
      INSERT INTO operational_actions (
        company_id, order_id, contact_id, conversation_id, actor_user_id, action_type, status, description, metadata_json
      ) VALUES ($1, $2, $3, $4, $5, 'payment_validated', 'completed', 'Pago Mercado Pago conciliado', $6::jsonb)
    `, [
      input.companyId, orderId, order.contactId, order.conversationId, input.actorUserId,
      JSON.stringify({ source: 'mercadopago_orders', intentId: input.intentId, providerOrderId: evidence.orderId,
        amount: evidence.amountPaid, currency: 'PEN' }),
    ]);
  }
}
