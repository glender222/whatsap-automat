export * from './types';
export * from './SsrfEgressGuard';
export * from './SafeHttpClient';
export * from './EffectCache';
export * from './ToolRegistry';
export * from './HitlApprovalService';
export * from './ToolBroker';
export * from './tools/HttpRequestTool';
export * from './tools/SearchKnowledgeTool';

import { ToolBroker } from './ToolBroker';
import { ToolRegistry } from './ToolRegistry';
import { HitlApprovalService } from './HitlApprovalService';
import { EffectCache } from './EffectCache';

export const toolRegistry = new ToolRegistry();
export const effectCache = new EffectCache();
export const hitlApprovalService = new HitlApprovalService();
export const toolBroker = new ToolBroker({
  registry: toolRegistry,
  effectCache,
  hitlService: hitlApprovalService,
});
