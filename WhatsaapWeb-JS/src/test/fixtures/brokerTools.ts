import type { TenantScopedUoW } from '../../db/TenantScopedUoW';
import { ToolRegistry } from '../../services/ai/broker/ToolRegistry';
import type { IToolImplementation } from '../../services/ai/broker/types';
import type { BrokerEffectStore } from '../../services/ai/broker/ToolBroker';
import type { EffectBinding } from '../../services/ai/broker/EffectCache';
import { randomUUID } from 'node:crypto';

/** In-memory double only for interception unit tests; PostgreSQL behavior has its own integration suite. */
export function createBrokerFixtureEffectCache(): BrokerEffectStore {
  const records = new Map<string, EffectBinding & { token: string; status: string; output?: unknown }>();
  return {
    async claim(tenantId, key, binding) {
      const id = `${tenantId}:${key}`;
      const prior = records.get(id);
      if (prior) {
        if (prior.actionHash !== binding.actionHash || prior.runId !== binding.runId || prior.toolName !== binding.toolName) {
          return { kind: 'conflict' };
        }
        if (prior.status === 'executed') return { kind: 'cached', record: { ...prior, output: prior.output } };
        return { kind: prior.status === 'processing' ? 'in_progress' : 'unknown' };
      }
      const token = randomUUID();
      records.set(id, { ...binding, token, status: 'processing' });
      return { kind: 'claimed', token };
    },
    async complete(tenantId, key, token, output) {
      const prior = records.get(`${tenantId}:${key}`);
      if (!prior || prior.token !== token) throw new Error('Fixture claim missing');
      prior.status = 'executed';
      prior.output = output;
    },
    async markUnknown(tenantId, key, token) {
      const prior = records.get(`${tenantId}:${key}`);
      if (prior?.token === token && prior.status === 'processing') prior.status = 'delivery_unknown';
    },
  };
}

export function createBrokerFixtureRegistry(uow: TenantScopedUoW): ToolRegistry {
  const registry = new ToolRegistry(uow);
  const fixture = (
    name: string,
    riskLevel: IToolImplementation['definition']['riskLevel'],
    requiredRoles: string[],
    required: string[],
    output: Record<string, string>,
    protections: Partial<IToolImplementation['definition']> = {}
  ): IToolImplementation => ({
    definition: {
      schemaVersion: 1,
      name,
      description: 'Test fixture',
      riskLevel,
      requiredRoles,
      parameters: { type: 'object', required },
      timeoutMs: 1000,
      isEgressNetworkTool: false,
      ...protections,
    },
    validateInput(input) {
      const errors = required.filter((key) => {
        const value = input[key];
        if (key === 'items') return !Array.isArray(value) || value.length === 0;
        if (key === 'conversationId' && typeof value === 'number') return !Number.isSafeInteger(value) || value < 1;
        return typeof value !== 'string' || value.trim().length === 0;
      });
      return { valid: errors.length === 0, errors };
    },
    async execute() {
      return output;
    },
  });
  registry.registerTool(fixture('search_knowledge', 'read', ['agent', 'operator'], ['query'], { source: 'test' }));
  registry.registerTool(fixture('create_invoice', 'financial', ['agent', 'admin', 'supervisor'], ['customerId', 'items'], {
    invoiceId: 'test-invoice',
    status: 'created',
  }, { requiresApproval: true }));
  registry.registerTool(fixture('send_whatsapp_message', 'send', ['agent', 'operator'], ['conversationId', 'messageText'], {
    messageId: 'test-message',
    status: 'dispatched',
  }, { requiresCasFencing: true }));
  return registry;
}
