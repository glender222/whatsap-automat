ALTER TABLE campaign_deliveries
  ADD COLUMN meta_connection_id text,
  ADD COLUMN meta_phone_number_id text,
  ADD CONSTRAINT chk_campaign_meta_receipt_provenance CHECK (
    (meta_connection_id IS NULL AND meta_phone_number_id IS NULL) OR
    (meta_connection_id IS NOT NULL AND meta_phone_number_id IS NOT NULL AND meta_phone_number_id ~ '^[0-9]+$')
  );

CREATE UNIQUE INDEX uq_campaign_meta_provider_message
  ON campaign_deliveries (tenant_id, provider_message_id)
  WHERE meta_phone_number_id IS NOT NULL AND provider_message_id IS NOT NULL;
