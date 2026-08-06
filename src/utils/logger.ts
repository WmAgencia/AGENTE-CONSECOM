import pino, { type Logger } from 'pino';
import { getEnv } from '../config/env.js';

let logger: Logger | null = null;

export function getLogger(): Logger {
  if (logger) return logger;

  let level = 'info';
  try {
    level = getEnv().LOG_LEVEL;
  } catch {
    // env not loaded yet (e.g. during early import) - fall back to info
  }

  logger = pino({
    level,
    base: undefined,
    timestamp: pino.stdTimeFunctions.isoTime,
    redact: {
      paths: [
        // Never allow secrets to appear in logs
        'NVIDIA_API_KEY',
        'EVOLUTION_API_KEY',
        'WEBHOOK_SECRET',
        'DATABASE_URL',
        'apiKey',
        'apikey',
        'headers.authorization',
        'headers.apikey',
        'req.headers.authorization',
        'req.headers["x-api-key"]',
        'req.headers["apikey"]',
        'req.headers.apikey',
        // Never log full WhatsApp message text (privacy)
        'req.body.data.message',
        'data.message',
        'message.conversation',
        'message.extendedTextMessage',
      ],
      remove: true,
    },
  });
  return logger;
}
