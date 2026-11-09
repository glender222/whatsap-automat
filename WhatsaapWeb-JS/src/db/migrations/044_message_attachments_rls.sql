-- An attachment belongs to the tenant of its parent message.
ALTER TABLE message_attachments ENABLE ROW LEVEL SECURITY;
ALTER TABLE message_attachments FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation_policy ON message_attachments;
CREATE POLICY tenant_isolation_policy ON message_attachments
  USING (EXISTS (
    SELECT 1 FROM messages m
    WHERE m.id = message_attachments.message_id
      AND m.company_id = NULLIF(current_setting('app.current_tenant_id', true), '')::integer
  ))
  WITH CHECK (EXISTS (
    SELECT 1 FROM messages m
    WHERE m.id = message_attachments.message_id
      AND m.company_id = NULLIF(current_setting('app.current_tenant_id', true), '')::integer
  ));
