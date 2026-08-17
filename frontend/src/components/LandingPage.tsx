import { useEffect, useState, useRef } from 'react'
import { useNavigate, Link } from 'react-router-dom'
import {
  ArrowRight,
  Menu,
  X,
  Search,
  MessageSquareText,
  Bot,
  Target,
  TrendingUp,
  ShieldCheck,
  Plug,
  Zap,
  CalendarDays,
  Users,
  Puzzle,
  Sparkles,
  Check,
  Download,
  Smartphone,
  BarChart3,
  PhoneCall,
  ChevronDown,
  CheckCircle2,
  HelpCircle,
} from 'lucide-react'
import { Button, Modal } from './ui'
import { saasApi, type SaasPlan, formatBRL } from '../lib/api'

type MercadoClient = { createCardToken(input: Record<string, string>): Promise<{ id?: string }>; getPaymentMethods(input: { bin: string }): Promise<Array<{ id?: string; issuer?: { id?: string } }>> }
async function loadMercadoClient(): Promise<MercadoClient> {
  const key = await saasApi.paymentPublicKey()
  if (!key) throw new Error('Checkout ainda não configurado para cartão.')
  const win = window as unknown as { MercadoPago?: (key: string, options: { locale: string }) => MercadoClient }
  if (!win.MercadoPago) await new Promise<void>((resolve, reject) => { const s = document.createElement('script'); s.src = 'https://sdk.mercadopago.com/js/v2'; s.onload = () => resolve(); s.onerror = () => reject(new Error('Não foi possível carregar o checkout.')); document.head.appendChild(s) })
  const factory = (window as unknown as { MercadoPago?: (key: string, options: { locale: string }) => MercadoClient }).MercadoPago
  if (!factory) throw new Error('SDK do Mercado Pago indisponível.')
  return factory(key, { locale: 'pt-BR' })
}

const NAV_LINKS = [
  { label: 'Problema', id: 'problema' },
  { label: 'Solução', id: 'solucao' },
  { label: 'Como funciona', id: 'como-funciona' },
  { label: 'Recursos', id: 'recursos' },
  { label: 'Planos', id: 'planos' },
  { label: 'FAQ', id: 'faq' },
]

function scrollTo(id: string) {
  document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' })
}

/** Reveal on scroll: adiciona .is-visible quando o elemento entra no viewport. */
function useReveal<T extends HTMLElement>() {
  const ref = useRef<T | null>(null)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const obs = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (e.isIntersecting) {
            e.target.classList.add('is-visible')
            obs.unobserve(e.target)
          }
        }
      },
      { threshold: 0.12 },
    )
    obs.observe(el)
    return () => obs.disconnect()
  }, [])
  return ref
}

/** Parallax suave no eixo Y conforme o scroll (desabilitado com reduced-motion). */
function useParallax(strength = 30) {
  const ref = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return
    let raf = 0
    const onScroll = () => {
      cancelAnimationFrame(raf)
      raf = requestAnimationFrame(() => {
        const rect = el.getBoundingClientRect()
        if (rect.bottom < 0 || rect.top > window.innerHeight) return
        const progress = (window.innerHeight / 2 - rect.top) / window.innerHeight
        el.style.transform = `translate3d(0, ${Math.round(progress * strength)}px, 0)`
      })
    }
    window.addEventListener('scroll', onScroll, { passive: true })
    onScroll()
    return () => {
      window.removeEventListener('scroll', onScroll)
      cancelAnimationFrame(raf)
    }
  }, [strength])
  return ref
}

const FAQS = [
  { q: 'Preciso instalar alguma coisa?', a: 'Sim, uma extensão leve para o Chrome. Ela funciona como um painel flutuante ao lado das suas buscas: captura leads, telefone e CNPJ em um clique — sem quebrar o seu fluxo de trabalho.' },
  { q: 'Como funciona a integração com o WhatsApp?', a: 'Você conecta uma instância da Evolution API no painel. A partir daí, as campanhas disparam mensagens, a IA responde e qualifica, e você acompanha tudo com histórico completo.' },
  { q: 'A IA substitui a minha conversa?', a: 'Não. A IA cuida da triagem e das primeiras respostas, identifica interesse e agenda reuniões — mas você decide. Toda conversa pode ser assumida por você a qualquer momento.' },
  { q: 'Meus dados estão seguros?', a: 'Sim. O acesso é por usuário autorizado, os dados são protegidos por RLS (row-level security) e cada workspace opera isolado dos demais.' },
  { q: 'Funciona para o meu tipo de negócio?', a: 'O Vyntra é feito para vendas B2B que usam pesquisa ativa: prestadores de serviços, consultorias, psicólogos, imobiliárias, concessionárias e agências — o fluxo é o mesmo: encontrar, conversar e converter.' },
  { q: 'Posso cancelar quando quiser?', a: 'Sim. A assinatura é controlada por você no painel e o acesso é interrompido ao final do período vigente.' },
]

function SectionTitle({ eyebrow, title, subtitle }: { eyebrow: string; title: string; subtitle: string }) {
  const ref = useReveal<HTMLDivElement>()
  return (
    <div ref={ref} className="max-w-2xl mx-auto text-center mb-14 reveal">
      <span className="inline-flex items-center gap-1.5 text-xs font-semibold uppercase tracking-widest text-accent-600 bg-subtle-2 border border-line rounded-full px-3 py-1">
        <Sparkles className="w-3.5 h-3.5" />
        {eyebrow}
      </span>
      <h2 className="text-3xl sm:text-4xl font-extrabold tracking-tight mt-4">{title}</h2>
      <p className="text-muted mt-3 text-lg leading-relaxed">{subtitle}</p>
    </div>
  )
}

