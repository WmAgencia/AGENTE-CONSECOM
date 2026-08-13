import { test } from 'node:test'
import assert from 'node:assert/strict'
import { normalizePhone } from '../routes/contacts.js'

test('importação normaliza telefones BR com máscara e +55', () => {
  assert.equal(normalizePhone('+55 (11) 99999-0001'), '11999990001')
  assert.equal(normalizePhone('11 99999-0001'), '11999990001')
})

test('importação rejeita telefone vazio ou fora do formato', () => {
  assert.equal(normalizePhone(''), null)
  assert.equal(normalizePhone('abc'), null)
  assert.equal(normalizePhone('123'), null)
})

test('importação mantém telefones fixos válidos para deduplicação', () => {
  assert.equal(normalizePhone('(11) 3333-4444'), '1133334444')
})
