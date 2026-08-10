-- ===== Migration v14 — Memória Comercial da IA =====
-- Objetivo: armazenar conversas reais importadas (ZIP/TXT/CSV) e transformá-las
-- em aprendizados comerciais estruturados que orientam a IA configurada, sem
-- alterar a personalidade nem enviar o histórico bruto no prompt.
--
-- Tabelas:
--   ai_memory_imports       -> lote de importação (status do processamento)
--   ai_memory_conversations -> conversa importada (transcript + metadados)
--   ai_memory_learnings     -> aprendizado extraído (categoria/conteúdo/provas)
--
-- Isolamento: user_id/workspace_id em TEXT (padrão do projeto). RLS restrita
-- a `authenticated` com user_id = auth.uid()::text (mesmo padrão de
-- lead_contacts). O backend grava com service role e filtra por user.
--
-- Idempotente: pode ser aplicado mais de uma vez sem erro.

-- ===== 1) ai_memory_imports =====
CREATE TABLE IF NOT EXISTS public.ai_memory_imports (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id               TEXT NOT NULL,
  workspace_id          TEXT,
  origin                TEXT NOT NULL CHECK (origin IN ('zip','txt','csv','arquivo')),
  file_name             TEXT NOT NULL,
  source_files          INTEGER NOT NULL DEFAULT 0,
  conversations_found   INTEGER NOT NULL DEFAULT 0,
  conversations_processed INTEGER NOT NULL DEFAULT 0,
  learnings_generated   INTEGER NOT NULL DEFAULT 0,
  failures              INTEGER NOT NULL DEFAULT 0,
  status                TEXT NOT NULL DEFAULT 'processing'
                        CHECK (status IN ('processing','done','failed')),
  error_message         TEXT,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at           TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS ai_memory_imports_user_idx ON public.ai_memory_imports (user_id);
CREATE INDEX IF NOT EXISTS ai_memory_imports_created_idx ON public.ai_memory_imports (created_at DESC);

-- ===== 2) ai_memory_conversations =====
CREATE TABLE IF NOT EXISTS public.ai_memory_conversations (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id            TEXT NOT NULL,
  workspace_id       TEXT,
  import_id          UUID REFERENCES public.ai_memory_imports(id) ON DELETE CASCADE,
  source_file        TEXT,
  contact_identifier TEXT,
  contact_name       TEXT,
  messages_count     INTEGER NOT NULL DEFAULT 0,
  direction          TEXT CHECK (direction IN ('entrada','saida','misto')),
  transcript         JSONB NOT NULL DEFAULT '[]'::jsonb,
  outcome            TEXT,
  status             TEXT NOT NULL DEFAULT 'imported'
                     CHECK (status IN ('imported','processing','processed','failed')),
  error_message      TEXT,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  processed_at       TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS ai_memory_conv_user_idx    ON public.ai_memory_conversations (user_id);
CREATE INDEX IF NOT EXISTS ai_memory_conv_import_idx  ON public.ai_memory_conversations (import_id);
CREATE INDEX IF NOT EXISTS ai_memory_conv_status_idx  ON public.ai_memory_conversations (status);

-- ===== 3) ai_memory_learnings =====
CREATE TABLE IF NOT EXISTS public.ai_memory_learnings (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         TEXT NOT NULL,
  workspace_id    TEXT,
  import_id       UUID REFERENCES public.ai_memory_imports(id) ON DELETE CASCADE,
  conversation_id UUID REFERENCES public.ai_memory_conversations(id) ON DELETE CASCADE,
  category        TEXT NOT NULL CHECK (category IN (
                    'communication_style',
                    'opening_patterns',
                    'discovery_questions',
                    'value_proposition',
                    'objection_handling',
                    'meeting_transition',
                    'follow_up_patterns',
                    'successful_patterns',
                    'unsuccessful_patterns',
                    'common_objections',
                    'conversation_patterns'
                  )),
  content         TEXT NOT NULL,
  evidence        JSONB NOT NULL DEFAULT '[]'::jsonb,
  confidence      TEXT NOT NULL DEFAULT 'media' CHECK (confidence IN ('alta','media','baixa')),
  occurrences     INTEGER NOT NULL DEFAULT 1,
  performance     TEXT NOT NULL DEFAULT 'neutro' CHECK (performance IN ('positivo','negativo','neutro')),
  status          TEXT NOT NULL DEFAULT 'identificado'
                  CHECK (status IN ('identificado','validado','ativo','inativo')),
  important       BOOLEAN NOT NULL DEFAULT false,
  discovered_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ai_memory_learning_user_idx     ON public.ai_memory_learnings (user_id);
CREATE INDEX IF NOT EXISTS ai_memory_learning_cat_idx      ON public.ai_memory_learnings (category);
CREATE INDEX IF NOT EXISTS ai_memory_learning_status_idx   ON public.ai_memory_learnings (status);
CREATE INDEX IF NOT EXISTS ai_memory_learning_create_idx   ON public.ai_memory_learnings (created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS ai_memory_learning_uniq  ON public.ai_memory_learnings (user_id, category, lower(left(content, 160)));
CREATE INDEX IF NOT EXISTS ai_memory_learning_import_idx   ON public.ai_memory_learnings (import_id);

-- ===== 4) RLS =====
ALTER TABLE public.ai_memory_imports       ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ai_memory_conversations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ai_memory_learnings     ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS ai_memory_imports_auth_all       ON public.ai_memory_imports;
DROP POLICY IF EXISTS ai_memory_conversations_auth_all ON public.ai_memory_conversations;
DROP POLICY IF EXISTS ai_memory_learnings_auth_all     ON public.ai_memory_learnings;

CREATE POLICY ai_memory_imports_auth_all       ON public.ai_memory_imports
  FOR ALL USING (auth.role() = 'authenticated' AND user_id = auth.uid()::text)
  WITH CHECK (auth.role() = 'authenticated' AND user_id = auth.uid()::text);

CREATE POLICY ai_memory_conversations_auth_all ON public.ai_memory_conversations
  FOR ALL USING (auth.role() = 'authenticated' AND user_id = auth.uid()::text)
  WITH CHECK (auth.role() = 'authenticated' AND user_id = auth.uid()::text);

CREATE POLICY ai_memory_learnings_auth_all     ON public.ai_memory_learnings
  FOR ALL USING (auth.role() = 'authenticated' AND user_id = auth.uid()::text)
  WITH CHECK (auth.role() = 'authenticated' AND user_id = auth.uid()::text);

-- ===== 5) Realtime (dashboard em tempo real) =====
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_publication_tables
                 WHERE pubname = 'supabase_realtime'
                   AND schemaname = 'public'
                   AND tablename = 'ai_memory_imports') THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.ai_memory_imports;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_publication_tables
                 WHERE pubname = 'supabase_realtime'
                   AND schemaname = 'public'
                   AND tablename = 'ai_memory_conversations') THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.ai_memory_conversations;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_publication_tables
                 WHERE pubname = 'supabase_realtime'
                   AND schemaname = 'public'
                   AND tablename = 'ai_memory_learnings') THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.ai_memory_learnings;
  END IF;
END $$;

GRANT SELECT, INSERT, UPDATE, DELETE ON public.ai_memory_imports       TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.ai_memory_conversations TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.ai_memory_learnings     TO authenticated;

NOTIFY pgrst, 'reload schema';