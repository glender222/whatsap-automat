-- The opaque provider reference is assigned before making a Graph request.
-- Earlier unresolved sends have no reference and cannot be linked retroactively.
ALTER TABLE conversation_send_claims ADD COLUMN IF NOT EXISTS callback_ref uuid;

CREATE UNIQUE INDEX IF NOT EXISTS uq_conversation_send_callback_ref
ON conversation_send_claims (tenant_id, callback_ref)
WHERE callback_ref IS NOT NULL;
