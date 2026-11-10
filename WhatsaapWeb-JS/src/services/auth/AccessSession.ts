import { withTenantTransaction } from '../../db/TenantScopedUoW';

export type AccessSession = {
  companyId: number;
  sessionId: string;
  userId: string;
  role: string;
  expiresAt: number;
};

const bigintId = /^[1-9]\d{0,18}$/;

function databaseId(value: unknown): string | null {
  const id = typeof value === 'number' && Number.isSafeInteger(value) ? String(value) : value;
  return typeof id === 'string' && bigintId.test(id) && BigInt(id) <= 9223372036854775807n ? id : null;
}

export function readAccessSession(claims: Record<string, unknown>, companyId: number | null): AccessSession | null | undefined {
  if (!Object.prototype.hasOwnProperty.call(claims, 'sessionId')) return undefined;
  const sessionId = databaseId(claims.sessionId);
  const userId = databaseId(claims.userId);
  const expiry = typeof claims.exp === 'number' ? claims.exp * 1000 : NaN;
  if (!sessionId || !userId || !companyId || !Number.isSafeInteger(companyId) || companyId > 2147483647 ||
      typeof claims.rol !== 'string' || !Number.isSafeInteger(expiry)) return null;
  return { companyId, sessionId, userId, role: claims.rol, expiresAt: expiry };
}

export function isActiveAccessSession(session: AccessSession): Promise<boolean> {
  return withTenantTransaction(session.companyId, async (client) => {
    const { rowCount } = await client.query(`
      SELECT 1 FROM refresh_tokens rt
      JOIN usuarios u ON u.id = rt.usuario_id AND u.company_id = $1
      WHERE rt.id = $2 AND u.id = $3 AND u.activo = true AND u.rol::text = $4
        AND rt.revocado = false AND rt.expira_en > clock_timestamp()
    `, [session.companyId, session.sessionId, session.userId, session.role]);
    return rowCount === 1;
  });
}
