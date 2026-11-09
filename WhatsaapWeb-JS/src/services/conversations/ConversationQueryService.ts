import {
  CHANNEL_KINDS,
  ChannelKind,
  CommercialStage,
  ConversationMessageV1,
  ConversationStatus,
  ConversationV1,
  toCanonicalDeliveryState,
} from '@whatsap-automat/contracts';
import { TenantScopedUoW, tenantScopedUoW } from '../../db/TenantScopedUoW';
import { Queryable } from '../../shared/UnitOfWorkPort';

type Cursor = { direction: 'older' | 'newer'; id: number };
export type ConversationPage = { cursor: Cursor | null; limit: number };
type ConversationFilters = { channel?: ChannelKind; stage?: CommercialStage; status?: ConversationStatus };

const whatsappAliases = ['whatsapp', 'whatsapp-cloud', 'whatsapp-web'];
const supportedChannels = [...CHANNEL_KINDS, ...whatsappAliases];
const statusExpression = `CASE WHEN archived_at IS NOT NULL THEN 'archived' ELSE status END`;
const conversationColumns = `id, company_id, channel, external_conversation_id, contact_id, title,
  ${statusExpression} AS status, commercial_stage, version,
  ia_paused AND (ia_resume_at IS NULL OR ia_resume_at > NOW()) AS ia_paused, ia_resume_at,
  assigned_user_id, owner_type, owner_id, last_message_at, service_window_expires_at, created_at, updated_at,
  EXISTS (SELECT 1 FROM conversation_send_claims s WHERE s.tenant_id = conversations.company_id
    AND s.conversation_id = conversations.id AND s.state = 'unknown_delivery') AS has_unresolved_delivery`;

function encodeCursor(direction: Cursor['direction'], id: number): string {
  return Buffer.from(`${direction}:${id}`).toString('base64url');
}

export function parseConversationPage(query: { limit?: unknown; cursor?: unknown }, defaultLimit: number): ConversationPage | null {
  const { cursor, limit } = query;
  if (limit !== undefined && (typeof limit !== 'string' || !/^\d{1,3}$/.test(limit))) return null;
  const size = limit === undefined ? defaultLimit : Number(limit);
  if (size < 1 || size > 100) return null;
  if (cursor === undefined) return { cursor: null, limit: size };
  if (typeof cursor !== 'string' || !/^[\w-]{1,32}$/.test(cursor)) return null;
  const match = /^(older|newer):([1-9]\d{0,9})$/.exec(Buffer.from(cursor, 'base64url').toString());
  if (!match || Number(match[2]) > 2147483647) return null;
  const direction = match[1] as Cursor['direction'];
  const id = Number(match[2]);
  if (encodeCursor(direction, id) !== cursor) return null;
  return { cursor: { direction, id }, limit: size };
}

function pageOf<T extends { id: string }>(rows: T[], { cursor, limit }: ConversationPage) {
  const extra = rows.length > limit;
  const items = rows.slice(0, limit);
  const newer = cursor?.direction === 'newer';
  if (newer) items.reverse();
  const first = items[0];
  const last = items[items.length - 1];
  const hasMore = Boolean(last && (newer || extra));
  return {
    items,
    nextCursor: hasMore && last ? encodeCursor('older', Number(last.id)) : null,
    prevCursor: first && (newer ? extra : cursor) ? encodeCursor('newer', Number(first.id)) : null,
    hasMore,
  };
}

const idText = (id: string | number | null): string | null => id === null ? null : String(id);
const dateText = (date: Date | null): string | null => date?.toISOString() ?? null;

type ConversationRow = {
  id: number;
  company_id: number;
  channel: string;
  external_conversation_id: string;
  contact_id: number | null;
  title: string | null;
  status: ConversationStatus;
  commercial_stage: CommercialStage;
  version: number;
  has_unresolved_delivery: boolean;
  ia_paused: boolean;
  ia_resume_at: Date | null;
  assigned_user_id: number | null;
  owner_type: string;
  owner_id: string | null;
  last_message_at: Date | null;
  service_window_expires_at: Date | null;
  created_at: Date;
  updated_at: Date;
};

function conversationFromRow(row: ConversationRow): ConversationV1 {
  const channel = whatsappAliases.includes(row.channel) ? 'whatsapp-cloud' : row.channel as ChannelKind;
  return {
    id: String(row.id), tenantId: String(row.company_id), channel,
    connectionId: `legacy:${row.company_id}:${channel}`,
    externalConversationId: row.external_conversation_id,
    contactIdentityId: idText(row.contact_id),
    title: row.title,
    status: row.status,
    stage: row.commercial_stage,
    stateVersion: row.version,
    hasUnresolvedDelivery: row.has_unresolved_delivery,
    aiPaused: Boolean(row.ia_paused),
    aiPausedUntil: dateText(row.ia_resume_at),
    assignedUserId: idText(row.assigned_user_id),
    assignedAgentId: row.owner_type === 'ai_agent' ? row.owner_id : null,
    lastMessageAt: dateText(row.last_message_at),
    serviceWindowExpiresAt: dateText(row.service_window_expires_at),
    createdAt: (row.created_at ?? row.updated_at).toISOString(),
    updatedAt: (row.updated_at ?? row.created_at).toISOString(),
  };
}

