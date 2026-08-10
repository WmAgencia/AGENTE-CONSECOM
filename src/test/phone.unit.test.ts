import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  classifyBrazilianPhone,
  normalizeBrazilianPhone,
  validateBrazilianPhone,
} from '../lib/phone.js'

test('normalize: celular 11 dígitos sem +55', () => {
  assert.equal(normalizeBrazilianPhone('31999998888'), '5531999998888')
})

test('normalize: celular com +55', () => {
  assert.equal(normalizeBrazilianPhone('+5531999998888'), '5531999998888')
})

test('normalize: já com 55 preserva (sem duplicar)', () => {
  assert.equal(normalizeBrazilianPhone('5531999998888'), '5531999998888')
  const e = normalizeBrazilianPhone('5531999998888')!
  assert.ok(!e.startsWith('5555'))
})

test('normalize: parênteses e hífen', () => {
  assert.equal(normalizeBrazilianPhone('(31) 99999-8888'), '5531999998888')
})

test('normalize: espaço simples', () => {
  assert.equal(normalizeBrazilianPhone('31 99999-8888'), '5531999998888')
})

test('normalize: +55 com parênteses (padrão completo)', () => {
  assert.equal(normalizeBrazilianPhone('+55 (31) 99999-8888'), '5531999998888')
})

test('normalize: prefixo interurbano 0 antes do DDD', () => {
  assert.equal(normalizeBrazilianPhone('031999998888'), '5531999998888')
})

test('normalize: prefixo internacional 00 + 55', () => {
  assert.equal(normalizeBrazilianPhone('005531999998888'), '5531999998888')
})

test('normalize: telefone fixo 10 dígitos', () => {
  assert.equal(normalizeBrazilianPhone('3133334444'), '553133334444')
})

test('normalize: telefone fixo com +55 e máscara', () => {
  assert.equal(normalizeBrazilianPhone('+55 (31) 3333-4444'), '553133334444')
})

test('normalize: fixo com 55 sem + e sem máscara', () => {
  assert.equal(normalizeBrazilianPhone('55 31 3333-4444'), '553133334444')
})

test('normalize: número numérico (spreadsheet)', () => {
  assert.equal(normalizeBrazilianPhone(31999998888), '5531999998888')
})

test('classify: MOBILE para 11 dígitos com nono dígito', () => {
  const info = classifyBrazilianPhone('31999998888')
  assert.equal(info.class, 'MOBILE')
  assert.equal(info.ddd, '31')
  assert.equal(info.national, '31999998888')
})

test('classify: LANDLINE para 10 dígitos', () => {
  const info = classifyBrazilianPhone('3133334444')
  assert.equal(info.class, 'LANDLINE')
  assert.equal(info.e164, '553133334444')
})

test('classify: INVALID para entradas vazias/null', () => {
  assert.equal(classifyBrazilianPhone('').class, 'INVALID')
  assert.equal(classifyBrazilianPhone(null).class, 'INVALID')
  assert.equal(classifyBrazilianPhone(undefined).class, 'INVALID')
  assert.equal(normalizeBrazilianPhone(''), null)
  assert.equal(normalizeBrazilianPhone(null), null)
  assert.equal(normalizeBrazilianPhone(undefined), null)
})

test('classify: INVALID para valores sem dígitos', () => {
  assert.equal(classifyBrazilianPhone('s/telefone').class, 'INVALID')
  assert.equal(classifyBrazilianPhone('---').class, 'INVALID')
})

test('classify: INVALID para comprimentos fora do padrão', () => {
  assert.equal(classifyBrazilianPhone('1234').class, 'INVALID')
  assert.equal(classifyBrazilianPhone('313333').class, 'INVALID')
  assert.equal(classifyBrazilianPhone('12345678901234567890').class, 'INVALID')
})

test('classify: INVALID para DDD fora da faixa brasileira', () => {
  assert.equal(classifyBrazilianPhone('0133334444').class, 'INVALID')
  assert.equal(classifyBrazilianPhone('1033334444').class, 'INVALID')
})

test('classify: INVALID para 11 dígitos sem nono dígito', () => {
  assert.equal(classifyBrazilianPhone('31333344445').class, 'INVALID')
})

test('classify: DDD 55 sem país vira nacional (celular)', () => {
  const info = classifyBrazilianPhone('55999998888')
  assert.equal(info.class, 'MOBILE')
  assert.equal(info.e164, '5555999998888')
})

test('validate: true para válido, false para inválido', () => {
  assert.equal(validateBrazilianPhone('31999998888'), true)
  assert.equal(validateBrazilianPhone('55 31 3333-4444'), true)
  assert.equal(validateBrazilianPhone('+55 (31) 99999-8888'), true)
  assert.equal(validateBrazilianPhone(''), false)
  assert.equal(validateBrazilianPhone('abc'), false)
})

test('hadCountryCode: detecta se o input trazia 55/+55', () => {
  assert.equal(classifyBrazilianPhone('+5531999998888').hadCountryCode, true)
  assert.equal(classifyBrazilianPhone('5531999998888').hadCountryCode, true)
  assert.equal(classifyBrazilianPhone('31999998888').hadCountryCode, false)
})

test('nunca produz 5555 indevidamente', () => {
  for (const n of ['31999998888', '+5531999998888', '5531999998888', '(31) 99999-8888', '+55 (31) 99999-8888']) {
    const e = normalizeBrazilianPhone(n)!
    assert.ok(!e.startsWith('5555'), `não deve duplicar 55: ${n} -> ${e}`)
  }
})

test('e164 é somente dígitos (pronto para Evolution API)', () => {
  const e = normalizeBrazilianPhone('+55 (31) 99999-8888')!
  assert.match(e, /^\d+$/)
})