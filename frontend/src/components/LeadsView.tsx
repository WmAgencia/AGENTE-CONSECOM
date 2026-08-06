import { type Lead, type LeadStatus } from '../lib/supabase'

const STATUS_LABEL: Record<LeadStatus, string> = {
  novo: 'Novo',
  na_fila: 'Na fila',
  mensagem_enviada: 'Mensagem enviada',
  respondendo: 'Respondendo',
  reuniao_marcada: 'Reunião marcada',
  fechado: 'Fechado',
  perdido: 'Perdido',
}

export function LeadsView({ leads }: { leads: Lead[] }) {
  return (
    <div className="h-full flex flex-col">
      <div className="px-6 py-4 border-b border-white/5">
        <h1 className="text-lg font-semibold">Leads</h1>
        <p className="text-sm text-slate-400">
          Empresas capturadas pela extensão ({leads.length})
        </p>
      </div>

      <div className="flex-1 overflow-auto px-6 py-5">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-[11px] uppercase tracking-wide text-slate-500">
              <th className="pb-3 pr-4">Empresa</th>
              <th className="pb-3 pr-4">Categoria</th>
              <th className="pb-3 pr-4">Cidade</th>
              <th className="pb-3 pr-4">Telefone</th>
              <th className="pb-3 pr-4">Status</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-white/5">
            {leads.map((lead) => (
              <tr key={lead.id} className="hover:bg-white/[0.02]">
                <td className="py-3 pr-4">
                  <div className="font-medium">{lead.name || '—'}</div>
                  {lead.niche && (
                    <div className="text-[11px] text-indigo-300/80">{lead.niche}</div>
                  )}
                </td>
                <td className="py-3 pr-4 text-slate-400">{lead.category || '—'}</td>
                <td className="py-3 pr-4 text-slate-400">
                  {lead.city ? `${lead.city}${lead.state ? ', ' + lead.state : ''}` : '—'}
                </td>
                <td className="py-3 pr-4 text-slate-400">{lead.phone || '—'}</td>
                <td className="py-3 pr-4">
                  <span className="inline-block text-[11px] px-2 py-1 rounded-full bg-white/5 text-slate-300">
                    {STATUS_LABEL[lead.status]}
                  </span>
                </td>
              </tr>
            ))}
            {leads.length === 0 && (
              <tr>
                <td colSpan={5} className="py-10 text-center text-slate-500">
                  Nenhum lead ainda. Use a extensão para capturar empresas.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  )
}