export async function readConversation(client: Queryable, tenantId: number, id: number): Promise<ConversationV1 | null> {
  const { rows } = await client.query(
    `SELECT ${conversationColumns} FROM conversations WHERE id = $1 AND company_id = $2 AND channel = ANY($3::text[])`,
    [id, tenantId, supportedChannels]
  );
  return rows.length ? conversationFromRow(rows[0]) : null;
}

function cursorOperator(cursor: Cursor | null): '<' | '>' { return cursor?.direction === 'newer' ? '>' : '<'; }
function orderForCursor(cursor: Cursor | null): 'DESC' | 'ASC' { return cursor?.direction === 'newer' ? 'ASC' : 'DESC'; }

export class ConversationQueryService {
  constructor(private readonly uow: TenantScopedUoW = tenantScopedUoW) {}

  list(tenantId: number, page: ConversationPage, filters: ConversationFilters) {
    const channels = filters.channel === 'whatsapp-cloud' ? whatsappAliases : filters.channel ? [filters.channel] : supportedChannels;
    return this.uow.run(tenantId, async (client) => {
      const { rows } = await client.query(
        `SELECT ${conversationColumns}
         FROM conversations
         WHERE company_id = $1 AND channel = ANY($2::text[])
           AND ($3::text IS NULL OR commercial_stage = $3)
           AND ($4::text IS NULL OR ${statusExpression} = $4)
           AND ($5::integer IS NULL OR id ${cursorOperator(page.cursor)} $5)
         ORDER BY id ${orderForCursor(page.cursor)} LIMIT $6`,
        [tenantId, channels, filters.stage ?? null, filters.status ?? null, page.cursor?.id ?? null, page.limit + 1]
      );
      return pageOf(rows.map(conversationFromRow), page);
    });
  }

  get(tenantId: number, id: number) {
    return this.uow.run(tenantId, (client) => readConversation(client, tenantId, id));
  }

  messages(tenantId: number, id: number, page: ConversationPage, clientRequestId?: string) {
    return this.uow.run(tenantId, async (client) => {
      const conversation = await readConversation(client, tenantId, id);
      if (!conversation) return null;
      const { rows } = await client.query(
        `SELECT m.id, m.direction, m.status, m.external_contact_id,
                m.client_request_id, m.body, COALESCE(m.occurred_at, m.created_at) AS created_at,
                send.actor_id AS canonical_actor_id, send.connection_id AS canonical_connection_id,
                COALESCE((SELECT jsonb_agg(jsonb_build_object(
                  'id', a.id::text, 'filename', a.filename, 'mimeType', COALESCE(a.mime_type, 'application/octet-stream'),
                  'sizeBytes', a.size_bytes
                ) ORDER BY a.id) FROM message_attachments a WHERE a.message_id = m.id), '[]') AS attachments
         FROM messages m
         LEFT JOIN conversation_send_claims send ON send.tenant_id = m.company_id
           AND send.conversation_id = m.conversation_id AND send.message_id = m.id
         WHERE m.company_id = $1 AND m.conversation_id = $2 AND m.direction IN ('inbound', 'outbound')
           AND ($3::integer IS NULL OR m.id ${cursorOperator(page.cursor)} $3)
           AND ($5::varchar IS NULL OR m.client_request_id = $5)
         ORDER BY m.id ${orderForCursor(page.cursor)} LIMIT $4`,
        [tenantId, id, page.cursor?.id ?? null, page.limit + 1, clientRequestId ?? null]
      );
      return pageOf(rows.map((row): ConversationMessageV1 => ({
        id: String(row.id), conversationId: conversation.id, tenantId: conversation.tenantId,
        connectionId: row.canonical_connection_id ?? conversation.connectionId, channel: conversation.channel,
        direction: row.direction,
        deliveryState: row.direction === 'inbound' && row.status === 'received' ? 'delivered' : toCanonicalDeliveryState(row.status ?? ''),
        originEventId: null, clientRequestId: row.client_request_id, correlationId: null, body: row.body,
        attachments: row.attachments.map((attachment: { id: string; filename: string | null; mimeType: string; sizeBytes: number | null }) => ({
          id: attachment.id, mimeType: attachment.mimeType,
          ...(attachment.filename && { filename: attachment.filename }),
          ...(attachment.sizeBytes !== null && { sizeBytes: attachment.sizeBytes }),
        })),
        causedBy: row.direction === 'inbound'
          ? { type: 'customer', id: conversation.contactIdentityId ?? row.external_contact_id ?? conversation.externalConversationId }
          : row.canonical_actor_id ? { type: 'human', id: String(row.canonical_actor_id) } : { type: 'system', id: 'legacy' },
        createdAt: row.created_at.toISOString(),
      })), page);
    });
  }
}

export const conversationQueryService = new ConversationQueryService();
