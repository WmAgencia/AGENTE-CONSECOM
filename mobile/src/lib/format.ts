export function formatReminder(minutes: number): string {
  if (minutes < 60) return `${minutes} min`
  const h = minutes / 60
  return `${Number.isInteger(h) ? h : h.toFixed(1)} h`
}
