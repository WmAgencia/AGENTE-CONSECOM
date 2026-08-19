-- Fase 5.1: "Responsável pelo fechamento" vive na Base de Conhecimento
-- (não na campanha). Cada pasta raiz (base) pode definir quem fecha a venda;
-- a campanha vinculada herda esse dado. O handoff configurado diretamente na
-- campanha (campaigns.ai_handoff) continua valendo como override/legado.

ALTER TABLE public.kb_folders ADD COLUMN IF NOT EXISTS closer_name TEXT;
ALTER TABLE public.kb_folders ADD COLUMN IF NOT EXISTS closer_phone TEXT;
ALTER TABLE public.kb_folders ADD COLUMN IF NOT EXISTS closer_instructions TEXT;