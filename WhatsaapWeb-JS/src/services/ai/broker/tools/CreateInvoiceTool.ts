import { ToolDefinitionV1 } from '@whatsap-automat/contracts';
import { IToolImplementation, ToolExecutionContext, ToolValidationResult } from '../types';

export class CreateInvoiceTool implements IToolImplementation {
  readonly definition: ToolDefinitionV1 = {
    schemaVersion: 1,
    name: 'create_invoice',
    description: 'Generates a binding commercial invoice and payment request. Requires supervisor human approval.',
    riskLevel: 'financial',
    requiredRoles: ['agent', 'admin', 'supervisor'],
    parameters: {
      type: 'object',
      required: ['customerId', 'items'],
      properties: {
        customerId: { type: 'string' },
        customerEmail: { type: 'string' },
        currency: { type: 'string', default: 'USD' },
        items: {
          type: 'array',
          items: {
            type: 'object',
            required: ['description', 'quantity', 'unitAmountCents'],
            properties: {
              description: { type: 'string' },
              quantity: { type: 'integer', minimum: 1 },
              unitAmountCents: { type: 'integer', minimum: 1 },
            },
          },
        },
      },
    },
    timeoutMs: 15000,
    requiresApproval: true,
    isEgressNetworkTool: false,
  };

  validateInput(input: Record<string, unknown>): ToolValidationResult {
    const errors: string[] = [];
    if (!input || typeof input !== 'object') {
      return { valid: false, errors: ['Input must be an object'] };
    }
    if (!input.customerId || typeof input.customerId !== 'string' || input.customerId.trim().length === 0) {
      errors.push("Missing or invalid required parameter 'customerId'");
    }
    if (!Array.isArray(input.items) || input.items.length === 0) {
      errors.push("Missing or invalid required parameter 'items': must be a non-empty array");
    }
    return { valid: errors.length === 0, errors: errors.length > 0 ? errors : undefined };
  }

  async execute(input: Record<string, unknown>, context: ToolExecutionContext): Promise<unknown> {
    const customerId = String(input.customerId);
    const currency = input.currency ? String(input.currency) : 'USD';
    const items = (input.items as Array<{ description: string; quantity: number; unitAmountCents: number }>) || [];

    const totalCents = items.reduce((acc, item) => acc + (Number(item.quantity) || 1) * (Number(item.unitAmountCents) || 0), 0);
    const invoiceId = `inv_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;

    return {
      invoiceId,
      customerId,
      tenantId: context.tenantId,
      currency,
      totalCents,
      status: 'created',
      itemsCount: items.length,
      createdAt: new Date().toISOString(),
    };
  }
}
