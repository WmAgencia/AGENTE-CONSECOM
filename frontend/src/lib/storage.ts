import { supabase } from './supabase'

export const MEDIA_BUCKET = 'consecom-media'

/**
 * Faz upload de um arquivo de mídia (áudio/vídeo/imagem/doc) para o bucket
 * público "consecom-media" e devolve a URL pública que o Evolution baixa.
 * Retorna null em caso de erro.
 */
export async function uploadMedia(
  file: File,
  onProgress?: (percent: number) => void,
): Promise<{ url: string; error: string | null }> {
  const ext = (file.name.split('.').pop() ?? 'bin').toLowerCase()
  const path = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`

  const { data, error } = await supabase.storage
    .from(MEDIA_BUCKET)
    .upload(path, file, {
      cacheControl: '3600',
      upsert: false,
      ...(onProgress
        ? {
            onUploadProgress(evt: { loaded: number; total?: number }) {
              if (evt.total) onProgress(Math.round((evt.loaded / evt.total) * 100))
            },
          }
        : {}),
    })

  if (error) return { url: '', error: error.message }
  const { data: urlData } = supabase.storage.from(MEDIA_BUCKET).getPublicUrl(data.path)
  return { url: urlData.publicUrl, error: null }
}