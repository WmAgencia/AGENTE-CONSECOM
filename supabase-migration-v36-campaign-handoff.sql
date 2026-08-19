-- Fase 7: responsável pelo fechamento/handoff da campanha.
ALTER TABLE public.campaigns ADD COLUMN IF NOT EXISTS ai_handoff JSONB NOT NULL DEFAULT '{}'::jsonb;

COMMENT ON COLUMN public.campaigns.ai_handoff IS
  'Responsável pelo fechamento: name, phone e instruções de encaminhamento.';
