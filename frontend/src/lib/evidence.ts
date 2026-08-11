/**
 * Normalização defensiva do contrato de `evidence` da Memória Comercial.
 *
 * O backend pode entregar evidence como: array, JSON string, objeto,
 * string simples, null ou undefined. A UI NUNCA pode assumir um único
 * formato — esta função transforma QUALQUER entrada válida em `string[]`
 * (o contrato canônico da aplicação). Sempre retorna um array.
 */
export function normalizeEvidence(value: unknown, limit = 10): string[] {
  if (value == null) return []
  if (Array.isArray(value)) {
    return value
      .map((e) => {
        if (e == null) return ''
        if (typeof e === 'string') return e.trim()
        if (typeof e === 'object') return extractEvidenceString(e as Record<string, unknown>)
        return String(e)
      })
      .filter((s) => s.length > 0)
      .slice(0, limit)
  }
  if (typeof value === 'string') {
    const t = value.trim()
    if (!t) return []
    try {
      const parsed = JSON.parse(t) as unknown
      if (Array.isArray(parsed)) return normalizeEvidence(parsed, limit)
      if (parsed && typeof parsed === 'object') return normalizeEvidence(parsed, limit)
      if (typeof parsed === 'string' && parsed.trim()) return [parsed.trim().slice(0, 220)]
      return []
    } catch {
      return [t.slice(0, 220)]
    }
  }
  if (typeof value === 'object') {
    const item = extractEvidenceString(value as Record<string, unknown>)
    return item ? [item] : []
  }
  return []
}

function extractEvidenceString(o: Record<string, unknown>): string {
  for (const k of ['quote', 'context', 'relevance', 'content', 'text', 'message']) {
    const v = o[k]
    if (typeof v === 'string' && v.trim()) return v.trim().slice(0, 220)
    if (Array.isArray(v) && v.length > 0) return String(v[0]).slice(0, 220)
  }
  const s = JSON.stringify(o)
  return s && s !== '{}' ? s.slice(0, 220) : ''
}
