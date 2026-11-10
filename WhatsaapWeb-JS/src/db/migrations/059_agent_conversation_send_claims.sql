-- Automatic replies use the same durable claim and signed receipt path as human
-- sends, with an explicit machine actor and immutable inbound cause.
ALTER TABLE conversation_send_claims ALTER COLUMN actor_id DROP NOT NULL;
ALTER TABLE conversation_send_claims
  ADD COLUMN actor_type text NOT NULL DEFAULT 'human',
  ADD COLUMN agent_identity text,
  ADD COLUMN inbound_message_id integer REFERENCES messages(id) ON DELETE RESTRICT,
  ADD COLUMN effect text;

ALTER TABLE conversation_send_claims ADD CONSTRAINT conversation_send_actor_cause CHECK (
  (actor_type = 'human' AND actor_id IS NOT NULL AND agent_identity IS NULL
    AND inbound_message_id IS NULL AND effect IS NULL)
  OR
  (actor_type = 'ai_agent' AND actor_id IS NULL AND agent_identity IS NOT NULL AND length(agent_identity) > 0
    AND inbound_message_id IS NOT NULL AND effect IS NOT NULL
    AND (effect = 'reply' OR effect ~ '^card:[A-Za-z0-9_-]{1,80}$'))
);

CREATE UNIQUE INDEX uq_conversation_agent_send_effect
  ON conversation_send_claims (tenant_id, inbound_message_id, effect)
  WHERE actor_type = 'ai_agent';

-- Existing outbound-message policy remains in force; this additional restrictive
-- policy prevents an AI claim from attaching a different tenant/conversation cause.
CREATE POLICY conversation_send_agent_cause ON conversation_send_claims AS RESTRICTIVE
  FOR ALL USING (true) WITH CHECK (
    actor_type = 'human' OR EXISTS (
      SELECT 1 FROM messages m WHERE m.id = inbound_message_id
        AND m.company_id = conversation_send_claims.tenant_id
        AND m.conversation_id = conversation_send_claims.conversation_id
        AND m.direction = 'inbound' AND m.channel = 'whatsapp' AND m.provider = 'meta-cloud'
    )
  );
