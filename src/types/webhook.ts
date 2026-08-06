/**
 * Zod schemas for Evolution API webhook payloads (MVP subset).
 *
 * Reference: Evolution API v2 emits POST payloads with shape:
 *   { event, instance, data: { key, message, pushName, ... }, ... }
 *
 * Only fields used by this MVP are typed strictly. Unknown extra fields
 * (sent by Evolution) are ignored via .passthrough() so we don't break on
 * forward-compatible additions.
 *
 * Security note: contents of `message` are sensitive (WhatsApp text) and
 * MUST NOT be logged. Only structural metadata is logged elsewhere.
 */
import { z } from 'zod';

export const evolutionMessageKeySchema = z.object({
  id: z.string().optional(),
  remoteJid: z.string().optional(),
  fromMe: z.boolean().optional(),
  participant: z.string().optional(),
}).passthrough();

export const evolutionMessageBodySchema = z.object({
  conversation: z.string().optional(),
  extendedTextMessage: z
    .object({ text: z.string().optional() })
    .passthrough()
    .optional(),
}).passthrough();

export const evolutionDataSchema = z.object({
  key: evolutionMessageKeySchema,
  message: evolutionMessageBodySchema.optional(),
  pushName: z.string().optional(),
  messageType: z.string().optional(),
}).passthrough();

export const evolutionWebhookPayloadSchema = z.object({
  event: z.string(),
  instance: z.string().optional(),
  data: evolutionDataSchema.optional(),
  destination: z.string().optional(),
  date_time: z.string().optional(),
  sender: z.string().optional(),
}).passthrough();

export type EvolutionWebhookPayload = z.infer<typeof evolutionWebhookPayloadSchema>;
export type EvolutionMessageKey = z.infer<typeof evolutionMessageKeySchema>;
export type EvolutionData = z.infer<typeof evolutionDataSchema>;

/**
 * Result returned by the webhook route to the caller (Evolution API).
 * Kept minimal so the Evolution side only knows whether the event was
 * accepted for processing, not the agent's response content.
 */
export interface WebhookAcknowledgement {
  accepted: boolean;
  reason?:
    | 'invalid_secret'
    | 'invalid_payload'
    | 'server_misconfigured'
    | 'unsupported_event'
    | 'instance_not_allowed'
    | 'group_not_allowed'
    | 'mention_required'
    | 'from_me'
    | 'no_text'
    | 'duplicate'
    | 'ignored';
  messageKeyId?: string;
  message?: string;
}

/**
 * Extracts text and sender from a validated Evolution payload.
 * Returns null when there is no usable text (e.g. audio/image/sticker).
 */
export interface ExtractedMessage {
  text: string;
  from: string;          // remoteJid (e.g. "5511999999999@s.whatsapp.net")
  fromMe: boolean;
  messageKeyId: string | undefined;
  pushName: string | undefined;
  isGroup: boolean;
  instance: string | undefined;
  mentionedJids: string[];
}

export function extractMessage(payload: EvolutionWebhookPayload): ExtractedMessage | null {
  const data = payload.data;
  if (!data) return null;
  const key = data.key ?? {};
  const message = data.message ?? {};

  const text =
    message.conversation ??
    message.extendedTextMessage?.text ??
    '';

  const from = key.remoteJid ?? '';
  const fromMe = key.fromMe === true;
  const messageKeyId = key.id;

  if (!text || !from) return null;
  if (fromMe) return null; // anti-loop: never process own outgoing messages

  const isGroup = from.endsWith('@g.us');
  const instance = payload.instance;

  // Evolution v2 puts mentioned JIDs at message.extendedTextMessage.mentionedJid
  // (string array). We don't strictly type this since it's optional and
  // missing in many payloads; passthrough already keeps the raw field.
  const mentionedJids: string[] = [];
  const rawMentions = (message as { extendedTextMessage?: { mentionedJid?: string[] } })
    .extendedTextMessage?.mentionedJid;
  if (Array.isArray(rawMentions)) {
    for (const jid of rawMentions) {
      if (typeof jid === 'string') mentionedJids.push(jid);
    }
  }

  return {
    text,
    from,
    fromMe,
    messageKeyId,
    pushName: data.pushName,
    isGroup,
    instance,
    mentionedJids,
  };
}
