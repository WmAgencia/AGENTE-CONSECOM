/**
 * Central Brazilian phone normalization + validation + classification.
 *
 * Single source of truth for phone handling across the whole VYNTRA system:
 * extension import, CSV/contacts import, manual registration, campaign queue
 * and Evolution API. The same logic must be shared (no duplicated heuristics).
 *
 * Rules (Brazilian layout):
 *   - Mobile:  DDD (2) + '9' + 8 digits  -> 11 dígitos nacionais.
 *   - Landline: DDD (2) + 8 digits       -> 10 dígitos nacionais.
 *   - Anything else after normalization is INVALID.
 *
 * Storage format: always digit-only E.164-ish `55<DDD><número>`.
 * Evolution API receives ONLY digits (no mask, no '+', no spaces).
 */

export type PhoneClass = 'MOBILE' | 'LANDLINE' | 'INVALID'

export interface PhoneInfo {
  /** Input original (exibição/debug). */
  original: string
  /** MOBILE | LANDLINE | INVALID */
  class: PhoneClass
  /** 55 + DDD + número, somente dígitos. null quando INVALID. */
  e164: string | null
  /** DDD + número (sem código do país). null quando INVALID. */
  national: string | null
  /** DDD (2 dígitos) ou null. */
  ddd: string | null
  /** true quando o input já trazia +55 / 55 (código do país). */
  hadCountryCode: boolean
  /** Motivo legível da classificação. */
  reason: string
}

/** Extrai apenas os dígitos do input e sinaliza a presença de '+'. */
function toDigits(input: unknown): { digits: string; hadPlus: boolean } | null {
  if (input === null || input === undefined) return null
  const s = String(input).trim()
  if (!s) return null
  const hadPlus = s.includes('+')
  const digits = s.replace(/\D/g, '')
  if (!digits) return null
  return { digits, hadPlus }
}

/** Remove prefixo internacional (00) e prefixo interurbano (0) brasileiro. */
function removeTrunkPrefix(digits: string): string {
  let d = digits
  if (d.startsWith('00')) d = d.slice(2)
  if (d.startsWith('0')) d = d.slice(1)
  return d
}

/**
 * Decide se o "55" inicial é código do país (BR) ou DDD (55 é um DDD válido
 * da região de Rio Grande do Sul). Heurística:
 *   - '+' presente => com certeza é código do país;
 *   - total de 12/13 dígitos iniciando em 55 => 55 + número nacional 10/11
 *     (número nacional nunca passa de 11, então 12+ não cabe como nacional);
 *   - 10/11 dígitos iniciando em 55 => número nacional com DDD 55.
 */
function splitCountryCode(
  digits: string,
  hadPlus: boolean,
): { national: string; hadCC: boolean } {
  if (!digits.startsWith('55')) {
    return { national: digits, hadCC: false }
  }
  const rem = digits.slice(2)
  if (
    (hadPlus || digits.length >= 12) &&
    (rem.length === 10 || rem.length === 11)
  ) {
    return { national: rem, hadCC: true }
  }
  return { national: digits, hadCC: false }
}

/** DDD brasileiro é 2 dígitos entre 11 e 99 (sem 0, sem 1x vazios). */
function isValidDDD(national: string): boolean {
  const ddd = national.slice(0, 2)
  if (!/^\d{2}$/.test(ddd)) return false
  const n = Number(ddd)
  return n >= 11 && n <= 99
}

function classifyNational(national: string): PhoneClass {
  if (national.length === 10) return 'LANDLINE'
  if (national.length === 11) return national[2] === '9' ? 'MOBILE' : 'INVALID'
  return 'INVALID'
}

/** Fluxo completo: raw -> normalize -> validate -> classify. */
export function classifyBrazilianPhone(input: unknown): PhoneInfo {
  const raw = toDigits(input)
  if (!raw) {
    const original = input == null ? String(input) : String(input).trim()
    return {
      original,
      class: 'INVALID',
      e164: null,
      national: null,
      ddd: null,
      hadCountryCode: false,
      reason: 'Input vazio ou sem dígitos.',
    }
  }

  const digits = removeTrunkPrefix(raw.digits)
  if (!digits) {
    return {
      original: String(input).trim(),
      class: 'INVALID',
      e164: null,
      national: null,
      ddd: null,
      hadCountryCode: false,
      reason: 'Input sem dígitos após remover prefixos.',
    }
  }

  const { national, hadCC } = splitCountryCode(digits, raw.hadPlus)

  const lengthOk = national.length === 10 || national.length === 11
  if (!lengthOk) {
    return {
      original: String(input).trim(),
      class: 'INVALID',
      e164: null,
      national: null,
      ddd: null,
      hadCountryCode: hadCC,
      reason: `Comprimento ${national.length} não corresponde a telefone brasileiro (10 ou 11 dígitos).`,
    }
  }

  if (!isValidDDD(national)) {
    return {
      original: String(input).trim(),
      class: 'INVALID',
      e164: null,
      national,
      ddd: null,
      hadCountryCode: hadCC,
      reason: `DDD "${national.slice(0, 2)}" não é um DDD brasileiro válido.`,
    }
  }

  const klass = classifyNational(national)
  const reason =
    klass === 'MOBILE'
      ? 'Celular brasileiro (DDD + 9 dígitos).'
      : klass === 'LANDLINE'
        ? 'Telefone fixo brasileiro (DDD + 8 dígitos / sem nono dígito).'
        : 'Comprimento nacional de 11 dígitos sem nono dígito na posição correta.'

  return {
    original: String(input).trim(),
    class: klass,
    e164: `55${national}`,
    national,
    ddd: national.slice(0, 2),
    hadCountryCode: hadCC,
    reason,
  }
}

/**
 * Normaliza para 55 + DDD + número (somente dígitos). Retorna null quando o
 * número não pode ser interpretado como telefone brasileiro válido.
 */
export function normalizeBrazilianPhone(input: unknown): string | null {
  const info = classifyBrazilianPhone(input)
  return info.class === 'INVALID' ? null : info.e164
}

/** true quando o número é um telefone brasileiro estruturalmente válido. */
export function validateBrazilianPhone(input: unknown): boolean {
  return classifyBrazilianPhone(input).class !== 'INVALID'
}