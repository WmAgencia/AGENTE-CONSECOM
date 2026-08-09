import { App } from '@capacitor/app'
import { supabase } from './supabase'

// Deep-link de auto-login: o site (já logado) abre
//   consecom://auth?access_token=...&refresh_token=...&expires_in=...
// e o app troca isso por uma sessão permanente (via setSession), sem login.

export function parseAuthUrl(url: string): {
  accessToken?: string
  refreshToken?: string
} {
  try {
    const u = new URL(url)
    const get = (k: string) => u.searchParams.get(k) ?? undefined
    return {
      accessToken: get('access_token'),
      refreshToken: get('refresh_token'),
    }
  } catch {
    return {}
  }
}

export async function applyAuthUrl(url: string): Promise<boolean> {
  const { accessToken, refreshToken } = parseAuthUrl(url)
  if (!accessToken || !refreshToken) return false
  const { error } = await supabase.auth.setSession({
    access_token: accessToken,
    refresh_token: refreshToken,
  })
  return !error
}

export function registerDeepLinkHandler(onAuthed: () => void): () => void {
  let disposed = false
  void (async () => {
    const initial = await App.getLaunchUrl()
    if (initial?.url && initial.url.startsWith('consecom://')) {
      if (await applyAuthUrl(initial.url)) onAuthed()
    }
  })()

  void App.addListener('appUrlOpen', ({ url }) => {
    if (!url.startsWith('consecom://') || disposed) return
    void (async () => {
      if (await applyAuthUrl(url)) onAuthed()
    })()
  })

  return () => {
    disposed = true
  }
}
