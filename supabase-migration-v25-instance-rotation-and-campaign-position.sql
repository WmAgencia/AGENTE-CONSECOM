-- ===== Migration v25 — Rotação de instâncias + ordenação de campanhas =====
-- Objetivo:
--   1. whatsapp_connections.rotation_of: aponta a conexão ANTIGA que a nova
--      instância (pendente de QR) vai substituir. Usada para a rotação de
--      instâncias a cada campanha e para reconciliar reconexões no meio de
--      uma campanha.
--   2. whatsapp_connections.superseded_by: registra, na conexão antiga, qual
--      conexão nova a substituiu (auditoria; evita re-popup de reconexão).
--   3. campaigns.position: ordem manual das campanhas dentro de cada seção
--      (em andamento / agendadas / finalizadas).
--
-- Idempotente: pode ser aplicado mais de uma vez sem erro.
--
-- Cole no Supabase: Dashboard -> SQL Editor -> New query -> Run.

-- ===== 1) Colunas de rotação em whatsapp_connections =====
ALTER TABLE public.whatsapp_connections
  ADD COLUMN IF NOT EXISTS rotation_of UUID,
  ADD COLUMN IF NOT EXISTS superseded_by UUID;

CREATE INDEX IF NOT EXISTS whatsapp_conn_rotation_idx ON public.whatsapp_connections (rotation_of);
CREATE INDEX IF NOT EXISTS whatsapp_conn_superseded_idx ON public.whatsapp_connections (superseded_by);

-- ===== 2) Ordenação manual das campanhas =====
ALTER TABLE public.campaigns
  ADD COLUMN IF NOT EXISTS position INTEGER DEFAULT 0;

CREATE INDEX IF NOT EXISTS campaigns_position_idx ON public.campaigns (position);

NOTIFY pgrst, 'reload schema';