-- Fase 6: persona comercial configurável por campanha.
ALTER TABLE public.campaigns ADD COLUMN IF NOT EXISTS ai_persona JSONB NOT NULL DEFAULT '{}'::jsonb;

COMMENT ON COLUMN public.campaigns.ai_persona IS
  'Persona controlada da IA: tone, formality, verbosity, emojis e style.';
