/**
 * Reimporta conversas reais (ZIPs do WhatsApp) usando o MESMO pipeline da rota
 * /api/ai/memory/import (buildConversations + createImportRow +
 * bulkCreateConversations + processImportInBackground), com a classificação de
 * papéis corrigida (seller_names + contato do nome do arquivo).
 *
 * Uso: node <script> <user_id> <zip1> <zip2> ...
 */
import dotenv from 'dotenv';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { readFileSync } from 'node:fs';
dotenv.config({ path: resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '.env.local'), override: true });

import { buildConversations, parseZipToText } from '../services/memory.parse.js';
import { loadSellerNames } from '../services/supabase.leads.js';
import { createImportRow, bulkCreateConversations } from '../services/memory.service.js';
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

async function main() {
  const userId = process.argv[2];
  const files = process.argv.slice(3);
  if (!userId || files.length === 0) {
    console.error('uso: node <script> <user_id> <zip1> <zip2> ...');
    process.exit(1);
  }

  const sellerNames = await loadSellerNames();
  console.log('seller_names:', JSON.stringify(sellerNames));

  for (const file of files) {
    const b64 = readFileSync(file).toString('base64');
    const fileName = file.split(/[\\/]/).pop() ?? file;

    const entries = parseZipToText(b64);
    const sources = entries.map((e) => ({
      fileName: e.fileName,
      content: e.content.replace(/^\uFEFF/, ''),
      kind: e.kind,
    }));
    const conversations = buildConversations(sources, sellerNames);

    console.log(`\n== ${fileName} ==`);
    console.log('conversas reconhecidas:', conversations.length);
    for (const c of conversations) {
      const agents = c.messages.filter((m) => m.role === 'agente').length;
      const leads = c.messages.filter((m) => m.role === 'lead').length;
      console.log(
        `  contato=${c.contactName ?? c.contactIdentifier ?? '?'} msgs=${c.messages.length} ` +
          `agente=${agents} lead=${leads}`,
      );
    }

    if (conversations.length === 0) {
      console.error('  -> nenhuma conversa; pulando.');
      continue;
    }

    const importId = await createImportRow({
      userId,
      origin: 'zip',
      fileName,
      sourceFiles: sources.length,
      conversationsFound: conversations.length,
    });
    if (!importId) {
      console.error('  -> falha ao criar lote; pulando.');
      continue;
    }

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
    console.log('  -> importId:', importId, 'conversas inseridas:', Object.keys(inserted).length);

    startImportBackground(importId, userId);
    console.log('  -> processamento em background iniciado.');
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
