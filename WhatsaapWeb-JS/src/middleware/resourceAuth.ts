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

import path from 'path';

const CHAT_ID_REGEX = /^[a-zA-Z0-9_\-+.:@]+$/;
const MESSAGE_ID_REGEX = /^[a-zA-Z0-9_\-+.:@=]+$/;
const VOUCHER_ID_REGEX = /^[a-zA-Z0-9_\-.]+$/;

export function createResourceAuth(db: DbQueryable = pool) {
  return {
    requireChatTenantAccess: async (req: JwtRequest, res: Response, next: NextFunction): Promise<void | Response> => {
      try {
        const companyId = resolveWhatsappCompanyId(req);
        const rawChatId = req.params?.chatId || req.params?.id || req.body?.chatId || req.body?.to;
        if (!rawChatId || (typeof rawChatId !== 'string' && typeof rawChatId !== 'number')) {
          return res.status(400).json({
            success: false,
            error: 'BAD_REQUEST',
            message: 'Identificador de chat requerido',
          });
        }

        const chatIdStr = String(rawChatId).trim();
        if (!chatIdStr) {
          return res.status(400).json({
            success: false,
            error: 'BAD_REQUEST',
            message: 'Identificador de chat no puede estar vacio',
          });
        }

        if (!CHAT_ID_REGEX.test(chatIdStr) || chatIdStr.length > 128) {
          return res.status(400).json({
            success: false,
            error: 'INVALID_CHAT_ID',
            message: 'Formato de identificador de chat invalido',
          });
        }

        const numericId = Number(chatIdStr);
        const isNumericId = Number.isInteger(numericId) && numericId > 0 && !chatIdStr.includes('@');

        if (isNumericId) {
          // Direct SQL tenant isolation: filter by company_id in SQL
          const result = await db.query(
            `SELECT id, company_id, external_conversation_id FROM conversations WHERE id = $1 AND company_id = $2 LIMIT 1`,
            [numericId, companyId]
          );

          if (result.rows.length > 0) {
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

          // Not found for this tenant: verify whether it exists for another tenant
          const existence = await db.query(
            `SELECT id, company_id FROM conversations WHERE id = $1 LIMIT 1`,
            [numericId]
          );
          if (existence.rows.length > 0) {
            return res.status(403).json({
              success: false,
              error: 'FORBIDDEN',
              message: 'Acceso denegado a conversacion de otra empresa',
            });
          }

          return res.status(404).json({
            success: false,
            error: 'CHAT_NOT_FOUND',
            message: 'Conversacion no encontrada',
          });
        }

        const candidates = normalizeChatIdCandidates(chatIdStr);
        // Direct SQL tenant isolation: filter by company_id in SQL
        const result = await db.query(
          `SELECT id, company_id, external_conversation_id FROM conversations
           WHERE external_conversation_id = ANY($1::varchar[]) AND company_id = $2
           ORDER BY last_message_at DESC NULLS LAST, id DESC
           LIMIT 1`,
          [candidates, companyId]
        );

        if (result.rows.length > 0) {
          const row = result.rows[0];
          if (Number(row.company_id) !== companyId) {
            return res.status(403).json({
              success: false,
              error: 'FORBIDDEN',
              message: 'Acceso denegado al chat de otra empresa',
            });
          }
          req.conversation = row;
          return next();
        }

        // Outbound creation/messaging via POST allows initiating conversation for this tenant
        // even if another tenant has communicated with the same external contact.
        const isActionOnExisting = Boolean(
          typeof req.path === 'string' &&
          (req.path.endsWith('/read') || req.path.endsWith('/sessions/complete'))
        );

        if (req.method === 'POST' && !isActionOnExisting) {
          return next();
        }

        // Not found for this tenant: check if registered for ANY other tenant
        const existence = await db.query(
          `SELECT id, company_id FROM conversations
           WHERE external_conversation_id = ANY($1::varchar[])
           LIMIT 1`,
          [candidates]
        );

        if (existence.rows.length > 0) {
          return res.status(403).json({
            success: false,
            error: 'FORBIDDEN',
            message: 'Acceso denegado al chat de otra empresa',
          });
        }

        return res.status(404).json({
          success: false,
          error: 'CHAT_NOT_FOUND',
          message: 'Conversacion no encontrada',
        });
      } catch (error) {
        return next(error);
      }
    },

    requireMediaTenantAccess: async (req: JwtRequest, res: Response, next: NextFunction): Promise<void | Response> => {
      try {
        const companyId = resolveWhatsappCompanyId(req);
        const rawMessageId = req.params?.messageId || req.params?.id;
        if (!rawMessageId || (typeof rawMessageId !== 'string' && typeof rawMessageId !== 'number')) {
          return res.status(400).json({
            success: false,
            error: 'BAD_REQUEST',
            message: 'Identificador de archivo multimedia requerido',
          });
        }

        const messageIdStr = String(rawMessageId).trim();
        if (!messageIdStr) {
          return res.status(400).json({
            success: false,
            error: 'BAD_REQUEST',
            message: 'Identificador de archivo multimedia no puede estar vacio',
          });
        }

        if (!MESSAGE_ID_REGEX.test(messageIdStr) || messageIdStr.length > 256) {
          return res.status(400).json({
            success: false,
            error: 'INVALID_MESSAGE_ID',
            message: 'Formato de identificador de mensaje invalido',
          });
        }

        // Direct SQL tenant isolation: filter by m.company_id in SQL
        const result = await db.query(
          `SELECT m.id AS message_id, m.company_id, a.id AS attachment_id, a.internal_path, a.provider_media_id
           FROM messages m
           LEFT JOIN message_attachments a ON a.message_id = m.id
           WHERE (
             m.provider_message_id = $1
             OR m.id::text = $1
             OR a.provider_media_id = $1
           ) AND m.company_id = $2
           ORDER BY a.id DESC NULLS LAST
           LIMIT 1`,
          [messageIdStr, companyId]
        );

        if (result.rows.length > 0) {
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
        }

        // Not found for this tenant: check if exists for ANY other tenant
        const existence = await db.query(
          `SELECT m.id AS message_id, m.company_id
           FROM messages m
           LEFT JOIN message_attachments a ON a.message_id = m.id
           WHERE (
             m.provider_message_id = $1
             OR m.id::text = $1
             OR a.provider_media_id = $1
           )
           LIMIT 1`,
          [messageIdStr]
        );

        if (existence.rows.length > 0) {
          return res.status(403).json({
            success: false,
            error: 'FORBIDDEN',
            message: 'Acceso denegado a archivo multimedia de otra empresa',
          });
        }

        return res.status(404).json({
          success: false,
          error: 'MEDIA_NOT_FOUND',
          message: 'Archivo multimedia no encontrado',
        });
      } catch (error) {
        return next(error);
      }
    },

    requireVoucherTenantAccess: async (req: JwtRequest, res: Response, next: NextFunction): Promise<void | Response> => {
      try {
        const companyId = resolveWhatsappCompanyId(req);
        const rawParam = req.params?.filename || req.params?.id;
        if (!rawParam || (typeof rawParam !== 'string' && typeof rawParam !== 'number')) {
          return res.status(400).json({
            success: false,
            error: 'BAD_REQUEST',
            message: 'Identificador de comprobante requerido',
          });
        }

        const rawParamStr = String(rawParam).trim();
        const paramStr = path.basename(rawParamStr);
        if (!paramStr || paramStr === '.' || paramStr === '..' || paramStr.includes('/') || paramStr.includes('\\')) {
          return res.status(400).json({
            success: false,
            error: 'BAD_REQUEST',
            message: 'Identificador de comprobante invalido',
          });
        }

        if (
          !VOUCHER_ID_REGEX.test(paramStr) ||
          paramStr.includes('%') ||
          paramStr === '_' ||
          /^_+$/.test(paramStr)
        ) {
          return res.status(400).json({
            success: false,
            error: 'BAD_REQUEST',
            message: 'Identificador de comprobante invalido',
          });
        }

        const escapedParam = paramStr.replace(/([%_\\])/g, '\\$1');
        const searchPattern = `%${escapedParam}`;
        // Direct SQL tenant isolation: filter by company_id in SQL
        const result = await db.query(
          `SELECT id, company_id, file_url FROM payment_vouchers
           WHERE (file_url LIKE $1 OR id::text = $2) AND company_id = $3
           LIMIT 1`,
          [searchPattern, paramStr, companyId]
        );

        if (result.rows.length > 0) {
          const row = result.rows[0];
          if (Number(row.company_id) !== companyId) {
            return res.status(403).json({
              success: false,
              error: 'FORBIDDEN',
              message: 'Acceso denegado a comprobante de otra empresa',
            });
          }
          return next();
        }

        // Not found for this tenant: check if exists for ANY other tenant
        const existence = await db.query(
          `SELECT id, company_id FROM payment_vouchers
           WHERE file_url LIKE $1 OR id::text = $2
           LIMIT 1`,
          [searchPattern, paramStr]
        );

        if (existence.rows.length > 0) {
          return res.status(403).json({
            success: false,
            error: 'FORBIDDEN',
            message: 'Acceso denegado a comprobante de otra empresa',
          });
        }

        return res.status(404).json({
          success: false,
          error: 'VOUCHER_NOT_FOUND',
          message: 'Comprobante de pago no encontrado',
        });
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
