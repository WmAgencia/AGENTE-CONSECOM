import { supabase } from './supabase'

export const MEDIA_BUCKET = 'consecom-media'
export const VIDEO_BUCKET = 'consecom-video'
export const MAX_VIDEO_BYTES = 65 * 1024 * 1024
export const VIDEO_TOO_LARGE_MESSAGE = 'Vídeo muito grande. O tamanho máximo permitido é 65 MB.'

export const MAX_AUDIO_BYTES = 64 * 1024 * 1024
export const AUDIO_TOO_LARGE_MESSAGE = 'Áudio muito grande. O tamanho máximo permitido é 64 MB.'
export const AUDIO_INVALID_FORMAT_MESSAGE = 'Formato de áudio não suportado. Use MP3, OGG, WAV, M4A, AAC, AMR ou WebM.'

const AUDIO_MIME_TYPES = [
  'audio/mpeg',
  'audio/ogg',
  'audio/opus',
  'audio/wav',
  'audio/x-wav',
  'audio/wave',
  'audio/mp4',
  'audio/x-m4a',
  'audio/aac',
  'audio/aacp',
  'audio/webm',
  'audio/amr',
  'audio/x-ms-wma',
]

const AUDIO_EXTENSIONS = ['mp3', 'ogg', 'opus', 'oga', 'wav', 'm4a', 'aac', 'webm', 'amr', 'wma', 'mp4']

export function isAudioFile(file: File): boolean {
  const mime = file.type.toLowerCase()
  if (AUDIO_MIME_TYPES.includes(mime)) return true
  const ext = (file.name.split('.').pop() ?? '').toLowerCase()
  return AUDIO_EXTENSIONS.includes(ext)
}

export function validateAudioFile(file: File): string | null {
  if (!isAudioFile(file)) return AUDIO_INVALID_FORMAT_MESSAGE
  if (file.size > MAX_AUDIO_BYTES) return AUDIO_TOO_LARGE_MESSAGE
  return null
}

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
  const { data: userData, error: authError } = await supabase.auth.getUser()
  if (authError || !userData.user) {
    return { url: '', error: 'Sua sessão expirou. Entre novamente para enviar o vídeo.' }
  }
  if (file.type.toLowerCase().startsWith('video/') && file.size > MAX_VIDEO_BYTES) {
    return {
      url: '',
      error: VIDEO_TOO_LARGE_MESSAGE,
    }
  }
  const ext = (file.name.split('.').pop() ?? 'bin').toLowerCase()
  const path = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`
  const bucket = file.type.toLowerCase().startsWith('video/') ? VIDEO_BUCKET : MEDIA_BUCKET

  const upload = supabase.storage.from(bucket).upload(path, file, {
    cacheControl: '3600',
    upsert: false,
    contentType: file.type,
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
    const { data: urlData } = supabase.storage.from(bucket).getPublicUrl(result.data.path)
    return { url: urlData.publicUrl, error: null }
  } catch (e) {
    return { url: '', error: e instanceof Error ? e.message : 'Falha no upload do arquivo' }
  } finally {
    clearTimeout(timer)
  }
}
