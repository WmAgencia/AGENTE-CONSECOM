/**
 * Template de mensagens — espelho do backend (`src/services/template.service.ts`).
 *
 * Mesma regra de renderização, garantindo que o preview no construtor de
 * campanha produza exatamente o que o send-worker envia:
 *   - variáveis conhecidas viram o valor do lead (ou '' se vazio);
 *   - variáveis desconhecidas permanecem literais (ex.: {horario}).
 */

export interface TemplateLead {
  name?: string | null
  phone?: string | null
  category?: string | null
  website?: string | null
  address?: string | null
  city?: string | null
  state?: string | null
  rating?: number | null
  reviews?: number | null
  niche?: string | null
  instagram?: string | null
}

type Field = keyof TemplateLead

const VARIABLE_ALIASES: Record<string, Field[]> = {
  empresa: ['name', 'niche'],
  nome: ['name'],
  cidade: ['city'],
  estado: ['state'],
  categoria: ['category'],
  telefone: ['phone'],
  site: ['website'],
  instagram: ['instagram'],
  avaliacao: ['rating'],
  avaliacoes: ['reviews'],
  nome_empresa: ['name'],
  endereco: ['address'],
  nicho: ['niche'],
}

export const SUPPORTED_VARIABLES: Array<{ token: string; label: string; description: string }> = [
  { token: 'empresa', label: 'Empresa', description: 'Nome da empresa/negócio' },
  { token: 'nome', label: 'Nome inteligente', description: 'Agente IA identifica o primeiro nome ou nome comercial correto por lead' },
  { token: 'cidade', label: 'Cidade', description: 'Cidade do lead' },
  { token: 'estado', label: 'Estado', description: 'Estado do lead' },
  { token: 'categoria', label: 'Categoria', description: 'Categoria/segmento do negócio' },
  { token: 'telefone', label: 'Telefone', description: 'Telefone do lead' },
  { token: 'site', label: 'Site', description: 'Website do lead' },
  { token: 'instagram', label: 'Instagram', description: 'Instagram do lead' },
  { token: 'avaliacao', label: 'Avaliação', description: 'Nota média de avaliação' },
  { token: 'avaliacoes', label: 'Avaliações', description: 'Quantidade de avaliações' },
]

const SAMPLE_LEAD: TemplateLead = {
  name: 'Carlos',
  phone: '5511999999999',
  category: 'Restaurante',
  website: 'www.empresa.com.br',
  city: 'São Paulo',
  state: 'SP',
  rating: 4.8,
  reviews: 127,
  niche: 'restaurante',
  instagram: '@empresa',
}

function stringValue(lead: TemplateLead, field: Field): string {
  const v = lead[field]
  if (v == null) return ''
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : ''
  return String(v).trim()
}

export function renderTemplate(message: string, lead: TemplateLead = SAMPLE_LEAD): string {
  if (!message) return ''
  return message.replace(/\{(\w+)\}/g, (match, key: string) => {
    const canonical = key.toLowerCase()
    const aliases = VARIABLE_ALIASES[canonical]
    if (!aliases) return match
    for (const field of aliases) {
      const value = stringValue(lead, field)
      if (value) return value
    }
    return ''
  })
}

/** Lista de placeholders não resolvidos (typos ou variáveis reservadas). */
export function unresolvedVariables(message: string): string[] {
  if (!message) return []
  const found = new Set<string>()
  for (const match of message.matchAll(/\{(\w+)\}/g)) {
    const key = match[1].toLowerCase()
    if (!(key in VARIABLE_ALIASES)) found.add(match[1])
  }
  return Array.from(found)
}