function Feature({ icon, title, desc, delay = 0 }: { icon: React.ReactNode; title: string; desc: string; delay?: number }) {
  const ref = useReveal<HTMLDivElement>()
  return (
    <div
      ref={ref}
      className="group rounded-2xl border border-line bg-panel p-6 shadow-1 transition-all duration-300 hover:shadow-3 hover:-translate-y-1 reveal"
      style={{ animationDelay: `${delay}ms` }}
    >
      <div className="w-11 h-11 rounded-xl bg-gradient-to-br from-accent-500 to-accent-700 flex items-center justify-center text-white shadow-2 mb-4">
        {icon}
      </div>
      <h3 className="font-semibold text-base">{title}</h3>
      <p className="text-sm text-muted mt-2 leading-relaxed">{desc}</p>
    </div>
  )
}

function Step({ n, title, desc }: { n: string; title: string; desc: string }) {
  return (
    <div className="relative flex gap-5">
      <div className="flex flex-col items-center">
        <div className="w-10 h-10 rounded-full bg-gradient-to-br from-accent-500 to-accent-700 text-white font-bold flex items-center justify-center shadow-2 shrink-0">
          {n}
        </div>
        <div className="w-px flex-1 bg-line-2 my-2" />
      </div>
      <div className="pb-10">
        <h3 className="font-semibold text-base">{title}</h3>
        <p className="text-sm text-muted mt-1.5 leading-relaxed">{desc}</p>
      </div>
    </div>
  )
}

function HeroVisual() {
  const parallax = useParallax(18)
  return (
    <div className="relative">
      <div className="absolute -inset-6 bg-gradient-to-tr from-accent-500/20 to-accent-300/10 rounded-[2rem] blur-2xl" />
      <div ref={parallax} className="relative rounded-3xl border border-line bg-sidebar shadow-4 overflow-hidden animate-fade-in-up" style={{ animationDelay: '120ms' }}>
        <div className="flex items-center gap-2 px-4 py-3 border-b border-line bg-subtle">
          <span className="w-3 h-3 rounded-full bg-line-strong" />
          <span className="w-3 h-3 rounded-full bg-line-strong" />
          <span className="w-3 h-3 rounded-full bg-line-strong" />
          <div className="ml-3 text-[11px] text-faint font-medium">painel.vyntra.com</div>
        </div>

        <div className="p-5 space-y-4">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-xl bg-gradient-to-br from-accent-500 to-accent-700 flex items-center justify-center text-sm font-extrabold text-white shadow-2">V</div>
            <div>
              <div className="text-sm font-semibold leading-none">Vyntra</div>
              <div className="text-[11px] text-faint mt-1">Painel de Prospecção Inteligente</div>
            </div>
            <div className="ml-auto flex items-center gap-1.5 text-[11px] text-faint">
              <span className="w-2 h-2 rounded-full bg-accent-500 animate-pulse-soft" />
              Conectado
            </div>
          </div>

          <div className="grid grid-cols-3 gap-3">
            {[
              { label: 'Leads ativos', value: '—' },
              { label: 'Reuniões', value: '—' },
              { label: 'Fechamentos', value: '—' },
            ].map((m) => (
              <div key={m.label} className="rounded-xl border border-line bg-subtle p-3">
                <div className="text-[10px] text-faint">{m.label}</div>
                <div className="text-sm font-bold mt-1">{m.value}</div>
              </div>
            ))}
          </div>

          <div className="rounded-xl border border-line bg-subtle p-4 space-y-3">
            <div className="flex items-center gap-2 text-xs font-semibold">
              <BarChart3 className="w-4 h-4 text-accent-600" />
              Desempenho da campanha
            </div>
            {[72, 55, 84, 66, 90].map((w, i) => (
              <div key={i} className="flex items-center gap-2">
                <div className="w-24 text-[10px] text-faint">Fase {i + 1}</div>
                <div className="flex-1 h-2 rounded-full bg-line/60">
                  <div
                    className="h-2 rounded-full bg-gradient-to-r from-accent-600 to-accent-400"
                    style={{ width: `${w}%`, opacity: 0.4 + i * 0.12 }}
                  />
                </div>
              </div>
            ))}
          </div>

          <div className="rounded-xl border border-line bg-chat-in p-3 flex items-start gap-3 shadow-1">
            <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-accent-500 to-accent-700 flex items-center justify-center text-white shrink-0">
              <MessageSquareText className="w-4 h-4" />
            </div>
            <div>
              <div className="text-xs font-semibold">WhatsApp</div>
              <div className="text-[11px] text-muted mt-0.5">Respostas automáticas com IA, contexto e follow-up na hora certa.</div>
            </div>
          </div>
        </div>
      </div>

      <div className="absolute -bottom-6 -left-8 hidden sm:block rounded-2xl border border-line bg-panel shadow-3 px-4 py-3 animate-fade-in-up" style={{ animationDelay: '260ms' }}>
        <div className="flex items-center gap-2 text-xs font-semibold">
          <PhoneCall className="w-4 h-4 text-accent-600" />
          Lembrete de reunião
        </div>
        <div className="text-[11px] text-muted mt-1">Voz programada para 10 min antes</div>
      </div>
    </div>
  )
}

