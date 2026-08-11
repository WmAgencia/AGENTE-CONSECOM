import { describe, expect, test } from 'vitest'
import { normalizeEvidence } from './evidence'

describe('normalizeEvidence (contrato de evidência)', () => {
  test('array é preservado e limpo', () => {
    expect(normalizeEvidence([' a ', 'b', ''])).toEqual(['a', 'b'])
    expect(normalizeEvidence([])).toEqual([])
  })

  test('JSON string de array vira array', () => {
    expect(normalizeEvidence('["trecho 1","trecho 2"]')).toEqual(['trecho 1', 'trecho 2'])
  })

  test('JSON string de objeto vira item com quote/context', () => {
    expect(normalizeEvidence('{"quote":"olá","context":"início"}')).toEqual(['olá'])
  })

  test('objeto direto vira item de evidência', () => {
    expect(normalizeEvidence({ quote: 'bom dia', relevance: 'alta' })).toEqual(['bom dia'])
  })

  test('string simples vira um único item', () => {
    expect(normalizeEvidence('trecho solto')).toEqual(['trecho solto'])
  })

  test('JSON string inválida vira item com o texto cru', () => {
    expect(normalizeEvidence('não é json')).toEqual(['não é json'])
  })

  test('null / undefined / string vazia nunca lançam', () => {
    expect(normalizeEvidence(null)).toEqual([])
    expect(normalizeEvidence(undefined)).toEqual([])
    expect(normalizeEvidence('')).toEqual([])
    expect(normalizeEvidence('[]')).toEqual([])
  })

  test('limite de itens é respeitado', () => {
    expect(normalizeEvidence(['a', 'b', 'c', 'd'], 2)).toEqual(['a', 'b'])
  })

  test('um aprendizado sem evidence nunca quebra a renderização', () => {
    expect(normalizeEvidence(undefined)).toEqual([])
    expect(normalizeEvidence(null)).toEqual([])
    expect(normalizeEvidence({})).toEqual([])
  })
})
