export const MAX_VIDEO_BYTES = 65 * 1024 * 1024;
export const VIDEO_TOO_LARGE_MESSAGE = 'Vídeo muito grande. O tamanho máximo permitido é 65 MB.';

export function isVideoMime(mimetype: string | null | undefined): boolean {
  return typeof mimetype === 'string' && mimetype.toLowerCase().startsWith('video/');
}

export function validateVideoSize(bytes: number, mimetype: string | null | undefined): string | null {
  if (!isVideoMime(mimetype) || bytes <= MAX_VIDEO_BYTES) return null;
  return VIDEO_TOO_LARGE_MESSAGE;
}
