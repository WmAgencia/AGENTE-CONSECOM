-- =============================================================
-- VYNTRA — Migration v10b (Realtime: identidade completa p/ campanhas)
-- Projeto Supabase: nzexythhastovjwuedsh
-- Execute no: Dashboard -> SQL Editor -> New query -> Run
--
-- Por que: tabelas habilitadas no realtime via `ALTER PUBLICATION ... ADD TABLE`
-- mantêm `REPLICA IDENTITY DEFAULT` (linha antiga contém só a PK). O evento
-- postgres_changes de UPDATE então vem sem `old.status`, fazendo os
-- consumidores que dependem de transição de status (voz de campanha iniciada/
-- finalizada) dispararem a narração em QUALQUER UPDATE da campanha (ex.: o
-- bump de success_count/fail_count a cada mensagem). Com identidade completa,
-- o `old` chega inteiro e as transições são reais.
--
-- A defesa adicional (idempotência por campaignRunId) já está no client
-- (frontend lib/voice.ts, mobile lib/campaignVoice.ts), independentemente
-- desta migration.
-- =============================================================

-- campaigns: tabela pequena + eventos essenciais de transição.
ALTER TABLE public.campaigns REPLICA IDENTITY FULL;

-- send_runs/leads/consecom_conversations NÃO entram aqui por escrito:
-- são tabelas de alto volume de escrita e o full-row identity inflaria o WAL
-- sem ganho (esses fluxos não dependem de `old`).

NOTIFY pgrst, 'reload schema';

-- =============================================================
-- CONFIRMAÇÃO:
--   SELECT relreplident FROM pg_class WHERE relname = 'campaigns';
--   -- 'f' == FULL (default é 'd')
-- =============================================================