import { describe, it, expect } from 'vitest'
import { leadMatchesSearch, filterLeadsBySearch } from './kanbanSearch'
import type { Lead } from './supabase'

const lead = (partial: Partial<Lead>): Lead => ({
  id: 'x',
  name: null,
  phone: null,
  status: 'enviado',
  is_active_in_prospecting: true,
  ...partial,
} as Lead)

describe('busca do kanban (nome/telefone)', () => {
  it('vazio retorna todos', () => {
    const l = lead({ name: 'Maria' })
    expect(leadMatchesSearch(l, '')).toBe(true)
    expect(leadMatchesSearch(l, '   ')).toBe(true)
  })

  it('casa por nome ignorando maiúsc./minúsc.', () => {
    const l = lead({ name: 'João da Silva' })
    expect(leadMatchesSearch(l, 'joão')).toBe(true)
    expect(leadMatchesSearch(l, 'JOAO')).toBe(true)
    expect(leadMatchesSearch(l, 'silva')).toBe(true)
    expect(leadMatchesSearch(l, 'ana')).toBe(false)
  })

  it('casa por telefone mesmo com máscara/DDD opcional', () => {
    const l = lead({ name: 'Maria', phone: '(34) 99203-8968' })
    expect(leadMatchesSearch(l, '992038968')).toBe(true)
    expect(leadMatchesSearch(l, '34 99203')).toBe(true)
    expect(leadMatchesSearch(l, '992')).toBe(true)
    expect(leadMatchesSearch(l, '5555')).toBe(false)
  })

  it('nome vazio sem telefone não casa outro termo', () => {
    const l = lead({ name: null, phone: null })
    expect(leadMatchesSearch(l, 'x')).toBe(false)
  })

  it('filterLeadsBySearch aplica o filtro na lista', () => {
    const a = lead({ id: 'a', name: 'Ana', phone: '(34) 99111-1111' })
    const b = lead({ id: 'b', name: 'Carlos', phone: '(34) 99222-2222' })
    const c = lead({ id: 'c', name: null, phone: '(34) 99333-3333' })
    expect(filterLeadsBySearch([a, b, c], 'carlos').map((x) => x.id)).toEqual(['b'])
    expect(filterLeadsBySearch([a, b, c], '9333').map((x) => x.id)).toEqual(['c'])
    expect(filterLeadsBySearch([a, b, c], '').length).toBe(3)
  })
})