export function LandingPage() {
  const navigate = useNavigate()
  const [open, setOpen] = useState(false)
  const [plans, setPlans] = useState<SaasPlan[]>([])
  const [openFaq, setOpenFaq] = useState<number | null>(0)
  const [checkoutPlan, setCheckoutPlan] = useState<SaasPlan | null>(null)
  const [checkoutMethod, setCheckoutMethod] = useState<'pix' | 'card'>('pix')
  const [checkoutBusy, setCheckoutBusy] = useState(false)
  const [checkoutMsg, setCheckoutMsg] = useState('')
  const [checkoutPix, setCheckoutPix] = useState<string | null>(null)
  const [checkoutForm, setCheckoutForm] = useState({ name: '', email: '', password: '', cpf: '', phone: '', number: '', holder: '', month: '', year: '', cvv: '' })

  useEffect(() => {
    saasApi.plans().then(setPlans).catch(() => setPlans([]))
  }, [])

  async function submitLandingCheckout() {
    if (!checkoutPlan) return
    setCheckoutBusy(true)
    setCheckoutMsg('')
    try {
      let cardToken: string | undefined
      let paymentMethodId: string | undefined
      let issuerId: string | undefined
      if (checkoutMethod === 'card') {
        const mp = await loadMercadoClient()
        const token = await mp.createCardToken({ cardNumber: checkoutForm.number.replace(/\D/g, ''), cardholderName: checkoutForm.holder, cardExpirationMonth: checkoutForm.month, cardExpirationYear: checkoutForm.year, securityCode: checkoutForm.cvv, identificationType: 'CPF', identificationNumber: checkoutForm.cpf.replace(/\D/g, '') })
        cardToken = token.id
        const methods = await mp.getPaymentMethods({ bin: checkoutForm.number.replace(/\D/g, '').slice(0, 6) })
        paymentMethodId = methods[0]?.id
        issuerId = methods[0]?.issuer?.id
        if (!cardToken || !paymentMethodId) throw new Error('Não foi possível validar o cartão.')
      }
      const result = await saasApi.publicCheckout({ planId: checkoutPlan.id, name: checkoutForm.name, email: checkoutForm.email, password: checkoutForm.password, cpf: checkoutForm.cpf, phone: checkoutForm.phone, method: checkoutMethod, cardToken, paymentMethodId, issuerId, installments: 1 })
      if (result.qrCode) { setCheckoutPix(result.qrCode); setCheckoutMsg('Conta criada. Pague o Pix para ativar seu plano.') }
      else { setCheckoutMsg('Conta criada e pagamento enviado. Você já pode entrar no painel.'); setTimeout(() => navigate('/login'), 1200) }
    } catch (e) { setCheckoutMsg(e instanceof Error ? e.message : 'Não foi possível concluir o cadastro e pagamento.') }
    finally { setCheckoutBusy(false) }
  }

  return (
    <div className="min-h-screen bg-app text-fg overflow-x-hidden">
      <header className="fixed top-0 inset-x-0 z-50 border-b border-line/70 bg-app/80 backdrop-blur-xl">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 h-16 flex items-center gap-4">
          <Link to="/" className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-accent-500 to-accent-700 flex items-center justify-center text-sm font-extrabold text-white shadow-2">V</div>
            <span className="font-semibold text-lg tracking-tight">Vyntra</span>
          </Link>

          <nav className="hidden lg:flex items-center gap-6 ml-10 text-sm text-secondary">
            {NAV_LINKS.map((l) => (
              <button key={l.id} onClick={() => scrollTo(l.id)} className="hover:text-fg transition-colors font-medium">
                {l.label}
              </button>
            ))}
          </nav>

          <div className="ml-auto flex items-center gap-3">
            <Button variant="ghost" size="sm" onClick={() => navigate('/login')} className="hidden sm:inline-flex">
              Entrar
            </Button>
            <Button size="sm" variant="gradient" onClick={() => navigate('/login')} icon={<ArrowRight className="w-4 h-4" />}>
              Começar agora
            </Button>
            <button
              className="lg:hidden p-2 rounded-lg text-secondary hover:bg-subtle hover:text-fg transition"
              onClick={() => setOpen(!open)}
              aria-label="Abrir menu"
            >
              {open ? <X className="w-5 h-5" /> : <Menu className="w-5 h-5" />}
            </button>
          </div>
        </div>

        {open && (
          <nav className="lg:hidden border-t border-line bg-sidebar px-4 py-4 space-y-1 animate-fade-in">
            {NAV_LINKS.map((l) => (
              <button
                key={l.id}
                onClick={() => { setOpen(false); scrollTo(l.id) }}
                className="w-full text-left px-3 py-2.5 rounded-lg text-sm font-medium text-secondary hover:bg-subtle hover:text-fg transition"
              >
                {l.label}
              </button>
            ))}
            <button
              onClick={() => { setOpen(false); navigate('/login') }}
              className="w-full text-left px-3 py-2.5 rounded-lg text-sm font-semibold text-accent-600 hover:bg-subtle transition"
            >
              Entrar no painel
            </button>
          </nav>
        )}
      </header>

      {/* HERO */}
      <section className="relative pt-32 pb-20 px-4 sm:px-6 lg:px-8">
        <div className="pointer-events-none absolute -top-40 -left-40 w-[34rem] h-[34rem] rounded-full opacity-40"
          style={{ background: 'radial-gradient(circle, var(--c-accent-200), transparent 70%)', filter: 'blur(100px)' }} />
        <div className="pointer-events-none absolute top-20 -right-40 w-[30rem] h-[30rem] rounded-full opacity-30"
          style={{ background: 'radial-gradient(circle, var(--c-accent-300), transparent 70%)', filter: 'blur(110px)' }} />

        <div className="max-w-7xl mx-auto grid lg:grid-cols-2 gap-16 items-center relative">
          <div>
            <span className="inline-flex items-center gap-2 text-xs font-semibold text-accent-600 bg-subtle-2 border border-line rounded-full px-3 py-1.5 animate-fade-in-up">
              <Zap className="w-3.5 h-3.5" />
              Plataforma de prospecção com IA
            </span>
            <h1 className="text-4xl sm:text-5xl lg:text-6xl font-extrabold tracking-tight mt-6 leading-[1.05] animate-fade-in-up" style={{ animationDelay: '60ms' }}>
              Prospecte no
              <span className="text-transparent bg-clip-text bg-gradient-to-r from-accent-600 to-accent-400"> Google,</span>
              <br />
              venda no WhatsApp.
            </h1>
            <p className="text-lg text-muted mt-6 leading-relaxed max-w-xl animate-fade-in-up" style={{ animationDelay: '120ms' }}>
              O Vyntra transforma a pesquisa de leads, a importação, as campanhas de WhatsApp e o
              acompanhamento comercial em um fluxo único — com IA cuidando das conversas e do follow-up.
            </p>
            <div className="flex flex-col sm:flex-row gap-3 mt-8 animate-fade-in-up" style={{ animationDelay: '180ms' }}>
              <Button size="lg" variant="gradient" onClick={() => navigate('/login')} icon={<ArrowRight className="w-5 h-5" />} className="sm:!h-14 sm:!px-7 sm:!text-base">
                Começar agora
              </Button>
              <Button size="lg" variant="outline" onClick={() => scrollTo('como-funciona')} className="sm:!h-14 sm:!px-7 sm:!text-base">
                Ver como funciona
              </Button>
            </div>
            <div className="flex flex-wrap gap-x-6 gap-y-2 mt-8 text-xs text-faint animate-fade-in-up" style={{ animationDelay: '240ms' }}>
              {['Extensão para Chrome', 'Integração WhatsApp', 'Agente de voz', 'IA conversacional'].map((t) => (
                <span key={t} className="inline-flex items-center gap-1.5">
                  <Check className="w-3.5 h-3.5 text-accent-500" />
                  {t}
                </span>
              ))}
            </div>
          </div>

          <HeroVisual />
        </div>
      </section>

      {/* PROBLEMA */}
      <section id="problema" className="py-20 px-4 sm:px-6 lg:px-8 bg-sidebar border-y border-line">
        <div className="max-w-7xl mx-auto grid lg:grid-cols-2 gap-14 items-center">
          <div>
            <SectionTitle eyebrow="O problema" title="Prospecção manual consome o seu dia" subtitle="" />
            <div className="text-center">
              <p className="text-muted text-lg leading-relaxed -mt-10">
                Buscar empresas no Google, copiar dados, salvar em planilha, mandar mensagem por
                mensagem e lembrar de cada follow-up — assim a prospecção vira um buraco de tempo e
                oportunidades se perdem no meio do caminho.
              </p>
            </div>
          </div>
          <div className="grid sm:grid-cols-2 gap-4">
            {[
              { icon: <Search className="w-5 h-5" />, title: 'Horas perdidas pesquisando', desc: 'Coleta manual de telefone, e-mail e CNPJ de cada empresa.' },
              { icon: <MessageSquareText className="w-5 h-5" />, title: 'Mensagens repetitivas', desc: 'Copiar e colar a mesma abordagem para dezenas de contatos.' },
              { icon: <CalendarDays className="w-5 h-5" />, title: 'Follow-up esquecido', desc: 'Leads esfriam porque ninguém acompanha na hora certa.' },
              { icon: <TrendingUp className="w-5 h-5" />, title: 'Sem visão do funil', desc: 'Nenhuma métrica clara de onde vendas se perdem ou convertem.' },
            ].map((f) => (
              <div key={f.title} className="rounded-2xl border border-line bg-app p-5">
                <div className="w-10 h-10 rounded-xl bg-subtle-2 text-accent-600 flex items-center justify-center mb-3">{f.icon}</div>
                <h3 className="font-semibold text-sm">{f.title}</h3>
                <p className="text-xs text-muted mt-1.5 leading-relaxed">{f.desc}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* SOLUÇÃO */}
      <section id="solucao" className="py-20 px-4 sm:px-6 lg:px-8">
        <div className="max-w-7xl mx-auto">
          <SectionTitle
            eyebrow="A solução"
            title="Um fluxo de vendas completo em um só lugar"
            subtitle="Do primeiro clique na pesquisa até a conversa no WhatsApp e o fechamento — tudo automatizado e com contexto."
          />
          <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-4">
            {[
              { icon: <Search className="w-5 h-5" />, title: 'Encontre', desc: 'Busque empresas e capture leads direto do painel com a extensão.' },
              { icon: <Users className="w-5 h-5" />, title: 'Organize', desc: 'Importe listas, qualifique e distribua no Kanban de vendas.' },
              { icon: <MessageSquareText className="w-5 h-5" />, title: 'Converse', desc: 'Dispare campanhas no WhatsApp com IA respondendo e qualificando.' },
              { icon: <TrendingUp className="w-5 h-5" />, title: 'Converta', desc: 'Acompanhe reuniões, follow-ups e fechamentos com métricas em tempo real.' },
            ].map((s) => (
              <div key={s.title} className="rounded-2xl border border-line bg-panel p-6 shadow-1">
                <div className="w-11 h-11 rounded-xl bg-gradient-to-br from-accent-500 to-accent-700 text-white flex items-center justify-center mb-4">{s.icon}</div>
                <h3 className="font-semibold">{s.title}</h3>
                <p className="text-sm text-muted mt-2 leading-relaxed">{s.desc}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* COMO FUNCIONA */}
      <section id="como-funciona" className="py-20 px-4 sm:px-6 lg:px-8 bg-sidebar border-y border-line">
        <div className="max-w-7xl mx-auto">
          <SectionTitle
            eyebrow="Como funciona"
            title="Da pesquisa ao fechamento em sete passos"
            subtitle="Cada etapa conecta a anterior: nada se perde, nada fica para trás."
          />
          <div className="grid lg:grid-cols-2 gap-x-16 gap-y-2 max-w-4xl mx-auto">
            {[
              { n: '1', title: 'Pesquisa', desc: 'Use a extensão para localizar empresas e avaliar o potencial de cada uma enquanto navega.' },
              { n: '2', title: 'Leads', desc: 'Capture em um clique com telefone, e-mail e CNPJ preenchidos automaticamente.' },
              { n: '3', title: 'Campanha', desc: 'Crie campanhas de WhatsApp e envie a abordagem no momento ideal.' },
              { n: '4', title: 'IA', desc: 'A Central da IA responde, qualifica e alimenta a memória comercial da sua operação.' },
              { n: '5', title: 'Conversas', desc: 'Acompanhe o histórico completo de cada lead com contexto de tudo o que já foi dito.' },
              { n: '6', title: 'Follow-up', desc: 'Agenda, voz e lembretes garantem que nenhum lead fique sem retorno.' },
              { n: '7', title: 'Conversão', desc: 'Reuniões marcadas, Kanban de vendas e dashboard mostram o resultado de ponta a ponta.' },
            ].map((s) => <Step key={s.n} {...s} />)}
          </div>
        </div>
      </section>

      {/* RECURSOS */}
      <section id="recursos" className="py-20 px-4 sm:px-6 lg:px-8">
        <div className="max-w-7xl mx-auto">
          <SectionTitle
            eyebrow="Recursos"
            title="Tudo o que o seu time precisa para vender mais"
            subtitle="Ferramentas completas de prospecção, campanha, voz e inteligência — em um painel único."
          />
          <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-4">
            <Feature icon={<Puzzle className="w-5 h-5" />} title="Extensão para Chrome" desc="Pesquisa no painel e captura de leads com um clique, sem sair do fluxo de trabalho." />
            <Feature icon={<Plug className="w-5 h-5" />} title="Integração WhatsApp" desc="Conecte a Evolution API e dispare campanhas com entrega e status em tempo real." />
            <Feature icon={<Users className="w-5 h-5" />} title="Importação de listas" desc="Traga planilhas de leads e organize tudo no histórico e no Kanban." />
            <Feature icon={<Bot className="w-5 h-5" />} title="Central da IA" desc="Respostas automáticas, qualificação e memória comercial para cada conversa." />
            <Feature icon={<PhoneCall className="w-5 h-5" />} title="Agente de voz" desc="Avisos falados e lembretes de reuniões para você nunca perder um contato." />
            <Feature icon={<Target className="w-5 h-5" />} title="Campanhas e funil" desc="Segmentação, disparo, acompanhamento e fechamento com visão clara de conversão." />
            <Feature icon={<CalendarDays className="w-5 h-5" />} title="Agenda e follow-up" desc="Reuniões marcadas, retornos programados e agenda de acompanhamento automática." />
            <Feature icon={<BarChart3 className="w-5 h-5" />} title="Dashboard" desc="Métricas de campanha, leads ativos e fechamentos em um só lugar." />
            <Feature icon={<ShieldCheck className="w-5 h-5" />} title="Seguro por design" desc="Acesso restrito por usuário, dados protegidos por RLS e operação controlada." />
          </div>
        </div>
      </section>

      {/* DEMONSTRAÇÃO */}
      <section id="demonstracao" className="py-20 px-4 sm:px-6 lg:px-8 bg-sidebar border-y border-line">
        <div className="max-w-7xl mx-auto grid lg:grid-cols-2 gap-14 items-center">
          <div>
            <SectionTitle
              eyebrow="Demonstração"
              title="Instale a extensão e comece em minutos"
              subtitle=""
            />
            <div className="text-center">
              <p className="text-muted text-lg leading-relaxed -mt-10">
                A extensão do Vyntra fica sempre ao seu lado no navegador: capture leads, pesquise
                empresas e acompanhe a importação direto do painel flutuante — enquanto o app mobile
                leva o controle da operação para onde você estiver.
              </p>
              <div className="flex flex-col sm:flex-row gap-3 justify-center mt-8">
                <Button size="lg" onClick={() => navigate('/login')} icon={<Download className="w-5 h-5" />}>
                  Baixar extensão
                </Button>
                <Button size="lg" variant="outline" onClick={() => navigate('/login')} icon={<Smartphone className="w-5 h-5" />}>
                  App mobile
                </Button>
              </div>
            </div>
          </div>
          <div className="relative">
            <div className="absolute -inset-6 bg-gradient-to-tl from-accent-500/15 to-accent-300/10 rounded-[2rem] blur-2xl" />
            <div className="relative rounded-3xl border border-line bg-panel shadow-4 overflow-hidden animate-fade-in-up">
              <div className="flex items-center gap-2 px-4 py-3 border-b border-line bg-subtle">
                <span className="w-3 h-3 rounded-full bg-line-strong" />
                <span className="w-3 h-3 rounded-full bg-line-strong" />
                <span className="w-3 h-3 rounded-full bg-line-strong" />
                <div className="ml-3 text-[11px] text-faint font-medium">extensão Vyntra</div>
              </div>
              <div className="p-5 space-y-3">
                <div className="flex items-center justify-between">
                  <div className="text-sm font-semibold">Captura de leads</div>
                  <span className="text-[11px] text-faint">pesquisa ativa</span>
                </div>
                {['Empresa A — segmento encontrado', 'Empresa B — telefone detectado', 'Empresa C — CNPJ localizado'].map((row, i) => (
                  <div key={row} className="flex items-center gap-3 rounded-xl border border-line bg-subtle p-3">
                    <div className={`w-8 h-8 rounded-lg flex items-center justify-center text-white text-xs font-bold shadow-1 ${['from-accent-500 to-accent-700', 'from-emerald-400 to-emerald-600', 'from-accent-600 to-accent-500'][i]}`}>
                      {row[0]}
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="text-xs font-medium truncate">{row}</div>
                      <div className="text-[10px] text-faint">aguardando captura</div>
                    </div>
                    <button className="text-[11px] font-semibold text-accent-600 bg-subtle-2 border border-line rounded-lg px-2.5 py-1">
                      Capturar
                    </button>
                  </div>
                ))}
                <div className="rounded-xl border border-accent-500/20 bg-accent-500/5 p-3 flex items-start gap-3">
                  <Check className="w-4 h-4 text-accent-600 mt-0.5 shrink-0" />
                  <div className="text-[11px] text-muted leading-relaxed">Dados importados automaticamente para a sua operação — sem planilha, sem retrabalho.</div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* IA */}
      <section id="ia" className="py-20 px-4 sm:px-6 lg:px-8">
        <div className="max-w-7xl mx-auto">
          <SectionTitle
            eyebrow="Inteligência artificial"
            title="Uma IA que conhece o seu negócio"
            subtitle="A Central da IA aprende com cada conversa e devolve contexto pronto para vender."
          />
          <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-4">
            {[
              { icon: <Bot className="w-5 h-5" />, title: 'Respostas automáticas', desc: 'A IA responde aos contatos com a voz da sua marca, 24/7.' },
              { icon: <Target className="w-5 h-5" />, title: 'Qualificação', desc: 'Identifica interesse e direciona os melhores leads para você.' },
              { icon: <Sparkles className="w-5 h-5" />, title: 'Memória comercial', desc: 'Lotes, conversas e aprendizados que acumulam contexto real da operação.' },
              { icon: <TrendingUp className="w-5 h-5" />, title: 'Resumo diário', desc: 'Acompanhamento diário do que aconteceu e do que precisa de atenção.' },
            ].map((f) => (
              <div key={f.title} className="rounded-2xl border border-line bg-panel p-6 shadow-1 hover:shadow-3 transition-shadow duration-300">
                <div className="w-11 h-11 rounded-xl bg-gradient-to-br from-accent-500 to-accent-700 text-white flex items-center justify-center mb-4">{f.icon}</div>
                <h3 className="font-semibold">{f.title}</h3>
                <p className="text-sm text-muted mt-2 leading-relaxed">{f.desc}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* RESULTADOS */}
      <section id="resultados" className="py-20 px-4 sm:px-6 lg:px-8 bg-sidebar border-y border-line">
        <div className="max-w-7xl mx-auto">
          <SectionTitle
            eyebrow="Resultados"
            title="Menos trabalho manual, mais vendas"
            subtitle="Quem estrutura a prospecção com automação e contexto deixa de operar no improviso e passa a trabalhar com previsibilidade."
          />
          <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-4 max-w-4xl mx-auto">
            {[
              { icon: <Zap className="w-5 h-5" />, title: 'Tempo de volta ao lead', desc: 'Respostas e follow-ups no momento certo, sem depender de memória.' },
              { icon: <MessageSquareText className="w-5 h-5" />, title: 'Primeiro contato', desc: 'Abordagem padronizada e personalizada com histórico completo.' },
              { icon: <CalendarDays className="w-5 h-5" />, title: 'Reuniões que acontecem', desc: 'Lembretes por voz e agenda integrada reduzem não comparecimentos.' },
              { icon: <TrendingUp className="w-5 h-5" />, title: 'Funil transparente', desc: 'Cada fase medida — você sabe exatamente onde está vendendo.' },
            ].map((f) => (
              <div key={f.title} className="rounded-2xl border border-line bg-app p-6 text-center">
                <div className="w-11 h-11 rounded-xl bg-subtle-2 text-accent-600 flex items-center justify-center mx-auto mb-4">{f.icon}</div>
                <h3 className="font-semibold text-sm">{f.title}</h3>
                <p className="text-xs text-muted mt-2 leading-relaxed">{f.desc}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* COMPARAÇÃO */}
      <section id="comparacao" className="py-20 px-4 sm:px-6 lg:px-8">
        <div className="max-w-5xl mx-auto">
          <SectionTitle
            eyebrow="Comparação"
            title="Manual vs Vyntra"
            subtitle="Veja o que muda quando a prospecção deixa de ser um processo manual."
          />
          <div className="grid md:grid-cols-2 gap-4">
            <div className="rounded-2xl border border-line bg-panel p-6 shadow-1">
              <div className="text-sm font-semibold text-muted mb-4">Prospecção manual</div>
              <ul className="space-y-3">
                {[
                  'Horas copiando dados de empresa em empresa',
                  'Planilhas que desatualizam na primeira semana',
                  'Mensagens enviadas uma a uma, na mão',
                  'Follow-ups esquecidos e leads esfriando',
                  'Sem métrica de onde as vendas se perdem',
                ].map((x) => (
                  <li key={x} className="flex items-start gap-3 text-sm text-muted">
                    <X className="w-4 h-4 text-rose-400 mt-0.5 shrink-0" />
                    {x}
                  </li>
                ))}
              </ul>
            </div>
            <div className="rounded-2xl border border-accent-500/25 bg-gradient-to-br from-accent-500/8 to-accent-300/5 p-6 shadow-2">
              <div className="text-sm font-semibold text-accent-600 mb-4">Com o Vyntra</div>
              <ul className="space-y-3">
                {[
                  'Captura de leads com telefone e CNPJ em um clique',
                  'Tudo centralizado: histórico, Kanban e agenda',
                  'Campanhas de WhatsApp com disparo automático',
                  'IA no follow-up e lembretes por voz',
                  'Funil e conversões medidos em tempo real',
                ].map((x) => (
                  <li key={x} className="flex items-start gap-3 text-sm text-secondary">
                    <Check className="w-4 h-4 text-accent-500 mt-0.5 shrink-0" />
                    {x}
                  </li>
                ))}
              </ul>
            </div>
          </div>
        </div>
      </section>

      {/* PLANOS */}
      <section id="planos" className="py-20 px-4 sm:px-6 lg:px-8 bg-sidebar border-y border-line">
        <div className="max-w-7xl mx-auto">
          <SectionTitle
            eyebrow="Planos"
            title="Comece simples, escale quando crescer"
            subtitle="Escolha o plano que cabe no seu momento. Todos incluem o painel completo, a extensão e a integração WhatsApp."
          />
          <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {plans.length === 0 ? (
              [0, 1, 2].map((i) => (
                <div key={i} className="rounded-3xl border border-line bg-panel p-8 animate-pulse-soft">
                  <div className="h-4 w-1/3 rounded bg-subtle-2" />
                  <div className="h-8 w-1/2 rounded bg-subtle-2 mt-4" />
                  <div className="h-3 w-3/4 rounded bg-subtle-2 mt-4" />
                  <div className="h-3 w-2/3 rounded bg-subtle-2 mt-2" />
                  <div className="h-11 w-full rounded-xl bg-subtle-2 mt-6" />
                </div>
              ))
            ) : (
              plans.map((p) => {
                const featured = p.featured
                const price = p.price > 0 ? formatBRL(p.price) : 'Grátis'
                const period = p.billing_type === 'recurring' ? '/mês' : p.duration_days ? ` /${p.duration_days}d` : ''
                const feats = Array.isArray(p.features) && p.features.length > 0
                  ? p.features.map((f) => String(f))
                  : [`Até ${p.lead_limit} leads`, 'Painel completo', 'Extensão Chrome', 'WhatsApp via Evolution API']
                return (
                  <div
                    key={p.id}
                    className={`relative rounded-3xl border p-8 shadow-2 transition-all duration-300 hover:-translate-y-1 ${
                      featured ? 'border-accent-500/40 bg-gradient-to-br from-accent-500/10 to-accent-300/5' : 'border-line bg-panel'
                    }`}
                  >
                    {featured && (
                      <span className="absolute -top-3 left-1/2 -translate-x-1/2 text-[11px] font-bold text-white bg-accent-600 rounded-full px-3 py-1 shadow-2 btn-sweep">
                        {p.badge_label ?? 'Mais popular'}
                      </span>
                    )}
                    <div className="text-sm font-semibold">{p.name}</div>
                    {p.description && <p className="text-xs text-muted mt-1">{p.description}</p>}
                    <div className="mt-5 flex items-baseline gap-1">
                      <span className="text-4xl font-extrabold tracking-tight">{price}</span>
                      <span className="text-sm text-muted">{period}</span>
                    </div>
                    <div className="flex items-center gap-1.5 mt-1 text-xs text-muted">
                      <Zap className="w-3.5 h-3.5 text-accent-500" />
                      {p.lead_limit} leads
                      <span className="mx-1">·</span>
                      {p.campaign_equivalence >= 999 ? 'campanhas ilimitadas' : `${p.campaign_equivalence} campanhas`}
                    </div>
                    <ul className="mt-6 space-y-2.5">
                      {feats.map((f) => (
                        <li key={f} className="flex items-start gap-2.5 text-sm text-secondary">
                          <CheckCircle2 className="w-4 h-4 text-accent-500 mt-0.5 shrink-0" />
                          {f}
                        </li>
                      ))}
                    </ul>
                    <Button
                      size="lg"
                      variant={featured ? 'gradient' : 'outline'}
                      className="w-full mt-7"
                      onClick={() => { setCheckoutPlan(p); setCheckoutMsg(''); setCheckoutPix(null) }}
                    >
                      {p.slug === 'teste' ? 'Ativar teste' : 'Começar agora'}
                    </Button>
                  </div>
                )
              })
            )}
          </div>
          <p className="text-center text-xs text-faint mt-6">
            Precisa de algo sob medida? Acesse o painel e fale com a gente.
          </p>
        </div>
      </section>

      {/* FAQ */}
      <section id="faq" className="py-20 px-4 sm:px-6 lg:px-8">
        <div className="max-w-3xl mx-auto">
          <SectionTitle
            eyebrow="FAQ"
            title="Perguntas frequentes"
            subtitle="Tudo o que você precisa saber antes de começar."
          />
          <div className="space-y-3">
            {FAQS.map((f, i) => (
              <div key={f.q} className="rounded-2xl border border-line bg-panel overflow-hidden">
                <button
                  onClick={() => setOpenFaq(openFaq === i ? null : i)}
                  className="w-full flex items-center justify-between gap-3 px-5 py-4 text-left text-sm font-semibold hover:bg-subtle transition"
                  aria-expanded={openFaq === i}
                >
                  <span className="flex items-center gap-2.5">
                    <HelpCircle className="w-4 h-4 text-accent-500 shrink-0" />
                    {f.q}
                  </span>
                  <ChevronDown className={`w-4 h-4 text-muted shrink-0 transition-transform ${openFaq === i ? 'rotate-180' : ''}`} />
                </button>
                {openFaq === i && (
                  <div className="px-5 pb-4 pl-[3.25rem] text-sm text-muted leading-relaxed animate-fade-in">
                    {f.a}
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* CTA FINAL */}
      <section className="py-20 px-4 sm:px-6 lg:px-8">
        <div className="max-w-5xl mx-auto rounded-3xl border border-line bg-gradient-to-br from-accent-600 to-accent-800 text-white p-10 sm:p-16 text-center relative overflow-hidden shadow-4 reveal" ref={useReveal<HTMLDivElement>()}>
          <div className="pointer-events-none absolute -top-24 -right-24 w-96 h-96 rounded-full bg-white/10 blur-3xl animate-pulse-soft" />
          <div className="pointer-events-none absolute -bottom-24 -left-24 w-96 h-96 rounded-full bg-black/10 blur-3xl" />
          <h2 className="text-3xl sm:text-4xl font-extrabold tracking-tight relative">Pronto para prospectar com IA?</h2>
          <p className="text-white/80 mt-4 text-lg leading-relaxed max-w-2xl mx-auto relative">
            Entre no painel, instale a extensão e comece a capturar leads com telefone, CNPJ e campanha
            de WhatsApp no mesmo fluxo.
          </p>
          <div className="flex flex-col sm:flex-row gap-3 justify-center mt-8 relative">
            <Button size="lg" variant="secondary" onClick={() => navigate('/login')} icon={<ArrowRight className="w-5 h-5" />} className="bg-white !text-accent-800 hover:!bg-accent-100 !shadow-3 btn-sweep">
              Entrar no painel
            </Button>
            <Button size="lg" variant="ghost" onClick={() => scrollTo('recursos')} className="text-white hover:bg-white/10 !border-white/30">
              Explorar recursos
            </Button>
          </div>
        </div>
      </section>

      {/* FOOTER */}
      <footer className="border-t border-line py-10 px-4 sm:px-6 lg:px-8">
        <div className="max-w-7xl mx-auto flex flex-col sm:flex-row items-center justify-between gap-6">
          <div className="flex items-center gap-2.5">
            <div className="w-7 h-7 rounded-lg bg-gradient-to-br from-accent-500 to-accent-700 flex items-center justify-center text-xs font-extrabold text-white shadow-2">V</div>
            <span className="font-semibold">Vyntra</span>
          </div>
          <nav className="flex flex-wrap justify-center gap-x-6 gap-y-2 text-xs text-muted">
            {NAV_LINKS.map((l) => (
              <button key={l.id} onClick={() => scrollTo(l.id)} className="hover:text-fg transition-colors">
                {l.label}
              </button>
            ))}
            <Link to="/login" className="hover:text-fg transition-colors font-medium text-accent-600">Entrar</Link>
          </nav>
          <p className="text-[11px] text-faint">© {new Date().getFullYear()} Vyntra · Prospecção Inteligente</p>
        </div>
      </footer>
      <Modal open={!!checkoutPlan} onClose={() => { if (!checkoutBusy) setCheckoutPlan(null) }} title={checkoutPlan ? `Começar com ${checkoutPlan.name}` : ''} subtitle="Crie sua conta e pague em poucos passos." size="md" footer={!checkoutPix ? <><Button variant="secondary" onClick={() => setCheckoutPlan(null)}>Cancelar</Button><Button onClick={() => void submitLandingCheckout()} loading={checkoutBusy}>{checkoutBusy ? 'Processando…' : 'Criar conta e pagar'}</Button></> : <Button onClick={() => navigate('/login')}>Entrar no painel</Button>}>
        {!checkoutPix ? (
          <div className="space-y-3">
            <div className="grid gap-2 sm:grid-cols-2">
              <input required placeholder="Seu nome" value={checkoutForm.name} onChange={(e) => setCheckoutForm({ ...checkoutForm, name: e.target.value })} className="input" />
              <input required type="email" placeholder="Seu e-mail" value={checkoutForm.email} onChange={(e) => setCheckoutForm({ ...checkoutForm, email: e.target.value })} className="input" />
              <input required type="password" minLength={8} placeholder="Crie uma senha (8+ caracteres)" value={checkoutForm.password} onChange={(e) => setCheckoutForm({ ...checkoutForm, password: e.target.value })} className="input" />
              <input required placeholder="CPF" inputMode="numeric" value={checkoutForm.cpf} onChange={(e) => setCheckoutForm({ ...checkoutForm, cpf: e.target.value })} className="input" />
              <input required placeholder="Celular" inputMode="tel" value={checkoutForm.phone} onChange={(e) => setCheckoutForm({ ...checkoutForm, phone: e.target.value })} className="input sm:col-span-2" />
            </div>
            <div className="grid grid-cols-2 gap-2">
              <button type="button" onClick={() => setCheckoutMethod('pix')} className={`rounded-xl border px-3 py-2 text-sm font-semibold ${checkoutMethod === 'pix' ? 'border-accent-500 bg-accent-600/15 text-accent-300' : 'border-line bg-subtle text-muted'}`}>Pix</button>
              <button type="button" onClick={() => setCheckoutMethod('card')} className={`rounded-xl border px-3 py-2 text-sm font-semibold ${checkoutMethod === 'card' ? 'border-accent-500 bg-accent-600/15 text-accent-300' : 'border-line bg-subtle text-muted'}`}>Cartão</button>
            </div>
            {checkoutMethod === 'card' && <div className="grid gap-2 sm:grid-cols-2"><input placeholder="Número do cartão" inputMode="numeric" value={checkoutForm.number} onChange={(e) => setCheckoutForm({ ...checkoutForm, number: e.target.value })} className="input sm:col-span-2" /><input placeholder="Nome no cartão" value={checkoutForm.holder} onChange={(e) => setCheckoutForm({ ...checkoutForm, holder: e.target.value })} className="input sm:col-span-2" /><input placeholder="Mês" value={checkoutForm.month} onChange={(e) => setCheckoutForm({ ...checkoutForm, month: e.target.value })} className="input" /><input placeholder="Ano" value={checkoutForm.year} onChange={(e) => setCheckoutForm({ ...checkoutForm, year: e.target.value })} className="input" /><input placeholder="CVV" value={checkoutForm.cvv} onChange={(e) => setCheckoutForm({ ...checkoutForm, cvv: e.target.value })} className="input" /></div>}
            {checkoutMsg && <p className="text-xs text-rose-300">{checkoutMsg}</p>}
          </div>
        ) : <div className="space-y-3 text-center"><p className="text-sm text-secondary">Conta criada para <b>{checkoutForm.email}</b>. Escaneie o QR Code ou copie o Pix.</p><div className="rounded-xl border border-accent-500/20 bg-accent-500/5 p-4"><div className="mx-auto max-w-full break-all text-xs text-secondary">{checkoutPix}</div><button className="mt-3 text-xs text-accent-500" onClick={() => void navigator.clipboard.writeText(checkoutPix)}>Copiar código Pix</button></div><p className="text-xs text-muted">Após a confirmação, entre no painel com o e-mail e senha criados.</p></div>}
      </Modal>
    </div>
  )
}
