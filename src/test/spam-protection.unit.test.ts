/**
 * Testes do SpamProtection (anti-spam da Evolution no disparo de campanhas).
 *
 * 1) maxPerMinute=0 (desabilitado) => chamadas imediatas
 * 2) rate limit: ao atingir o teto da janela, a próxima chamada espera o fim
 *    da janela antes de liberar
 * 3) jitter: retorna após um delay dentro de [min, max]
 * 4) jitter com max=0 (desabilitado) => imediato
 *
 * Usa configuração injetada com janela curta para não depender de 60s reais.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { SpamProtection } from '../services/spam-protection.js'

function elapsedMs(fn: () => Promise<unknown>): Promise<number> {
  return (async () => {
    const start = Date.now()
    await fn()
    return Date.now() - start
  })()
}

test('1) maxPerMinute=0 => rate limit imediato (desabilitado)', async () => {
  const spam = new SpamProtection({ maxPerMinute: 0, windowMs: 50 })
  const t = await elapsedMs(async () => {
    await spam.checkRateLimit()
    await spam.checkRateLimit()
    await spam.checkRateLimit()
  })
  assert.ok(t < 100, `esperava imediato, levou ${t}ms`)
})

test('2) rate limit espera o fim da janela ao atingir o teto', async () => {
  const spam = new SpamProtection({ maxPerMinute: 2, windowMs: 60 })
  // As duas primeiras passam na hora.
  assert.ok((await elapsedMs(() => spam.checkRateLimit())) < 50)
  assert.ok((await elapsedMs(() => spam.checkRateLimit())) < 50)
  // A terceira bloqueia até o fim da janela.
  const third = await elapsedMs(() => spam.checkRateLimit())
  assert.ok(third >= 40, `esperava bloqueio ~60ms, levou ${third}ms`)
})

test('3) jitter retorna após um delay dentro de [min, max]', async () => {
  const spam = new SpamProtection({ jitterMinMs: 10, jitterMaxMs: 40 })
  const t = await elapsedMs(() => spam.jitter())
  assert.ok(t >= 5 && t <= 80, `jitter fora do esperado [10,40]: ${t}ms`)
})

test('4) jitter com max=0 => imediato (desabilitado)', async () => {
  const spam = new SpamProtection({ jitterMinMs: 1000, jitterMaxMs: 0 })
  const t = await elapsedMs(() => spam.jitter())
  assert.ok(t < 100, `esperava imediato, levou ${t}ms`)
})
