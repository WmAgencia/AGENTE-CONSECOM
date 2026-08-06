/**
 * Shared auth helpers for API-key validation.
 * Uses constant-time comparison so an attacker cannot time-guess the key.
 */
import { timingSafeEqual } from 'node:crypto';

export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

/**
 * Extracts a `Bearer <token>` from the Authorization header.
 * Returns undefined when the header is absent or malformed.
 */
export function extractBearerToken(
  authHeader: string | undefined,
): string | undefined {
  if (!authHeader) return undefined;
  if (!authHeader.startsWith('Bearer ')) return undefined;
  const token = authHeader.slice('Bearer '.length).trim();
  return token.length > 0 ? token : undefined;
}