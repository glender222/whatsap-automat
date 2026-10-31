const jwt = require('jsonwebtoken') as any;

export const TEST_JWT_SECRET = 'test-only-jwt-secret-with-at-least-32-characters-for-testing';

export function createTestJwt(
  payload: Record<string, unknown>,
  secret: string = TEST_JWT_SECRET,
  options: Record<string, unknown> = {}
): string {
  return jwt.sign(payload, secret, {
    expiresIn: '1h',
    algorithm: 'HS256',
    ...options,
  });
}

/**
 * Token válido para Tenant A (companyId: 1 por defecto)
 */
export function createTenantAToken(
  companyId: number = 1,
  role: string = 'ADMIN',
  extra: Record<string, unknown> = {}
): string {
  return createTestJwt({
    userId: 101,
    email: 'admin-tenant-a@example.com',
    nombre: 'Admin Tenant A',
    rol: role,
    companyId,
    ...extra,
  });
}

/**
 * Token válido para Tenant B (companyId: 2 por defecto)
 */
export function createTenantBToken(
  companyId: number = 2,
  role: string = 'ADMIN',
  extra: Record<string, unknown> = {}
): string {
  return createTestJwt({
    userId: 202,
    email: 'admin-tenant-b@example.com',
    nombre: 'Admin Tenant B',
    rol: role,
    companyId,
    ...extra,
  });
}

/**
 * Token con claim alternativo company_id (snake_case)
 */
export function createSnakeCaseCompanyClaimToken(companyId: number = 3): string {
  return createTestJwt({
    userId: 303,
    email: 'user-snake@example.com',
    nombre: 'User Snake',
    rol: 'ADMIN',
    company_id: companyId,
  });
}

/**
 * Token con claim alternativo tenantId (convención de contratos v0.4)
 */
export function createTenantIdClaimToken(tenantId: number = 4): string {
  return createTestJwt({
    userId: 404,
    email: 'user-tenantid@example.com',
    nombre: 'User TenantId',
    rol: 'ADMIN',
    tenantId,
  });
}

/**
 * Token válido pero SIN ningún claim de empresa (para probar SEC-03)
 */
export function createNoCompanyClaimToken(extra: Record<string, unknown> = {}): string {
  return createTestJwt({
    userId: 505,
    email: 'attacker-no-tenant@example.com',
    nombre: 'No Tenant User',
    rol: 'ADMIN',
    ...extra,
  });
}

/**
 * Token con claim companyId nulo o inválido
 */
export function createInvalidCompanyClaimToken(value: unknown = null): string {
  return createTestJwt({
    userId: 606,
    email: 'user-invalid-claim@example.com',
    nombre: 'Invalid Claim User',
    rol: 'ADMIN',
    companyId: value,
  });
}

/**
 * Token expirado
 */
export function createExpiredToken(companyId: number = 1): string {
  return jwt.sign(
    {
      userId: 707,
      email: 'expired@example.com',
      companyId,
    },
    TEST_JWT_SECRET,
    {
      expiresIn: '-10s',
      algorithm: 'HS256',
    }
  );
}

/**
 * Token firmado con secreto incorrecto
 */
export function createInvalidSignatureToken(companyId: number = 1): string {
  return createTestJwt(
    {
      userId: 808,
      email: 'imposter@example.com',
      companyId,
    },
    'wrong-secret-that-does-not-match-configuration-32chars'
  );
}

/**
 * Token con formato inválido
 */
export const MALFORMED_TOKEN = 'not.a.valid.jwt.token';
