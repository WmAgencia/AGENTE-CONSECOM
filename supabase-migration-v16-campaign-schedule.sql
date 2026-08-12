-- ===== Migration v16 — Agendamento de campanhas =====
-- Objetivo: permitir agendar o início de uma campanha (status 'agendada' +
-- coluna scheduled_at) e corrigir um bug latente: o CHECK de status atual
-- ('pronta','em_progresso','finalizada','cancelada') REJEITA 'pausada' — ou
-- seja, o botão Pausar da UI nunca funcionou de verdade no banco de produção.
--
-- Alterações:
--   1. campaigns.scheduled_at  -> TIMESTAMPTZ (início agendado da campanha)
--   2. campaigns_status_check  -> passa a aceitar 'pausada' e 'agendada'
--   3. Índice por scheduled_at  -> lookup rápido do scheduler
--
-- Idempotente: pode ser aplicado mais de uma vez sem erro.
--
-- Cole no Supabase: Dashboard -> SQL Editor -> New query -> Run.

-- ===== 1) Coluna scheduled_at =====
ALTER TABLE public.campaigns ADD COLUMN IF NOT EXISTS scheduled_at TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS campaigns_scheduled_at_idx ON public.campaigns (scheduled_at);

-- ===== 2) CHECK de status com 'pausada' + 'agendada' =====
ALTER TABLE public.campaigns DROP CONSTRAINT IF EXISTS campaigns_status_check;

-- Sanidade: qualquer valor fora do conjunto esperado cai para 'cancelada'
-- antes de reaplicar a restrição (evita falha do ADD CONSTRAINT).
UPDATE public.campaigns
SET status = 'cancelada'
WHERE status IS NULL
   OR status NOT IN ('pronta','em_progresso','pausada','finalizada','cancelada','agendada');

ALTER TABLE public.campaigns
  ADD CONSTRAINT campaigns_status_check
  CHECK (status IN ('pronta','em_progresso','pausada','finalizada','cancelada','agendada'));

-- ===== 3) Realtime (dashboard reage a mudanças de agendamento) =====
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_publication_tables
                 WHERE pubname = 'supabase_realtime'
                   AND schemaname = 'public'
                   AND tablename = 'campaigns') THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.campaigns;
  END IF;
END $$;

NOTIFY pgrst, 'reload schema';
