/**
 * Tool: list.dir
 * Permission: READ
 *
 * Lists immediate children of a directory under the workspace root.
 * Caps number of entries to 500 to avoid huge model context.
 */
import { readdir, stat } from 'node:fs/promises';
import type { ToolBase } from './registry.js';
import { safeResolvePath, PathValidationError } from './fs.safe.js';

const MAX_ENTRIES = 500;

export function createListDirTool(allowedDir: string): ToolBase {
  return {
    definition: {
      name: 'list.dir',
      description:
        'Lists immediate children of a directory under the agent workspace. ' +
        'Returns one entry per line with [DIR] or [FILE] annotation.',
      parameters: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description:
              'Relative directory path (e.g. "" for root, "notes" for notes/).',
          },
        },
        required: ['path'],
      },
    },
    permission: 'READ',
    async execute(args) {
      try {
        const rel = typeof args.path === 'string' ? args.path : '';
        const resolved = safeResolvePath(rel || '.', allowedDir);
        const entries = await readdir(resolved, { withFileTypes: true });
        const lines: string[] = [];
        const truncated = entries.length > MAX_ENTRIES;
        for (const e of truncated ? entries.slice(0, MAX_ENTRIES) : entries) {
          try {
            const s = await stat(`${resolved}/${e.name}`);
            const tag = s.isDirectory() ? '[DIR] ' : '[FILE]';
            lines.push(`${tag} ${e.name}`);
          } catch {
            lines.push(`[?] ${e.name}`);
          }
        }
        const header = truncated
          ? `[showing first ${MAX_ENTRIES} of ${entries.length}]\n`
          : '';
        return {
          ok: true,
          output: header + lines.join('\n'),
          data: { count: entries.length, truncated },
        };
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
          return { ok: false, output: 'Directory not found.', error: 'not_found' };
        }
        const message = err instanceof Error ? err.message : 'readdir error';
        return { ok: false, output: message, error: 'io_error' };
      }
    },
  };
}
