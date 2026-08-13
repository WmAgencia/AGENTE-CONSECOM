import { describe, it, expect } from 'vitest'
import { buildMonthCells, saLocalDay, saLocalTime, saDayToMs, humanDate } from './month'

describe('month calendar helpers (fuso São Paulo, UTC−3)', () => {
  it('buildMonthCells: grade fixa de 42 células com inMonth correto', () => {
    const cells = buildMonthCells(2026, 7) // agosto/2026
    expect(cells.length).toBe(42)
    expect(cells.filter((c) => c.inMonth).length).toBe(31)
    // 1º de agosto/2026 é sábado → a grade começa no domingo 26/07
    expect(cells[0].key).toBe('2026-07-26')
    expect(cells.find((c) => c.key === '2026-08-01')?.dow).toBe(6)
    // 31/08 é segunda (dow 1)
    expect(cells.find((c) => c.key === '2026-08-31')?.dow).toBe(1)
  })

  it('saLocalDay/saLocalTime: converte ISO em horário de São Paulo', () => {
    // 2026-08-12T10:00:00Z = 07:00 no Brasil
    expect(saLocalDay(Date.parse('2026-08-12T10:00:00Z'))).toBe('2026-08-12')
    expect(saLocalTime(Date.parse('2026-08-12T10:00:00Z'))).toBe('07:00')
    // 01:30Z de 13/08 = 22:30 de 12/08 no Brasil (vira o dia)
    expect(saLocalDay(Date.parse('2026-08-13T01:30:00Z'))).toBe('2026-08-12')
    expect(saLocalTime(Date.parse('2026-08-13T01:30:00Z'))).toBe('22:30')
  })

  it('saDayToMs: roundtrip com saLocalDay', () => {
    const ms = saDayToMs('2026-08-12')
    expect(Number.isFinite(ms)).toBe(true)
    expect(saLocalDay(ms)).toBe('2026-08-12')
  })

  it('humanDate: rótulo amigável', () => {
    expect(humanDate('2026-08-12')).toBe('12 ago 2026')
  })
})
