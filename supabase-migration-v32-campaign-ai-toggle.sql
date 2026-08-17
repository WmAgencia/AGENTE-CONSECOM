-- Configuração de IA por campanha, sem alterar fila, leads ou status.
ALTER TABLE public.campaigns
  ADD COLUMN IF NOT EXISTS ai_enabled BOOLEAN NOT NULL DEFAULT false;
