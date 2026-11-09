import { createHash, randomUUID } from 'node:crypto';
import { type SendMessageResultV1, type StandardErrorCode, toCanonicalDeliveryState } from '@whatsap-automat/contracts';
import config from '../../config/index';
import { TenantScopedUoW, tenantScopedUoW } from '../../db/TenantScopedUoW';
import type { Queryable } from '../../shared/UnitOfWorkPort';
import MetaAccountStore from '../whatsapp/meta/MetaAccountStore';
import { isDefiniteMetaMessageRejection, MetaCloudClient } from '../whatsapp/meta/MetaCloudClient';
import { inspectConversationAttachment, uploadConversationAttachment, type AttachmentFile, type UploadedAttachment } from './ConversationAttachment';
import { applyCanonicalMetaStatuses, lockMetaReceipt, refreshConversationPreview } from '../whatsapp/meta/MetaCanonicalReceipt';

export class ConversationSendError extends Error {
  constructor(
    readonly code: StandardErrorCode,
    readonly reasonCode: string,
    message: string,
    readonly metadata?: Record<string, unknown>,
  ) { super(message); }
}

type SendIdentity = {
  tenantId: number;
  conversationId: number;
  actorId: number;
  expectedVersion: number;
  key: string;
};

export type SendConversationText = SendIdentity & { text: string };
export type SendConversationAttachment = SendIdentity & { file: AttachmentFile; caption: string; forceDocument: boolean };

type ClaimRow = {
  conversation_id: number;
  actor_id: number;
  expected_version: number;
  payload_hash: string;
  state: 'unknown_delivery' | 'provider_accepted' | 'failed';
  provider_message_id: string | null;
  message_status: string | null;
};
type SendAuthority = {
  connectionId: string;
  phoneId: string;
  accountProof: string;
  recipient: string;
  windowExpiresAt: Date;
  client: MetaCloudClient;
};

type ReservedSend = SendAuthority & { messageId: number; callbackRef: string };

const unknownDelivery: SendMessageResultV1 = {
  providerMessageId: null, accepted: false, rawStatus: 'unknown_delivery', deliveryState: 'unknown_delivery',
};
const failedDelivery: SendMessageResultV1 = {
  providerMessageId: null, accepted: false, rawStatus: 'failed', deliveryState: 'failed',
};

function replay(claim: ClaimRow, command: SendIdentity, hash: string): SendMessageResultV1 {
  if (claim.conversation_id !== command.conversationId || claim.actor_id !== command.actorId ||
      claim.expected_version !== command.expectedVersion || claim.payload_hash !== hash) {
    throw new ConversationSendError('CONFLICT', 'IDEMPOTENCY_KEY_CONFLICT', 'This idempotency key is already bound to a different send.');
  }
  if (claim.state === 'unknown_delivery') return unknownDelivery;
  if (claim.state === 'failed') return failedDelivery;
  const status = claim.message_status ?? 'accepted';
  return { providerMessageId: claim.provider_message_id, accepted: true, rawStatus: status, deliveryState: toCanonicalDeliveryState(status) };
}

async function getClaim(db: Queryable, tenantId: number, key: string): Promise<ClaimRow | undefined> {
  const { rows } = await db.query(`
    SELECT c.conversation_id, c.actor_id, c.expected_version, c.payload_hash, c.state,
      c.provider_message_id, m.status AS message_status
    FROM conversation_send_claims c LEFT JOIN messages m ON m.company_id = c.tenant_id AND m.id = c.message_id
    WHERE c.tenant_id = $1 AND c.request_key = $2
  `, [tenantId, key]);
  return rows[0];
}

export class ConversationSendService {
  constructor(
    private readonly uow: TenantScopedUoW = tenantScopedUoW,
    private readonly accounts = new MetaAccountStore(),
    private readonly enabled = config.whatsapp.provider === 'meta-cloud',
    private readonly fetchGraph?: typeof fetch,
  ) {}

  async send(command: SendConversationText): Promise<SendMessageResultV1> {
    const hash = createHash('sha256').update(command.text).digest('hex');
    const reserved = await this.claimOr(command, hash, (db) => this.reserve(db, command, hash, command.text));
    if ('deliveryState' in reserved) return reserved;
    return this.dispatch(command, reserved, hash, (options) => reserved.client.sendText(reserved.recipient, command.text, options));
  }

