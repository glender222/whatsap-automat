# Automatic Meta reply admission and recovery

The internal `ConversationSendService.sendAgentText` and `sendAgentAttachment`
methods share `conversation_send_claims` and the existing signed Meta receipt
reconciliation with operator sends. Apply migration `059_agent_conversation_send_claims`
before deploying these service/query changes. Migration 059 is independent of 058.
No new public route or runtime composition is introduced by this change.

## Internal contract

Both methods take `tenantId`, `conversationId`, the numeric canonical
`messages.id` as `inboundMessageId`, `phoneNumberId`, and an effect:

- `reply` is the final reply for an inbound turn, whether text or media. A text
  fallback must keep this effect; changing content after admission produces
  `IDEMPOTENCY_KEY_CONFLICT` and cannot authorize another send.
- `card:<productId>` identifies a separately intended product-card action; product
  IDs use 1–80 ASCII letters, digits, underscores or hyphens.

Text adds `text`. Attachment adds `file` (`path`, `mimetype`, `originalname`),
`caption`, and `forceDocument`, reusing the canonical upload validation.
Optional `authority` implements `isCurrent(db?: Queryable): Promise<boolean>` and
may expose `signal: AbortSignal`. The durable inbound worker should always pass
its authority; the optional form supports other explicitly admitted internal
callers. The claim checks authority with the same transaction, allowing the worker
to hold its outbox lease row with `FOR SHARE`; upload and pre-POST checks also
reject expired/cancelled work.

The return value adds `messageId: number | null` and `clientRequestId: string` to
`SendMessageResultV1`. The internal ID can be null if a replay cannot read storage.
Callers must inspect `accepted` and `deliveryState`: `unknown_delivery` is not a
successful send and must never trigger a new key or fallback POST.

## Admission and identity

The service derives its key from tenant, conversation, inbound message and effect.
It does not accept a human actor, recipient, client key or caller-provided version.
Under the conversation lock it requires an open Meta conversation, AI ownership,
no effective AI pause, the exact persisted inbound with matching processed webhook
identity and timestamp, its unexpired 24-hour window, and an active line with its
own encrypted tenant credential. The recipient comes from that verified inbound
and matching conversation. A recent different inbound cannot extend this cause's
window. Multiple lines cannot redirect the selected inbound's reply.

Media is uploaded before admission; afterward the service rechecks ownership,
pause, window, lease and exact account credential before reserving. No database
transaction or lock is held across network requests. Committing the durable claim
is the admission point: a send already admitted may finish while a human takes
over. A worker authority that expires before POST closes that admitted claim as
failed without sending. The Graph transport has its existing 20-second timeout,
including response body consumption. Cancellation does not recall an admitted
external effect.

Claims persist `actor_type = ai_agent`, `actor_id = NULL`, the inbound cause,
effect and conversation agent identity (`default` when unassigned). Message
metadata records the same cause. Canonical history reports `causedBy.type = agent`;
operator sends retain their existing actor, version, payload and response contract.
A restrictive RLS policy additionally binds an AI cause to an inbound message of
the same tenant and conversation.

## Lost acknowledgements and real-time recovery

The claim and unknown outbound message commit before the sole `/messages` POST.
Concurrent calls and new processes replay the stored outcome. They cannot resume
a reserved external request. An unresolved claim also blocks new conversation
sends, including distinct effects, until receipt reconciliation resolves it.

The existing opaque callback, provider ID lock, tenant, phone, recipient and timing
checks reconcile signed receipts. `MetaInboxStore` emits the existing
`conversation.delivery_changed` invalidation to the tenant's conversation after a
matching status advances. Callers can use the returned internal message ID and
request key to invalidate/refetch immediately; this service does not emit a new
Socket.IO event itself.

## Regression evidence

`src/test/conversation-send-postgres.test.ts` exercises PostgreSQL with a
`NOSUPERUSER NOBYPASSRLS` role, the real signed webhook route and a local Graph HTTP
server. It is already included in the PostgreSQL CI gate.

Covered cases include operator compatibility; concurrent and fresh-process replay
after lost HTTP acknowledgement; text and media receipt recovery; foreign company,
line, recipient and callback rejection; canonical AI authorship; two companies'
credentials; exact inbound routing with multiple lines; forged/expired cause;
closed/paused/human-owned conversations; expired worker before and after claim;
and pause, takeover, lease expiry or token rotation during upload. The admission
test allows a takeover to complete while Graph is in flight, proving that no
conversation lock is held across the network request.

Run against an isolated, migrated fixture database:

```sh
npm run typecheck
npm run build
CONVERSATION_SEND_TEST_DATABASE_URL="$FIXTURE_DATABASE_URL" \
  node --import tsx --test src/test/conversation-send-postgres.test.ts
```

These tests use synthetic local credentials and recipients. They do not send a
live WhatsApp message or claim that the runtime has been wired to these methods.
