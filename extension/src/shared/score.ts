import type { ScrapedLead } from './leads'

// =====================================================================
// Score Vyntra: 0-100 indicando a chance de o lead ser uma boa
// oportunidade. Composto por:
//   - nota do Google (rating) — 0..45 pontos
//   - quantidade de avaliações — 0..30 pontos (escala log)
//   - presença de website — 0..10 pontos
//   - presença de telefone — 0..10 pontos
//   - categoria identificada — 0..5 pontos
// Bands -> badge de oportunidade mostrado no card.
// =====================================================================

export interface VyntraScore {
  total: number
  band: 'alta' | 'boa' | 'media' | 'baixa' | 'nenhuma'
  label: string
  parts: { rating: number; reviews: number; website: number; phone: number; category: number }
}

export function computeVyntraScore(lead: ScrapedLead): VyntraScore {
  let rating = 0
  if (lead.rating != null && lead.rating > 0) {
    rating = Math.min(45, Math.round((lead.rating / 5) * 45))
  }

  let reviews = 0
  if (lead.reviews != null && lead.reviews > 0) {
    reviews = Math.min(30, Math.round(Math.log10(lead.reviews + 1) / Math.log10(10000) * 30))
  }

  const website = lead.website ? 10 : 0
  const phone = lead.phone ? 10 : 0
  const category = lead.category ? 5 : 0

  const total = Math.max(0, Math.min(100, rating + reviews + website + phone + category))

  const band = bandOf(total)
  return {
    total,
    band,
    label: LABEL[band],
    parts: { rating, reviews, website, phone, category },
  }
}

type Band = VyntraScore['band']

const LABEL: Record<Band, string> = {
  alta: 'Alta oportunidade',
  boa: 'Boa oportunidade',
  media: 'Oportunidade média',
  baixa: 'Baixa oportunidade',
  nenhuma: 'Sem dados',
}

const BAND_EMOJI: Record<Band, string> = {
  alta: '🔥',
  boa: '😃',
  media: '🙂',
  baixa: '😕',
  nenhuma: '😴',
}

function bandOf(total: number): Band {
  if (total >= 90) return 'alta'
  if (total >= 70) return 'boa'
  if (total >= 50) return 'media'
  if (total >= 1) return 'baixa'
  return 'nenhuma'
}

export function bandEmoji(band: Band): string {
  return BAND_EMOJI[band]
}

export function bandClass(band: Band): string {
  return 'cs-band-' + band
}

/** Cor do badge de oportunidade (tema escuro). */
export function bandColor(band: Band): string {
  switch (band) {
    case 'alta':
      return '#10b981'
    case 'boa':
      return '#22c55e'
    case 'media':
      return '#f59e0b'
    case 'baixa':
      return '#f87171'
    default:
      return '#64748b'
  }
}
