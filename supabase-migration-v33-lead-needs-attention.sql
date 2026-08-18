-- Lead respondeu com IA desativada: o operador precisa saber (badge no Kanban).
ALTER TABLE public.leads ADD COLUMN IF NOT EXISTS needs_attention BOOLEAN NOT NULL DEFAULT false;
CREATE INDEX IF NOT EXISTS leads_needs_attention_idx ON public.leads(needs_attention) WHERE needs_attention = true;