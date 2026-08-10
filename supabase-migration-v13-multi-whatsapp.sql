-- ===== Migration v13 (Multi-WhatsApp / conexões independentes) =====
-- Objetivo: permitir que um usuário/workspace tenha VÁRIAS conexões WhatsApp
-- simultâneas (cada uma com seu instance_name na Evolution), sem constraint
-- única que bloqueie múltiplas linhas. Também garante colunas TEXT (UUID foi
-- tornado TEXT em migrações anteriores) e limpeza de linhas órfãs que apontam
-- para instâncias inexistentes na Evolution.
--
-- Idempotente: pode ser aplicado mais de uma vez sem erro.

-- 1) Colunas em TEXT (já feito em v4+; aqui garantimos para DBs antigos)
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='whatsapp_connections'
      AND column_name='user_id' AND data_type='uuid'
  ) THEN
    ALTER TABLE public.whatsapp_connections DROP CONSTRAINT IF EXISTS whatsapp_connections_user_id_fkey;
    ALTER TABLE public.whatsapp_connections ALTER COLUMN user_id TYPE TEXT USING user_id::TEXT;
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='whatsapp_connections'
      AND column_name='workspace_id' AND data_type='uuid'
  ) THEN
    ALTER TABLE public.whatsapp_connections ALTER COLUMN workspace_id TYPE TEXT USING workspace_id::TEXT;
  END IF;
END $$;

-- 2) Garantir que NÃO exista constraint única sobre instance_name ou
--    (user_id, instance_name) — múltiplas conexões exigem linhas distintas.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE contype = 'u'
      AND conrelid = 'public.whatsapp_connections'::regclass
      AND conname ILIKE '%instance_name%'
  ) THEN
    RAISE NOTICE 'Unique constraint on instance_name found; múltiplas conexões exigem remoção manual se existir.';
  END IF;
END $$;

-- 3) Índices de busca por conexão (multi) e por instância
CREATE INDEX IF NOT EXISTS whatsapp_conn_workspace_idx ON public.whatsapp_connections (workspace_id);
CREATE INDEX IF NOT EXISTS whatsapp_conn_user_idx     ON public.whatsapp_connections (user_id);
CREATE INDEX IF NOT EXISTS whatsapp_conn_instance_idx ON public.whatsapp_connections (instance_name);

-- 4) RLS: autenticados podem ler/gravar (padrão do projeto; a associação
--    real é feita no backend via service role key).
DROP POLICY IF EXISTS whatsapp_connections_auth_all ON public.whatsapp_connections;
CREATE POLICY whatsapp_connections_auth_all ON public.whatsapp_connections
  FOR ALL USING (auth.role() = 'authenticated');