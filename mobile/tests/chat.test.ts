import { describe, it, expect } from 'vitest'
import {
  newChatId,
  formatAudioDuration,
  trimHistory,
  formatChatTimestamp,
} from '../src/lib/chat'

describe('chat helpers', () => {
  it('newChatId gera ids únicos', () => {
    const a = newChatId()
    const b = newChatId()
    expect(a).not.toBe(b)
    expect(a.length).toBeGreaterThan(0)
  })

  it('formatAudioDuration formata como m:ss', () => {
    expect(formatAudioDuration(0)).toBe('0:00')
    expect(formatAudioDuration(4_000)).toBe('0:04')
    expect(formatAudioDuration(83_000)).toBe('1:23')
    expect(formatAudioDuration(-5)).toBe('0:00')
  })

  it('trimHistory mantém apenas as últimas N', () => {
    const items = Array.from({ length: 10 }, (_, i) => i)
    expect(trimHistory(items, 3)).toEqual([7, 8, 9])
    expect(trimHistory(items, 200)).toHaveLength(10)
  })

  it('formatChatTimestamp formata hora local', () => {
    const t = new Date(2026, 0, 1, 14, 5).getTime()
    expect(formatChatTimestamp(t)).toMatch(/^14:05$/)
  })
})
