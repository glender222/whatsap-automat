import { NextFunction, Request, Response, Router } from 'express';

export default function createPaymentWebhookRoutes(): Router {
  const router = Router();

  router.post('/mercadopago', async (req: Request, res: Response, next: NextFunction) => {
    try {
      return res.status(501).json({
        success: false,
        error: 'PROVIDER_NOT_IMPLEMENTED',
        message: 'Mercado Pago no implementado aun. Use el spec F5 para implementarlo.',
      });
    } catch (error) { return next(error); }
  });

  router.post('/stripe', async (_req: Request, res: Response) => {
    return res.status(501).json({ success: false, error: 'PROVIDER_NOT_IMPLEMENTED', message: 'Stripe no implementado aun.' });
  });

  router.post('/paypal', async (_req: Request, res: Response) => {
    return res.status(501).json({ success: false, error: 'PROVIDER_NOT_IMPLEMENTED', message: 'PayPal no implementado aun.' });
  });

  return router;
}
