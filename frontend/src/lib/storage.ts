import { supabase } from './supabase'

export const MEDIA_BUCKET = 'consecom-media'

/** Tempo máximo de upload antes de reportar erro (evita travamento infinito). */
const UPLOAD_TIMEOUT_MS = 60_000

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
  const ext = (file.name.split('.').pop() ?? 'bin').toLowerCase()
  const path = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`

  const upload = supabase.storage.from(MEDIA_BUCKET).upload(path, file, {
    cacheControl: '3600',
    upsert: false,
  })

  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const result = await Promise.race([
      upload,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`upload excedeu ${UPLOAD_TIMEOUT_MS / 1000}s`)),
          UPLOAD_TIMEOUT_MS,
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