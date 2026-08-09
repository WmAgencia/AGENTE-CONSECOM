import type { ScrapedLead } from './leads'
import { computeVyntraScore } from './score'

// =====================================================================
// Filtros do Vyntra Prospector (Prospecção Automática)
// Regra de operadores (spec seção 11):
//   - Filtros dentro da MESMA categoria: OR
//   - Filtros de categorias DIFERENTES:  AND
// Uma categoria sem nenhum filtro selecionado = não filtra (passa todos).
// =====================================================================

export type SiteFilter =
  | 'sem_site'
  | 'site_ruim'
  | 'site_desatualizado'
  | 'site_nao_responsivo'
  | 'site_lento'
  | 'site_amador'
  | 'site_quebrado'
  | 'site_problemas'
  | 'site_bom'
  | 'site_profissional'

export type DigitalFilter =
  | 'sem_instagram'
  | 'instagram_encontrado'
  | 'instagram_pouco_ativo'
  | 'instagram_sem_link_site'
  | 'sem_facebook'
  | 'sem_presenca_digital'
  | 'sem_whatsapp'
  | 'tem_whatsapp'

/** Filtros de qualificação transversais (chips): "Tem telefone", "Poucas avaliações", etc. */
export type QualifyFilter =
  | 'tem_telefone'
  | 'poucas_avaliacoes'   // reviews < 10
  | 'nota_baixa'          // rating < 4.0
  | 'muitas_avaliacoes'   // reviews >= 100
  | 'tem_site'

export type ScoreBand = 'alta' | 'boa' | 'media' | 'baixa'

export type ServiceInterest = 'site' | 'sistema' | 'trafego' | 'automacao' | 'presenca' | 'todos'

/** Um chip de filtro individual (referência: "No website", "High opportunity", ...). */
export interface FilterChip {
  id: string
  label: string
  /** Categoria lógica para aplicação OR dentro / AND entre. */
  cat: 'site' | 'digital' | 'score' | 'qualify'
  /** Valor associado (SiteFilter | DigitalFilter | ScoreBand | QualifyFilter). */
  value: string
  /** Cor do chip quando ativo (acento). */
  accent?: string
}

/** Catálogo de chips visíveis no painel (ordem da imagem de referência). */
export const FILTER_CHIPS: FilterChip[] = [
  { id: 'sem_site', label: 'Sem site', cat: 'site', value: 'sem_site', accent: '#f87171' },
  { id: 'alta', label: 'Alta oportunidade', cat: 'score', value: 'alta', accent: '#10b981' },
  { id: 'site_ruim', label: 'Site ruim', cat: 'site', value: 'site_ruim', accent: '#f59e0b' },
  { id: 'poucas_avaliacoes', label: 'Poucas avaliações', cat: 'qualify', value: 'poucas_avaliacoes', accent: '#a855f7' },
  { id: 'nota_baixa', label: 'Nota baixa', cat: 'qualify', value: 'nota_baixa', accent: '#f87171' },
  { id: 'sem_presenca_digital', label: 'Sem presença digital', cat: 'digital', value: 'sem_presenca_digital', accent: '#64748b' },
  { id: 'tem_telefone', label: 'Tem telefone', cat: 'qualify', value: 'tem_telefone', accent: '#22c55e' },
  { id: 'sem_instagram', label: 'Sem Instagram', cat: 'digital', value: 'sem_instagram', accent: '#ec4899' },
  { id: 'sem_whatsapp', label: 'Sem WhatsApp', cat: 'digital', value: 'sem_whatsapp', accent: '#f87171' },
  { id: 'tem_whatsapp', label: 'Tem WhatsApp', cat: 'digital', value: 'tem_whatsapp', accent: '#22c55e' },
  { id: 'tem_site', label: 'Tem site', cat: 'site', value: 'site_bom', accent: '#22c55e' },
  { id: 'boa', label: 'Boa oportunidade', cat: 'score', value: 'boa', accent: '#84cc16' },
  { id: 'media', label: 'Média oportunidade', cat: 'score', value: 'media', accent: '#f59e0b' },
  { id: 'baixa', label: 'Baixa oportunidade', cat: 'score', value: 'baixa', accent: '#f87171' },
]

export interface ProspectFilters {
  site: SiteFilter[]
  digital: DigitalFilter[]
  qualify: QualifyFilter[]
  minRating: number | null
  minReviews: number | null
  scoreBands: ScoreBand[]
  service: ServiceInterest
  /** Chips ativos (ids) — fonte única de verdade para matchFilters */
  activeChips: Set<string>
}

