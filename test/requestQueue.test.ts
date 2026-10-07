import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { backoffDelayMs, RequestQueue, type BackoffState } from "../src/poller/requestQueue.js";

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
});
afterEach(() => {
  vi.useRealTimers();
});

describe("RequestQueue", () => {
  it("spaces request starts", async () => {
    const queue = new RequestQueue({ spacingMs: 1000, jitterMs: 0 });
    const starts: number[] = [];
    const jobs = [1, 2, 3].map(() => queue.enqueue("poll", async () => void starts.push(Date.now())));
    await vi.advanceTimersByTimeAsync(5000);
    await Promise.all(jobs);
    expect(starts).toEqual([0, 1000, 2000]);
  });

  it("adds jitter to the gap", async () => {
    const queue = new RequestQueue({ spacingMs: 1000, jitterMs: 500, random: () => 0.5 });
    const starts: number[] = [];
    const jobs = [1, 2].map(() => queue.enqueue("poll", async () => void starts.push(Date.now())));
    await vi.advanceTimersByTimeAsync(5000);
    await Promise.all(jobs);
    expect(starts).toEqual([0, 1250]);
  });

  it("runs higher priorities first", async () => {
    const queue = new RequestQueue({ spacingMs: 100, jitterMs: 0 });
    const order: string[] = [];
    let release!: () => void;
    const first = queue.enqueue("poll", () => new Promise<void>((resolve) => (release = resolve)));
    const rest = [
      queue.enqueue("warmup", async () => void order.push("warmup")),
      queue.enqueue("poll", async () => void order.push("poll")),
      queue.enqueue("detail", async () => void order.push("detail")),
    ];
    release();
    await vi.advanceTimersByTimeAsync(1000);
    await Promise.all([first, ...rest]);
    expect(order).toEqual(["detail", "poll", "warmup"]);
  });

  it("backs off exponentially while blocked and recovers on success", async () => {
    const changes: BackoffState[] = [];
    const queue = new RequestQueue({ spacingMs: 100, jitterMs: 0, onBackoffChange: (state) => changes.push(state) });
    const starts: number[] = [];
    await queue.enqueue("poll", async () => {
      starts.push(Date.now());
      queue.reportBlocked();
    });
    const second = queue.enqueue("poll", async () => {
      starts.push(Date.now());
      queue.reportBlocked();
    });
    const third = queue.enqueue("poll", async () => {
      starts.push(Date.now());
      queue.reportSuccess();
    });
    await vi.advanceTimersByTimeAsync(200_000);
    await Promise.all([second, third]);
    expect(starts).toEqual([0, 60_000, 180_000]);
    expect(changes.map((state) => [state.active, state.level])).toEqual([
      [true, 1],
      [true, 2],
      [false, 0],
    ]);
    expect(queue.backoff.active).toBe(false);
  });

  it("caps the backoff at 30 minutes", () => {
    expect([1, 2, 3, 6, 10].map(backoffDelayMs)).toEqual([60_000, 120_000, 240_000, 1_800_000, 1_800_000]);
  });

  it("propagates job errors without stopping", async () => {
    const queue = new RequestQueue({ spacingMs: 10, jitterMs: 0 });
    // Attach the handler immediately: the job rejects before the timers advance.
    const failing = queue
      .enqueue("poll", async () => {
        throw new Error("boom");
      })
      .catch((error: unknown) => error);
    const next = queue.enqueue("poll", async () => "ok");
    await vi.advanceTimersByTimeAsync(100);
    expect(await failing).toEqual(new Error("boom"));
    await expect(next).resolves.toBe("ok");
  });

  it("rejects queued and new jobs after stop", async () => {
    const queue = new RequestQueue({ spacingMs: 1000, jitterMs: 0 });
    const first = queue.enqueue("poll", async () => "first");
    const second = queue.enqueue("poll", async () => "second");
    await expect(first).resolves.toBe("first");
    queue.stop();
    await expect(second).rejects.toThrow("queue stopped");
    await expect(queue.enqueue("poll", async () => "late")).rejects.toThrow("queue stopped");
  });
});
