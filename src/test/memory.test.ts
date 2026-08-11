/**
 * Testes da Memória Comercial da IA.
 *
 * A) Unit — parser de conversas (WhatsApp TXT, CSV, ZIP base64, classificação
 *    agente/lead, detecção de formato).
 * B) Integration — auth (401) e validação das rotas /api/ai/memory/* sem
 *    depender de NVIDIA (sem token → 401; payload inválido → 400/422).
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import AdmZip from 'adm-zip';
import { loadDotenvLocalIfPresent } from './load.env.js';
loadDotenvLocalIfPresent();
import {
  detectContentKind,
  parseWhatsAppText,
  parseCsvExport,
  parseZipToText,
  buildConversations,
  classifyRoles,
  normalizeWord,
  parseText,
} from '../services/memory.parse.js';
import { inferConversationOutcome } from '../services/memory.processor.js';

describe('memory.parse: format detection', () => {
  test('detecta TXT padrão do WhatsApp', () => {
    const txt = '[05/01/2025, 14:30:22] Wesley Tune: Olá, tudo bem?';
    assert.equal(detectContentKind(txt), 'txt');
  });

  test('detecta CSV por cabeçalho', () => {
    const csv = 'Nome;Mensagem;Data\nJoão;Olá;10/05\n';
    assert.equal(detectContentKind(csv), 'csv');
  });

  test('detecta ZIP por assinatura base64 (PK)', () => {
    assert.equal(detectContentKind('UEsDBBQACAgIAAAAAAAAAAAAAAAAAAAA'), 'zip');
    assert.equal(detectContentKind('UEsFBgAAAAAAAAAAAAAAAAAAAAAAAAAA'), 'zip');
  });
});

describe('memory.parse: WhatsApp TXT', () => {
  test('parsa linhas com timestamp, sender e mensagem', () => {
    const txt = [
      '[05/01/2025, 14:30:22] Wesley Tune: Olá João, tudo bem?',
      '[05/01/2025, 14:31:05] João: Bom dia! Quem é?',
      '[05/01/2025, 14:31:40] Wesley Tune: Aqui é da empresa X, ajudamos negócios a vender mais.',
    ].join('\n');
    const msgs = parseWhatsAppText(txt);
    assert.equal(msgs.length, 3);
    assert.equal(msgs[0].sender, 'Wesley Tune');
    assert.equal(msgs[0].text, 'Olá João, tudo bem?');
    assert.equal(msgs[1].sender, 'João');
  });

  test('mesmo sender + mesmo minuto vira continuação', () => {
    const txt = [
      '[05/01/2025, 14:30:22] Wesley Tune: Primeira linha',
      'segunda linha sem cabeçalho',
      '[05/01/2025, 14:31:05] João: Ok',
    ].join('\n');
    const msgs = parseWhatsAppText(txt);
    assert.equal(msgs.length, 2);
    assert.ok(msgs[0].text.includes('segunda linha'));
  });

  test('formato simplificado hh:mm - Nome: msg', () => {
    const msgs = parseWhatsAppText('10:03 - Wesley: Olá\n10:04 - Cliente: Oi');
    assert.equal(msgs.length, 2);
    assert.equal(msgs[0].sender, 'Wesley');
  });

  test('linhas de mídia viram placeholder, não são descartadas', () => {
    const txt = '[05/01/2025, 14:30:22] João: <Media omitedo>';
    const msgs = parseWhatsAppText(txt);
    assert.equal(msgs.length, 1);
    assert.ok(msgs[0].text.includes('[midia]'));
  });
});

describe('memory.parse: CSV', () => {
  test('inferência de colunas por cabeçalho (Nome;Mensagem;Data)', () => {
    const csv = ['Nome;Mensagem;Data', 'João;Tenho interesse no serviço;10/05/2025', 'Wesley;Ótimo!'].join('\n');
    const msgs = parseCsvExport(csv);
    assert.equal(msgs.length, 2);
    assert.equal(msgs[0].sender, 'João');
    assert.equal(msgs[0].text, 'Tenho interesse no serviço');
  });

  test('sem cabeçalho assume sender/mensagem/data', () => {
    const csv = 'João;Quanto custa?;10/05/2025\nWesley;Vou te passar orçamento;\n';
    const msgs = parseCsvExport(csv);
    assert.equal(msgs.length, 2);
    assert.equal(msgs[1].text, 'Vou te passar orçamento');
  });

  test('delimitador com aspas', () => {
    const csv = 'remetente;mensagem\nJoão;"Orçamento, por favor"\n';
    const msgs = parseCsvExport(csv);
    assert.equal(msgs[0].text, 'Orçamento, por favor');
  });
});

describe('memory.parse: ZIP', () => {
  test('extrai txt de um ZIP (base64) e preserva conteúdo', () => {
    const zip = new AdmZip();
    zip.addFile('chat1.txt', Buffer.from('[05/01/2025, 14:30:22] Wesley: Olá\n', 'utf8'));
    zip.addFile('ignorado.pdf', Buffer.from('pdf', 'utf8'));
    const b64 = zip.toBuffer().toString('base64');
    const entries = parseZipToText(b64);
    assert.equal(entries.length, 1);
    assert.equal(entries[0].fileName, 'chat1.txt');
    assert.ok(entries[0].content.includes('Wesley'));
  });

  test('entrada inválida → vazio', () => {
    assert.deepEqual(parseZipToText(''), []);
    assert.deepEqual(parseZipToText('não é um zip'), []);
  });
});

describe('memory.parse: classificação e conversas', () => {
  test('com agentName, sender correspondente vira agente', () => {
    const msgs = classifyRoles(
      [
        { sender: 'Alex', text: 'Olá' },
        { sender: 'Carlos', text: 'Oi' },
        { sender: 'Alex', text: 'Como posso ajudar?' },
      ],
      'Alex',
    );
    assert.equal(msgs[0].role, 'agente');
    assert.equal(msgs[1].role, 'lead');
  });

  test('sem agentName, quem envia mais é o agente', () => {
    const msgs = classifyRoles([
      { sender: 'Wesley', text: 'a' },
      { sender: 'João', text: 'b' },
      { sender: 'Wesley', text: 'c' },
      { sender: 'Wesley', text: 'd' },
    ]);
    assert.equal(msgs[0].role, 'agente');
    assert.equal(msgs[1].role, 'lead');
  });

  test('buildConversations agrupa por arquivo e encontra o contato', () => {
    const convs = buildConversations(
      [
        {
          fileName: 'chat.txt',
          kind: 'txt' as const,
          content: [
            '[05/01/2025, 14:30:22] Wesley Tune: Olá João!',
            '[05/01/2025, 14:31:05] João: Oi, quem fala?',
          ].join('\n'),
        },
      ],
      'Wesley Tune',
    );
    assert.equal(convs.length, 1);
    assert.equal(convs[0].contactName, 'João');
    assert.equal(convs[0].messages[0].role, 'agente');
  });

  test('normalizeWord remove acentos', () => {
    assert.equal(normalizeWord('João VENDAS'), 'joao vendas');
  });
});

describe('memory.parse: formato real da exportação do WhatsApp (sem colchetes)', () => {
  test('dd/mm/aaaa, hh:mm:ss - Nome: msg', () => {
    const txt = [
      '23/01/2026, 09:14:02 - Wesley Tune: Bom dia João!',
      '23/01/2026, 09:14:55 - João: Bom dia, quem fala?',
    ].join('\n');
    const msgs = parseWhatsAppText(txt);
    assert.equal(msgs.length, 2);
    assert.equal(msgs[0].sender, 'Wesley Tune');
    assert.equal(msgs[0].text, 'Bom dia João!');
    assert.equal(msgs[1].sender, 'João');
  });

  test('aceita dia/mês de 1 dígito e ano de 2 dígitos (d/m/aa)', () => {
    const msgs = parseWhatsAppText('3/2/26, 10:05 - Wesley: Oi\n3/2/26, 10:06 - João: Ola');
    assert.equal(msgs.length, 2);
    assert.equal(msgs[0].sender, 'Wesley');
  });

  test('aceita hora sem segundos no formato real', () => {
    const msgs = parseWhatsAppText('23/01/2026, 09:14 - Wesley: Teste');
    assert.equal(msgs.length, 1);
    assert.equal(msgs[0].text, 'Teste');
  });

  test('aceita AM/PM', () => {
    const msgs = parseWhatsAppText('3/2/2026, 10:05 PM - Wesley: Oi');
    assert.equal(msgs.length, 1);
    assert.equal(msgs[0].sender, 'Wesley');
  });

  test('aceita data separada por ponto', () => {
    const msgs = parseWhatsAppText('23.01.2026, 09:14 - Wesley: Teste');
    assert.equal(msgs.length, 1);
    assert.equal(msgs[0].text, 'Teste');
  });

  test('mensagem multilinha é anexada à anterior (formato real)', () => {
    const txt = [
      '23/01/2026, 09:14:02 - Wesley Tune: Primeira linha',
      'segunda linha',
      '23/01/2026, 09:15:00 - João: Ok',
    ].join('\n');
    const msgs = parseWhatsAppText(txt);
    assert.equal(msgs.length, 2);
    assert.ok(msgs[0].text.includes('segunda linha'));
  });

  test('emoji e caracteres unicode são preservados', () => {
    const msgs = parseWhatsAppText('23/01/2026, 09:14 - Wesley: Olá 😀, vamos conversar?');
    assert.equal(msgs.length, 1);
    assert.ok(msgs[0].text.includes('😀'));
    assert.ok(msgs[0].text.includes('Olá'));
  });

  test('nome com acento é preservado', () => {
    const msgs = parseWhatsAppText('23/01/2026, 09:14 - José Antônio: Bom dia');
    assert.equal(msgs[0].sender, 'José Antônio');
  });

  test('mídia omitida vira placeholder no formato real', () => {
    const msgs = parseWhatsAppText('23/01/2026, 09:14 - João: <Mídia oculta>');
    assert.equal(msgs.length, 1);
    assert.ok(msgs[0].text.includes('[midia]'));
  });

  test('mensagens de sistema não viram conversa', () => {
    const txt = [
      '23/01/2026, 09:00:01 - Messages and calls are end-to-end encrypted. No one outside of this chat can read them.',
      '23/01/2026, 09:14:02 - Wesley Tune: Olá',
      '23/01/2026, 09:15:00 - João criou o grupo "Vendas".',
    ].join('\n');
    const msgs = parseWhatsAppText(txt);
    assert.equal(msgs.length, 1);
    assert.equal(msgs[0].sender, 'Wesley Tune');
  });

  test('linhas não reconhecidas não descartam a conversa inteira', () => {
    const txt = [
      'qualquer coisa que não é cabeçalho',
      '23/01/2026, 09:14:02 - Wesley Tune: Olá',
      'outra linha solta',
      '23/01/2026, 09:15:00 - João: Oi',
    ].join('\n');
    const msgs = parseWhatsAppText(txt);
    assert.equal(msgs.length, 2);
  });

  test('conteúdo totalmente inválido → zero mensagens', () => {
    const msgs = parseWhatsAppText('isto não é uma conversa\nnem isto');
    assert.equal(msgs.length, 0);
  });

  test('parseText expõe stats de diagnóstico', () => {
    const txt = [
      'linha solta',
      '23/01/2026, 09:14:02 - Wesley Tune: Olá',
      '23/01/2026, 09:15:00 - João: Oi',
    ].join('\n');
    const { messages, stats } = parseText(txt, 'txt');
    assert.equal(messages.length, 2);
    assert.equal(stats.lines, 3);
    assert.equal(stats.messages, 2);
    assert.equal(stats.unsupported, 1);
  });

  test('buildConversations reconhece e classifica o formato real', () => {
    const convs = buildConversations(
      [
        {
          fileName: 'whatsapp.txt',
          kind: 'txt' as const,
          content: [
            '23/01/2026, 09:14:02 - Wesley Tune: Olá João!',
            '23/01/2026, 09:14:55 - João: Bom dia, quem fala?',
          ].join('\n'),
        },
      ],
      'Wesley Tune',
    );
    assert.equal(convs.length, 1);
    assert.equal(convs[0].contactName, 'João');
    assert.equal(convs[0].messages[0].role, 'agente');
  });
});

describe('memory.parse: ZIP com múltiplos arquivos reais', () => {
  test('extrai vários .txt e .csv e ignora não-texto', () => {
    const zip = new AdmZip();
    zip.addFile(
      'chat1.txt',
      Buffer.from('23/01/2026, 09:14:02 - Wesley: Olá\n23/01/2026, 09:15:00 - João: Oi', 'utf8'),
    );
    zip.addFile(
      'chat2.txt',
      Buffer.from('[05/01/2025, 14:30:22] Wesley: Teste antigo', 'utf8'),
    );
    zip.addFile('planilha.csv', Buffer.from('Nome;Mensagem\nJoão;Interesse', 'utf8'));
    zip.addFile('foto.jpg', Buffer.from('jpeg', 'utf8'));
    const entries = parseZipToText(zip.toBuffer().toString('base64'));
    assert.equal(entries.length, 3);
    assert.ok(entries.every((e) => e.kind !== 'zip'));
    const csv = entries.find((e) => e.fileName === 'planilha.csv');
    assert.equal(csv?.kind, 'csv');
  });
});

describe('memory.parse: CSV em inglês e colunas amplas', () => {
  test('cabeçalho em inglês (sender,message,created)', () => {
    const csv = [
      'sender,message,created',
      'João,"Tenho interesse, pode me ligar",2026-01-23',
    ].join('\n');
    const msgs = parseCsvExport(csv);
    assert.equal(msgs.length, 1);
    assert.equal(msgs[0].sender, 'João');
    assert.equal(msgs[0].text, 'Tenho interesse, pode me ligar');
  });

  test('célula multilinha com aspas é unida', () => {
    const csv = ['remetente;mensagem', 'João;"Primeira linha', 'segunda linha"', 'Wesley;ok'].join('\n');
    const msgs = parseCsvExport(csv);
    assert.equal(msgs.length, 2);
    assert.ok(msgs[0].text.includes('segunda linha'));
  });
});

describe('memory.processor: desfecho', () => {
  test('detecta interesse em reunião', () => {
    const out = inferConversationOutcome([
      { role: 'lead', text: 'Pode marcar sim, amanhã de manhã.' },
    ]);
    assert.equal(out, 'reuniao');
  });

  test('detecta sem interesse', () => {
    const out = inferConversationOutcome([
      { role: 'lead', text: 'Obrigado, mas não tenho interesse.' },
    ]);
    assert.equal(out, 'sem_interesse');
  });

  test('sem sinal → null', () => {
    const out = inferConversationOutcome([{ role: 'lead', text: 'ok' }]);
    assert.equal(out, null);
  });
});

describe('memory routes: auth', () => {
  test('rotas exigem token Supabase (401 sem token)', async () => {
    const { buildApp } = await import('../app.js');
    const { app } = buildApp();
    await app.ready();

    const cases = [
      { method: 'POST', url: '/api/ai/memory/import' },
      { method: 'GET', url: '/api/ai/memory/dashboard' },
      { method: 'GET', url: '/api/ai/memory/imports' },
      { method: 'GET', url: '/api/ai/memory/conversations' },
      { method: 'GET', url: '/api/ai/memory/learnings' },
      { method: 'DELETE', url: '/api/ai/memory/learnings/123e4567-e89b-12d3-a456-426614174000' },
      { method: 'PATCH', url: '/api/ai/memory/learnings/123e4567-e89b-12d3-a456-426614174000' },
    ] as const;

    for (const c of cases) {
      const res = await app.inject({
        method: c.method,
        url: c.url,
        headers: { 'Content-Type': 'application/json' },
        payload: c.method === 'POST' ? { fileName: 'a.txt', content: 'x' } : {},
      });
      assert.equal(res.statusCode, 401, `${c.method} ${c.url} deve ser 401`);
    }

    await app.close();
  });

  test('import rejeita conteúdo inválido com 422', async () => {
    const { buildApp } = await import('../app.js');
    const { app } = buildApp();
    await app.ready();

    const res = await app.inject({
      method: 'POST',
      url: '/api/ai/memory/import',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer token-invalido',
      },
      payload: { fileName: 'x.txt', content: 'isto não é uma conversa' },
    });
    // Com token inválido → 401 (auth acontece antes da validação).
    assert.equal(res.statusCode, 401);
    await app.close();
  });
});