  async sendAttachment(command: SendConversationAttachment): Promise<SendMessageResultV1> {
    const { hash, kind, file } = await inspectConversationAttachment(command);
    const preflight = await this.claimOr(command, hash, (db) => this.authorize(db, command));
    if ('deliveryState' in preflight) return preflight;

    // Uploading media creates no recipient message. Only a revalidated durable claim
    // authorizes the subsequent /messages POST, even if another upload ran in parallel.
    const uploaded = await uploadConversationAttachment(preflight.client, kind, file);
    const reserved = await this.claimOr(command, hash, (db) =>
      this.reserve(db, command, hash, command.caption, uploaded, preflight.accountProof));
    if ('deliveryState' in reserved) return reserved;
    return this.dispatch(command, reserved, hash, (options) => reserved.client.sendMedia(
      reserved.recipient, uploaded.id, uploaded.kind, { ...options, caption: command.caption, filename: uploaded.filename },
    ));
  }

  private async claimOr<T>(command: SendIdentity, hash: string, proceed: (db: Queryable) => Promise<T>) {
    const { tenantId, key } = command;
    return this.uow.run(tenantId, async (db) => {
      await db.query("SELECT pg_advisory_xact_lock(hashtextextended('conversation-send:' || $1::text || ':' || $2::text, 0))",
        [tenantId, key]);
      const claim = await getClaim(db, tenantId, key);
      return claim ? replay(claim, command, hash) : proceed(db);
    });
  }

  private async dispatch(
    command: SendIdentity, reserved: ReservedSend, hash: string,
    send: (options: { redirect: RequestRedirect; callbackData: string }) => Promise<{ providerMessageId: string | null }>,
  ): Promise<SendMessageResultV1> {
    // The durable unknown state already exists. Only the transaction that inserted it
    // can reach this call. No process may resume or retry a claimed external request.
    if (Date.now() >= reserved.windowExpiresAt.getTime()) {
      return this.complete(command, reserved, hash, null, 'SERVICE_WINDOW_EXPIRED');
    }

    let receipt: string | null;
    try {
      const sent = await send({
        redirect: 'error', callbackData: `automat:${reserved.callbackRef}`,
      });
      receipt = sent.providerMessageId;
    } catch (error) {
      if (isDefiniteMetaMessageRejection(error)) return this.complete(command, reserved, hash, null, 'META_REJECTED');
      return this.readOutcome(command, hash);
    }
    if (typeof receipt !== 'string' || !/^wamid\.[A-Za-z0-9+/_=-]{1,249}$/.test(receipt)) return this.readOutcome(command, hash);
    return this.complete(command, reserved, hash, receipt, null);
  }

  private async readOutcome(command: SendIdentity, hash: string): Promise<SendMessageResultV1> {
    try {
      const claim = await this.uow.run(command.tenantId, (db) => getClaim(db, command.tenantId, command.key));
      return claim ? replay(claim, command, hash) : unknownDelivery;
    } catch {
      return unknownDelivery;
    }
  }

