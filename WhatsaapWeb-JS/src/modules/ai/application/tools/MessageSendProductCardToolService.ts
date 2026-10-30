import { Queryable } from '../../../../shared/UnitOfWorkPort';
import { ProductRepositoryPg } from '../../../inventory';
import type { AgentToolContext, ToolExecutorOutcome } from '../../domain/tool.types';
import { TOOL_EXECUTION_ERROR_CODE } from '../../domain/tool.types';

type SendProductCardInput = {
  commercialItemId: number;
  caption?: string;
};

export type ProductCardSendPayload = {
  companyId: number;
  chatId: string;
  commercialItemId: number;
  primaryImageUrl: string | null;
  productName: string;
  caption: string;
};

export interface ProductCardSender {
  sendProductCard(payload: ProductCardSendPayload): Promise<{ providerMessageId: string | null }>;
}

const MAX_CAPTION_LENGTH = 1024;

export class MessageSendProductCardToolService {
  constructor(
    private readonly pool: Queryable,
    private readonly productRepo: ProductRepositoryPg,
    private readonly sender: ProductCardSender
  ) {}

  async send(ctx: AgentToolContext, raw: SendProductCardInput): Promise<ToolExecutorOutcome> {
    const id = Number(raw.commercialItemId);
    if (!Number.isInteger(id) || id <= 0) return { status: 'invalid_input', output: { sent: false } };
    if (!ctx.chatId) return { status: 'invalid_input', output: { sent: false, reason: 'chat_id_required' } };

    const product = await this.productRepo.get(ctx.companyId, id);
    if (!product || product.status !== 'active' || !product.aiEnabled) {
      return { status: 'not_found', output: { sent: false, reason: 'product_not_found' } };
    }

    const { catalogIds, sectionIds } = ctx.catalogScope;
    if (catalogIds.length === 0 && sectionIds.length === 0) {
      return { status: 'scope_empty', output: { sent: false, reason: 'scope_empty' } };
    }
    const inScope =
      product.catalogs.some((c) => catalogIds.includes(Number(c.id))) ||
      product.sections.some((s) => sectionIds.includes(Number(s.id)));
    if (!inScope) return { status: 'not_found', output: { sent: false, reason: 'out_of_scope' } };

    const primaryImageUrl = product.primaryImage?.url || product.imageUrl || null;
    if (!primaryImageUrl) {
      return { status: 'failed', output: { sent: false, reason: 'missing_primary_image' } };
    }

    const caption = String(raw.caption || '').slice(0, MAX_CAPTION_LENGTH);

    try {
      const { providerMessageId } = await this.sender.sendProductCard({
        companyId: ctx.companyId,
        chatId: ctx.chatId,
        commercialItemId: product.id,
        primaryImageUrl,
        productName: product.name,
        caption,
      });

      await this.pool.query(
        `INSERT INTO operational_actions (
           company_id, conversation_id, actor_user_id, action_type, status, description, metadata_json
         )
         VALUES ($1, $2, $3, 'product_card_sent', 'completed', $4, $5::jsonb)`,
        [ctx.companyId, ctx.conversationId ?? null, ctx.actorUserId ?? null, `Ficha producto enviada: ${product.name}`, JSON.stringify({ commercialItemId: product.id, providerMessageId })]
      );

      return {
        status: 'ok',
        output: { sent: true, providerMessageId, commercialItemId: product.id },
      };
    } catch {
      return {
        status: 'failed',
        output: { sent: false, reason: 'send_error', errorCode: TOOL_EXECUTION_ERROR_CODE },
      };
    }
  }
}

let instance: MessageSendProductCardToolService | null = null;

export function getMessageSendProductCardToolService(
  pool: Queryable,
  sender: ProductCardSender
): MessageSendProductCardToolService {
  if (!instance) instance = new MessageSendProductCardToolService(pool, new ProductRepositoryPg(pool), sender);
  return instance;
}
