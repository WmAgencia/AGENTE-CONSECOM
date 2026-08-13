import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseFollowUpMarker, stripFollowUpMarker } from '../services/followup.parser.js'

test('follow-up explícito com data e horário é extraído', () => {
  const raw = 'Perfeito. Vou falar com você depois. <!--FOLLOW_UP:{"requested":true,"date":"2026-08-17","time":"14:00","message":"Olá, posso falar com o responsável?"}-->'
  assert.deepEqual(parseFollowUpMarker(raw), {
    requested: true,
    date: '2026-08-17',
    time: '14:00',
    message: 'Olá, posso falar com o responsável?',
  })
  assert.equal(stripFollowUpMarker(raw), 'Perfeito. Vou falar com você depois.')
})

test('menção de data sem pedido explícito não cria follow-up', () => {
  assert.equal(parseFollowUpMarker('O dono chega segunda-feira. <!--FOLLOW_UP:{"requested":false,"date":"2026-08-17","time":null,"message":"x"}-->'), null)
})

test('follow-up sem horário preserva null e não inventa hora', () => {
  const parsed = parseFollowUpMarker('<!--FOLLOW_UP:{"requested":true,"date":"2026-08-17","time":null,"message":"Retomar contato"}-->')
  assert.equal(parsed?.time, null)
})
