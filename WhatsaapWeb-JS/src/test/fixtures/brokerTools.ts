import type { TenantScopedUoW } from '../../db/TenantScopedUoW';
import { ToolRegistry } from '../../services/ai/broker/ToolRegistry';
import type { IToolImplementation } from '../../services/ai/broker/types';

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
