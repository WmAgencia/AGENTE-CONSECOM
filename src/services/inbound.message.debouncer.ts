/** Debounce persistente no processo para agrupar mensagens de um mesmo lead. */
export class InboundMessageDebouncer<T> {
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly latest = new Map<string, T>();

  schedule(key: string, value: T, delayMs: number, callback: (value: T) => void): void {
    const previous = this.timers.get(key);
    if (previous) clearTimeout(previous);
    this.latest.set(key, value);
    this.timers.set(key, setTimeout(() => {
      const next = this.latest.get(key);
      this.latest.delete(key);
      this.timers.delete(key);
      if (next !== undefined) callback(next);
    }, delayMs));
  }

  cancel(key: string): void {
    const timer = this.timers.get(key);
    if (timer) clearTimeout(timer);
    this.timers.delete(key);
    this.latest.delete(key);
  }
}
