export const MAX_VIDEO_BYTES = 100 * 1024 * 1024;

export function isVideoMime(mimetype: string | null | undefined): boolean {
  return typeof mimetype === 'string' && mimetype.toLowerCase().startsWith('video/');
}

export function validateVideoSize(bytes: number, mimetype: string | null | undefined): string | null {
  if (!isVideoMime(mimetype) || bytes <= MAX_VIDEO_BYTES) return null;
  return `Vídeos devem ter no máximo ${MAX_VIDEO_BYTES / 1024 / 1024} MB.`;
}
