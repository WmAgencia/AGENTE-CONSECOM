import type { Lead } from './supabase'

function digits(s: string): string {
  return (s ?? '').replace(/\D/g, '')
}

/** Minúsculas + remove acentos (busca insensível a acento). */
function fold(s: string): string {
  return (s ?? '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
}

/** True quando o lead casa com o termo de busca (nome ou telefone). */
export function leadMatchesSearch(lead: Lead, term: string): boolean {
  const query = fold(term).trim()
  if (!query) return true
  if (fold(lead.name ?? '').includes(query)) return true
  const digitsQuery = digits(query)
  if (digitsQuery && digits(lead.phone ?? '').includes(digitsQuery)) return true
  return false
}

/** Busca difere maiúsc./minús. e ignora máscara do telefone para substring. */
export function filterLeadsBySearch(leads: Lead[], term: string): Lead[] {
  return leads.filter((l) => leadMatchesSearch(l, term))
}