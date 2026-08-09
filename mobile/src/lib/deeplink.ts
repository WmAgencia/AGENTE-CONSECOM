import { App } from '@capacitor/app'
import { supabase } from './supabase'

// Deep-link de auto-login: o site (já logado) abre
//   vyntra://auth?access_token=...&refresh_token=...
// e o app troca isso por uma sessão permanente (via setSession), sem login.

const AUTH_SCHEMES = ['vyntra://', 'consecom://']

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
  const isAuthUrl = (u: string) => AUTH_SCHEMES.some((s) => u.startsWith(s))
  void (async () => {
    const initial = await App.getLaunchUrl()
    if (initial?.url && isAuthUrl(initial.url)) {
      if (await applyAuthUrl(initial.url)) onAuthed()
    }
  })()

  void App.addListener('appUrlOpen', ({ url }) => {
    if (!isAuthUrl(url) || disposed) return
    void (async () => {
      if (await applyAuthUrl(url)) onAuthed()
    })()
  })

  return () => {
    disposed = true
  }
}
