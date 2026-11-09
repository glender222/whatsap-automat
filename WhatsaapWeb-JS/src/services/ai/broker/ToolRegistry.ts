import { TenantScopedUoW, tenantScopedUoW } from '../../../db/TenantScopedUoW';
import { KnowledgeBaseService } from '../rag/KnowledgeBaseService';
import { IToolImplementation } from './types';
import { HttpRequestTool } from './tools/HttpRequestTool';
import { SearchKnowledgeTool } from './tools/SearchKnowledgeTool';

export class ToolRegistry {
  private readonly builtinTools = new Map<string, IToolImplementation>();
  private readonly customTools = new Map<string, IToolImplementation>();

  constructor(uow: TenantScopedUoW = tenantScopedUoW) {
    const builtins = [new HttpRequestTool(), new SearchKnowledgeTool(new KnowledgeBaseService(uow))];
    for (const tool of builtins) this.builtinTools.set(tool.definition.name, tool);
  }

  registerTool(tool: IToolImplementation, tenantId?: number): void {
    const key = tenantId === undefined ? tool.definition.name : `${tenantId}:${tool.definition.name}`;
    this.customTools.set(key, tool);
  }

  async getTool(tenantId: number, toolName: string): Promise<IToolImplementation | null> {
    return this.customTools.get(`${tenantId}:${toolName}`)
      ?? this.customTools.get(toolName)
      ?? this.builtinTools.get(toolName)
      ?? null;
  }

  async listTools(tenantId: number): Promise<IToolImplementation[]> {
    const tools = new Map(this.builtinTools);
    for (const [key, tool] of this.customTools) {
      if (!key.includes(':')) tools.set(tool.definition.name, tool);
    }
    for (const [key, tool] of this.customTools) {
      if (key.startsWith(`${tenantId}:`)) tools.set(tool.definition.name, tool);
    }
    return [...tools.values()];
  }
}
