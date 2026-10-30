-- Sprint 5 HU16/HU17: indexes for bounded reports and inbound heatmap queries.

CREATE INDEX IF NOT EXISTS idx_messages_company_direction_occurred
ON messages(company_id, direction, occurred_at DESC, conversation_id);

CREATE INDEX IF NOT EXISTS idx_customer_orders_company_status_occurred
ON customer_orders(company_id, status, occurred_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS idx_tag_chats_company_tag_conversation
ON tag_chats(company_id, tag_id, conversation_id)
WHERE conversation_id IS NOT NULL;
