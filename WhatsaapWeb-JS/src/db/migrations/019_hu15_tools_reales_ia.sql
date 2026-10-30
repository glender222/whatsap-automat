-- HU15 - Tools reales IA: tags de sistema + indices de auditoria de tools.
-- Aditivo y retrocompatible. No toca migraciones aplicadas.

-- Etiquetas de sistema: la IA puede aplicar solo etiquetas predefinidas con is_system=true.
-- El backend las crea por compañia si no existen (colores tokens del diseno).
ALTER TABLE tags
  ADD COLUMN IF NOT EXISTS is_system BOOLEAN NOT NULL DEFAULT FALSE;

CREATE INDEX IF NOT EXISTS idx_tags_company_system
ON tags(company_id, is_system)
WHERE is_system = TRUE;

-- Indice complementario para filtros de logs por tool_result_status (spec §12, §17).
CREATE INDEX IF NOT EXISTS idx_agent_runtime_logs_result_status
ON agent_runtime_logs(company_id, tool_result_status, created_at DESC)
WHERE tool_result_status IS NOT NULL;
