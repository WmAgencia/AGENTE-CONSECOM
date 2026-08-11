/**
 * Harness de simulação — conversa com o agente comercial REAL (mesmo
 * runAgentLoop do WhatsApp), sem tools, sem enviar WhatsApp, sem alterar
 * o banco real. Persiste o histórico num arquivo JSON para simular turnos.
 *
 * Uso: node script.js "<mensagem do lead>"
 */
import dotenv from 'dotenv';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
dotenv.config({ path: resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '.env.local'), override: true });
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { loadAgentDirectives, loadAgentName, formatAgentSignature } from '../services/supabase.leads.js';
import { loadLearningsForPrompt } from '../services/agent.learning.js';
import { loadCommercialMemoryForPrompt } from '../services/memory.service.js';
import { runAgentLoop } from '../services/agent.service.js';

const STATE = resolve(process.cwd(), 'src/test/.sim_state.json');

interface Turn { role: 'user' | 'assistant'; content: string }

function loadState(): Turn[] {
  if (!existsSync(STATE)) return [];
  try { return JSON.parse(readFileSync(STATE, 'utf8')) as Turn[]; } catch { return []; }
}
function saveState(t: Turn[]): void {
  writeFileSync(STATE, JSON.stringify(t, null, 2));
}
function historyOf(t: Turn[]) {
  return t.map((x) => ({ role: x.role, content: x.content }));
}

const LEAD = 'Ricardo';

async function main() {
  const msg = process.argv[2]?.trim();
  if (!msg) { console.error('uso: node <script> "<msg>"'); process.exit(1); }

  const ownerId = process.env.SIM_USER_ID ?? null;
  const directives = (await loadAgentDirectives()) ?? undefined;
  const learnings = (await loadLearningsForPrompt()) ?? undefined;
  const commercialMemory = (await loadCommercialMemoryForPrompt(ownerId)) ?? undefined;

  const state = loadState();
  const leadContext =
    `leadId=simulacao-ricardo; nome=${LEAD}; nicho/negocio=Padaria do Bairro; ` +
    `categoria=alimentacao; telefone=11988887777`;

  const result = await runAgentLoop({
    task: msg,
    conversationId: `sim:${LEAD}`,
    source: 'whatsapp',
    history: historyOf(state),
    directives,
    learnings,
    commercialMemory,
    leadContext,
    enableTools: false,
  });

  state.push({ role: 'user', content: msg });
  state.push({ role: 'assistant', content: result.result });
  saveState(state);

  const name = await loadAgentName();
  console.log('\n[LEAD] ' + msg);
  console.log('[IA]   ' + formatAgentSignature(result.result, name));
}

main().catch((e) => { console.error(e); process.exit(1); });
