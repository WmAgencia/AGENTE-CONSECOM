/**
 * Path sanitization for filesystem tools.
 *
 * Goals:
 *  - Reject absolute paths (force users to pass relative paths under the
 *    configured workspace root).
 *  - Reject path traversal (.., encoded ..).
 *  - Resolve final path and confirm it is inside ALLOWED_DIR.
 *  - Never expose secrets in error messages.
 *
 * The ALLOWED_DIR is read at registration time from env, never re-read
 * at execute time, so a stray env mutation mid-request has no effect.
 */
import { resolve as pathResolve, normalize as pathNormalize, isAbsolute } from 'node:path';

export class PathValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PathValidationError';
  }
}

/**
 * Validates a user-supplied path against an allowed workspace directory.
 * Returns the absolute resolved path on success.
 */
export function safeResolvePath(
  userInput: unknown,
  allowedDir: string,
): string {
  if (typeof userInput !== 'string' || userInput.length === 0) {
    throw new PathValidationError('Path must be a non-empty string.');
  }

  const raw = userInput.trim();

  // Reject absolute paths on any OS, plus Windows drive letters.
  if (isAbsolute(raw) || /^[A-Za-z]:[\\/]/.test(raw)) {
    throw new PathValidationError('Absolute paths are not allowed.');
  }

  // Reject obvious traversal and URL-encoded traversal.
  if (/\.\./.test(raw) || /%2e%2e/i.test(raw) || /%252e%252e/i.test(raw)) {
    throw new PathValidationError('Path traversal is not allowed.');
  }

  // Normalize and resolve under the allowed root.
  const cleaned = raw.replace(/\\/g, '/');
  const base = pathResolve(allowedDir);
  const resolved = pathResolve(base, pathNormalize(cleaned));

  if (!resolved.startsWith(base)) {
    throw new PathValidationError('Resolved path is outside the allowed directory.');
  }
  return resolved;
}
