import { NextFunction, Response } from 'express';
import pool from '../config/database';
import { JwtRequest, resolveWhatsappCompanyId } from './jwtAuth';

export interface DbQueryable {
  query(sql: string, params?: unknown[]): Promise<{ rows: any[] }>;
}

export function normalizeChatIdCandidates(raw: string): string[] {
  const trimmed = String(raw || '').trim();
  if (!trimmed) return [];
  const digits = trimmed.replace(/[^\d]/g, '');
  const set = new Set<string>();
  set.add(trimmed);
  if (digits) {
    set.add(digits);
    set.add(`${digits}@c.us`);
    set.add(`${digits}@s.whatsapp.net`);
  }
  return Array.from(set);
}

export function createResourceAuth(db: DbQueryable = pool) {
  return {
    requireChatTenantAccess: async (req: JwtRequest, res: Response, next: NextFunction): Promise<void | Response> => {
      try {
        const companyId = resolveWhatsappCompanyId(req);
        const rawChatId = req.params.chatId || req.params.id || req.body?.chatId || req.body?.to;
        if (!rawChatId) {
          return next();
        }

        const chatIdStr = String(rawChatId).trim();
        const numericId = Number(chatIdStr);
        const isNumericId = Number.isInteger(numericId) && numericId > 0 && !chatIdStr.includes('@');

        if (isNumericId) {
          const result = await db.query(
            `SELECT id, company_id, external_conversation_id FROM conversations WHERE id = $1 LIMIT 1`,
            [numericId]
          );
          if (result.rows.length === 0) {
            return res.status(404).json({
              success: false,
              error: 'CHAT_NOT_FOUND',
              message: 'Conversacion no encontrada',
            });
          }
          const row = result.rows[0];
          if (Number(row.company_id) !== companyId) {
            return res.status(403).json({
              success: false,
              error: 'FORBIDDEN',
              message: 'Acceso denegado a conversacion de otra empresa',
            });
          }
          req.conversation = row;
          return next();
        }

        const candidates = normalizeChatIdCandidates(chatIdStr);
        const result = await db.query(
          `SELECT id, company_id, external_conversation_id FROM conversations
           WHERE external_conversation_id = ANY($1::varchar[])
           ORDER BY last_message_at DESC NULLS LAST, id DESC`,
          [candidates]
        );

        if (result.rows.length === 0) {
          // Chat no registrado en BD para ningún tenant
          if (
            req.method === 'GET' ||
            req.method === 'PUT' ||
            req.path.endsWith('/read') ||
            req.path.endsWith('/sessions/complete')
          ) {
            return res.status(404).json({
              success: false,
              error: 'CHAT_NOT_FOUND',
              message: 'Conversacion no encontrada',
            });
          }
          // Si es POST para nuevo mensaje outbound, permitir creación para su propio tenant
          return next();
        }

        const matchingTenant = result.rows.find((r) => Number(r.company_id) === companyId);
        if (matchingTenant) {
          req.conversation = matchingTenant;
          return next();
        }

        // Existe en el sistema pero pertenece a OTRA empresa (SEC-01)
        return res.status(403).json({
          success: false,
          error: 'FORBIDDEN',
          message: 'Acceso denegado al chat de otra empresa',
        });
      } catch (error) {
        return next(error);
      }
    },

    requireMediaTenantAccess: async (req: JwtRequest, res: Response, next: NextFunction): Promise<void | Response> => {
      try {
        const companyId = resolveWhatsappCompanyId(req);
        const rawMessageId = req.params.messageId || req.params.id;
        if (!rawMessageId) {
          return next();
        }

        const messageIdStr = String(rawMessageId).trim();
        const result = await db.query(
          `SELECT m.id AS message_id, m.company_id, a.id AS attachment_id, a.internal_path, a.provider_media_id
           FROM messages m
           LEFT JOIN message_attachments a ON a.message_id = m.id
           WHERE (
             m.provider_message_id = $1
             OR m.id::text = $1
             OR a.provider_media_id = $1
           )
           ORDER BY a.id DESC NULLS LAST
           LIMIT 1`,
          [messageIdStr]
        );

        if (result.rows.length === 0) {
          return res.status(404).json({
            success: false,
            error: 'MEDIA_NOT_FOUND',
            message: 'Archivo multimedia no encontrado',
          });
        }

        const row = result.rows[0];
        if (Number(row.company_id) !== companyId) {
          return res.status(403).json({
            success: false,
            error: 'FORBIDDEN',
            message: 'Acceso denegado a archivo multimedia de otra empresa',
          });
        }

        req.mediaAttachment = row;
        return next();
      } catch (error) {
        return next(error);
      }
    },

    requireVoucherTenantAccess: async (req: JwtRequest, res: Response, next: NextFunction): Promise<void | Response> => {
      try {
        const companyId = resolveWhatsappCompanyId(req);
        const rawParam = req.params.filename || req.params.id;
        if (!rawParam) {
          return next();
        }

        const paramStr = String(rawParam).trim();
        const searchPattern = `%${paramStr}`;
        const result = await db.query(
          `SELECT id, company_id, file_url FROM payment_vouchers
           WHERE file_url LIKE $1 OR id::text = $2
           LIMIT 1`,
          [searchPattern, paramStr]
        );

        if (result.rows.length === 0) {
          return res.status(404).json({
            success: false,
            error: 'VOUCHER_NOT_FOUND',
            message: 'Comprobante de pago no encontrado',
          });
        }

        const row = result.rows[0];
        if (Number(row.company_id) !== companyId) {
          return res.status(403).json({
            success: false,
            error: 'FORBIDDEN',
            message: 'Acceso denegado a comprobante de otra empresa',
          });
        }

        return next();
      } catch (error) {
        return next(error);
      }
    },
  };
}

const defaultResourceAuth = createResourceAuth(pool);
export const requireChatTenantAccess = defaultResourceAuth.requireChatTenantAccess;
export const requireMediaTenantAccess = defaultResourceAuth.requireMediaTenantAccess;
export const requireVoucherTenantAccess = defaultResourceAuth.requireVoucherTenantAccess;

module.exports = {
  createResourceAuth,
  normalizeChatIdCandidates,
  requireChatTenantAccess,
  requireMediaTenantAccess,
  requireVoucherTenantAccess,
};
