import type { Queryable } from '../../../../shared/UnitOfWorkPort';

type ReviewCode = 'provider_inconsistent' | 'provider_credit_decreased' | 'settled_payment_changed' |
  'intent_changed' | 'order_changed' | 'gateway_changed' | 'voucher_pending' | 'voucher_validated' | 'checkout_expired';
type ObservationState = 'unpaid' | 'pending' | 'failed' | 'partial' | 'settled' | 'review_required';
export type CheckoutReconciliation = {
  state: 'awaiting_observation' | ObservationState;
  amountPaid: string | null;
  providerStatus: string | null;
  providerStatusDetail: string | null;
  observedAt: Date | null;
  settledAt: Date | null;
  reviewCode: ReviewCode | null;
};
export type ObservationDecision = { state: Exclude<ObservationState, 'review_required'> } |
  { state: 'review_required'; reviewCode: ReviewCode };

export type CheckoutReconciliationRow = Pick<CheckoutReconciliation,
  'state' | 'amountPaid' | 'observedAt' | 'settledAt' | 'reviewCode'> & {
  orderId: string;
  providerOrderId: string | null;
  expectedAmount: string;
  currency: 'PEN';
};
export type CheckoutReconciliationFilters = { orderId: string | null; beforeOrderId: string | null; limit: number };

const columns = `
  state, amount_paid::text AS "amountPaid", provider_status AS "providerStatus",
  provider_status_detail AS "providerStatusDetail", observed_at AS "observedAt",
  settled_at AS "settledAt", review_code AS "reviewCode"
`;

export class PaymentCheckoutReconciliationRepositoryPg {
  constructor(private readonly db: Queryable) {}

  async list(companyId: number, filters: CheckoutReconciliationFilters) {
    const { rows } = await this.db.query(`
      SELECT d.order_id::text AS "orderId", d.provider_order_id AS "providerOrderId",
             i.amount::text AS "expectedAmount", i.currency,
             r.state, r.amount_paid::text AS "amountPaid", r.observed_at AS "observedAt",
             r.settled_at AS "settledAt", r.review_code AS "reviewCode"
      FROM payment_checkout_dispatches d
      JOIN payment_checkout_reconciliations r USING (company_id, intent_id)
      JOIN payment_checkout_intents i ON i.company_id = d.company_id AND i.id = d.intent_id
      WHERE d.company_id = $1
        AND ($2::bigint IS NULL OR d.order_id = $2)
        AND ($3::bigint IS NULL OR d.order_id < $3)
      ORDER BY d.order_id DESC
      LIMIT $4
    `, [companyId, filters.orderId, filters.beforeOrderId, filters.limit + 1]);
    const visible = rows.slice(0, filters.limit) as CheckoutReconciliationRow[];
    return { rows: visible, nextBeforeOrderId: rows.length > filters.limit ? visible[visible.length - 1].orderId : null };
  }

  async begin(companyId: number, intentId: string): Promise<number> {
    const { rows: [row] } = await this.db.query(`
      INSERT INTO payment_checkout_reconciliations AS reconciliation (company_id, intent_id)
      VALUES ($1, $2)
      ON CONFLICT (intent_id) DO UPDATE SET lookup_version = reconciliation.lookup_version + 1
      WHERE reconciliation.company_id = EXCLUDED.company_id
      RETURNING lookup_version
    `, [companyId, intentId]);
    if (!row) throw new Error('No se pudo registrar la consulta de conciliación.');
    return row.lookup_version;
  }

  async lock(companyId: number, intentId: string, lookupVersion: number): Promise<CheckoutReconciliation | null> {
    const { rows: [row] } = await this.db.query(`
      SELECT ${columns} FROM payment_checkout_reconciliations
      WHERE company_id = $1 AND intent_id = $2 AND lookup_version = $3 FOR UPDATE
    `, [companyId, intentId, lookupVersion]);
    return row ? row as CheckoutReconciliation : null;
  }

  async record(input: {
    companyId: number; intentId: string; lookupVersion: number; decision: ObservationDecision;
    amountPaid: string; providerStatus: string; providerStatusDetail: string; settleBefore: number | null;
  }): Promise<CheckoutReconciliation | null> {
    const { decision } = input;
    const { rows: [row] } = await this.db.query(`
      WITH observation AS (SELECT clock_timestamp() AS at)
      UPDATE payment_checkout_reconciliations
      SET state = $4, review_code = $5, amount_paid = $6, provider_status = $7, provider_status_detail = $8,
          observed_at = observation.at,
          settled_at = CASE WHEN $4 = 'settled' THEN COALESCE(settled_at, observation.at) ELSE settled_at END
      FROM observation
      WHERE company_id = $1 AND intent_id = $2 AND lookup_version = $3
        AND ($4 <> 'settled' OR settled_at IS NOT NULL OR observation.at < $9::timestamptz)
      RETURNING ${columns}
    `, [
      input.companyId, input.intentId, input.lookupVersion, decision.state,
      decision.state === 'review_required' ? decision.reviewCode : null,
      input.amountPaid, input.providerStatus, input.providerStatusDetail,
      input.settleBefore === null ? null : new Date(input.settleBefore),
    ]);
    return row ? row as CheckoutReconciliation : null;
  }
}
