-- ===== Migration v20 — Status waiting_connection (pool de conexões resiliente) =====
-- Objetivo: quando TODAS as conexões WhatsApp de uma campanha caem, o worker
-- agora sinaliza o estado `waiting_connection` em vez de simplesmente esperar
-- em silêncio (ou pior, marcar a campanha como failed). A UI exibe um banner
-- "aguardando conexão" e o worker retoma sozinho para `em_progresso` quando
-- pelo menos uma conexão voltar.
--
-- Alterações:
--   1. campaigns_status_check -> passa a aceitar 'waiting_connection'
--
-- Idempotente: pode ser aplicado mais de uma vez sem erro.
--
-- Cole no Supabase: Dashboard -> SQL Editor -> New query -> Run.

-- ===== 1) CHECK de status com 'waiting_connection' =====
ALTER TABLE public.campaigns DROP CONSTRAINT IF EXISTS campaigns_status_check;

-- Sanidade: nenhum valor legado usa o novo status; apenas reaplica a restrição.
ALTER TABLE public.campaigns
  ADD CONSTRAINT campaigns_status_check
  CHECK (status IN ('pronta','em_progresso','pausada','finalizada','cancelada','agendada','waiting_connection'));

NOTIFY pgrst, 'reload schema';
