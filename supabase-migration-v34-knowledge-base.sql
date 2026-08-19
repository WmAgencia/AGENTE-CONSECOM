-- Fase 5: Base de Conhecimento (estrutura em árvore, estilo Google Drive).
-- Uma "base" é uma pasta raiz (kb_folders.parent_id = NULL); a campanha aponta
-- para uma base. O agente recebe todo o conteúdo abaixo dela como contexto.

CREATE TABLE IF NOT EXISTS public.kb_folders (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  UUID,
  user_id    UUID,
  name       TEXT NOT NULL,
  parent_id  UUID REFERENCES public.kb_folders (id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS kb_folders_parent_idx ON public.kb_folders (parent_id);

CREATE TABLE IF NOT EXISTS public.kb_files (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   UUID,
  user_id     UUID,
  folder_id   UUID REFERENCES public.kb_folders (id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  kind        TEXT NOT NULL DEFAULT 'texto'
              CHECK (kind IN ('texto','readme','link','documento','video','imagem','audio','youtube')),
  content     TEXT,
  source_url  TEXT,
  usage_count INTEGER NOT NULL DEFAULT 0,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS kb_files_folder_idx ON public.kb_files (folder_id);

-- Campanha -> base de conhecimento raiz (opcional).
ALTER TABLE public.campaigns ADD COLUMN IF NOT EXISTS knowledge_base_id UUID
  REFERENCES public.kb_folders (id) ON DELETE SET NULL;

-- RLS (mesmo padrão das tabelas do app: usuário autenticado; isolamento por
-- tenant ocorre na camada de aplicação, igual leads/campaigns).
ALTER TABLE public.kb_folders ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.kb_files    ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS kb_folders_auth_all ON public.kb_folders;
CREATE POLICY kb_folders_auth_all ON public.kb_folders FOR ALL
  USING (auth.role() = 'authenticated')
  WITH CHECK (auth.role() = 'authenticated');

DROP POLICY IF EXISTS kb_files_auth_all ON public.kb_files;
CREATE POLICY kb_files_auth_all ON public.kb_files FOR ALL
  USING (auth.role() = 'authenticated')
  WITH CHECK (auth.role() = 'authenticated');

GRANT ALL ON public.kb_folders TO authenticated, service_role;
GRANT ALL ON public.kb_files    TO authenticated, service_role;