export class SourceTracker<TValue> {
  readonly #maxSources: number;
  readonly #values = new Map<string, TValue>();

  constructor(maxSources: number) {
    this.#maxSources = Math.max(1, Math.trunc(maxSources));
  }

  get(source: string): TValue | undefined {
    const value = this.#values.get(source);
    if (value === undefined) {
      return undefined;
    }
    this.#values.delete(source);
    this.#values.set(source, value);
    return value;
  }

  set(source: string, value: TValue): void {
    if (this.#values.has(source)) {
      this.#values.delete(source);
    }
    this.#values.set(source, value);
    while (this.#values.size > this.#maxSources) {
      const oldest = this.#values.keys().next().value;
      if (oldest === undefined) break;
      this.#values.delete(oldest);
    }
  }

  clear(source?: string): void {
    if (source) {
      this.#values.delete(source);
      return;
    }
    this.#values.clear();
  }
}
