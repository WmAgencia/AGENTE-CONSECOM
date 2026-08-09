/**
 * Publica o build da extensão Vyntra Prospector no Supabase Storage.
 *
 * Uso:
 *   node scripts/publish.mjs
 *
 * Variáveis de ambiente necessárias (lidas do .env do backend ou exportadas):
 *   SUPABASE_URL                       ex: https://<ref>.supabase.co
 *   SUPABASE_SERVICE_ROLE_KEY          service_role (NAO anon)
 *   EXTENSION_BUCKET                   (opcional, default: consecom-media)
 *   EXTENSION_OBJECT_PATH              (opcional, default: extensions/vyntra-prospector.zip)
 *
 * O bucket `consecom-media` já é público para leitura, então após o upload
 * qualquer pessoa consegue baixar pela URL pública retornada ao final.
 *
 * Pré-requisito: rode `npm run build` antes (gera dist/).
 */
import { readdir, readFile, stat } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import process from 'node:process'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, '..')

function env(name, fallback) {
  const v = process.env[name] ?? fallback
  if (!v) {
    console.error(`[publish] variável de ambiente ausente: ${name}`)
    process.exit(1)
  }
  return v
}

async function main() {
  const supabaseUrl = env('SUPABASE_URL').replace(/\/+$/, '')
  const serviceKey = env('SUPABASE_SERVICE_ROLE_KEY')
  const bucket = process.env.EXTENSION_BUCKET ?? 'consecom-media'
  const objectPath = process.env.EXTENSION_OBJECT_PATH ?? 'extensions/vyntra-prospector.zip'

  const distDir = join(ROOT, 'dist')
  if (!existsSync(distDir)) {
    console.error('[publish] dist/ não encontrado. Rode `npm run build` antes.')
    process.exit(1)
  }

  // Empacota dist/ em vyntra-prospector.zip (no root da extensão)
  const zipPath = join(ROOT, 'vyntra-prospector.zip')
  // Remove zip antigo se existir e cria novamente via PowerShell (Windows) ou zip (unix)
  const isWindows = process.platform === 'win32'
  if (isWindows) {
    spawnSync('powershell', ['-NoProfile', '-Command', `Compress-Archive -Path dist\\* -DestinationPath vyntra-prospector.zip -Force`], { cwd: ROOT, stdio: 'inherit' })
  } else {
    spawnSync('zip', ['-r', '-j', 'vyntra-prospector.zip', 'dist/'], { cwd: ROOT, stdio: 'inherit' })
  }

  if (!existsSync(zipPath)) {
    console.error('[publish] falha ao gerar vyntra-prospector.zip')
    process.exit(1)
  }

  const bytes = await readFile(zipPath)
  console.log(`[publish] zip gerado (${(bytes.length / 1024).toFixed(1)} KB) -> ${zipPath}`)
  console.log(`[publish] subindo para ${bucket}/${objectPath} ...`)

  // Upload via Supabase Storage REST API (upsert).
  const upsertUrl = `${supabaseUrl}/storage/v1/object/${encodeURIComponent(bucket)}/${objectPath}`
  const res = await fetch(upsertUrl, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${serviceKey}`,
      apikey: serviceKey,
      'Content-Type': 'application/zip',
      'x-upsert': 'true',
    },
    body: bytes,
  })
  const text = await res.text()
  if (!res.ok) {
    console.error(`[publish] upload falhou (${res.status}): ${text}`)
    process.exit(1)
  }

  const publicUrl = `${supabaseUrl}/storage/v1/object/public/${bucket}/${objectPath}`
  console.log('----')
  console.log('[publish] upload OK')
  console.log(`[publish] url pública: ${publicUrl}`)
  console.log('----')
}

main().catch((err) => {
  console.error('[publish] erro:', err)
  process.exit(1)
})
