-- =============================================================
-- VYNTRA — Migration v10 (Roteamento de números p/ ligação + normalização)
-- Projeto Supabase: nzexythhastovjwuedsh
-- Execute no: Dashboard -> SQL Editor -> New query -> Run
-- Idempotente: pode ser rodado múltiplas vezes.
-- =============================================================

-- 1) NOVA ETAPA DO KANBAN: "Números para ligação" (status 'para_ligacao')
--    Estende o CHECK de leads sem quebrar os estados existentes.
ALTER TABLE public.leads DROP CONSTRAINT IF EXISTS leads_status_check;
ALTER TABLE public.leads ADD CONSTRAINT leads_status_check CHECK (
  status IN (
    'novo','na_fila','enviado','conversando','sem_interesse',
    'remarketing','reuniao_marcada','reuniao_cancelada','fechado','nao_fechado',
    'para_ligacao'
  )
);

-- 2) Colunas de apoio para a coluna "Números para ligação":
--    - call_reason:    motivo pelo qual o lead foi encaminhado (ex: número fixo).
--    - call_moved_at:  data/hora da movimentação automática p/ essa etapa.
ALTER TABLE public.leads
  ADD COLUMN IF NOT EXISTS call_reason   TEXT,
  ADD COLUMN IF NOT EXISTS call_moved_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS leads_call_moved_at_idx ON public.leads (status, call_moved_at);

-- 3) Motivo de falha por execução na fila (o painel exibe o motivo ao lado do lead).
ALTER TABLE public.send_runs
  ADD COLUMN IF NOT EXISTS fail_reason TEXT;

-- 4) Realtime: leads/send_runs/lead_status_history já estão na publicação
--    (v7). Novas colunas são propagadas automaticamente; nada a fazer além de
--    garantir a publicação das tabelas envolvidas.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['leads','send_runs','lead_status_history']
  LOOP
    IF EXISTS (SELECT 1 FROM pg_tables WHERE schemaname = 'public' AND tablename = t)
       AND NOT EXISTS (SELECT 1 FROM pg_publication_tables
                       WHERE pubname = 'supabase_realtime'
                         AND schemaname = 'public' AND tablename = t) THEN
      EXECUTE format('ALTER PUBLICATION supabase_realtime ADD TABLE public.%I', t);
    END IF;
  END LOOP;
END $$;

-- 5) Atualiza schema cache PostgREST (garante que o REST enxergue as colunas novas)
NOTIFY pgrst, 'reload schema';

-- =============================================================
-- CONFIRMAÇÃO (rode após):
--   SELECT column_name FROM information_schema.columns
--   WHERE table_schema='public' AND table_name='leads'
--     AND column_name IN ('call_reason','call_moved_at');
--   SELECT column_name FROM information_schema.columns
--   WHERE table_schema='public' AND table_name='send_runs'
--     AND column_name = 'fail_reason';
-- =============================================================