import { Queryable } from '../../../../shared/UnitOfWorkPort';
import { OrderRepositoryPg } from '../../../orders';
import type { CommercialOrderStatus, CreateDetectedOrderInput } from '../../../orders';
import type { AgentToolContext, ToolExecutorOutcome } from '../../domain/tool.types';
import { TOOL_EXECUTION_ERROR_CODE } from '../../domain/tool.types';

type PreorderItemInput = {
  commercialItemId: number;
  quantity: number;
};

type UpsertPreorderInput = {
  items: PreorderItemInput[];
  status?: 'draft' | 'quoted' | 'pending_handoff';
  notes?: string;
};

const AI_ALLOWED_STATUSES: ReadonlyArray<'draft' | 'quoted' | 'pending_handoff'> = ['draft', 'quoted', 'pending_handoff'];
const AI_FORBIDDEN_STATUSES: ReadonlyArray<CommercialOrderStatus> = ['confirmed', 'reserved', 'completed', 'cancelled'];

export class PreorderToolService {
  constructor(private readonly orderRepo: OrderRepositoryPg) {}

  async upsertPreorder(ctx: AgentToolContext, raw: UpsertPreorderInput): Promise<ToolExecutorOutcome> {
    if (!Array.isArray(raw.items) || raw.items.length === 0) {
      return { status: 'invalid_input', output: { orderId: null, items: [] } };
    }
    const requestedStatus = (raw.status || 'draft') as 'draft' | 'quoted' | 'pending_handoff';
    if (!AI_ALLOWED_STATUSES.includes(requestedStatus)) {
      return { status: 'forbidden', output: { orderId: null, items: [], reason: 'status_not_allowed_for_ai' } };
    }
    if (!ctx.chatId) {
      return { status: 'invalid_input', output: { orderId: null, items: [], reason: 'chat_id_required' } };
    }

    const items = raw.items.map((item) => {
      const id = Number(item.commercialItemId);
      const qty = Math.max(1, Math.trunc(Number(item.quantity || 1)));
      return {
        commercialItemId: Number.isInteger(id) && id > 0 ? id : null,
        productName: '',
        detectedName: '',
        quantity: qty,
      };
    });
    if (items.every((i) => !i.commercialItemId)) {
      return { status: 'invalid_input', output: { orderId: null, items: [], reason: 'missing_commercial_item_ids' } };
    }

    const input: CreateDetectedOrderInput = {
      companyId: ctx.companyId,
      chatId: ctx.chatId,
      agentId: ctx.agentId,
      userId: ctx.actorUserId ?? null,
      items,
      status: requestedStatus,
      notes: raw.notes || null,
      metadata: { source: 'ai_tool', tool: 'order.upsertPreorder' },
    };

    try {
      const { order } = await this.orderRepo.createDetected(input);
      if (AI_FORBIDDEN_STATUSES.includes(order.status as CommercialOrderStatus)) {
        return { status: 'forbidden', output: { orderId: order.id, items: [], reason: 'resolved_status_forbidden_for_ai' } };
      }
      const outputItems = order.items.map((i) => ({
        commercialItemId: i.commercialItemId,
        quantity: i.quantity,
        status: i.status,
      }));
      return {
        status: 'ok',
        output: { orderId: order.id, status: order.status, items: outputItems },
        relatedOrderId: order.id,
      };
    } catch {
      return {
        status: 'failed',
        output: { orderId: null, items: [], errorCode: TOOL_EXECUTION_ERROR_CODE },
      };
    }
  }
}

let instance: PreorderToolService | null = null;

export function getPreorderToolService(pool: Queryable): PreorderToolService {
  if (!instance) instance = new PreorderToolService(new OrderRepositoryPg(pool));
  return instance;
}
