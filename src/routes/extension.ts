/**
 * Extensão Vyntra Prospector — download do build publicado.
 *
 * GET /api/extension/download
 *   Retorna a URL pública do zip mais recente no Supabase Storage
 *     { url, bucket, path, version }
 *   (Não exige auth: o próprio zip é público no bucket.)
 *
 * GET /api/extension/version
 *   Metadados mínimos: versão do manifesto + link de download.
 */
import type { FastifyInstance } from 'fastify'
import { getEnv, getSupabaseProspeccaoConfig } from '../config/env.js'
import { getLogger } from '../utils/logger.js'

/** Versão do manifesto da extensão publicada (mantenha em sincronia com manifest.ts). */
const VERSION = '1.3.0'

export function registerExtensionRoutes(app: FastifyInstance): void {
  app.get('/api/extension/download', async (_req, reply) => {
    const log = getLogger()
    const cfg = getSupabaseProspeccaoConfig()
    const env = getEnv()
    if (!cfg.url) {
      log.warn('extension: SUPABASE_URL não configurada')
      return reply.status(503).send({
        error: 'server_misconfigured',
        message: 'SUPABASE_URL não configurada no backend',
        statusCode: 503,
      })
    }
    const bucket = env.EXTENSION_BUCKET
    const objectPath = env.EXTENSION_OBJECT_PATH
    const base = cfg.url.replace(/\/+$/, '')
    const url = `${base}/storage/v1/object/public/${bucket}/${objectPath}`
    return reply.status(200).send({
      url,
      bucket,
      path: objectPath,
      version: VERSION,
    })
  })

  app.get('/api/extension/version', async (_req, reply) => {
    const env = getEnv()
    return reply.status(200).send({
      version: VERSION,
      bucket: env.EXTENSION_BUCKET,
      path: env.EXTENSION_OBJECT_PATH,
    })
  })
}
