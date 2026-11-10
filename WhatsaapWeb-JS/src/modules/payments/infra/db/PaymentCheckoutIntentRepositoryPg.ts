import type { Queryable } from '../../../../shared/UnitOfWorkPort';
import type { CheckoutIntentSnapshot, PaymentCheckoutIntent } from '../../domain/paymentCheckoutIntent.types';

const columns = `
  id, external_reference AS "externalReference", order_id::text AS "orderId", gateway_id::text AS "gatewayId",
  amount::text, currency, items, order_status AS "orderStatus",
  to_char(order_updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "orderRevision",
  to_char(reservation_expires_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "reservationExpiresAt",
  to_char(gateway_updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "gatewayRevision",
  state, version, void_reason AS "voidReason"`;

export class PaymentCheckoutIntentRepositoryPg {
  constructor(private readonly db: Queryable) {}

  get(companyId: number, intentId: string) {
    return this.oneIntent(`
      SELECT ${columns} FROM payment_checkout_intents WHERE company_id = $1 AND id = $2
    `, [companyId, intentId]);
  }

  byKey(companyId: number, actorId: number, key: string) {
    return this.oneIntent(`
      SELECT ${columns} FROM payment_checkout_intents
      WHERE company_id = $1 AND actor_user_id = $2 AND idempotency_key = $3
    `, [companyId, actorId, key]);
  }

  async hasPrepared(companyId: number, orderId: number): Promise<boolean> {
    const { rowCount } = await this.db.query(`
      SELECT 1 FROM payment_checkout_intents WHERE company_id = $1 AND order_id = $2 AND state = 'prepared'
    `, [companyId, orderId]);
    return Boolean(rowCount);
  }

  async lockGateway(companyId: number, gatewayId: number): Promise<string | null> {
    const { rows: [gateway] } = await this.db.query(`
      SELECT to_char(updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS revision FROM payment_gateways
      WHERE company_id = $1 AND id = $2 AND provider = 'mercadopago' AND status = 'active' FOR SHARE
    `, [companyId, gatewayId]);
    return typeof gateway?.revision === 'string' ? gateway.revision : null;
  }

  async voucherStatus(companyId: number, orderId: number) {
    // A reviewer locks the voucher before the order. Read its committed state without taking a voucher lock.
    const { rows: [voucher] } = await this.db.query(`
      SELECT status FROM payment_vouchers WHERE company_id = $1 AND order_id = $2 AND status IN ('pending','validated')
      ORDER BY (status = 'validated') DESC LIMIT 1
    `, [companyId, orderId]);
    return voucher?.status as 'pending' | 'validated' | undefined;
  }

  async deadlineIsLive(deadline: string | null): Promise<boolean> {
    if (deadline === null) return true;
    const { rows: [result] } = await this.db.query(
      'SELECT $1::timestamptz > clock_timestamp() AS live', [deadline],
    );
    return result.live === true;
  }

  insert(input: {
    id: string; externalReference: string; companyId: number; orderId: number; gatewayId: number;
    actorUserId: number; idempotencyKey: string; snapshot: CheckoutIntentSnapshot;
  }) {
    const { snapshot } = input;
    return this.oneIntent(`
      INSERT INTO payment_checkout_intents (
        id, external_reference, company_id, order_id, gateway_id, actor_user_id, idempotency_key,
        provider, amount, currency, items, order_status, order_updated_at, reservation_expires_at, gateway_updated_at
      )
      SELECT $1, $2, $3, $4, $5, $6, $7, 'mercadopago', $8, $9, $10::jsonb, $11, $12, $13, $14
      WHERE $13::timestamptz IS NULL OR $13::timestamptz > clock_timestamp()
      ON CONFLICT DO NOTHING RETURNING ${columns}
    `, [
      input.id, input.externalReference, input.companyId, input.orderId, input.gatewayId, input.actorUserId,
      input.idempotencyKey, snapshot.amount, snapshot.currency, JSON.stringify(snapshot.items), snapshot.orderStatus,
      snapshot.orderRevision, snapshot.reservationExpiresAt, snapshot.gatewayRevision,
    ]);
  }

  void(companyId: number, intentId: string, expectedVersion: number) {
    return this.oneIntent(`
      UPDATE payment_checkout_intents
      SET state = 'voided', version = version + 1, voided_at = clock_timestamp(), void_reason = 'operator_cancelled'
      WHERE company_id = $1 AND id = $2 AND state = 'prepared' AND version = $3 RETURNING ${columns}
    `, [companyId, intentId, expectedVersion]);
  }

  async voidForValidatedVoucher(companyId: number, orderId: number) {
    await this.db.query(`
      UPDATE payment_checkout_intents
      SET state = 'voided', version = version + 1, voided_at = clock_timestamp(), void_reason = 'voucher_validated'
      WHERE company_id = $1 AND order_id = $2 AND state = 'prepared'
    `, [companyId, orderId]);
  }

  private async oneIntent(statement: string, values: Array<string | number | null>): Promise<PaymentCheckoutIntent | null> {
    const { rows: [intent] } = await this.db.query(statement, values);
    return intent ? intent as PaymentCheckoutIntent : null;
  }
}
