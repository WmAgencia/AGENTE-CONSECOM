-- Migration v24: AI/operator follow-ups.
-- Execute in the Supabase SQL Editor.

ALTER TABLE public.leads
  DROP CONSTRAINT IF EXISTS leads_status_check;

ALTER TABLE public.leads
  ADD CONSTRAINT leads_status_check CHECK (
    status IN (
      'novo','na_fila','enviado','conversando','sem_interesse',
      'remarketing','reuniao_marcada','reuniao_cancelada','fechado',
      'nao_fechado','para_ligacao','responder_depois'
    )
  );

CREATE TABLE IF NOT EXISTS public.follow_ups (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id           UUID NOT NULL REFERENCES public.leads(id) ON DELETE CASCADE,
  owner_user_id     UUID,
  scheduled_date    DATE NOT NULL,
  scheduled_time    TIME,
  message           TEXT NOT NULL,
  status            TEXT NOT NULL DEFAULT 'agendado'
                    CHECK (status IN ('agendado','processando','enviado','falhou','cancelado')),
  source            TEXT NOT NULL DEFAULT 'operador'
                    CHECK (source IN ('ia','operador')),
  connection_id     UUID,
  connection_instance TEXT,
  conversation_id   TEXT,
  origin_context    TEXT,
  failure_reason    TEXT,
  idempotency_key   TEXT NOT NULL UNIQUE,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  sent_at           TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS follow_ups_due_idx
  ON public.follow_ups (status, scheduled_date, scheduled_time);
CREATE INDEX IF NOT EXISTS follow_ups_lead_idx
  ON public.follow_ups (lead_id, created_at DESC);
CREATE INDEX IF NOT EXISTS follow_ups_owner_idx
  ON public.follow_ups (owner_user_id, status, scheduled_date);

ALTER TABLE public.follow_ups ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS follow_ups_auth_read ON public.follow_ups;
DROP POLICY IF EXISTS follow_ups_auth_write ON public.follow_ups;
CREATE POLICY follow_ups_auth_read ON public.follow_ups
  FOR SELECT TO authenticated USING (true);
CREATE POLICY follow_ups_auth_write ON public.follow_ups
  FOR ALL TO authenticated USING (true) WITH CHECK (true);

NOTIFY pgrst, 'reload schema';
