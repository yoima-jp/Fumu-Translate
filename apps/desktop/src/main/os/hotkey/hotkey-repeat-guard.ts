export class HotkeyRepeatGuard {
  readonly #quietPeriodMs: number;
  #releaseTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(quietPeriodMs = 180) {
    this.#quietPeriodMs = quietPeriodMs;
  }

  push(callback: () => void): void {
    const isFirstPress = this.#releaseTimer === null;
    if (this.#releaseTimer !== null) clearTimeout(this.#releaseTimer);
    // RegisterHotKey can repeat while the key chord remains held. Extending the quiet
    // window on every repeat keeps one physical press mapped to exactly one request.
    this.#releaseTimer = setTimeout(() => {
      this.#releaseTimer = null;
    }, this.#quietPeriodMs);
    if (isFirstPress) callback();
  }

  reset(): void {
    if (this.#releaseTimer !== null) clearTimeout(this.#releaseTimer);
    this.#releaseTimer = null;
  }
}