export const DEFAULT_FILTERS: ProspectFilters = {
  site: [],
  digital: [],
  qualify: [],
  minRating: null,
  minReviews: null,
  scoreBands: [],
  service: 'todos',
  activeChips: new Set(),
}

/** Helper: o conjunto de filtros está vazio (não afeta nenhum resultado). */
export function isEmptyFilters(f: ProspectFilters): boolean {
  return (
    f.site.length === 0 &&
    f.digital.length === 0 &&
    f.qualify.length === 0 &&
    (f.minRating == null || f.minRating <= 0) &&
    (f.minReviews == null || f.minReviews <= 0) &&
    f.scoreBands.length === 0 &&
    f.service === 'todos'
  )
}

/**
 * Verifica se um lead satisfaz o conjunto de filtros.
 * Retorna true quando o lead passa em TODAS as categorias ativas.
 * Categoria sem filtros = passa (ignorada).
 */
export function matchFilters(lead: ScrapedLead, f: ProspectFilters): boolean {
  // ---- SITE (OR dentro da categoria) ----
  // Implementação atual: somente "sem_site" ativa (demais = "em breve").
  // "Site bom/profissional/ruim/..." exigem análise de conteúdo (backend/IA),
  // marcados como indisponíveis nesta versão — quando selecionados aplicam
  // apenas o critério deterministico disponível (tem/não tem site).
  if (f.site.length > 0) {
    if (!matchSiteCategory(lead, f.site)) return false
  }

  // ---- PRESENÇA DIGITAL (OR dentro da categoria) ----
  if (f.digital.length > 0) {
    if (!matchDigitalCategory(lead, f.digital)) return false
  }

  // ---- QUALIFY (OR dentro da categoria: Tem telefone, Poucas avaliações...) ----
  if (f.qualify.length > 0) {
    if (!matchQualifyCategory(lead, f.qualify)) return false
  }

  // ---- GOOGLE MAPS: nota mínima (AND) ----
  if (f.minRating != null && f.minRating > 0) {
    if (lead.rating == null || lead.rating < f.minRating) return false
  }
  // ---- GOOGLE MAPS: avaliações mínimas (AND) ----
  if (f.minReviews != null && f.minReviews > 0) {
    if (lead.reviews == null || lead.reviews < f.minReviews) return false
  }

  // ---- VYNTRA SCORE bandas (OR dentro da categoria) ----
  if (f.scoreBands.length > 0) {
    const score = computeVyntraScore(lead)
    // 'nenhuma' (sem dados) nunca corresponde a uma banda de oportunidade ativa
    if (score.band === 'nenhuma' || !f.scoreBands.includes(score.band)) return false
  }

  // ---- SERVIÇO (radio único; 'todos' passa) ----
  // não há critério deterministico para filtrar por serviço no lead do Maps,
  // então o serviço é registrado mas não exclui resultados nesta versão.

  return true
}

function matchSiteCategory(lead: ScrapedLead, filters: SiteFilter[]): boolean {
  const hasSite = !!lead.website
  for (const filter of filters) {
    switch (filter) {
      case 'sem_site':
        if (!hasSite) return true
        break
      // Os filtros abaixo exigem análise de conteúdo do site (em breve).
      // Enquanto indisponíveis, tratamos como "tem site" (compatível com a
      // heurística deterministica atual) para não zerar resultados quando
      // o usuário só quer empresas com site em qualquer estado.
      case 'site_bom':
      case 'site_profissional':
      case 'site_ruim':
      case 'site_desatualizado':
      case 'site_nao_responsivo':
      case 'site_lento':
      case 'site_amador':
      case 'site_quebrado':
      case 'site_problemas':
        if (hasSite) return true
        break
    }
  }
  return false
}

function matchDigitalCategory(lead: ScrapedLead, filters: DigitalFilter[]): boolean {
  const hasIg = !!lead.instagram
  const hasFb = !!lead.facebook
  const hasWa = !!lead.whatsapp
  for (const filter of filters) {
    switch (filter) {
      case 'sem_instagram':
        if (!hasIg) return true
        break
      case 'instagram_encontrado':
        if (hasIg) return true
        break
      case 'sem_facebook':
        if (!hasFb) return true
        break
      case 'sem_presenca_digital':
        if (!hasIg && !hasFb && !hasWa) return true
        break
      case 'sem_whatsapp':
        if (!hasWa) return true
        break
      case 'tem_whatsapp':
        if (hasWa) return true
        break
      // Heurísticas que exigem acessar o perfil (em breve): tratamos como
      // passagem broad — presença/encontrado é o melhor sinal deterministico.
      case 'instagram_pouco_ativo':
      case 'instagram_sem_link_site':
        if (hasIg) return true
        break
    }
  }
  return false
}

