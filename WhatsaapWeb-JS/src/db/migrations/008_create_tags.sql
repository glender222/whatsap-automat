-- Multi-company tags for inbox segmentation and employee permissions.

CREATE TABLE IF NOT EXISTS tags (
  id BIGSERIAL PRIMARY KEY,
  company_id INT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  name VARCHAR(80) NOT NULL,
  color VARCHAR(80),
  is_default BOOLEAN NOT NULL DEFAULT FALSE,
  created_by BIGINT REFERENCES usuarios(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_tags_company_name_lower
ON tags(company_id, LOWER(name));

CREATE UNIQUE INDEX IF NOT EXISTS uq_tags_company_default
ON tags(company_id)
WHERE is_default = TRUE;

INSERT INTO tags (company_id, name, color, is_default)
SELECT c.id, 'Todo', 'text-green-500', TRUE
FROM companies c
WHERE NOT EXISTS (
  SELECT 1 FROM tags t WHERE t.company_id = c.id AND t.is_default = TRUE
);

CREATE TABLE IF NOT EXISTS tag_chats (
  id BIGSERIAL PRIMARY KEY,
  company_id INT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  tag_id BIGINT NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
  conversation_id INT REFERENCES conversations(id) ON DELETE CASCADE,
  chat_id VARCHAR(255) NOT NULL,
  created_by BIGINT REFERENCES usuarios(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_tag_chats_tag_chat UNIQUE (tag_id, chat_id)
);

CREATE INDEX IF NOT EXISTS idx_tag_chats_company_chat
ON tag_chats(company_id, chat_id);

CREATE INDEX IF NOT EXISTS idx_tag_chats_conversation
ON tag_chats(conversation_id)
WHERE conversation_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS tag_users (
  id BIGSERIAL PRIMARY KEY,
  company_id INT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  tag_id BIGINT NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
  user_id BIGINT NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
  created_by BIGINT REFERENCES usuarios(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_tag_users_tag_user UNIQUE (tag_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_tag_users_company_user
ON tag_users(company_id, user_id);
