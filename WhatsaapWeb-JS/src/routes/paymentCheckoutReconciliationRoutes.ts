import { Router, type Response } from 'express';
import { requireJwt } from '../middleware/jwtAuth';
import { resolveTenantContext, tenantContext } from '../middleware/tenantContext';
import { PaymentCheckoutIntentError } from '../modules/payments/application/PaymentCheckoutIntentService';
import type { PaymentCheckoutReconciliationService } from '../modules/payments/application/PaymentCheckoutReconciliationService';
import { isMercadoPagoOrderId } from '../modules/payments/infra/mercadopago/MercadoPagoOrdersAdapter';

const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;

type Reconciler = Pick<PaymentCheckoutReconciliationService, 'reconcile'>;

const retryResponses = {
  observation_superseded: [409, 'CHECKOUT_OBSERVATION_SUPERSEDED', 'Otra consulta actualizó la conciliación. Vuelve a consultar.'],
  provider_order_unresolved: [409, 'CHECKOUT_PROVIDER_ORDER_UNRESOLVED', 'Identifica la orden en el panel de Mercado Pago antes de volver a conciliar.'],
  provider_unavailable: [503, 'CHECKOUT_PROVIDER_UNAVAILABLE', 'No se pudo comprobar el estado de la orden.'],
} as const;

function errorResponse(res: Response, status: number, code: string, message: string) {
  return res.status(status).json({ success: false, error: code, message });
}

export default function createPaymentCheckoutReconciliationRoutes(service?: Reconciler): Router {
  const router = Router();
  router.post('/:intentId/reconcile', requireJwt, tenantContext({ allowSandbox: false }), async (req, res) => {
    res.setHeader('Cache-Control', 'private, no-store');
    const actor = resolveTenantContext(req);
    if (!actor.userId || actor.role !== 'ADMIN') {
      return errorResponse(res, 403, 'CHECKOUT_ADMIN_REQUIRED', 'La conciliación requiere un administrador activo.');
    }
    if (!service) {
      return errorResponse(res, 501, 'PAYMENT_RECONCILIATION_UNAVAILABLE', 'La conciliación operativa está deshabilitada.');
    }
    const { intentId } = req.params;
    const body = req.body ?? {};
    const providerOrderId: unknown = body.providerOrderId;
    if (typeof intentId !== 'string' || !uuid.test(intentId) || typeof body !== 'object' || Array.isArray(body) ||
        Object.keys(body).some((key) => key !== 'providerOrderId') ||
        (providerOrderId !== undefined && !isMercadoPagoOrderId(providerOrderId))) {
      return errorResponse(res, 422, 'CHECKOUT_INPUT_INVALID', 'La intención o la orden de Mercado Pago es inválida.');
    }

    try {
      const result = await service.reconcile({
        companyId: actor.tenantId, actorUserId: actor.userId, sessionRole: actor.role, intentId, providerOrderId,
      });
      if (result.kind === 'retry') {
        const [status, code, message] = retryResponses[result.reason];
        return errorResponse(res, status, code, message);
      }
      const { state, amountPaid, providerStatus, providerStatusDetail, observedAt, settledAt, reviewCode } = result.reconciliation;
      return res.json({
        success: true,
        data: { state, amountPaid, providerStatus, providerStatusDetail, observedAt, settledAt, reviewCode },
      });
    } catch (error) {
      if (error instanceof PaymentCheckoutIntentError) {
        return errorResponse(res, error.statusCode, error.code, error.message);
      }
      console.error('PAYMENT_CHECKOUT_RECONCILIATION_FAILED');
      return errorResponse(res, 503, 'CHECKOUT_RECONCILIATION_FAILED', 'No se pudo guardar la conciliación.');
    }
  });
  return router;
}
