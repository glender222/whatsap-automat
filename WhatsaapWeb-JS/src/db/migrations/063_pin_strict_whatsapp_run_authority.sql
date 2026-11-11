-- Pin the pause and ownership observed before a run, including across worker restarts.
-- Rows created before this migration have no verified ownership epoch.
ALTER TABLE strict_whatsapp_runs
  ADD COLUMN IF NOT EXISTS ownership_epoch integer CHECK (ownership_epoch >= 0),
  ADD COLUMN IF NOT EXISTS ia_paused_at timestamptz;
