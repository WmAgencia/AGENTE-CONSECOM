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

export type ScoreBand = 'alta' | 'boa' | 'media' | 'baixa'

export type ServiceInterest = 'site' | 'sistema' | 'trafego' | 'automacao' | 'presenca' | 'todos'

export interface ProspectFilters {
  /** Filtros da categoria SITE (OR entre eles). */
  site: SiteFilter[]
  /** Filtros da categoria PRESENÇA DIGITAL (OR entre eles). */
  digital: DigitalFilter[]
  /** Nota mínima do Google (ex: 4.5). null = sem filtro. */
  minRating: number | null
  /** Quantidade mínima de avaliações (ex: 50). null = sem filtro. */
  minReviews: number | null
  /** Bandas de oportunidade do Vyntra Score (OR entre elas). */
  scoreBands: ScoreBand[]
  /** Serviço de interesse (radio: um único). 'todos' = sem filtro. */
  service: ServiceInterest
}

export const DEFAULT_FILTERS: ProspectFilters = {
  site: [],
  digital: [],
  minRating: null,
  minReviews: null,
  scoreBands: [],
  service: 'todos',
}

/** Helper: o conjunto de filtros está vazio (não afeta nenhum resultado). */
export function isEmptyFilters(f: ProspectFilters): boolean {
  return (
    f.site.length === 0 &&
    f.digital.length === 0 &&
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
        if (!hasIg && !hasFb) return true
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
  }
  for (const s of f.site) out.push(siteLabels[s])
  for (const d of f.digital) out.push(digitalLabels[d])
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
  if (!lead.instagram && !lead.facebook) tags.add('Presença Digital Fraca')
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
