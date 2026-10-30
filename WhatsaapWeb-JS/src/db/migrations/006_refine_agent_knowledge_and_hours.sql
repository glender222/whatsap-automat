-- Knowledge is business content. Operational schedules belong to agent rules.

UPDATE agent_knowledge_sources
SET source_type = 'policy'
WHERE source_type = 'schedule';

ALTER TABLE agent_knowledge_sources
DROP CONSTRAINT IF EXISTS chk_agent_knowledge_type;

ALTER TABLE agent_knowledge_sources
ADD CONSTRAINT chk_agent_knowledge_type CHECK (
  source_type IN ('faq', 'product', 'pricing', 'policy', 'document', 'url', 'catalog')
);
