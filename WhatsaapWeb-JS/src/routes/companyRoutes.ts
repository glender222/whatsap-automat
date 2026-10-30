import { NextFunction, Response, Router } from 'express';
import pool from '../config/database';
import config from '../config/index';
import { JwtRequest, resolveWhatsappCompanyId } from '../middleware/jwtAuth';
import WhatsAppService from '../services/whatsappService';

function normalizeUser(row: any): Record<string, unknown> | null {
  if (!row) return null;
  return {
    id: row.id,
    nombre: row.nombre,
    email: row.email,
    rol: row.rol,
    idPadre: row.id_padre,
    companyId: row.company_id || config.defaultCompanyId || 1,
    activo: row.activo,
    fechaCreacion: row.fecha_creacion,
  };
}

async function buildWhatsappOverview(whatsappService: WhatsAppService, companyId: number, account: any): Promise<Record<string, unknown>> {
  const status = await whatsappService.getCompanyStatus(companyId);
  const configured = Boolean(status.configured);

  return {
    provider: status.provider || config.whatsapp.provider,
    configured,
    connected: Boolean(status.connected ?? configured),
    requiresQr: Boolean(status.hasQR),
    hasQr: Boolean(status.hasQR),
    phoneNumberId: status.phoneNumberId || account?.phone_number_id || null,
    wabaId: status.wabaId || account?.waba_id || null,
    displayPhoneNumber: status.phoneNumber || account?.display_phone_number || null,
    graphVersion: status.graphVersion || config.meta.graphVersion,
    accountStatus: status.accountStatus || account?.status || (configured ? 'connected' : 'missing_config'),
    webhookPath: '/api/webhooks/meta/whatsapp',
    tokenConfigured: Boolean(status.tokenConfigured),
    tokenLastFour: account?.token_last_four || null,
    tokenConfiguredAt: account?.token_configured_at || null,
    lastErrorMessage: account?.last_error_message || null,
    webhookVerifyTokenConfigured: Boolean(account?.webhook_verify_token || config.meta.webhookVerifyToken),
    message: status.message || null,
  };
}

function isAdmin(req: JwtRequest): boolean {
  return req.user?.rol === 'ADMIN';
}

export default function createCompanyRoutes(whatsappService: WhatsAppService): Router {
  const router = Router();

  router.get('/me', async (req: JwtRequest, res: Response, next: NextFunction) => {
    try {
      const companyId = resolveWhatsappCompanyId(req);
      const userId = req.user?.userId;

      const [companyResult, userResult, accountResult] = await Promise.all([
        pool.query(
          'SELECT id, name, created_at FROM companies WHERE id = $1',
          [companyId]
        ),
        userId
          ? pool.query(
              `SELECT id, nombre, email, rol, id_padre, company_id, activo, fecha_creacion
               FROM usuarios
               WHERE id = $1 AND activo = true`,
              [userId]
            )
          : Promise.resolve({ rows: [] }),
        pool.query(
          `SELECT id, provider, waba_id, phone_number_id, display_phone_number, status,
                  token_last_four, token_configured_at, webhook_verify_token,
                  last_error_message, updated_at
           FROM whatsapp_business_accounts
           WHERE company_id = $1 AND provider = $2
           ORDER BY updated_at DESC
           LIMIT 1`,
          [companyId, 'meta-cloud']
        ),
      ]);

      const company = companyResult.rows[0] || {
        id: companyId,
        name: `Empresa ${companyId}`,
        created_at: null,
      };

      res.json({
        success: true,
        data: {
          company: {
            id: company.id,
            name: company.name,
            createdAt: company.created_at,
          },
          user: normalizeUser(userResult.rows[0]),
          whatsapp: await buildWhatsappOverview(whatsappService, companyId, accountResult.rows[0]),
        },
      });
    } catch (error) {
      next(error);
    }
  });

  router.get('/whatsapp/connection', async (req: JwtRequest, res: Response, next: NextFunction) => {
    try {
      const companyId = resolveWhatsappCompanyId(req);
      const [connection, status] = await Promise.all([
        whatsappService.getCompanyConnection(companyId),
        whatsappService.getCompanyStatus(companyId),
      ]);

      res.json({
        success: true,
        data: {
          connection,
          status,
          webhook: {
            callbackPath: '/api/webhooks/meta/whatsapp',
            verifyTokenConfigured: Boolean(config.meta.webhookVerifyToken),
          },
        },
      });
    } catch (error) {
      next(error);
    }
  });

  router.post('/whatsapp/connection', async (req: JwtRequest, res: Response, next: NextFunction) => {
    try {
      if (!isAdmin(req)) {
        return res.status(403).json({
          success: false,
          error: 'Solo administradores pueden conectar WhatsApp Business',
        });
      }

      const companyId = resolveWhatsappCompanyId(req);
      const connection = await whatsappService.saveCompanyConnection(companyId, req.body || {});

      res.json({
        success: true,
        data: connection,
      });
    } catch (error) {
      next(error);
    }
  });

  router.delete('/whatsapp/connection', async (req: JwtRequest, res: Response, next: NextFunction) => {
    try {
      if (!isAdmin(req)) {
        return res.status(403).json({
          success: false,
          error: 'Solo administradores pueden desconectar WhatsApp Business',
        });
      }

      const companyId = resolveWhatsappCompanyId(req);
      await whatsappService.disconnectCompanyConnection(companyId);

      res.json({
        success: true,
        message: 'WhatsApp Business desconectado para esta empresa',
      });
    } catch (error) {
      next(error);
    }
  });

  return router;
}