/** Categoria QUALIFY (chips transversais: Tem telefone, Poucas avaliações...). */
function matchQualifyCategory(lead: ScrapedLead, filters: QualifyFilter[]): boolean {
  for (const filter of filters) {
    switch (filter) {
      case 'tem_telefone':
        if (lead.phone) return true
        break
      case 'tem_site':
        if (lead.website) return true
        break
      case 'poucas_avaliacoes':
        if (lead.reviews == null || lead.reviews < 10) return true
        break
      case 'muitas_avaliacoes':
        if (lead.reviews != null && lead.reviews >= 100) return true
        break
      case 'nota_baixa':
        if (lead.rating == null || lead.rating < 4.0) return true
        break
    }
  }
  return false
}

/** Rótulos amigáveis dos filtros (para o relatório de prospecção). */
export function describeFilters(f: ProspectFilters): string[] {
  const out: string[] = []
  const siteLabels: Record<SiteFilter, string> = {
    sem_site: 'Sem site',
    site_ruim: 'Site ruim',
    site_desatualizado: 'Site desatualizado',
    site_nao_responsivo: 'Site não responsivo',
    site_lento: 'Site lento',
    site_amador: 'Site amador',
    site_quebrado: 'Site quebrado',
    site_problemas: 'Site com problemas',
    site_bom: 'Site bom',
    site_profissional: 'Site profissional',
  }
  const digitalLabels: Record<DigitalFilter, string> = {
    sem_instagram: 'Sem Instagram',
    instagram_encontrado: 'Instagram encontrado',
    instagram_pouco_ativo: 'Instagram pouco ativo',
    instagram_sem_link_site: 'Instagram sem link para site',
    sem_facebook: 'Sem Facebook',
    sem_presenca_digital: 'Sem presença digital',
    sem_whatsapp: 'Sem WhatsApp',
    tem_whatsapp: 'Tem WhatsApp',
  }
  const qualifyLabels: Record<QualifyFilter, string> = {
    tem_telefone: 'Tem telefone',
    poucas_avaliacoes: 'Poucas avaliações',
    nota_baixa: 'Nota baixa',
    muitas_avaliacoes: 'Muitas avaliações',
    tem_site: 'Tem site',
  }
  for (const s of f.site) out.push(siteLabels[s])
  for (const d of f.digital) out.push(digitalLabels[d])
  for (const q of f.qualify) out.push(qualifyLabels[q])
  if (f.minRating != null && f.minRating > 0) out.push(`${f.minRating.toFixed(1)}+ estrelas`)
  if (f.minReviews != null && f.minReviews > 0) out.push(`${f.minReviews}+ avaliações`)
  const bandLabels: Record<ScoreBand, string> = {
    alta: 'Alta oportunidade',
    boa: 'Boa oportunidade',
    media: 'Média oportunidade',
    baixa: 'Baixa oportunidade',
  }
  for (const b of f.scoreBands) out.push(bandLabels[b])
  return out
}

/** Gera as tags automáticas do lead com base nos critérios que ele satisfez. */
export function buildTagsForLead(lead: ScrapedLead, f: ProspectFilters): string[] {
  const tags = new Set<string>(['Google Maps'])
  if (!lead.website) tags.add('Sem Site')
  else tags.add('Tem Site')
  if (lead.instagram) tags.add('Instagram')
  if (lead.facebook) tags.add('Facebook')
  if (lead.whatsapp) tags.add('WhatsApp')
  if (!lead.instagram && !lead.facebook && !lead.whatsapp) tags.add('Presença Digital Fraca')
  if (f.minRating != null && f.minRating >= 4.8 && lead.rating != null) {
    tags.add(`${lead.rating.toFixed(1)} Stars`)
  } else if (lead.rating != null) {
    tags.add(`${lead.rating.toFixed(1)} Stars`)
  }
  const score = computeVyntraScore(lead)
  const bandTag: Record<ScoreBand, string> = {
    alta: 'Alta Oportunidade',
    boa: 'Boa Oportunidade',
    media: 'Média Oportunidade',
    baixa: 'Baixa Oportunidade',
  }
  if (score.band !== 'nenhuma') tags.add(bandTag[score.band])
  // Tag comercial derivada (para campanhas futuras)
  if (!lead.website) tags.add('Site Opportunity')
  return Array.from(tags)
}
