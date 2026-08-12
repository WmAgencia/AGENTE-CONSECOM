import { supabase } from './supabase'

export const MEDIA_BUCKET = 'consecom-media'
export const MAX_VIDEO_BYTES = 100 * 1024 * 1024

/** Tempo máximo de upload antes de reportar erro (evita travamento infinito). */
const DEFAULT_UPLOAD_TIMEOUT_MS = 60_000
const VIDEO_UPLOAD_TIMEOUT_MS = 5 * 60_000

/**
 * Faz upload de um arquivo de mídia (áudio/vídeo/imagem/doc) para o bucket
 * público "consecom-media" e devolve a URL pública que o Evolution baixa.
 * Nunca lança exceção: retorna { url, error } — com timeout para não ficar
 * preso em "enviando" para sempre.
 */
export async function uploadMedia(
  file: File,
  _onProgress?: (percent: number) => void,
): Promise<{ url: string; error: string | null }> {
  if (file.type.toLowerCase().startsWith('video/') && file.size > MAX_VIDEO_BYTES) {
    return {
      url: '',
      error: `Vídeos devem ter no máximo ${MAX_VIDEO_BYTES / 1024 / 1024} MB. Este arquivo tem ${(file.size / 1024 / 1024).toFixed(1)} MB.`,
    }
  }
  const ext = (file.name.split('.').pop() ?? 'bin').toLowerCase()
  const path = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`

  const upload = supabase.storage.from(MEDIA_BUCKET).upload(path, file, {
    cacheControl: '3600',
    upsert: false,
  })

  let timer: ReturnType<typeof setTimeout> | undefined
  const uploadTimeoutMs = file.type.toLowerCase().startsWith('video/')
    ? VIDEO_UPLOAD_TIMEOUT_MS
    : DEFAULT_UPLOAD_TIMEOUT_MS
  try {
    const result = await Promise.race([
      upload,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`upload excedeu ${uploadTimeoutMs / 1000}s`)),
          uploadTimeoutMs,
        )
      }),
    ])
    if (result.error) return { url: '', error: result.error.message }
    const { data: urlData } = supabase.storage.from(MEDIA_BUCKET).getPublicUrl(result.data.path)
    return { url: urlData.publicUrl, error: null }
  } catch (e) {
    return { url: '', error: e instanceof Error ? e.message : 'Falha no upload do arquivo' }
  } finally {
    clearTimeout(timer)
  }
}
