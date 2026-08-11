/**
 * Validação E2E da Memória Comercial da IA (uso: node <script> <user_id>).
 *
 * 1) Cria um ZIP com uma conversa REAL no formato do WhatsApp e roda o MESMO
 *    pipeline da rota /api/ai/memory/import (parse -> buildConversations ->
 *    createImportRow -> bulkCreateConversations -> startImportBackground).
 * 2) Aguarda o processamento em background terminar e confirma que a análise
 *    automática gerou aprendizados persistidos.
 * 3) Valida o CRUD manual no nível de serviço (mesma lógica das rotas):
 *    criar, editar, ativar, desativar, remover.
 * 4) Confirma que aprendizados ativos entram em loadCommercialMemoryForPrompt
 *    e que inativos NÃO entram.
 */
import dotenv from 'dotenv';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
dotenv.config({ path: resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '.env.local'), override: true });

import AdmZip from 'adm-zip';
import { buildConversations, parseZipToText } from '../services/memory.parse.js';
import { loadSellerNames } from '../services/supabase.leads.js';
import {
  createImportRow,
  bulkCreateConversations,
  listLearnings,
  createLearningRow,
  updateLearningRow,
  deleteLearningRow,
  getImportRow,
  loadCommercialMemoryForPrompt,
  normalizeEvidenceValue,
} from '../services/memory.service.js';
import { startImportBackground } from '../services/memory.processor.js';

function computeDirection(messages: Array<{ role?: 'agente' | 'lead' }>): string {
  const agents = messages.filter((m) => m.role === 'agente').length;
  const leads = messages.length - agents;
  if (leads === 0) return 'saida';
  const ratio = agents / leads;
  if (ratio > 1.2) return 'saida';
  if (ratio < 0.8) return 'entrada';
  return 'misto';
}

