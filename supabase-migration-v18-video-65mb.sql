-- Migration v18: bucket exclusivo para vídeos da Vyntra.
--
-- O limite global do projeto Supabase precisa ser >= 65 MB antes desta
-- migration produzir efeito. No plano Free, o máximo global é 50 MB.
-- Os demais arquivos continuam no bucket consecom-media.

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'consecom-video',
  'consecom-video',
  true,
  68157440,
  ARRAY['video/*']::text[]
)
ON CONFLICT (id) DO UPDATE SET
  name = EXCLUDED.name,
  public = true,
  file_size_limit = 68157440,
  allowed_mime_types = ARRAY['video/*']::text[];

DROP POLICY IF EXISTS consecom_video_insert ON storage.objects;
CREATE POLICY consecom_video_insert
  ON storage.objects FOR INSERT
  WITH CHECK (bucket_id = 'consecom-video' AND auth.role() = 'authenticated');

DROP POLICY IF EXISTS consecom_video_update ON storage.objects;
CREATE POLICY consecom_video_update
  ON storage.objects FOR UPDATE
  USING (bucket_id = 'consecom-video' AND auth.role() = 'authenticated');

DROP POLICY IF EXISTS consecom_video_select_public ON storage.objects;
CREATE POLICY consecom_video_select_public
  ON storage.objects FOR SELECT
  USING (bucket_id = 'consecom-video');
