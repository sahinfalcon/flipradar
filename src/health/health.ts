import type { BackoffState } from "../poller/requestQueue.js";

export interface HealthOptions {
  notifyOwner: (text: string) => Promise<void>;
  now?: () => number;
  silenceMs?: number;
  staleMs?: number;
  overflowSilenceMs?: number;
}

export interface HealthSnapshot {
  startedAt: number;
  lastSuccessAt: number | null;
  backoff: BackoffState;
  failureCount: number;
  overflowCounts: Record<string, number>;
  layoutSuspects: string[];
  medianPollIntervalMs: number | null;
}

const MINUTE = 60_000;

export class Health {
  private readonly startedAt: number;
  private lastSuccessAt: number | null = null;
  private backoff: BackoffState = { active: false, level: 0, until: 0 };
  private failureCount = 0;
  private readonly overflowCounts = new Map<string, number>();
  private readonly layoutSuspects = new Set<string>();
  private readonly intervals: number[] = [];
  private readonly lastNotified = new Map<string, number>();

  constructor(private readonly opts: HealthOptions) {
    this.startedAt = this.now();
  }

  private now(): number {
    return (this.opts.now ?? Date.now)();
  }

  /** Message the owner unless the same condition was reported within silenceMs. Never throws. */
  private async notify(key: string, text: string, silenceMs = this.opts.silenceMs ?? 15 * MINUTE): Promise<void> {
    const now = this.now();
    const last = this.lastNotified.get(key);
    if (last !== undefined && now - last < silenceMs) return;
    this.lastNotified.set(key, now);
    try {
      await this.opts.notifyOwner(text);
    } catch {
      // owner messaging must never take the engine down
    }
  }

  async onBackoffChange(state: BackoffState): Promise<void> {
    const wasActive = this.backoff.active;
    this.backoff = state;
    if (state.active && !wasActive) {
      const minutes = Math.max(1, Math.round((state.until - this.now()) / MINUTE));
      await this.notify("backoff-start", `⚠️ Vinted is blocking requests. Pausing for ${minutes} min, then retrying with longer waits.`);
    } else if (!state.active && wasActive) {
      await this.notify("backoff-end", "✅ Vinted requests are working again.", 0);
    }
  }

  recordSuccess(): void {
    this.lastSuccessAt = this.now();
  }

  recordFailure(_termKey: string, _message: string): void {
    this.failureCount += 1;
  }

  async layoutSuspect(termKey: string): Promise<void> {
    this.layoutSuspects.add(termKey);
    await this.notify(`layout:${termKey}`, `🧩 Vinted layout may have changed: no items recognised for "${termKey}" 3 times in a row.`);
  }

  clearLayoutSuspect(termKey: string): void {
    this.layoutSuspects.delete(termKey);
  }

  async overflow(termKey: string): Promise<void> {
    this.overflowCounts.set(termKey, (this.overflowCounts.get(termKey) ?? 0) + 1);
    await this.notify(
      `overflow:${termKey}`,
      `🌊 "${termKey}" had a full page of new listings in one check, so some may have been missed.`,
      this.opts.overflowSilenceMs ?? 60 * MINUTE,
    );
  }

  recordPollInterval(ms: number): void {
    this.intervals.push(ms);
    if (this.intervals.length > 100) this.intervals.shift();
  }

  async checkStale(): Promise<void> {
    if (this.backoff.active) return;
    const reference = this.lastSuccessAt ?? this.startedAt;
    if (this.now() - reference >= (this.opts.staleMs ?? 5 * MINUTE)) {
      await this.notify("stale", "⏳ No successful Vinted request for 5 minutes.");
    }
  }

  async restartNotice(): Promise<void> {
    await this.notify("restart", "🔄 flipradar restarted after an unexpected stop.", 0);
  }

  snapshot(): HealthSnapshot {
    const sorted = [...this.intervals].sort((a, b) => a - b);
    return {
      startedAt: this.startedAt,
      lastSuccessAt: this.lastSuccessAt,
      backoff: this.backoff,
      failureCount: this.failureCount,
      overflowCounts: Object.fromEntries(this.overflowCounts),
      layoutSuspects: [...this.layoutSuspects],
      medianPollIntervalMs: sorted.length ? sorted[Math.floor(sorted.length / 2)]! : null,
    };
  }
}
