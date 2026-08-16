export type WelcomeSite = 'wepsy' | 'webmotors' | 'airbnb' | 'google' | 'global'

interface WelcomeCopy {
  title: string
  tagline: string
  subtitle: string
  siteName: string
  emoji: string
}

const COPY: Record<WelcomeSite, WelcomeCopy> = {
  wepsy: {
    title: 'Bem-vindo ao Vyntra',
    tagline: 'Cada conexão começa com um nome. Vamos encontrar os seus.',
    subtitle: 'Você está prospectando no',
    siteName: 'Wepsy',
    emoji: '💜',
  },
  webmotors: {
    title: 'Olá, prospector',
    tagline: 'A próxima loja que fecha é só um clique de distância.',
    subtitle: 'Você está prospectando no',
    siteName: 'WebMotors',
    emoji: '🚗',
  },
  airbnb: {
    title: 'Bem-vindo ao Vyntra',
    tagline: 'Onde tem anfitrião, tem oportunidade. Bora caçar.',
    subtitle: 'Você está prospectando no',
    siteName: 'Airbnb',
    emoji: '🏠',
  },
  google: {
    title: 'Bem-vindo ao Vyntra',
    tagline: 'A cidade está cheia de leads. Vamos mapeá-los.',
    subtitle: 'Você está prospectando no',
    siteName: 'Google Maps',
    emoji: '📍',
  },
  global: {
    title: 'Pronto pra prospectar',
    tagline: 'Sua próxima lista de leads está nessa página.',
    subtitle: 'Você está prospectando em',
    siteName: 'qualquer página',
    emoji: '🎯',
  },
}

function sessionKey(site: WelcomeSite): string {
  return `consecom-welcome-${site}`
}

const WELCOME_CSS = `
.vy-welcome {
  position: fixed; inset: 0; z-index: 2147483647;
  display: flex; align-items: center; justify-content: center;
  background: rgba(16,7,29,0.82);
  backdrop-filter: blur(18px) saturate(1.4);
  animation: vy-fade-in 0.45s ease-out;
  font-family: 'Inter', 'Segoe UI', system-ui, sans-serif;
}
.vy-welcome.leaving { animation: vy-fade-out 0.45s ease-out forwards; }
@keyframes vy-fade-in { from { opacity: 0; } to { opacity: 1; } }
@keyframes vy-fade-out { from { opacity: 1; } to { opacity: 0; } }

.vy-welcome__card {
  position: relative;
  background: linear-gradient(135deg, rgba(139,92,246,0.16), rgba(168,85,247,0.08));
  border: 1px solid rgba(139,92,246,0.35);
  border-radius: 24px;
  padding: 38px 42px 30px;
  max-width: 460px;
  width: calc(100% - 40px);
  text-align: center;
  color: #f5f3ff;
  box-shadow: 0 30px 80px rgba(0,0,0,0.5), inset 0 1px 0 rgba(255,255,255,0.08);
  animation: vy-card-in 0.65s cubic-bezier(0.16, 1, 0.3, 1);
  overflow: hidden;
}
.vy-welcome.leaving .vy-welcome__card { animation: vy-card-out 0.4s ease-in forwards; }
@keyframes vy-card-in {
  0% { opacity: 0; transform: translateY(42px) scale(0.9); }
  100% { opacity: 1; transform: translateY(0) scale(1); }
}
@keyframes vy-card-out {
  to { opacity: 0; transform: translateY(-24px) scale(0.95); }
}

.vy-welcome__logo {
  width: 76px; height: 76px;
  margin: 0 auto 20px;
  border-radius: 22px;
  display: flex; align-items: center; justify-content: center;
  font-weight: 800; font-size: 38px; font-style: italic; color: #fff;
  background: linear-gradient(135deg, #8b5cf6, #a855f7, #d946ef);
  box-shadow: 0 16px 40px rgba(139,92,246,0.5);
  animation: vy-logo-pop 0.85s 0.15s cubic-bezier(0.16, 1, 0.3, 1) backwards, vy-logo-glow 2.6s 1.2s ease-in-out infinite;
}
@keyframes vy-logo-pop {
  0% { transform: scale(0.4) rotate(-22deg); opacity: 0; }
  55% { transform: scale(1.12) rotate(6deg); }
  100% { transform: scale(1) rotate(0); }
}
@keyframes vy-logo-glow {
  0%, 100% { box-shadow: 0 16px 40px rgba(139,92,246,0.5); }
  50% { box-shadow: 0 16px 62px rgba(168,85,247,0.9), 0 0 34px rgba(217,70,239,0.45); }
}

.vy-welcome__title {
  font-size: 26px; font-weight: 800; letter-spacing: -0.02em; margin-bottom: 14px;
  background: linear-gradient(135deg, #fff, #c4b5fd);
  -webkit-background-clip: text; background-clip: text;
  -webkit-text-fill-color: transparent; color: transparent;
  animation: vy-text-up 0.5s 0.4s backwards;
}
.vy-welcome__site {
  display: inline-flex; align-items: center; gap: 8px;
  padding: 6px 16px; background: rgba(255,255,255,0.08); border-radius: 999px;
  font-size: 13px; font-weight: 600; color: #c4b5fd; margin-bottom: 18px;
  animation: vy-text-up 0.5s 0.55s backwards;
}
.vy-welcome__site b { color: #fff; font-weight: 700; }
.vy-welcome__emoji { font-size: 16px; }
.vy-welcome__tagline {
  font-size: 14px; color: #b9b1d6; line-height: 1.6; margin-bottom: 24px; font-style: italic;
  animation: vy-text-up 0.5s 0.7s backwards;
}
@keyframes vy-text-up {
  from { opacity: 0; transform: translateY(14px); }
  to { opacity: 1; transform: translateY(0); }
}

.vy-welcome__cta {
  background: linear-gradient(135deg, #8b5cf6, #a855f7);
  border: none; color: #fff; font-weight: 700;
  padding: 12px 30px; border-radius: 999px; font-size: 14px; cursor: pointer;
  letter-spacing: 0.02em; box-shadow: 0 12px 28px rgba(139,92,246,0.5);
  transition: transform 0.15s, box-shadow 0.2s, filter 0.15s;
  animation: vy-text-up 0.5s 0.85s backwards;
}
.vy-welcome__cta:hover { transform: translateY(-2px); box-shadow: 0 16px 38px rgba(139,92,246,0.75); filter: brightness(1.08); }
.vy-welcome__cta:active { transform: translateY(0); }

.vy-welcome__particles { position: absolute; inset: 0; pointer-events: none; overflow: hidden; }
.vy-welcome__particles span {
  position: absolute; width: 6px; height: 6px;
  background: rgba(168,85,247,0.65); border-radius: 50%;
  bottom: -10px;
  animation: vy-particle var(--t) var(--d) linear infinite;
}
@keyframes vy-particle {
  0% { transform: translateY(0) scale(0); opacity: 0; }
  10% { opacity: 1; }
  100% { transform: translateY(-120vh) scale(1); opacity: 0; }
}
`

