-- =============================================================
-- VYNTRA — Migration v11 (RLS: remoção de mensagens e desenfileirar)
-- Projeto Supabase: nzexythhastovjwuedsh
-- Execute no: Dashboard -> SQL Editor -> New query -> Run
-- Idempotente: pode ser rodado múltiplas vezes.
-- =============================================================

-- Contexto: a migration v5 trocou a política de DELETE da tabela
-- queue_messages (qm_auth_delete) por uma restrita ao service_role
-- (qm_service_delete). O painel (frontend autenticado) usa a chave anônima
-- com sessão autenticada — logo o "✕" de remover mensagem da sequência
-- falhava silenciosamente (RLS bloqueia o DELETE).
--
-- Aqui nós:
--   1) Re-criamos o DELETE para autenticados em queue_messages (o painel
--      edita a sequência da campanha diretamente via PostgREST autenticado).
--   2) Criamos o DELETE para autenticados em send_runs (botão
--      "Desenfileirar" da fila de envio — nunca teve política de DELETE).
--
-- A exclusão de LEADS continua restrita a authenticated + service_role
-- (casos sensíveis permanecem por RPC/service_role). Nada além disso muda.

-- 1) queue_messages: autenticados podem DELETAR (remover etapa da sequência).
DROP POLICY IF EXISTS qm_service_delete ON public.queue_messages;
DROP POLICY IF EXISTS qm_auth_delete     ON public.queue_messages;
CREATE POLICY qm_auth_delete
  ON public.queue_messages
  FOR DELETE USING (auth.role() = 'authenticated');

-- 2) send_runs: autenticados podem DELETAR (desenfileirar um lead).
DROP POLICY IF EXISTS sendruns_auth_delete ON public.send_runs;
CREATE POLICY sendruns_auth_delete
  ON public.send_runs
  FOR DELETE USING (auth.role() = 'authenticated');

-- 3) Notificação do PostgREST (garante políticas novas valendo imediatamente)
NOTIFY pgrst, 'reload schema';

-- =============================================================
-- CONFIRMAÇÃO (rode após):
--   SELECT policyname, cmd FROM pg_policies
--   WHERE tablename IN ('queue_messages','send_runs');
--   -- esperado: queue_messages com qm_auth_delete (DELETE) e
--   --           send_runs     com sendruns_auth_delete (DELETE)
-- =============================================================