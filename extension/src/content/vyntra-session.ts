// Ponte mínima entre a sessão autenticada do painel e o popup da extensão.
// Não envia tokens para logs nem para páginas externas.
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== 'consecom:request-session') return false
  try {
    const prefix = 'sb-'
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i)
      if (!key?.startsWith(prefix) || !key.endsWith('-auth-token')) continue
      const raw = localStorage.getItem(key)
      if (!raw) continue
      const session = JSON.parse(raw) as { access_token?: string; refresh_token?: string }
      if (session.access_token && session.refresh_token) {
        sendResponse({ accessToken: session.access_token, refreshToken: session.refresh_token })
        return true
      }
    }
  } catch {
    // O popup exibirá a ausência de sessão sem expor detalhes.
  }
  sendResponse({ error: 'session_not_found' })
  return true
})
