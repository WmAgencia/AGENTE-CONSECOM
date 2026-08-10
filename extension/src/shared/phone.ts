/**
 * Normalização/classificação de telefone brasileiro — cópia PORTÁTIL (sem deps)
 * da lógica do backend em `src/lib/phone.ts`. Mantenha em sincronia com ela:
 * as duas devem produzir EXATAMENTE o mesmo resultado, pois o backend reclassifica
 * os números gravados pela extensão.
 *
 * Regras:
 *  - Mobile:   DDD + '9' + 8 → 11 dígitos nacionais.
 *  - Landline: DDD + 8      → 10 dígitos nacionais.
 *  - Formato de armazenamento: sempre 55 + DDD + número (somente dígitos).
 */

export type PhoneClass = 'MOBILE' | 'LANDLINE' | 'INVALID'

export interface PhoneInfo {
  original: string
  class: PhoneClass
  /** 55 + DDD + número, somente dígitos. null quando INVALID. */
  e164: string | null
  /** DDD + número (sem país). null quando INVALID. */
  national: string | null
  ddd: string | null
  hadCountryCode: boolean
  reason: string
}

function toDigits(input: unknown): { digits: string; hadPlus: boolean } | null {
  if (input === null || input === undefined) return null
  const s = String(input).trim()
  if (!s) return null
  const hadPlus = s.includes('+')
  const digits = s.replace(/\D/g, '')
  if (!digits) return null
  return { digits, hadPlus }
}

function removeTrunkPrefix(digits: string): string {
  let d = digits
  if (d.startsWith('00')) d = d.slice(2)
  if (d.startsWith('0')) d = d.slice(1)
  return d
}

function splitCountryCode(digits: string, hadPlus: boolean): { national: string; hadCC: boolean } {
  if (!digits.startsWith('55')) return { national: digits, hadCC: false }
  const rem = digits.slice(2)
  if ((hadPlus || digits.length >= 12) && (rem.length === 10 || rem.length === 11)) {
    return { national: rem, hadCC: true }
  }
  return { national: digits, hadCC: false }
}

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

export function classifyBrazilianPhone(input: unknown): PhoneInfo {
  const raw = toDigits(input)
  if (!raw) {
    const original = input == null ? String(input) : String(input).trim()
    return { original, class: 'INVALID', e164: null, national: null, ddd: null, hadCountryCode: false, reason: 'Input vazio ou sem dígitos.' }
  }
  const digits = removeTrunkPrefix(raw.digits)
  if (!digits) {
    return { original: String(input).trim(), class: 'INVALID', e164: null, national: null, ddd: null, hadCountryCode: false, reason: 'Input sem dígitos após remover prefixos.' }
  }
  const { national, hadCC } = splitCountryCode(digits, raw.hadPlus)
  const lengthOk = national.length === 10 || national.length === 11
  if (!lengthOk) {
    return { original: String(input).trim(), class: 'INVALID', e164: null, national: null, ddd: null, hadCountryCode: hadCC, reason: `Comprimento ${national.length} não corresponde a telefone brasileiro (10 ou 11 dígitos).` }
  }
  if (!isValidDDD(national)) {
    return { original: String(input).trim(), class: 'INVALID', e164: null, national, ddd: null, hadCountryCode: hadCC, reason: `DDD "${national.slice(0, 2)}" não é um DDD brasileiro válido.` }
  }
  const klass = classifyNational(national)
  const reason =
    klass === 'MOBILE'
      ? 'Celular brasileiro (DDD + 9 dígitos).'
      : klass === 'LANDLINE'
        ? 'Telefone fixo brasileiro (DDD + 8 dígitos / sem nono dígito).'
        : 'Comprimento nacional de 11 dígitos sem nono dígito na posição correta.'
  return { original: String(input).trim(), class: klass, e164: `55${national}`, national, ddd: national.slice(0, 2), hadCountryCode: hadCC, reason }
}

export function normalizeBrazilianPhone(input: unknown): string | null {
  const info = classifyBrazilianPhone(input)
  return info.class === 'INVALID' ? null : info.e164
}

export function validateBrazilianPhone(input: unknown): boolean {
  return classifyBrazilianPhone(input).class !== 'INVALID'
}