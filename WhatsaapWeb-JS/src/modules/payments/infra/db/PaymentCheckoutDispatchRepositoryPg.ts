import type { Queryable } from '../../../../shared/UnitOfWorkPort';
import type { PaymentCheckoutDispatch, PaymentCheckoutDispatchOutcome } from '../../domain/paymentCheckoutDispatch.types';
import type { PaymentCheckoutIntent } from '../../domain/paymentCheckoutIntent.types';

type DispatchRow = Omit<PaymentCheckoutDispatch, 'plannedAt' | 'validUntil' | 'providerExpiresAt'> & {
  plannedAt: Date;
  validUntil: Date;
  providerExpiresAt: Date | null;
};

const columns = `
  intent_id AS "intentId", order_id::text AS "orderId", intent_version AS "intentVersion",
  planned_at AS "plannedAt", valid_until AS "validUntil", state, provider_order_id AS "providerOrderId",
  provider_expires_at AS "providerExpiresAt", outcome_code AS "outcomeCode", version`;

export class PaymentCheckoutDispatchRepositoryPg {
  constructor(private readonly db: Queryable) {}

  get(companyId: number, intentId: string) {
    return this.one(`SELECT ${columns} FROM payment_checkout_dispatches WHERE company_id = $1 AND intent_id = $2`,
      [companyId, intentId]);
  }

  byOrder(companyId: number, orderId: string) {
    return this.one(`SELECT ${columns} FROM payment_checkout_dispatches WHERE company_id = $1 AND order_id = $2`,
      [companyId, orderId]);
  }

  claim(companyId: number, actorUserId: number, intent: PaymentCheckoutIntent) {
    return this.one(`
      WITH planned AS (
        SELECT date_trunc('milliseconds', clock_timestamp()) AS at
      ), checkout_window AS (
        SELECT at, LEAST(at + INTERVAL '15 minutes', $6::timestamptz) AS deadline FROM planned
      )
      INSERT INTO payment_checkout_dispatches (
        company_id, intent_id, order_id, intent_version, claimed_by_user_id, planned_at, valid_until
      )
      SELECT $1, $2, $3, $4, $5, at, deadline FROM checkout_window
      WHERE deadline > at + INTERVAL '20 seconds'
      RETURNING ${columns}
    `, [companyId, intent.id, intent.orderId, intent.version, actorUserId, intent.reservationExpiresAt]);
  }

  finish(companyId: number, intentId: string, expectedVersion: number, outcome: PaymentCheckoutDispatchOutcome) {
    return this.one(`
      UPDATE payment_checkout_dispatches
      SET state = $4, provider_order_id = $5, provider_expires_at = $6, outcome_code = $7,
          version = version + 1, updated_at = clock_timestamp()
      WHERE company_id = $1 AND intent_id = $2 AND version = $3 AND state = 'claimed'
      RETURNING ${columns}
    `, [companyId, intentId, expectedVersion, outcome.state, outcome.providerOrderId ?? null,
      outcome.providerExpiresAt ?? null, outcome.outcomeCode ?? null]);
  }

  attachVerifiedOrder(companyId: number, intentId: string, expectedVersion: number, providerOrderId: string) {
    return this.one(`
      UPDATE payment_checkout_dispatches
      SET state = 'uncertain', provider_order_id = $4, outcome_code = COALESCE(outcome_code, 'acknowledgement_lost'),
          version = version + 1, updated_at = clock_timestamp()
      WHERE company_id = $1 AND intent_id = $2 AND version = $3
        AND state IN ('claimed', 'uncertain') AND provider_order_id IS NULL
      RETURNING ${columns}
    `, [companyId, intentId, expectedVersion, providerOrderId]);
  }

  private async one(statement: string, values: Array<string | number | null>): Promise<PaymentCheckoutDispatch | null> {
    const { rows } = await this.db.query(statement, values);
    const row = rows[0] as DispatchRow | undefined;
    return row ? {
      ...row, plannedAt: row.plannedAt.getTime(), validUntil: row.validUntil.getTime(),
      providerExpiresAt: row.providerExpiresAt?.toISOString() ?? null,
    } : null;
  }
}
