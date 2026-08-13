import { test } from 'node:test'
import assert from 'node:assert/strict'
import { InboundMessageDebouncer } from '../services/inbound.message.debouncer.js'

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

test('delay agrupa mensagens e reinicia a janela por lead', async () => {
  const queue = new InboundMessageDebouncer<string>()
  const delivered: string[] = []

  queue.schedule('lead-1', 'Olá', 20, (value) => delivered.push(value))
  await wait(10)
  queue.schedule('lead-1', 'Tudo bem?', 20, (value) => delivered.push(value))
  await wait(12)
  assert.deepEqual(delivered, [])
  await wait(15)
  assert.deepEqual(delivered, ['Tudo bem?'])
})

test('delay mantém janelas independentes para leads diferentes', async () => {
  const queue = new InboundMessageDebouncer<string>()
  const delivered: string[] = []
  queue.schedule('lead-1', 'A', 10, (value) => delivered.push(value))
  queue.schedule('lead-2', 'B', 20, (value) => delivered.push(value))
  await wait(15)
  assert.deepEqual(delivered, ['A'])
  await wait(10)
  assert.deepEqual(delivered, ['A', 'B'])
})
