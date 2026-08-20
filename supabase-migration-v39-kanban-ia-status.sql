-- =============================================================
-- VYNTRA — Migration v39 (Kanban IA + Necessita de Humano)
-- Projeto Supabase: nzexythhastovjwuedsh
-- Execute no: Dashboard -> SQL Editor -> New query -> Run
-- Idempotente: pode ser rodado múltiplas vezes.
--
-- CORREÇÃO: o CHECK de leads.status (última versão na v24) não inclui
-- 'ia' nem 'necessita_humano'. Resultado: o webhook da IA tenta mover o
-- lead para a coluna IA / Necessita de Humano, o UPDATE é REJEITADO com
-- 23514 (constraint violation) e o erro é engolido silenciosamente
-- (updateLeadStatus não checa res.ok) — o lead NUNCA sai de "Enviados".
-- Esta migration adiciona os dois status ao CHECK.
-- =============================================================
ALTER TABLE public.leads DROP CONSTRAINT IF EXISTS leads_status;
ALTER TABLE public.leads DROP CONSTRAINT IF EXISTS leads_status_check;
ALTER TABLE public.leads ADD CONSTRAINT leads_status_check CHECK (
  status IN (
    'novo','na_fila','enviado','conversando','sem_interesse',
    'remarketing','reuniao_marcada','reuniao_cancelada','fechado','nao_fechado',
    'para_ligacao','responder_depois','ia','necessita_humano'
  )
);