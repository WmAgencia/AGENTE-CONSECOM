export const SAO_PAULO_OFFSET_MS = -3 * 3600_000

export const DAY_SHORT = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb']
export const MONTHS_SHORT = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez']
export const MONTHS_FULL = [
  'Janeiro', 'Fevereiro', 'Março', 'Abril', 'Maio', 'Junho',
  'Julho', 'Agosto', 'Setembro', 'Outubro', 'Novembro', 'Dezembro',
]

export interface MonthCell {
  key: string // YYYY-MM-DD (fuso São Paulo)
  day: number
  dow: number // 0=domingo
  inMonth: boolean
}

/** Grade mensal (6 semanas) com as datas no fuso de São Paulo (UTC−3 fixo). */
export function buildMonthCells(year: number, month0: number): MonthCell[] {
  const first = new Date(Date.UTC(year, month0, 1))
  const startDow = first.getUTCDay()
  const start = new Date(Date.UTC(year, month0, 1 - startDow))
  const cells: MonthCell[] = []
  for (let i = 0; i < 42; i++) {
    const d = new Date(start.getTime() + i * 86_400_000)
    cells.push({
      key: `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`,
      day: d.getUTCDate(),
      dow: d.getUTCDay(),
      inMonth: d.getUTCMonth() === month0,
    })
  }
  return cells
}

/** ISO/ms → 'YYYY-MM-DD' no fuso de São Paulo. */
export function saLocalDay(ms: number): string {
  const d = new Date(ms + SAO_PAULO_OFFSET_MS)
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`
}

/** ISO/ms → 'HH:mm' no fuso de São Paulo. */
export function saLocalTime(ms: number): string {
  const d = new Date(ms + SAO_PAULO_OFFSET_MS)
  return `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`
}

/** 'YYYY-MM-DD' (SP) → ms do início do dia (UTC). */
export function saDayToMs(dateStr: string): number {
  const [y, m, d] = dateStr.split('-').map(Number)
  if (!Number.isFinite(y) || !Number.isFinite(m) || !Number.isFinite(d)) return NaN
  return Date.UTC(y, m - 1, d) - SAO_PAULO_OFFSET_MS
}

/** 'YYYY-MM-DD' (SP) → rótulo amigável "12 ago 2026". */
export function humanDate(dateStr: string): string {
  const [y, m, d] = dateStr.split('-').map(Number)
  if (!y || !m || !d) return dateStr
  return `${d} ${MONTHS_SHORT[m - 1]} ${y}`
}

/** ms → rótulo amigável no fuso de São Paulo. */
export function humanDateTime(ms: number): string {
  const day = saLocalDay(ms)
  return `${humanDate(day)} às ${saLocalTime(ms)}`
}

/** 'YYYY-MM-DD' → parte do dia "12" (usado no cabeçalho do modal). */
export function dayOfMonth(dateStr: string): number {
  const d = Number(dateStr.slice(8, 10))
  return Number.isFinite(d) ? d : 0
}

export function monthTitle(year: number, month0: number): string {
  return `${MONTHS_FULL[month0]} ${year}`
}

export function addMonths(year: number, month0: number, delta: number): { year: number; month0: number } {
  const t = year * 12 + month0 + delta
  return { year: Math.floor(t / 12), month0: ((t % 12) + 12) % 12 }
}
