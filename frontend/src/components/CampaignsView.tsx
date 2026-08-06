import { useEffect, useState } from 'react'
import { supabase, type Campaign, type QueueMessage } from '../lib/supabase'

export function CampaignsView() {
  const [campaigns, setCampaigns] = useState<Campaign[]>([])
  const [messagesByCampaign, setMessagesByCampaign] = useState<Record<string, QueueMessage[]>>({})

  useEffect(() => {
    load()
  }, [])

  async function load() {
    const { data, error } = await supabase.from('campaigns').select('*').order('created_at')
    if (error || !data) return
    setCampaigns(data)
    const grouped: Record<string, QueueMessage[]> = {}
    for (const c of data) {
      const { data: msgs } = await supabase
        .from('queue_messages')
        .select('*')
        .eq('campaign_id', c.id)
        .order('position')
      if (msgs) grouped[c.id] = msgs
    }
    setMessagesByCampaign(grouped)
  }

  return (
    <div className="h-full flex flex-col">
      <div className="px-6 py-4 border-b border-white/5 flex items-center justify-between">
        <div>
          <h1 className="text-lg font-semibold">Campanhas &amp; fila de envio</h1>
          <p className="text-sm text-slate-400">
            Monte a sequência de mensagens que será enviada aos leads
          </p>
        </div>
        <button onClick={load}
          className="px-3 py-1.5 text-xs bg-white/5 hover:bg-white/10 rounded-lg transition">
          Atualizar
        </button>
      </div>

      <div className="flex-1 overflow-auto px-6 py-5 space-y-5">
        <CampaignButton onCreated={load} />
        <div className="grid gap-5 md:grid-cols-2 xl:grid-cols-3">
          {campaigns.map((c) => (
            <CampaignCard key={c.id} campaign={c} messages={messagesByCampaign[c.id] ?? []} />
          ))}
          {campaigns.length === 0 && (
            <p className="col-span-full text-sm text-slate-500">
              Nenhuma campanha criada ainda.
            </p>
          )}
        </div>
      </div>
    </div>
  )
}

// Wrapper para criar campanha
function CampaignButton({ onCreated }: { onCreated: () => Promise<void> }) {
  const [open, setOpen] = useState(false)
  const [name, setName] = useState('')

  async function create() {
    if (!name.trim()) return
    const { error } = await supabase.from('campaigns').insert({ name: name.trim() })
    if (!error) {
      setName('')
      setOpen(false)
      await onCreated()
    }
  }

  return (
    <div>
      {open ? (
        <form
          onSubmit={(e) => {
            e.preventDefault()
            void create()
          }}
          className="flex gap-2 items-center"
        >
          <input
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Nome da campanha"
            className="flex-1 max-w-xs bg-black/30 border border-white/10 rounded-lg px-3 py-1.5 text-sm outline-none focus:border-indigo-500"
          />
          <button type="submit"
            className="px-3 py-1.5 text-sm bg-indigo-600 hover:bg-indigo-500 rounded-lg transition">
            Criar
          </button>
          <button type="button" onClick={() => setOpen(false)}
            className="px-3 py-1.5 text-sm bg-white/5 hover:bg-white/10 rounded-lg">
            Cancelar
          </button>
        </form>
      ) : (
        <button onClick={() => setOpen(true)}
          className="px-4 py-2 text-sm bg-indigo-600 hover:bg-indigo-500 rounded-lg transition font-medium">
          + Nova campanha
        </button>
      )}
    </div>
  )
}

function CampaignCard({ campaign, messages }: { campaign: Campaign; messages: QueueMessage[] }) {
  return (
    <div className="rounded-xl border border-white/5 bg-white/[0.02] p-4">
      <div className="flex items-center justify-between mb-3">
        <div>
          <div className="font-medium">{campaign.name}</div>
          <div className="text-[11px] text-slate-400">
            {messages.length} mensagens na sequência
          </div>
        </div>
        <span
          className={`text-[11px] px-2 py-1 rounded-full ${
            campaign.is_active ? 'bg-emerald-500/15 text-emerald-300' : 'bg-white/5 text-slate-400'
          }`}
        >
          {campaign.is_active ? 'Ativa' : 'Pausada'}
        </span>
      </div>
      <ol className="space-y-1.5">
        {messages.map((m, i) => (
          <li key={m.id} className="text-xs flex items-center gap-2 text-slate-300">
            <span className="w-5 h-5 shrink-0 rounded-full bg-white/5 flex items-center justify-center text-[10px] text-slate-400">
              {i + 1}
            </span>
            <KindBadge kind={m.kind} />
            <span className="truncate flex-1">{m.text || (m.media_url ? 'Mídia' : '...')}</span>
            {m.delay_seconds > 0 && (
              <span className="text-[10px] text-slate-500 shrink-0">+{m.delay_seconds}s</span>
            )}
          </li>
        ))}
        {messages.length === 0 && (
          <li className="text-xs text-slate-600">
            Sem mensagens — monte a sequência no painel da campanha.
          </li>
        )}
      </ol>
    </div>
  )
}

const KIND_META: Record<QueueMessage['kind'], { label: string; cls: string }> = {
  text: { label: 'Texto', cls: 'bg-sky-500/15 text-sky-300' },
  audio: { label: 'Áudio', cls: 'bg-amber-500/15 text-amber-300' },
  video: { label: 'Vídeo', cls: 'bg-rose-500/15 text-rose-300' },
  image: { label: 'Imagem', cls: 'bg-emerald-500/15 text-emerald-300' },
  document: { label: 'Doc', cls: 'bg-violet-500/15 text-violet-300' },
}

function KindBadge({ kind }: { kind: QueueMessage['kind'] }) {
  const meta = KIND_META[kind]
  return (
    <span className={`${meta.cls} px-1.5 py-0.5 rounded text-[10px] font-medium shrink-0`}>
      {meta.label}
    </span>
  )
}