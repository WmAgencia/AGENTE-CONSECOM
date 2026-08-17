/** Normaliza nomes para o limite real de armazenamento/envio do lead. */
export function shortenLeadName(value: string | null | undefined, max = 80): string {
  const clean = String(value ?? '').replace(/\s+/g, ' ').trim();
  if (!clean || clean.length <= max) return clean;

  const words = clean.split(' ').filter(Boolean);
  const firstNames: string[] = [];
  for (const word of words) {
    const candidate = [...firstNames, word].join(' ');
    if (candidate.length > max) break;
    firstNames.push(word);
    if (firstNames.length >= 3) break;
  }
  if (firstNames.length > 0) return firstNames.join(' ');
  return clean.slice(0, max).trim();
}
