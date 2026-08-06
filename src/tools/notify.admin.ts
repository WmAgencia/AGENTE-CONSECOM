/**
 * Tool: notify_admin_group
 * Permission: WHATSAPP
 *
 * Sends a WhatsApp message to the admin group (AGENT_ADMIN_GROUP_JID) through
 * the Evolution API when a client is left waiting and the agent could not
 * resolve the request. The message should tell the team who is waiting and why.
 *
 * If the group JID or Evolution API is not configured here, returns ok:false
 * so the agent falls back to a natural reply ("A Samira vai te atender assim
 * que puder") and never exposes the technical failure to the client.
 */
import type { ToolBase } from './registry.js';
import { getEnv, hasEvolutionConfig } from '../config/env.js';
import { isEvolutionMockMode, sendGroupText } from '../services/evolution.service.js';

export function createNotifyAdminGroupTool(): ToolBase {
  return {
    definition: {
      name: 'notify_admin_group',
      description:
        'Sends a WhatsApp message to the internal admin group to report that a ' +
        'client is waiting for a reply from Samira. Pass the client name/number ' +
        'and the reason in the message. Use only when you could not resolve the ' +
        'request and need the team to handle it.',
      parameters: {
        type: 'object',
        properties: {
          message: {
            type: 'string',
            description:
              'The notification text for the admin group, e.g. "Cliente Maria (55 11 99999-9999) aguardando resposta sobre horário de 07/08 15h."',
          },
        },
        required: ['message'],
      },
    },
    permission: 'WHATSAPP',
    async execute(args) {
      const message = typeof args.message === 'string' ? args.message.trim() : '';
      if (!message) {
        return { ok: false, output: 'message is required.', error: 'invalid_args' };
      }
      const groupJid = getEnv().AGENT_ADMIN_GROUP_JID;
      if (!groupJid) {
        return {
          ok: false,
          output: 'AGENT_ADMIN_GROUP_JID is not configured on the server.',
          error: 'tool_disabled',
        };
      }
      if (!hasEvolutionConfig() || isEvolutionMockMode()) {
        return {
          ok: false,
          output: 'Evolution API is not configured for this agent service.',
          error: 'tool_disabled',
        };
      }
      const result = await sendGroupText(groupJid, message);
      if (!result.ok) {
        return {
          ok: false,
          output: `Falha ao notificar o grupo: ${result.error ?? 'unknown error'}`,
          error: 'io_error',
        };
      }
      return { ok: true, output: 'Grupo de administração notificado com sucesso.' };
    },
  };
}