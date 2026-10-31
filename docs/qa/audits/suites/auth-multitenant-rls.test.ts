import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

// Variables de entorno de prueba deterministas (sin secretos reales)
process.env.JWT_SECRET ||= 'test-jwt-secret-qa-audit-32-chars-strictly-for-testing';
process.env.DB_PASSWORD ||= 'test-db-password-strictly-mocked';

// Resolución robusta de módulos hacia WhatsaapWeb-JS
const rootDir = path.resolve(__dirname, '../../../../');
const backendDir = path.join(rootDir, 'WhatsaapWeb-JS');
const jwt = require(path.join(backendDir, 'node_modules/jsonwebtoken'));
const config = require(path.join(backendDir, 'src/config/index')).default || require(path.join(backendDir, 'src/config/index'));
const { requireJwt, optionalWhatsappJwt, resolveWhatsappCompanyId } = require(path.join(backendDir, 'src/middleware/jwtAuth'));

describe('QA Security Audit: Autenticación, JWT Fail-Closed y Aislamiento Multiempresa', () => {

  describe('1. Comportamiento de requireJwt (Baseline actual)', () => {
    test('rechaza petición sin header Authorization con 401', () => {
      let statusCalled: number | null = null;
      let jsonPayload: any = null;
      let nextCalled = false;

      const req: any = { headers: {} };
      const res: any = {
        status: (s: number) => {
          statusCalled = s;
          return {
            json: (data: any) => { jsonPayload = data; }
          };
        }
      };
      const next = () => { nextCalled = true; };

      requireJwt(req, res, next);

      assert.equal(statusCalled, 401, 'Debe devolver código 401');
      assert.equal(jsonPayload?.success, false);
      assert.equal(nextCalled, false, 'No debe llamar a next()');
    });

    test('rechaza token manipulado o con firma incorrecta con 401', () => {
      let statusCalled: number | null = null;
      let jsonPayload: any = null;
      let nextCalled = false;

      const fakeToken = jwt.sign({ userId: 10, companyId: 2 }, 'clave_totalmente_distinta_y_falsa');
      const req: any = {
        headers: { authorization: `Bearer ${fakeToken}` }
      };
      const res: any = {
        status: (s: number) => {
          statusCalled = s;
          return {
            json: (data: any) => { jsonPayload = data; }
          };
        }
      };
      const next = () => { nextCalled = true; };

      requireJwt(req, res, next);

      assert.equal(statusCalled, 401);
      assert.equal(jsonPayload?.error, 'Token invalido o expirado');
      assert.equal(nextCalled, false);
    });

    test('acepta token válido con companyId explícito y asocia req.whatsappCompanyId', () => {
      let nextCalled = false;
      const validToken = jwt.sign(
        { userId: 100, companyId: 42, role: 'admin' },
        config.jwt.secret
      );

      const req: any = {
        headers: { authorization: `Bearer ${validToken}` }
      };
      const res: any = {};
      const next = () => { nextCalled = true; };

      requireJwt(req, res, next);

      assert.equal(nextCalled, true, 'Debe llamar a next()');
      assert.equal(req.whatsappCompanyId, 42, 'Debe extraer y asociar companyId=42');
      assert.equal(req.user?.userId, 100);
    });
  });

  describe('2. Auditoría de Brechas P0: Fail-Open vs Fail-Closed (PR-01 Gates SEC-01 & SEC-03)', () => {
    test('HALLAZGO CRÍTICO SEC-03: resolveWhatsappCompanyId recurre a defaultCompanyId=1 si el token carece de companyId', () => {
      const tokenWithoutTenant = jwt.sign(
        { userId: 999, email: 'rogue@tenant-b.com' }, // sin claim companyId ni tenantId
        config.jwt.secret
      );

      const req: any = {
        headers: { authorization: `Bearer ${tokenWithoutTenant}` }
      };

      // Si whatsappApiRequireCompanyClaim está desactivado (default en baseline):
      const previousSetting = config.security.whatsappApiRequireCompanyClaim;
      try {
        config.security.whatsappApiRequireCompanyClaim = false;
        let nextCalled = false;
        const res: any = {
          status: () => ({ json: () => {} })
        };

        requireJwt(req, res, () => { nextCalled = true; });

        assert.equal(nextCalled, true, 'El baseline permite continuar sin companyId');
        assert.equal(req.whatsappCompanyId, 1, 'VULNERABILIDAD: El token sin empresa hereda la empresa 1 por defecto');
      } finally {
        config.security.whatsappApiRequireCompanyClaim = previousSetting;
      }
    });

    test('HALLAZGO CRÍTICO SEC-01: optionalWhatsappJwt permite acceso anónimo sin token cuando WHATSAPP_API_REQUIRE_JWT=false', () => {
      const previousSetting = config.security.whatsappApiRequireJwt;
      try {
        config.security.whatsappApiRequireJwt = false; // Estado por defecto en ausencia de variable explícita
        let nextCalled = false;
        const req: any = { headers: {} };
        const res: any = {};

        optionalWhatsappJwt(req, res, () => { nextCalled = true; });

        assert.equal(nextCalled, true, 'optionalWhatsappJwt permite llamadas anónimas');
        assert.equal(req.whatsappCompanyId, 1, 'Asigna arbitrariamente la empresa 1');
      } finally {
        config.security.whatsappApiRequireJwt = previousSetting;
      }
    });
  });

  describe('3. Auditoría de RLS y Modelo de Datos (PR-03 Gates SEC-04 & SEC-05)', () => {
    test('HALLAZGO CRÍTICO SEC-04: Ninguna migración existente (000 a 021) implementa ROW LEVEL SECURITY', () => {
      const migrationsDir = path.join(backendDir, 'src/db/migrations');
      const files = fs.readdirSync(migrationsDir).filter(f => f.endsWith('.sql'));

      assert.ok(files.length >= 20, `Se encontraron ${files.length} migraciones`);

      const migrationsWithRLS: string[] = [];
      const migrationsWithPolicy: string[] = [];

      for (const file of files) {
        const content = fs.readFileSync(path.join(migrationsDir, file), 'utf8');
        if (/ENABLE\s+ROW\s+LEVEL\s+SECURITY/i.test(content)) {
          migrationsWithRLS.push(file);
        }
        if (/CREATE\s+POLICY/i.test(content)) {
          migrationsWithPolicy.push(file);
        }
      }

      assert.equal(
        migrationsWithRLS.length,
        0,
        `EVIDENCIA DE AUDITORÍA: 0 de ${files.length} migraciones activan RLS. Se requiere migración 022_ en PR-03.`
      );
      assert.equal(
        migrationsWithPolicy.length,
        0,
        `EVIDENCIA DE AUDITORÍA: 0 políticas RLS encontradas en el baseline actual.`
      );
    });

    test('HALLAZGO SEC-07: Conexión PG no define contexto de sesión tenant por defecto', () => {
      // Verificamos estáticamente que PgUnitOfWork / pool no ejecutan SET LOCAL app.current_tenant_id
      const dbConfigPath = path.join(backendDir, 'src/config/database.ts');
      const content = fs.readFileSync(dbConfigPath, 'utf8');

      assert.ok(!content.includes('app.current_tenant_id'), 'No hay session variable de tenant en la conexión global');
      assert.ok(!content.includes('SET LOCAL'), 'No hay seteo transaccional de tenant en database.ts');
    });
  });
});
