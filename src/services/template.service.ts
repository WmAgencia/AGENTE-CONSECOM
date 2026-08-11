/**
 * Template de mensagens — renderização central de variáveis dinâmicas.
 *
 * Fonte única de verdade da substituição de variáveis ({empresa}, {nome},
 * {cidade}, ...) usada por TODOS os pontos de envio (send-worker, remarketing)
 * e espelhada no frontend (`frontend/src/lib/template.ts`) para o preview,
 * garantindo que preview e envio produzam exatamente a mesma mensagem.
 *
 * Garantias:
 *   - Variáveis conhecidas SEMPRE são resolvidas (valor do lead ou fallback
 *     vazio). Nunca vira "undefined"/"null" na mensagem.
 *   - Variáveis desconhecidas permanecem literais (ex.: {horario} — reservada
 *     para variáveis de agenda no futuro), para typos ficarem visíveis.
 *   - Compatibilidade total com os placeholders antigos ({nome_empresa},
 *     {endereco}, {nicho}, ...).
 */

export interface TemplateLead {
  name?: string | null;
  phone?: string | null;
  category?: string | null;
  website?: string | null;
  address?: string | null;
  city?: string | null;
  state?: string | null;
  rating?: number | null;
  reviews?: number | null;
  niche?: string | null;
  instagram?: string | null;
}

type Field = keyof TemplateLead;

/**
 * Alias de variável -> campos do lead a consultar (ordem de preferência).
 * Ex.: {empresa} = nome da empresa, caindo para nicho se estiver vazio.
 */
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
  // Placeholders legados (compatibilidade com campanhas antigas)
  nome_empresa: ['name'],
  endereco: ['address'],
  nicho: ['niche'],
};

/** Lista de variáveis suportadas (usada pela barra do construtor + docs). */
export const SUPPORTED_VARIABLES: Array<{ token: string; label: string; description: string }> = [
  { token: 'empresa', label: 'Empresa', description: 'Nome da empresa/negócio' },
  { token: 'nome', label: 'Nome', description: 'Nome do responsável, quando disponível' },
  { token: 'cidade', label: 'Cidade', description: 'Cidade do lead' },
  { token: 'estado', label: 'Estado', description: 'Estado do lead' },
  { token: 'categoria', label: 'Categoria', description: 'Categoria/segmento do negócio' },
  { token: 'telefone', label: 'Telefone', description: 'Telefone do lead' },
  { token: 'site', label: 'Site', description: 'Website do lead' },
  { token: 'instagram', label: 'Instagram', description: 'Instagram do lead' },
  { token: 'avaliacao', label: 'Avaliação', description: 'Nota média de avaliação' },
  { token: 'avaliacoes', label: 'Avaliações', description: 'Quantidade de avaliações' },
];

function stringValue(lead: TemplateLead, field: Field): string {
  const v = lead[field];
  if (v == null) return '';
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : '';
  return String(v).trim();
}

/**
 * Renderiza `message` substituindo as variáveis pelos dados do lead.
 * Variáveis conhecidas com valor ausente viram string vazia (nunca o literal
 * do token, nunca "undefined"/"null"). Variáveis desconhecidas são mantidas.
 */
export function renderTemplate(message: string, lead: TemplateLead): string {
  if (!message) return '';
  return message.replace(/\{(\w+)\}/g, (match, key: string) => {
    const canonical = key.toLowerCase();
    const aliases = VARIABLE_ALIASES[canonical];
    if (!aliases) return match; // variável desconhecida -> mantém literal
    for (const field of aliases) {
      const value = stringValue(lead, field);
      if (value) return value;
    }
    return '';
  });
}
