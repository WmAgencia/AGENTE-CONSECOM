-- =============================================================
-- Consecom — Migração v4 (Conexões: WhatsApp + Notificações)
-- Cole no Supabase: Dashboard -> SQL Editor -> New query
-- Idempotente.
-- =============================================================

-- 1) Conexões WhatsApp (Evolution API) — uma por usuário/workspace
-- workspace_id e user_id são TEXT para aceitar UUIDs do Supabase Auth OU
-- slugs custom (ex: "user-wesley", "wm-agencia-main"). Sem FK para auth.users.
CREATE TABLE IF NOT EXISTS public.whatsapp_connections (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id               TEXT,
  workspace_id          TEXT,
  instance_name         TEXT NOT NULL,
  phone_number          TEXT,
  whatsapp_name         TEXT,
  status                TEXT NOT NULL DEFAULT 'pending'
                          CHECK (status IN ('pending','connecting','connected','disconnected','error')),
  evolution_instance_id TEXT,
  qr_code               TEXT,
  last_sync_at          TIMESTAMPTZ,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE public.whatsapp_connections ENABLE ROW LEVEL SECURITY;
CREATE POLICY whatsapp_connections_auth_all ON public.whatsapp_connections
  FOR ALL USING (auth.role() = 'authenticated');
CREATE INDEX IF NOT EXISTS whatsapp_conn_workspace_idx ON public.whatsapp_connections (workspace_id);
CREATE INDEX IF NOT EXISTS whatsapp_conn_user_idx ON public.whatsapp_connections (user_id);

-- 2) Grupos de notificação (selecionados pelo usuário)
CREATE TABLE IF NOT EXISTS public.notification_groups (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id  TEXT,
  user_id       TEXT,
  group_id      TEXT NOT NULL,
  group_name    TEXT NOT NULL,
  enabled       BOOLEAN NOT NULL DEFAULT true,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE public.notification_groups ENABLE ROW LEVEL SECURITY;
CREATE POLICY notification_groups_auth_all ON public.notification_groups
  FOR ALL USING (auth.role() = 'authenticated');
CREATE INDEX IF NOT EXISTS notif_groups_user_idx ON public.notification_groups (user_id);

-- 3) Preferências de notificação (chave-valor por workspace)
CREATE TABLE IF NOT EXISTS public.notification_settings (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id  TEXT,
  user_id       TEXT,
  key           TEXT NOT NULL,
  value         JSONB NOT NULL DEFAULT 'true',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, key)
);
ALTER TABLE public.notification_settings ENABLE ROW LEVEL SECURITY;
CREATE POLICY notification_settings_auth_all ON public.notification_settings
  FOR ALL USING (auth.role() = 'authenticated');

-- 4) Trigger para updated_at automático
CREATE OR REPLACE FUNCTION public.set_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS whatsapp_connections_updated ON public.whatsapp_connections;
CREATE TRIGGER whatsapp_connections_updated BEFORE UPDATE ON public.whatsapp_connections
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

DROP TRIGGER IF EXISTS notification_groups_updated ON public.notification_groups;
CREATE TRIGGER notification_groups_updated BEFORE UPDATE ON public.notification_groups
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

DROP TRIGGER IF EXISTS notification_settings_updated ON public.notification_settings;
CREATE TRIGGER notification_settings_updated BEFORE UPDATE ON public.notification_settings
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
