import Papa from 'papaparse'
import * as XLSX from 'xlsx'

/** Normaliza um telefone (BR): remove máscara, espaços, +55 opcional. */
export function normalizePhone(input: string): string | null {
  const raw = (input ?? '').replace(/[^\d+]/g, '')
  if (!raw) return null
  let digits = raw.replace(/[^\d]/g, '')
  if (!digits) return null
  if (/^\+55/.test(raw) && digits.length >= 12) digits = digits.slice(2)
  if (digits.length === 11 && digits[2] === '9') digits = `${digits.slice(0, 2)}${digits.slice(3)}`
  return digits.length >= 10 && digits.length <= 13 ? digits : null
}

/** Variantes de nome de coluna aceitas para Nome e Telefone. */
export const NAME_HEADERS = ['nome', 'name', 'cliente', 'contato', 'contato nome', 'empresa']
export const PHONE_HEADERS = ['telefone', 'phone', 'celular', 'whatsapp', 'celular/whasapp', 'fone', 'telefone/whatsapp']

export interface ParsedContact {
  row: number
  name: string
  phone: string
}

export interface ColumnGuess {
  nameCol: string
  phoneCol: string
}

export interface ParseResult {
  headers: string[]
  rows: Array<Record<string, string>>
  guessed: ColumnGuess
}

/** Escolhe as colunas prováveis de Nome e Telefone pelo cabeçalho. */
export function guessColumns(headers: string[]): ColumnGuess {
  const norm = (h: string) => (h || '').toString().trim().toLowerCase().replace(/\s+/g, ' ')
  let nameCol = ''
  let phoneCol = ''
  for (const h of headers) {
    const n = norm(h)
    if (!nameCol && NAME_HEADERS.some((x) => n.trim().replace(/\s+/g, '') === x.replace(/\s+/g, '') || n.includes(x))) nameCol = h
    if (!phoneCol && PHONE_HEADERS.some((x) => n.includes(x) || n.trim() === x)) phoneCol = h
  }
  return { nameCol, phoneCol }
}

/** Lê CSV (PapaParse) e XLSX (SheetJS) e retorna linhas + cabeçalhos. */
export async function parseSpreadsheet(file: File): Promise<ParseResult> {
  const name = file.name.toLowerCase()
  if (name.endsWith('.csv')) {
    const text = await file.text()
    const res = Papa.parse<Record<string, string>>(text, {
      header: true,
      skipEmptyLines: 'greedy',
    })
    const headers = Array.isArray(res.meta.fields) ? res.meta.fields : []
    return { headers, rows: res.data, guessed: guessColumns(headers) }
  }
  if (name.endsWith('.xlsx') || name.endsWith('.xls')) {
    const buf = await file.arrayBuffer()
    const wb = XLSX.read(buf, { type: 'array' })
    const ws = wb.Sheets[wb.SheetNames[0]]
    const rows = XLSX.utils.sheet_to_json<Record<string, string>>(ws, { defval: '' })
    const headers = rows.length > 0 ? Object.keys(rows[0]) : []
    return { headers, rows, guessed: guessColumns(headers) }
  }
  throw new Error('Formato não suportado. Envie um arquivo .csv ou .xlsx')
}

export interface ValidationIssue {
  row: number
  name: string
  phone: string
  reason: 'vazio' | 'inválido' | 'duplicado' | 'sem_telefone'
}

export interface ValidationReport {
  valid: ParsedContact[]
  invalid: ValidationIssue[]
  duplicates: ValidationIssue[]
}

/** Valida: normaliza, remove espaços, máscara, válidos vs inválidos vs duplicados. */
export function validateContacts(rows: Array<Record<string, string>>, guessed: ColumnGuess, size = 5000): ValidationReport {
  const valid: ParsedContact[] = []
  const invalid: ValidationIssue[] = []
  const duplicates: ValidationIssue[] = []
  const seen = new Map<string, number>()

  for (let i = 0; i < rows.length && valid.length + invalid.length < size; i++) {
    const r = rows[i]
    const rawName = guessed.nameCol ? (r[guessed.nameCol] ?? '').toString().trim() : ''
    const rawPhone = guessed.phoneCol ? (r[guessed.phoneCol] ?? '').toString().trim() : ''
    const name = rawName || 'Sem nome'
    const rowNum = i + 2 // cabeçalho na linha 1

    if (!rawPhone) {
      invalid.push({ row: rowNum, name, phone: '', reason: 'vazio' })
      continue
    }
    const norm = normalizePhone(rawPhone)
    if (!norm) {
      invalid.push({ row: rowNum, name, phone: rawPhone, reason: 'inválido' })
      continue
    }
    if (seen.has(norm)) {
      duplicates.push({ row: rowNum, name, phone: rawPhone, reason: 'duplicado' })
      continue
    }
    seen.set(norm, rowNum)
    valid.push({ row: rowNum, name, phone: norm })
  }

  return { valid, invalid, duplicates }
}