const CONVERSATION = [
  '23/01/2026, 09:14:02 - Wesley Tune: Bom dia! Tudo bem?',
  '23/01/2026, 09:14:55 - Samira: Bom dia, quem fala?',
  '23/01/2026, 09:15:20 - Wesley Tune: Aqui da Consecom, falo com as empresas de marketing para reduzir o custo de captação.',
  '23/01/2026, 09:16:10 - Samira: Interessante. Quanto custa?',
  '23/01/2026, 09:17:00 - Wesley Tune: Antes do valor, me conta: como vocês captam clientes hoje?',
  '23/01/2026, 09:18:30 - Samira: Anúncio no Google e indicação, mas está caro.',
  '23/01/2026, 09:19:00 - Wesley Tune: Entendi. Nesse caso o que mais faz sentido é reduzir o custo do lead qualificado.',
  '23/01/2026, 09:20:10 - Samira: Faz sentido. Consegue marcar uma reunião pra essa semana?',
  '23/01/2026, 09:21:00 - Wesley Tune: Claro! Que tal quinta às 10h?',
  '23/01/2026, 09:21:40 - Samira: Fechado, quinta 10h.',
].join('\n');

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const userId = process.argv[2];
  if (!userId) {
    console.error('uso: node <script> <user_id>');
    process.exit(1);
  }

  const sellerNames = await loadSellerNames();
  console.log('1) seller_names:', JSON.stringify(sellerNames));

  // Monta um ZIP com a conversa (formato real do WhatsApp).
  const zip = new AdmZip();
  zip.addFile('Conversa do WhatsApp com Samira.txt', Buffer.from(CONVERSATION, 'utf8'));
  const b64 = zip.toBuffer().toString('base64');

  const entries = parseZipToText(b64);
  const sources = entries.map((e) => ({ fileName: e.fileName, content: e.content, kind: e.kind }));
  const conversations = buildConversations(sources, sellerNames);
  console.log(`2) conversas reconhecidas: ${conversations.length}`);
  for (const c of conversations) {
    const agents = c.messages.filter((m) => m.role === 'agente').length;
    const leads = c.messages.filter((m) => m.role === 'lead').length;
    console.log(`   contato=${c.contactName ?? c.contactIdentifier ?? '?'} msgs=${c.messages.length} agente=${agents} lead=${leads}`);
  }
  if (conversations.length === 0) throw new Error('nenhuma conversa reconhecida');

  // Pipeline REAL (igual à rota POST /api/ai/memory/import).
  const importId = await createImportRow({
    userId,
    origin: 'zip',
    fileName: 'Conversa do WhatsApp com Samira.txt',
    sourceFiles: sources.length,
    conversationsFound: conversations.length,
  });
  if (!importId) throw new Error('falha ao criar lote');

  const inserted = await bulkCreateConversations(
    conversations.map((c) => ({
      userId,
      importId,
      sourceFile: c.sourceFile ?? null,
      contactName: c.contactName ?? null,
      contactIdentifier: c.contactIdentifier ?? null,
      direction: computeDirection(c.messages),
      transcript: c.messages.map((m) => ({ role: m.role ?? 'lead', text: m.text })),
    })),
  );
  console.log(`3) importId=${importId} conversas inseridas=${Object.keys(inserted).length}`);

  startImportBackground(importId, userId);
  console.log('4) processamento em background iniciado (análise automática)…');

  // Aguarda a análise terminar.
  let done = false;
  let countNoLote = 0;
  for (let i = 0; i < 40; i++) {
    await sleep(5000);
    countNoLote = (await listLearnings(userId, { limit: 500 })).filter((l) => l.import_id === importId).length;
    const row = await getImportRow(importId);
    console.log(`   [${i + 1}] status=${row?.status} learnings_do_lote=${countNoLote} learnings_meta=${row?.learnings_generated}`);
    if (row && (row.status === 'done' || row.status === 'failed')) {
      done = true;
      break;
    }
  }
  if (!done) throw new Error('timeout aguardando processamento');

  const learningsDoLote = (await listLearnings(userId, { limit: 500 })).filter((l) => l.import_id === importId);
  console.log(`5) aprendizados extraídos automaticamente: ${learningsDoLote.length}`);
  if (learningsDoLote.length === 0) throw new Error('análise automática NÃO gerou aprendizados');
  for (const l of learningsDoLote.slice(0, 6)) {
    console.log(`   [${l.category}] ${l.content.slice(0, 90)} (evidence=${JSON.stringify(normalizeEvidenceValue(l.evidence).length)} itens, origem=${l.import_id ? 'ai' : 'manual'})`);
  }
  // Confirma contrato de evidence (sempre array de strings).
  const first = learningsDoLote[0];
  if (!Array.isArray(first.evidence)) throw new Error('evidence não veio como array');

  // Valida CRUD manual (mesma lógica das rotas POST/PATCH/DELETE).
  const manualId = await createLearningRow(userId, {
    category: 'discovery_questions',
    content: 'E2E: Sempre perguntar sobre o processo de captação antes de falar preço',
    confidence: 'alta',
    performance: 'positivo',
    status: 'identificado',
    important: false,
    evidence: ['Como vocês captam clientes hoje?'],
  });
  if (!manualId) throw new Error('criação manual falhou');
  console.log('6) aprendizado manual criado:', manualId);

  const manual = (await listLearnings(userId, { limit: 500 })).find((l) => l.id === manualId);
  if (!manual) throw new Error('aprendizado manual não encontrado na listagem');
  if (manual.origin !== 'manual') throw new Error(`origin deveria ser manual, veio ${manual.origin}`);
  console.log('   origin=', manual.origin, 'evidence=', JSON.stringify(manual.evidence));

  // Editar (PATCH content/status).
  const okEdit = await updateLearningRow(manualId, userId, { content: manual.content + ' (editado)', status: 'ativo' });
  if (!okEdit) throw new Error('edição falhou');
  const edited = (await listLearnings(userId, { limit: 500 })).find((l) => l.id === manualId);
  console.log('7) editado: status=', edited?.status, 'content_ok=', edited?.content.includes('(editado)'));

  // Memória comercial: ativo deve entrar.
  await updateLearningRow(manualId, userId, { status: 'ativo' });
  const memAtivo = await loadCommercialMemoryForPrompt(userId, 10);
  if (!memAtivo || !memAtivo.includes('captação antes de falar preço')) {
    throw new Error('aprendizado ATIVO não entrou no commercialMemory');
  }
  console.log('8) aprendizado ativo presente no commercialMemory ✓');

  // Desativar: não deve entrar.
  await updateLearningRow(manualId, userId, { status: 'inativo' });
  const memInativo = await loadCommercialMemoryForPrompt(userId, 10);
  if (memInativo && memInativo.includes('captação antes de falar preço')) {
    throw new Error('aprendizado INATIVO entrou no commercialMemory (erro)');
  }
  console.log('9) aprendizado inativo NÃO entra no commercialMemory ✓');

  // Remover.
  const okDel = await deleteLearningRow(manualId, userId);
  if (!okDel) throw new Error('remoção falhou');
  const removed = (await listLearnings(userId, { limit: 500 })).find((l) => l.id === manualId);
  if (removed) throw new Error('aprendizado removido ainda existe');
  console.log('10) aprendizado removido ✓');

  console.log('\nE2E OK: pipeline, análise automática, CRUD e memória comercial validados.');
}

main().catch((e) => {
  console.error('E2E FAIL:', e.message ?? e);
  process.exit(1);
});
