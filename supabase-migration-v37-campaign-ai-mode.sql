-- Fase 8: modo de disparo da campanha.
ALTER TABLE public.campaigns ADD COLUMN IF NOT EXISTS ai_mode TEXT NOT NULL DEFAULT 'traditional';
ALTER TABLE public.campaigns ADD COLUMN IF NOT EXISTS ai_initial_message TEXT;
ALTER TABLE public.campaigns DROP CONSTRAINT IF EXISTS campaigns_ai_mode_check;
ALTER TABLE public.campaigns ADD CONSTRAINT campaigns_ai_mode_check CHECK (ai_mode IN ('traditional', 'intelligent'));
