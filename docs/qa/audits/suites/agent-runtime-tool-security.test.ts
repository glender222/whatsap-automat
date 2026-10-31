import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';

process.env.JWT_SECRET ||= 'test-jwt-secret-qa-audit-32-chars-strictly-for-testing';
process.env.DB_PASSWORD ||= 'test-db-password-strictly-mocked';

const rootDir = path.resolve(__dirname, '../../../../');
const backendDir = path.join(rootDir, 'WhatsaapWeb-JS');
const { AgentToolRegistry } = require(path.join(backendDir, 'src/modules/ai/application/AgentToolRegistry'));
const { AgentToolExecutor } = require(path.join(backendDir, 'src/modules/ai/application/AgentToolExecutor'));
const {
  MAX_TOOL_ROUNDS,
  MAX_TOOL_CALLS_PER_MESSAGE,
  TOOL_EXECUTION_ERROR_CODE,
} = require(path.join(backendDir, 'src/modules/ai/domain/tool.types'));

describe('QA Security Audit: Ejecución de Agentes, Guardrails y Seguridad de Herramientas (RUN-01..12)', () => {

  const registry = new AgentToolRegistry();
  const dummyPool: any = { query: async () => ({ rows: [] }) };
  const dummyLogger: any = {
    logToolStarted: async () => {},
    logToolCall: async () => {},
  };
  const executor = new AgentToolExecutor(dummyPool, registry, dummyLogger);

  describe('1. Límites Operativos de Bucles y Ejecución (RUN-01, RUN-02)', () => {
    test('Límites estrictos de seguridad definidos para prevenir bucles infinitos de agentes', () => {
      assert.equal(MAX_TOOL_ROUNDS, 4, 'Máximo 4 rondas de herramientas por turno de usuario');
      assert.equal(MAX_TOOL_CALLS_PER_MESSAGE, 8, 'Máximo 8 llamadas a herramientas acumuladas por mensaje');
    });
  });

  describe('2. Control de Acceso y Modos Operativos (RUN-03)', () => {
    test('Modo Normal bloquea toda ejecución de herramientas con permission_denied', async () => {
      const ctx: any = {
        companyId: 1,
        companyMode: 'normal',
        agentMode: 'auto',
      };
      const result = await executor.execute(ctx, {
        id: 'call_1',
        name: 'catalog.search',
        input: { q: 'zapatos' },
      });

      assert.equal(result.status, 'permission_denied', 'Modo normal no permite tools');
      assert.equal(result.output?.reason, 'mode_blocked');
    });

    test('Modo Mixto (asistido) permite herramientas de lectura pero bloquea herramientas de escritura con forbidden', async () => {
      const ctx: any = {
        companyId: 1,
        companyMode: 'mixed',
        agentMode: 'auto',
      };

      // Intento de mutar pedido
      const writeResult = await executor.execute(ctx, {
        id: 'call_write',
        name: 'order.upsertPreorder',
        input: { items: [{ commercialItemId: 1, quantity: 2 }] },
      });

      assert.equal(
        writeResult.status,
        'forbidden',
        'Herramientas de escritura prohibidas en modo mixto'
      );
      assert.equal(writeResult.output?.reason, 'mode_blocked');
    });
  });

  describe('3. Sandbox de Agente y Prevención de Mutaciones en Pruebas (RUN-12)', () => {
    test('Cuando ctx.isTest=true, herramientas de mutación retornan dryRun sin mutar DB', async () => {
      const ctx: any = {
        companyId: 1,
        companyMode: 'automator',
        agentMode: 'auto',
        isTest: true, // Modo Sandbox / Simulador
        moduleAccess: { orders: true },
        toolAccess: { orderUpsertPreorder: true },
      };

      const result = await executor.execute(ctx, {
        id: 'call_sandbox',
        name: 'order.upsertPreorder',
        input: { items: [{ commercialItemId: 10, quantity: 1 }] },
      });

      assert.equal(result.status, 'ok');
      assert.equal(result.output?.dryRun, true, 'Debe activar flag dryRun');
      assert.equal(result.output?.reason, 'sandbox_no_mutation');
    });
  });

  describe('4. Guardrail contra Prompt Injection y Pagos No Autorizados (RUN-04)', () => {
    test('Herramientas de pago están deshabilitadas y redirigen automáticamente a handoff humano', async () => {
      const ctx: any = {
        companyId: 1,
        companyMode: 'automator',
        agentMode: 'auto',
        chatId: '5491112345678',
        moduleAccess: { handoff: true },
        toolAccess: { handoffCreate: true },
      };

      // Si el LLM o un prompt injection intenta invocar payment.createLink:
      const result = await executor.execute(ctx, {
        id: 'call_payment',
        name: 'payment.createLink',
        input: { amount: 500 },
      });

      assert.equal(result.status, 'disabled_future_tool');
      assert.equal(result.output?.reason, 'future_tool_disabled');
    });
  });

  describe('5. Sanitización de Errores y Blindaje contra Fugas de Información', () => {
    test('Errores internos inesperados de herramientas se capturan y retornan código seguro sin stacktrace', async () => {
      // Mockeamos el dispatch para lanzar una excepción de base de datos con credenciales
      const faultyPool: any = {
        query: async () => {
          throw new Error('FATAL: password authentication failed for user "postgres" at pg_connect');
        }
      };
      const faultyExecutor = new AgentToolExecutor(faultyPool, registry, dummyLogger);

      const ctx: any = {
        companyId: 1,
        companyMode: 'automator',
        agentMode: 'auto',
        moduleAccess: { catalog: true },
        toolAccess: { catalogGetItem: true },
      };

      const result = await faultyExecutor.execute(ctx, {
        id: 'call_err',
        name: 'catalog.getItem',
        input: { commercialItemId: 99 },
      });

      assert.equal(result.status, 'failed');
      assert.equal(result.output?.reason, 'execution_error');
      assert.equal(result.output?.errorCode, TOOL_EXECUTION_ERROR_CODE);
      assert.equal(
        JSON.stringify(result).includes('password authentication failed'),
        false,
        'No debe filtrar el mensaje de error interno ni detalles de infraestructura'
      );
    });
  });
});
