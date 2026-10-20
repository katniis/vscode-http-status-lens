export interface RefreshTimer {
  setTimeout(callback: () => void, delayMs: number): unknown;
  clearTimeout(handle: unknown): void;
}

const systemTimer: RefreshTimer = {
  setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/** Debounces refresh callbacks independently for each document key. */
export class PerDocumentRefreshScheduler {
  private readonly timers = new Map<string, unknown>();

  constructor(private readonly delayMs: number, private readonly timer: RefreshTimer = systemTimer) {}

  schedule(key: string, callback: () => void): void {
    this.cancel(key);
    const handle = this.timer.setTimeout(() => {
      this.timers.delete(key);
      callback();
    }, this.delayMs);
    this.timers.set(key, handle);
  }

  cancel(key: string): void {
    const handle = this.timers.get(key);
    if (handle === undefined) return;
    this.timer.clearTimeout(handle);
    this.timers.delete(key);
  }

  dispose(): void {
    for (const handle of this.timers.values()) this.timer.clearTimeout(handle);
    this.timers.clear();
  }
}
