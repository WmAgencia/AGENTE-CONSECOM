/**
 * Tool: file.read
 * Permission: READ
 *
 * Reads a UTF-8 text file under the workspace root. Rejects paths outside
 * the allowed directory. Caps output at ~32KB to avoid flooding the model
 * context.
 */
import { readFile } from 'node:fs/promises';
import type { ToolBase } from './registry.js';
import { safeResolvePath, PathValidationError } from './fs.safe.js';

const MAX_READ_BYTES = 32 * 1024;

export function createFileReadTool(allowedDir: string): ToolBase {
  return {
    definition: {
      name: 'file.read',
      description:
        'Reads a UTF-8 text file under the agent workspace. ' +
        'Use a relative path; absolute and ".." paths are rejected.',
      parameters: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: 'Relative path to the file (e.g. "notes/todo.md").',
          },
        },
        required: ['path'],
      },
    },
    permission: 'READ',
    async execute(args) {
      try {
        const resolved = safeResolvePath(args.path, allowedDir);
        const buf = await readFile(resolved);
        const truncated = buf.length > MAX_READ_BYTES;
        const slice = truncated ? buf.subarray(0, MAX_READ_BYTES) : buf;
        const text = slice.toString('utf8');
        const output =
          (truncated
            ? `[file truncated at ${MAX_READ_BYTES} bytes]\n`
            : '') + text;
        return { ok: true, output, data: { bytes: buf.length, truncated } };
      } catch (err) {
        if (err instanceof PathValidationError) {
          return {
            ok: false,
            output: err.message,
            error: 'invalid_args',
          };
        }
        const code = (err as NodeJS.ErrnoException)?.code;
        if (code === 'ENOENT') {
          return { ok: false, output: 'File not found.', error: 'not_found' };
        }
        const message = err instanceof Error ? err.message : 'read error';
        return { ok: false, output: message, error: 'io_error' };
      }
    },
  };
}
