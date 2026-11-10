import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';

async function main() {
  const backend = new URL(process.env.PRODUCT_SMOKE_URL ?? '');
  const provider = new URL(process.env.PRODUCT_MERCADOPAGO_FIXTURE_URL ?? '');
  for (const endpoint of [backend, provider]) {
    assert.equal(endpoint.protocol, 'http:');
    assert.equal(endpoint.hostname, '127.0.0.1');
  }
  assert.equal(process.env.DB_HOST, '127.0.0.1');
  assert.match(process.env.DB_NAME ?? '', /_smoke$/);
  assert.equal(process.env.META_WA_ACCESS_TOKEN, 'synthetic-local-token');
  const { default: pool } = await import('../../config/database');
  const { tenantScopedUoW: uow } = await import('../../db/TenantScopedUoW');
  try {
    const { rows: [role] } = await pool.query('SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname=current_user');
    assert.deepEqual(role, { rolsuper: false, rolbypassrls: false });
    if (process.argv[2] === '--inspect') {
      const companyId = Number(process.argv[3]);
      const orderId = Number(process.argv[4]);
      assert.ok(Number.isSafeInteger(companyId) && Number.isSafeInteger(orderId));
      const snapshot = await uow.run(companyId, async (db) => {
        const { rows: [order] } = await db.query('SELECT status FROM customer_orders WHERE company_id=$1 AND id=$2', [companyId, orderId]);
        const { rows: [reconciliation] } = await db.query(`
          SELECT r.state, r.amount_paid, r.settled_at, r.review_code FROM payment_checkout_reconciliations r
          JOIN payment_checkout_dispatches d USING (company_id,intent_id) WHERE d.company_id=$1 AND d.order_id=$2
        `, [companyId, orderId]);
        const { rows: [audit] } = await db.query(`
          SELECT count(*)::integer AS count FROM operational_actions WHERE company_id=$1 AND order_id=$2
            AND action_type='payment_validated' AND metadata_json->>'source'='mercadopago_orders'
        `, [companyId, orderId]);
        return { order, reconciliation: reconciliation ?? null, settlements: audit.count };
      });
      process.stdout.write(JSON.stringify(snapshot));
      return;
    }
    assert.equal(process.argv[2], undefined);
    const { OrderRepositoryPg } = await import('../../modules/orders');
    const { PaymentGatewayRepositoryPg } = await import('../../modules/ai/infra/db/PaymentGatewayRepositoryPg');
    const { PaymentCheckoutIntentService, PaymentCheckoutDispatchService } = await import('../../modules/payments');
    const orders = new OrderRepositoryPg(pool);
    const intents = new PaymentCheckoutIntentService(uow);
    const gateways = new PaymentGatewayRepositoryPg(pool);
    async function actor(name: string) {
      const response = await fetch(backend.origin + '/api/auth/register', { method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ nombre: name, email: `mp-browser-${randomUUID()}@example.invalid`, password: randomUUID() }),
      });
      assert.equal(response.status, 200);
      const { data } = await response.json();
      const companyId = Number(data.user.companyId);
      const actorUserId = Number(data.user.id);
      const token = 'fixture-mp-' + randomUUID();
      const sellerId = String(companyId);
      const gateway = await gateways.create(companyId, { provider: 'mercadopago', displayName: 'Mercado Pago QA',
        credentials: { access_token: token, seller_id: sellerId },
      });
      return { companyId, actorUserId, token, sellerId, gatewayId: gateway.id,
        auth: { browserSessionId: randomUUID(), ...data, user: { ...data.user, id: String(data.user.id) } },
      };
    }
    const alpha = await actor('Conciliación Alfa');
    const bravo = await actor('Conciliación Bravo');
    async function checkout(owner: typeof alpha, uncertain = false) {
      const { companyId, actorUserId } = owner;
      const chatId = '1202' + String(Math.floor(Math.random() * 10_000_000)).padStart(7, '0');
      const productId = await uow.run(companyId, async (db) => {
        await db.query("INSERT INTO conversations (company_id,channel,external_conversation_id) VALUES ($1,'whatsapp',$2)", [companyId, chatId]);
        const { rows: [product] } = await db.query(`
          INSERT INTO products (company_id,name,price,currency,item_type,stock_available,availability_type)
          VALUES ($1,'Producto conciliación QA','5.25','PEN','physical_product',40,'stock') RETURNING id
        `, [companyId]);
        return Number(product.id);
      });
      const { order } = await orders.createDetected({ companyId, userId: actorUserId, chatId,
        items: [{ commercialItemId: productId, quantity: 2, productName: 'Producto conciliación QA' }],
      });
      await orders.updateStatus(companyId, order.id, 'reserved', actorUserId, 30);
      const actor = { companyId, actorUserId, sessionRole: 'ADMIN' };
      const intent = await intents.prepare({ ...actor, orderId: order.id, gatewayId: owner.gatewayId, idempotencyKey: randomUUID() });
      const providerOrderId = 'ORDTST' + randomBytes(13).toString('hex').toUpperCase();
      const dispatcher = new PaymentCheckoutDispatchService({ async create({ validUntil }) {
        const created = new Date();
        const seconds = Math.floor((new Date(validUntil).getTime() - created.getTime()) / 1000);
        const body = { id: providerOrderId, external_reference: intent.externalReference,
          total_amount: '10.50', total_paid_amount: '0.00', type: 'online', processing_mode: 'manual',
          country_code: 'PER', currency: 'PEN', user_id: owner.sellerId,
          created_date: created.toISOString(), expiration_time: `PT${seconds}S`, status: 'created', status_detail: 'created',
        };
        const registered = await fetch(provider.origin + '/fixtures/orders/' + providerOrderId, { method: 'POST',
          headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: owner.token, body }),
        });
        assert.equal(registered.status, 200);
        return uncertain ? { kind: 'uncertain', reason: 'transport' } : {
          kind: 'created', orderId: providerOrderId, expiresAt: new Date(created.getTime() + seconds * 1000).toISOString(), checkoutUrl: 'fixture-internal-only',
        };
      } }, uow);
      const dispatch = await dispatcher.dispatch({ ...actor, intentId: intent.id, expectedVersion: intent.version });
      assert.equal(dispatch.state, uncertain ? 'uncertain' : 'created');
      return { orderId: order.id, intentId: intent.id, providerOrderId, companyId, chatId };
    }
    const [order, unresolved, foreign] = await Promise.all([checkout(alpha), checkout(alpha, true), checkout(bravo)]);
    process.stdout.write(JSON.stringify({ alpha: { auth: alpha.auth }, bravo: { auth: bravo.auth }, order, unresolved, foreign }));
  } finally { await pool.end(); }
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : 'Mercado Pago browser fixture failed');
  process.exitCode = 1;
});
