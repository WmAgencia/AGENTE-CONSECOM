import { supabase } from './supabase'

const BACKEND = import.meta.env.VITE_BACKEND_URL as string | undefined
const API = BACKEND ?? 'https://consecom-backend-production.up.railway.app'

export interface DownloadResult {
  ok: boolean
  message: string
}

/**
 * Baixa o .zip da extensão PERSONALIZADO para a conta logada no Vyntra.
 * O backend injeta `auto-config.json` com extensionKey + ownerUserId, então a
 * extensão já nasce vinculada à conta — sem login nem token na extensão.
 */
export async function downloadPersonalizedExtension(): Promise<DownloadResult> {
  // Tenta renovar a sessão primeiro (conserta refresh token velho/corrompido
  // gravado no localStorage). Sem sessão válida, cai no fluxo sem refresh.
  let session = (await supabase.auth.refreshSession()).data.session
  if (!session) {
    session = (await supabase.auth.getSession()).data.session
  }
  if (!session?.access_token) {
    return { ok: false, message: 'Sessão expirada. Entre novamente no Vyntra.' }
  }

  const res = await fetch(`${API}/api/extension/download`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${session.access_token}`,
    },
    body: JSON.stringify({}),
  })

  if (!res.ok) {
    let detail = ''
    try {
      const body = (await res.json()) as { message?: string }
      detail = body.message ?? ''
    } catch {
      /* corpo não-json */
    }
    return { ok: false, message: `Não foi possível gerar a extensão (HTTP ${res.status}). ${detail}`.trim() }
  }

  const blob = await res.blob()
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = 'consecom-extension.zip'
  document.body.appendChild(a)
  a.click()
  a.remove()
  URL.revokeObjectURL(url)
  return { ok: true, message: 'Extensão baixada já vinculada à sua conta.' }
}