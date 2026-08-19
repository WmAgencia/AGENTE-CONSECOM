/**
 * Minimal .env.local loader for tests (no dotenv dependency).
 * Reads <root>/.env.local and populates process.env for keys not already set.
 * Never overwrites an existing env var so CI/secret-injection still wins.
 */
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..', '..');
const envPath = resolve(root, '.env.local');

const PLACEHOLDER_VALUES = new Set(['', 'test_key', 'test-key', 'mock', 'undefined', 'null']);

export function loadDotenvLocalIfPresent(): void {
  if (!existsSync(envPath)) return;
  const raw = readFileSync(envPath, 'utf8');
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1).trim();
    // Só preenche quando a chave ainda não existe OU o valor ambiente é um
    // placeholder de teste (ex.: NVIDIA_API_KEY=test_key herdado do shell)
    // — nesses casos o .env.local (chave real) deve prevalecer.
    if (key && (process.env[key] === undefined || PLACEHOLDER_VALUES.has(process.env[key]?.trim() ?? ''))) {
      process.env[key] = value;
    }
  }
}