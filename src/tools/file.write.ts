/**
 * Tool: file.write
 * Permission: WRITE
 *
 * Writes/overwrites a UTF-8 text file under the workspace root.
 * Rejects paths outside the allowed directory. Refuses to write if the
 * payload exceeds 1MB (safety valve against model runaway).
 */
import { writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { ToolBase } from './registry.js';
import { safeResolvePath, PathValidationError } from './fs.safe.js';

const MAX_WRITE_BYTES = 1024 * 1024;

export function createFileWriteTool(allowedDir: string): ToolBase {
  return {
    definition: {
      name: 'file.write',
      description:
        'Writes a UTF-8 text file under the agent workspace. ' +
        'Use a relative path; absolute and ".." paths are rejected. ' +
        'Existing files are overwritten.',
      parameters: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: 'Relative path to the file (e.g. "notes/todo.md").',
          },
          content: {
            type: 'string',
            description: 'The text content to write.',
          },
        },
        required: ['path', 'content'],
      },
    },
    permission: 'WRITE',
    async execute(args) {
      try {
        if (typeof args.content !== 'string') {
          return {
            ok: false,
            output: 'content must be a string.',
            error: 'invalid_args',
          };
        }
        const contentBytes = Buffer.byteLength(args.content, 'utf8');
        if (contentBytes > MAX_WRITE_BYTES) {
          return {
            ok: false,
            output: `content exceeds ${MAX_WRITE_BYTES} bytes.`,
            error: 'invalid_args',
          };
        }
        const resolved = safeResolvePath(args.path, allowedDir);
        await mkdir(dirname(resolved), { recursive: true });
        await writeFile(resolved, args.content, 'utf8');
        return {
          ok: true,
          output: `Wrote ${contentBytes} bytes to ${args.path}.`,
          data: { bytes: contentBytes, path: args.path },
        };
      } catch (err) {
        if (err instanceof PathValidationError) {
          return {
            ok: false,
            output: err.message,
            error: 'invalid_args',
          };
        }
        const message = err instanceof Error ? err.message : 'write error';
        return { ok: false, output: message, error: 'io_error' };
      }
    },
  };
}