  private async authorize(db: Queryable, command: SendIdentity): Promise<SendAuthority> {
    const { tenantId, conversationId, actorId, expectedVersion } = command;
    const { rows: [conversation] } = await db.query(`
      SELECT version, channel, provider, external_conversation_id, owner_type, owner_id, status, archived_at
      FROM conversations WHERE company_id = $1 AND id = $2 FOR UPDATE
    `, [tenantId, conversationId]);
    if (!conversation) throw new ConversationSendError('NOT_FOUND', 'CONVERSATION_NOT_FOUND', 'Conversation not found.');
    if (conversation.version !== expectedVersion) {
      throw new ConversationSendError('CONFLICT', 'CONVERSATION_VERSION_CHANGED', 'Conversation version changed.',
        { currentVersion: conversation.version, expectedVersion });
    }
    if (conversation.owner_type !== 'human' || conversation.owner_id !== String(actorId)) {
      throw new ConversationSendError('POLICY_DENIED', 'HUMAN_TAKEOVER_REQUIRED', 'Take ownership of this conversation with the same session before sending.');
    }
    if (conversation.archived_at || conversation.status !== 'open') {
      throw new ConversationSendError('CONFLICT', 'CONVERSATION_CLOSED', 'The conversation is not open.');
    }
    const recipient = conversation.external_conversation_id as string;
    if (!this.enabled || conversation.channel !== 'whatsapp' || conversation.provider !== 'meta-cloud' ||
        !/^[1-9][0-9]{6,14}$/.test(recipient)) {
      throw new ConversationSendError('CONFLICT', 'CONVERSATION_CHANNEL_UNSUPPORTED', 'This send requires a configured WhatsApp Cloud conversation with a verified phone identity.');
    }

    const unresolved = await db.query(`
      SELECT 1 FROM conversation_send_claims
      WHERE tenant_id = $1 AND conversation_id = $2 AND state = 'unknown_delivery'
    `, [tenantId, conversationId]);
    if (unresolved.rows.length) {
      throw new ConversationSendError('CONFLICT', 'DELIVERY_UNRESOLVED', 'A previous send has unknown delivery. Reconcile it before sending again.');
    }

    const { rows: evidence } = await db.query(`
      SELECT e.phone_number_id, MAX(m.occurred_at) + interval '24 hours' AS window_expires_at
      FROM messages m
      LEFT JOIN whatsapp_webhook_events e
        ON m.channel = 'whatsapp' AND m.provider = 'meta-cloud' AND m.external_contact_id = $3
        AND e.company_id = m.company_id AND e.provider = 'meta-cloud'
        AND e.event_dedupe_key = 'message:' || m.provider_message_id
        AND e.provider_message_id = m.provider_message_id AND e.processing_status = 'processed'
        AND e.event_type LIKE 'message.%' AND e.phone_number_id ~ '^[0-9]+$'
        AND e.payload_json #>> '{metadata,phone_number_id}' = e.phone_number_id
        AND e.payload_json #>> '{message,from}' = $3
        AND m.occurred_at <= clock_timestamp()
        AND m.occurred_at = CASE WHEN e.payload_json #>> '{message,timestamp}' ~ '^[0-9]{1,11}$'
          THEN to_timestamp((e.payload_json #>> '{message,timestamp}')::double precision) END
      WHERE m.company_id = $1 AND m.conversation_id = $2 AND m.direction = 'inbound'
      GROUP BY e.phone_number_id LIMIT 2
    `, [tenantId, conversationId, recipient]);
    if (!evidence.length) throw this.windowClosed();
    if (evidence.length !== 1 || !evidence[0].phone_number_id) {
      throw new ConversationSendError('CONFLICT', 'SENDING_ACCOUNT_UNVERIFIED', 'Stored inbound events do not identify one verified sending account for this conversation.');
    }
    const { phone_number_id: phoneId, window_expires_at: expiresAt } = evidence[0] as {
      phone_number_id: string; window_expires_at: Date;
    };

    const { rows: [account] } = await db.query(`
      SELECT a.phone_number_id, a.graph_version, a.access_token_encrypted, c.id AS connection_id
      FROM whatsapp_business_accounts a JOIN channel_connections c
        ON c.tenant_id = a.company_id AND c.account_id = a.phone_number_id AND c.channel = 'whatsapp-cloud'
      WHERE a.company_id = $1 AND a.phone_number_id = $2 AND a.provider = 'meta-cloud'
        AND a.status IN ('connected', 'configured') AND c.status = 'active' AND a.access_token_encrypted IS NOT NULL
      FOR SHARE OF a, c
    `, [tenantId, phoneId]);
    const { rows: [window] } = await db.query('SELECT $1::timestamptz > clock_timestamp() AS open', [expiresAt]);
    if (!window.open) throw this.windowClosed();
    let clientConfig;
    try { clientConfig = this.accounts.toClientConfig(account ?? null, false); } catch { /* unavailable */ }
    if (!clientConfig?.accessToken || !/^v\d+\.\d+$/.test(clientConfig.graphVersion)) {
      throw new ConversationSendError('CONFLICT', 'SENDING_ACCOUNT_UNAVAILABLE', 'The verified WhatsApp account is unavailable or has no usable tenant credential.');
    }

    return {
      recipient, phoneId, connectionId: account.connection_id, windowExpiresAt: expiresAt,
      accountProof: JSON.stringify([recipient, phoneId, account.connection_id, clientConfig.graphVersion, account.access_token_encrypted]),
      client: new MetaCloudClient(clientConfig, this.fetchGraph),
    };
  }

