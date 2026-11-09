import { Router } from 'express';

export default function createPaymentWebhookRoutes(): Router {
  const router = Router();

  router.post('/mercadopago', (_req, res) => {
    // A signed notification cannot be applied until a server-owned checkout
    // binds the expected payment to its gateway, tenant, order and total.
    res.status(501).json({
      success: false,
      error: 'PAYMENT_RECONCILIATION_UNAVAILABLE',
      message: 'La conciliación automática de Mercado Pago no está habilitada.',
    });
  });

  router.post('/stripe', (_req, res) => {
    res.status(501).json({ success: false, error: 'PROVIDER_NOT_IMPLEMENTED', message: 'Stripe no está habilitado.' });
  });

  router.post('/paypal', (_req, res) => {
    res.status(501).json({ success: false, error: 'PROVIDER_NOT_IMPLEMENTED', message: 'PayPal no está habilitado.' });
  });

  return router;
}
