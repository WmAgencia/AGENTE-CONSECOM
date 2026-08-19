/**
 * Tool: enviar_midia_kb
 * Permission: WHATSAPP
 *
 * Envia uma mídia da Base de Conhecimento (áudio/vídeo/imagem/documento) para
 * o lead que está conversando, quando a conversa pede isso (ex.: áudio com a
 * explicação, vídeo de demonstração). O agente informa a URL pública do arquivo
 * (a Base de Conhecimento já expõe os links no contexto) e um texto opcional.
 *
 * Segurança: apenas URLs do armazenamento público do Supabase (buckets
 * consecom-media / consecom-video) são aceitas — nunca URLs externas arbitrárias.
 * Se o Evolution/instância não estiver configurado, retorna ok:false para a IA
 * responder naturalmente ("vou te enviar assim que puder") sem expor a falha.
 */
import type { ToolBase } from './registry.js';
import { getSupabaseProspeccaoConfig, hasEvolutionConfig } from '../config/env.js';
import { isEvolutionMockMode, sendMedia, type MediaKind } from '../services/evolution.service.js';

function guessKind(url: string): MediaKind {
  const m = url.toLowerCase().match(/\.(\w+)(\?|$)/);
  const ext = m ? m[1] : '';
  if (['mp3', 'ogg', 'wav', 'opus', 'm4a', 'aac', 'amr'].includes(ext)) return 'audio';
  if (['mp4', 'mov', 'webm', 'mkv', 'avi'].includes(ext)) return 'video';
  if (['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp'].includes(ext)) return 'image';
  return 'document';
}

function guessMimetype(url: string, kind: MediaKind): string | undefined {
  const m = url.toLowerCase().match(/\.(\w+)(\?|$)/);
  const ext = m ? m[1] : '';
  if (kind === 'audio') return 'audio/mpeg';
  if (kind === 'video') return 'video/mp4';
  if (kind === 'image') return `${ext === 'png' ? 'image/png' : 'image/jpeg'}`;
  if (kind === 'document') {
    const map: Record<string, string> = {
      pdf: 'application/pdf',
      doc: 'application/msword',
      docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      xls: 'application/vnd.ms-excel',
      xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      ppt: 'application/vnd.ms-powerpoint',
      pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    };
    return map[ext] ?? 'application/octet-stream';
  }
  return undefined;
}

function basename(url: string): string {
  try {
    return url.split('/').pop()?.split('?')[0] ?? 'arquivo';
  } catch {
    return 'arquivo';
  }
}

export function createSendMediaTool(): ToolBase {
  return {
    definition: {
      name: 'enviar_midia_kb',
      description:
        'Envia para o lead uma mídia da Base de Conhecimento: áudio, vídeo, imagem ou ' +
        'documento. Use quando o lead pedir mais detalhes que existem em material gravado ' +
        'da base (áudio explicativo, vídeo de demonstração, catálogo em PDF). Informe a URL ' +
        'pública exata do arquivo (aparece como "Link: https://..." no contexto da base) e, ' +
        'se quiser, um texto curto acompanhando a mídia. Não invente URLs: use somente os ' +
        'links presentes no contexto da Base de Conhecimento.',
      parameters: {
        type: 'object',
        properties: {
          url: {
            type: 'string',
            description: 'URL pública do arquivo na Base de Conhecimento (link exato do contexto).',
          },
          caption: {
            type: 'string',
            description: 'Texto curto enviado junto com a mídia (opcional).',
          },
        },
        required: ['url'],
      },
    },
    permission: 'WHATSAPP',
    async execute(args, ctx) {
      const url = typeof args.url === 'string' ? args.url.trim() : '';
      if (!url) {
        return { ok: false, output: 'url é obrigatória.', error: 'invalid_args' };
      }
      if (ctx.source !== 'whatsapp') {
        return {
          ok: false,
          output: 'Esta ferramenta só funciona em conversas do WhatsApp.',
          error: 'tool_disabled',
        };
      }
      const leadPhone = ctx.leadPhone;
      if (!leadPhone) {
        return {
          ok: false,
          output: 'Número do lead não informado — não é possível enviar a mídia.',
          error: 'invalid_args',
        };
      }
      if (!hasEvolutionConfig() || isEvolutionMockMode()) {
        return {
          ok: false,
          output: 'Envio de mídia não configurado neste serviço.',
          error: 'tool_disabled',
        };
      }

      // Somente URLs do armazenamento público do Supabase (buckets da KB).
      const storageUrl = `${getSupabaseProspeccaoConfig().url}/storage/v1/object/public/`;
      const isStorageUrl =
        url.startsWith(`${storageUrl}consecom-media/`) || url.startsWith(`${storageUrl}consecom-video/`);
      if (!isStorageUrl) {
        return {
          ok: false,
          output: 'A URL precisa ser de um arquivo da Base de Conhecimento (armazenamento do app).',
          error: 'invalid_args',
        };
      }

      const kind = guessKind(url);
      const caption = typeof args.caption === 'string' && args.caption.trim() ? args.caption.trim() : `[${kind}]`;
      try {
        const res = await sendMedia({
          to: leadPhone,
          kind,
          media: url,
          caption,
          mimetype: guessMimetype(url, kind),
          filename: basename(url),
          instance: ctx.instance,
        });
        if (!res.ok) {
          return {
            ok: false,
            output: `Falha ao enviar a mídia: ${res.error ?? 'unknown error'}`,
            error: 'io_error',
          };
        }
        return { ok: true, output: 'Mídia enviada para o lead com sucesso.' };
      } catch (err) {
        return {
          ok: false,
          output: `Falha ao enviar a mídia: ${err instanceof Error ? err.message : 'unknown error'}`,
          error: 'io_error',
        };
      }
    },
  };
}