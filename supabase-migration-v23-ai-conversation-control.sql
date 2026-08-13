-- Migration v23: per-lead AI ownership for human takeover.
-- Execute in the Supabase SQL Editor.

ALTER TABLE public.leads
  ADD COLUMN IF NOT EXISTS ai_control TEXT NOT NULL DEFAULT 'ai';

ALTER TABLE public.leads
  DROP CONSTRAINT IF EXISTS leads_ai_control_check;

ALTER TABLE public.leads
  ADD CONSTRAINT leads_ai_control_check
  CHECK (ai_control IN ('ai', 'human'));

DELETE FROM public.agent_settings
WHERE key = 'agent_name';

CREATE INDEX IF NOT EXISTS leads_ai_control_idx
  ON public.leads (ai_control);

NOTIFY pgrst, 'reload schema';