export function showWelcome(site: WelcomeSite): void {
  try {
    if (sessionStorage.getItem(sessionKey(site))) return
    sessionStorage.setItem(sessionKey(site), '1')
  } catch {
    /* sessionStorage pode estar indisponível */
  }

  if (!document.getElementById('vy-welcome-css')) {
    const style = document.createElement('style')
    style.id = 'vy-welcome-css'
    style.textContent = WELCOME_CSS
    document.head.appendChild(style)
  }

  const cfg = COPY[site]
  const overlay = document.createElement('div')
  overlay.className = 'vy-welcome'
  overlay.innerHTML = `
    <div class="vy-welcome__card">
      <div class="vy-welcome__particles">${Array.from(
        { length: 26 },
        () => `<span style="left:${(Math.random() * 100).toFixed(2)}%;--d:${(Math.random() * 1.5).toFixed(2)}s;--t:${(2.2 + Math.random() * 3).toFixed(2)}s"></span>`,
      ).join('')}</div>
      <div class="vy-welcome__logo">V</div>
      <div class="vy-welcome__title">${cfg.title}</div>
      <div class="vy-welcome__site"><span class="vy-welcome__emoji">${cfg.emoji}</span><span>${cfg.subtitle} <b>${cfg.siteName}</b></span></div>
      <div class="vy-welcome__tagline">${cfg.tagline}</div>
      <button class="vy-welcome__cta">Vamos lá →</button>
    </div>
  `
  document.body.appendChild(overlay)

  const dismiss = () => overlay.classList.add('leaving')
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) dismiss()
  })
  overlay.querySelector('.vy-welcome__cta')?.addEventListener('click', dismiss)
  setTimeout(dismiss, 6000)
  setTimeout(() => overlay.remove(), 6800)
}

export function detectWelcomeSite(hostname: string, href: string): WelcomeSite | null {
  const h = hostname.toLowerCase()
  if (/(^|\.)wepsy\.com\.br$/.test(h)) return 'wepsy'
  if (/(^|\.)webmotors\.com\.br$/.test(h)) return 'webmotors'
  if (/(^|\.)airbnb\.com(\.br)?$/.test(h)) return 'airbnb'
  if (/(^|\.)google\.(com|com\.br|[a-z.]+)\/maps\//.test(href) || h.startsWith('maps.google')) return 'google'
  return 'global'
}