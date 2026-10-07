export type Priority = "detail" | "poll" | "warmup";

const RANK: Record<Priority, number> = { detail: 0, poll: 1, warmup: 2 };

export interface BackoffState {
  active: boolean;
  level: number;
  until: number;
}

export const BACKOFF_BASE_MS = 60_000;
export const BACKOFF_MAX_MS = 30 * 60_000;

export function backoffDelayMs(level: number): number {
  return Math.min(BACKOFF_BASE_MS * 2 ** (level - 1), BACKOFF_MAX_MS);
}

export interface QueueOptions {
  spacingMs: number;
  jitterMs: number;
  random?: () => number;
  onBackoffChange?: (state: BackoffState) => void;
}

interface Job {
  priority: Priority;
  seq: number;
  run: () => Promise<unknown>;
  resolve: (value: unknown) => void;
  reject: (error: unknown) => void;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Every Vinted request goes through here: one at a time, spaced, prioritised, paused while blocked. */
export class RequestQueue {
  private readonly jobs: Job[] = [];
  private seq = 0;
  private lastStart = Number.NEGATIVE_INFINITY;
  private nextGap: number;
  private level = 0;
  private until = 0;
  private wake: (() => void) | null = null;
  private running = false;
  private stopped = false;

  constructor(private readonly opts: QueueOptions) {
    this.nextGap = opts.spacingMs;
  }

  enqueue<T>(priority: Priority, run: () => Promise<T>): Promise<T> {
    if (this.stopped) return Promise.reject(new Error("queue stopped"));
    return new Promise<T>((resolve, reject) => {
      this.jobs.push({ priority, seq: this.seq++, run, resolve: resolve as (value: unknown) => void, reject });
      this.ensureRunning();
      this.wake?.();
    });
  }

  get backoff(): BackoffState {
    return { active: this.level > 0, level: this.level, until: this.until };
  }

  get size(): number {
    return this.jobs.length;
  }

  reportBlocked(): void {
    this.level += 1;
    this.until = Date.now() + backoffDelayMs(this.level);
    this.opts.onBackoffChange?.(this.backoff);
  }

  reportSuccess(): void {
    if (this.level === 0) return;
    this.level = 0;
    this.until = 0;
    this.opts.onBackoffChange?.(this.backoff);
  }

  stop(): void {
    this.stopped = true;
    for (const job of this.jobs.splice(0)) job.reject(new Error("queue stopped"));
    this.wake?.();
  }

  private ensureRunning(): void {
    if (this.running) return;
    this.running = true;
    void this.loop();
  }

  private async loop(): Promise<void> {
    while (!this.stopped) {
      if (this.jobs.length === 0) {
        await new Promise<void>((resolve) => (this.wake = resolve));
        this.wake = null;
        continue;
      }
      const readyAt = Math.max(this.lastStart + this.nextGap, this.until);
      const wait = readyAt - Date.now();
      if (wait > 0) {
        await sleep(wait);
        continue; // re-check: a higher-priority job or a backoff change may have arrived
      }
      const job = this.takeNext();
      this.lastStart = Date.now();
      this.nextGap = this.opts.spacingMs + Math.floor((this.opts.random ?? Math.random)() * this.opts.jitterMs);
      try {
        job.resolve(await job.run());
      } catch (error) {
        job.reject(error);
      }
    }
    this.running = false;
  }

  private takeNext(): Job {
    let best = 0;
    for (let i = 1; i < this.jobs.length; i += 1) {
      const candidate = this.jobs[i]!;
      const current = this.jobs[best]!;
      const rankDiff = RANK[candidate.priority] - RANK[current.priority];
      if (rankDiff < 0 || (rankDiff === 0 && candidate.seq < current.seq)) best = i;
    }
    return this.jobs.splice(best, 1)[0]!;
  }
}
