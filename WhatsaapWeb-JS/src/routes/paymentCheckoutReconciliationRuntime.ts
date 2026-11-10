import type { Pool } from 'pg';
import pool from '../config/database';
import { TenantScopedUoW } from '../db/TenantScopedUoW';
import { PaymentGatewayRepositoryPg } from '../modules/ai/infra/db/PaymentGatewayRepositoryPg';
import { PaymentCheckoutReconciliationService } from '../modules/payments/application/PaymentCheckoutReconciliationService';
import { isMercadoPagoOrderId, MercadoPagoOrdersAdapter } from '../modules/payments/infra/mercadopago/MercadoPagoOrdersAdapter';
import createPaymentCheckoutReconciliationRoutes from './paymentCheckoutReconciliationRoutes';

const ordersPath = '/v1/orders';
const orderPrefix = ordersPath + '/';

export function isMercadoPagoReconciliationEnabled(): boolean {
  return process.env.MERCADOPAGO_RECONCILIATION_ENABLED === 'true';
}

export default function createPaymentCheckoutReconciliationRuntime(
  database: Pool = pool,
  request: typeof fetch = fetch,
) {
  if (!isMercadoPagoReconciliationEnabled()) {
    return createPaymentCheckoutReconciliationRoutes();
  }
  const gateways = new PaymentGatewayRepositoryPg(database);
  const provider = new MercadoPagoOrdersAdapter(async (url, init) => {
    const orderResource = url.pathname.startsWith(orderPrefix) && isMercadoPagoOrderId(url.pathname.slice(orderPrefix.length));
    if (url.origin !== 'https://api.mercadopago.com' || url.username || url.password || url.hash ||
        init.method !== 'GET' || (url.pathname !== ordersPath && !orderResource)) {
      throw new Error('Operación del proveedor fuera del alcance de conciliación.');
    }
    return request(url, { ...init, redirect: 'error' });
  }, (scope) => gateways.resolveMercadoPagoOrdersCredential(scope));
  return createPaymentCheckoutReconciliationRoutes(
    new PaymentCheckoutReconciliationService(provider, new TenantScopedUoW(database)),
  );
}