  private async reserve(
    db: Queryable, command: SendIdentity, hash: string, body: string,
    attachment?: UploadedAttachment, expectedAccountProof?: string,
  ): Promise<ReservedSend> {
    const { tenantId, conversationId, actorId, expectedVersion, key } = command;
    const authority = await this.authorize(db, command);
    if (expectedAccountProof !== undefined && authority.accountProof !== expectedAccountProof) {
      throw new ConversationSendError('CONFLICT', 'SENDING_ACCOUNT_CHANGED', 'The verified sending account changed during upload.');
    }
    const { rows: [message] } = await db.query(`
      INSERT INTO messages (company_id, conversation_id, direction, channel, provider, client_request_id,
        external_contact_id, body, message_type, status, metadata_json)
      VALUES ($1, $2, 'outbound', 'whatsapp', 'meta-cloud', $3, $4, $5, $7, 'unknown_delivery',
        jsonb_build_object('actorId', $6::integer))
      ON CONFLICT (company_id, client_request_id) DO NOTHING RETURNING id
    `, [tenantId, conversationId, key, authority.recipient, body, actorId, attachment?.kind ?? 'text']);
    if (!message) throw new ConversationSendError('CONFLICT', 'IDEMPOTENCY_KEY_CONFLICT', 'This key is already in use.');
    if (attachment) {
      await db.query(`
        INSERT INTO message_attachments (message_id, provider, provider_media_id, filename, mime_type, size_bytes, caption, storage_status)
        VALUES ($1, 'meta-cloud', $2, $3, $4, $5, $6, 'remote')
      `, [message.id, attachment.id, attachment.filename, attachment.mimetype, attachment.size, body || null]);
    }
    const callbackRef = randomUUID();
    await db.query(`
      INSERT INTO conversation_send_claims
        (tenant_id, request_key, conversation_id, actor_id, expected_version, payload_hash, connection_id, phone_number_id, recipient_id, message_id, callback_ref)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
    `, [tenantId, key, conversationId, actorId, expectedVersion, hash, authority.connectionId, authority.phoneId, authority.recipient, message.id, callbackRef]);
    await db.query('UPDATE conversations SET version = version + 1, updated_at = clock_timestamp() WHERE company_id = $1 AND id = $2',
      [tenantId, conversationId]);
    return { ...authority, messageId: message.id, callbackRef };
  }

  private windowClosed() {
    return new ConversationSendError('CONFLICT', 'SERVICE_WINDOW_CLOSED', 'The verified WhatsApp customer service window is closed.');
  }

  private async complete(
    command: SendIdentity, reserved: ReservedSend, hash: string, receipt: string | null, rejection: string | null,
  ): Promise<SendMessageResultV1> {
    const { tenantId, key } = command;
    try {
      return await this.uow.run(tenantId, async (db) => {
        if (receipt) await lockMetaReceipt(db, tenantId, receipt);
        const result = await db.query(`
          UPDATE conversation_send_claims SET state = $3, provider_message_id = $4, resolved_at = clock_timestamp()
          WHERE tenant_id = $1 AND request_key = $2 AND state = 'unknown_delivery' AND message_id = $5
          RETURNING message_id
        `, [tenantId, key, receipt ? 'provider_accepted' : 'failed', receipt, reserved.messageId]);
        if (!result.rows.length) {
          const claim = await getClaim(db, tenantId, key);
          return claim ? replay(claim, command, hash) : unknownDelivery;
        }

        await db.query(`
          UPDATE messages SET provider_message_id = $3::varchar, status = $4::varchar, error_code = $5,
            raw_payload_json = CASE WHEN $3::varchar IS NOT NULL THEN jsonb_build_object('providerMessageId', $3::varchar) END,
            failed_at = CASE WHEN $4::varchar = 'failed' THEN clock_timestamp() END
          WHERE company_id = $1 AND id = $2
        `, [tenantId, reserved.messageId, receipt, receipt ? 'accepted' : 'failed', rejection]);
        await db.query(`
          INSERT INTO message_statuses (message_id, status, source, occurred_at, metadata_json, provider, provider_message_id)
          VALUES ($1, $2, $3, clock_timestamp(), jsonb_build_object('reasonCode', $4::text), 'meta-cloud', $5)
          ON CONFLICT DO NOTHING
        `, [reserved.messageId, receipt ? 'accepted' : 'failed', receipt ? 'meta-cloud' : 'canonical-send', rejection, receipt]);

        if (receipt) {
          await applyCanonicalMetaStatuses(db, tenantId, receipt);
          await refreshConversationPreview(db, tenantId, reserved.messageId);
        }
        const claim = await getClaim(db, tenantId, key);
        return claim ? replay(claim, command, hash) : unknownDelivery;
      });
    } catch (error) {
      // A receipt that could not be persisted cannot authorize a second provider POST.
      const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined;
      console.warn('Canonical WhatsApp send outcome could not be persisted', { code });
      return unknownDelivery;
    }
  }
}

export const conversationSendService = new ConversationSendService();
