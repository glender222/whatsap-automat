import { TenantScopedUoW, tenantScopedUoW } from '../../../db/TenantScopedUoW';
import { IToolImplementation } from './types';
import { HttpRequestTool } from './tools/HttpRequestTool';
import { SearchKnowledgeTool } from './tools/SearchKnowledgeTool';
import { SendWhatsappMessageTool } from './tools/SendWhatsappMessageTool';
import { CreateInvoiceTool } from './tools/CreateInvoiceTool';

export class ToolRegistry {
  private readonly builtinTools = new Map<string, IToolImplementation>();
  private readonly customTools = new Map<string, IToolImplementation>();

  constructor(private readonly uow: TenantScopedUoW = tenantScopedUoW) {
    this.registerBuiltin(new HttpRequestTool());
    this.registerBuiltin(new SearchKnowledgeTool(this.uow));
    this.registerBuiltin(new SendWhatsappMessageTool(this.uow));
    this.registerBuiltin(new CreateInvoiceTool());
  }

  private registerBuiltin(tool: IToolImplementation): void {
    this.builtinTools.set(tool.definition.name, tool);
  }

  registerTool(tool: IToolImplementation, tenantId?: number): void {
    const key = tenantId ? `${tenantId}:${tool.definition.name}` : tool.definition.name;
    this.customTools.set(key, tool);
  }

  async getTool(tenantId: number, toolName: string): Promise<IToolImplementation | null> {
    // 1. Check tenant-specific custom registered implementation
    const tenantKey = `${tenantId}:${toolName}`;
    if (this.customTools.has(tenantKey)) {
      return this.customTools.get(tenantKey)!;
    }

    // 2. Check global custom tool
    if (this.customTools.has(toolName)) {
      return this.customTools.get(toolName)!;
    }

    // 3. Check built-in tool
    if (this.builtinTools.has(toolName)) {
      return this.builtinTools.get(toolName)!;
    }

    // 4. Check DB for custom tool definition
    try {
      return await this.uow.run(tenantId, async (client) => {
        const res = await client.query(
          `SELECT name, display_name, description, risk_level, required_roles,
                  parameters_schema, timeout_ms, is_egress_network, requires_approval,
                  requires_cas_fencing, is_active
           FROM tool_definitions
           WHERE (tenant_id = $1 OR tenant_id IS NULL) AND name = $2 AND is_active = true
           ORDER BY tenant_id NULLS LAST
           LIMIT 1`,
          [tenantId, toolName]
        );

        if (res.rowCount === 0) return null;
        const row = res.rows[0];

        return {
          definition: {
            schemaVersion: 1,
            name: row.name,
            description: row.description,
            riskLevel: row.risk_level,
            requiredRoles: row.required_roles || ['agent'],
            parameters: typeof row.parameters_schema === 'string'
              ? JSON.parse(row.parameters_schema)
              : row.parameters_schema || {},
            timeoutMs: row.timeout_ms || 10000,
            isEgressNetworkTool: Boolean(row.is_egress_network),
            requiresApproval: Boolean(row.requires_approval),
            requiresCasFencing: Boolean(row.requires_cas_fencing),
          },
          validateInput: () => ({ valid: true }),
          execute: async (input) => ({ executed: true, input }),
        };
      });
    } catch {
      return null;
    }
  }

  async listTools(tenantId: number): Promise<IToolImplementation[]> {
    const toolsMap = new Map<string, IToolImplementation>();

    // Add all built-ins
    for (const [name, tool] of this.builtinTools.entries()) {
      toolsMap.set(name, tool);
    }

    // Add in-memory custom tools
    for (const [key, tool] of this.customTools.entries()) {
      if (key.startsWith(`${tenantId}:`)) {
        toolsMap.set(tool.definition.name, tool);
      } else if (!key.includes(':')) {
        toolsMap.set(tool.definition.name, tool);
      }
    }

    // Add DB tool definitions if available
    try {
      await this.uow.run(tenantId, async (client) => {
        const res = await client.query(
          `SELECT name, display_name, description, risk_level, required_roles,
                  parameters_schema, timeout_ms, is_egress_network, requires_approval,
                  requires_cas_fencing
           FROM tool_definitions
           WHERE (tenant_id = $1 OR tenant_id IS NULL) AND is_active = true`,
          [tenantId]
        );

        for (const row of res.rows) {
          if (!toolsMap.has(row.name)) {
            toolsMap.set(row.name, {
              definition: {
                schemaVersion: 1,
                name: row.name,
                description: row.description,
                riskLevel: row.risk_level,
                requiredRoles: row.required_roles || ['agent'],
                parameters: typeof row.parameters_schema === 'string'
                  ? JSON.parse(row.parameters_schema)
                  : row.parameters_schema || {},
                timeoutMs: row.timeout_ms || 10000,
                isEgressNetworkTool: Boolean(row.is_egress_network),
                requiresApproval: Boolean(row.requires_approval),
                requiresCasFencing: Boolean(row.requires_cas_fencing),
              },
              validateInput: () => ({ valid: true }),
              execute: async (input) => ({ executed: true, input }),
            });
          }
        }
      });
    } catch {
      // Return currently cached/built-in tools
    }

    return Array.from(toolsMap.values());
  }
}
