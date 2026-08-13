export interface FollowUpIntent {
  requested: true;
  date: string;
  time: string | null;
  message: string;
}

const MARKER = /<!--\s*FOLLOW_UP:\s*(\{[\s\S]*?\})\s*-->/i;

/** Lê somente o marker controlado pelo modelo; não infere datas por palavra solta. */
export function parseFollowUpMarker(response: string): FollowUpIntent | null {
  const match = response.match(MARKER);
  if (!match) return null;
  try {
    const raw = JSON.parse(match[1]) as Record<string, unknown>;
    if (raw.requested !== true || typeof raw.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(raw.date)) return null;
    const time = typeof raw.time === 'string' && /^\d{2}:\d{2}$/.test(raw.time) ? raw.time : null;
    const message = typeof raw.message === 'string' ? raw.message.trim() : '';
    if (!message) return null;
    return { requested: true, date: raw.date, time, message };
  } catch {
    return null;
  }
}

export function stripFollowUpMarker(response: string): string {
  return response.replace(MARKER, '').trim();
}
