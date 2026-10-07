import { describe, expect, it, vi } from "vitest";
import { Health } from "../src/health/health.js";

function setup() {
  let now = 0;
  const notifyOwner = vi.fn<(text: string) => Promise<void>>(async () => {});
  const health = new Health({ notifyOwner, now: () => now });
  return { health, notifyOwner, advance: (ms: number) => (now += ms) };
}

describe("Health", () => {
  it("messages the owner when backoff starts and ends", async () => {
    const { health, notifyOwner } = setup();
    await health.onBackoffChange({ active: true, level: 1, until: 60_000 });
    await health.onBackoffChange({ active: true, level: 2, until: 180_000 });
    await health.onBackoffChange({ active: false, level: 0, until: 0 });
    expect(notifyOwner.mock.calls.map(([text]) => text)).toEqual([
      "⚠️ Vinted is blocking requests. Pausing for 1 min, then retrying with longer waits.",
      "✅ Vinted requests are working again.",
    ]);
  });

  it("rate-limits repeated layout alarms per term to one per 15 minutes", async () => {
    const { health, notifyOwner, advance } = setup();
    await health.layoutSuspect("iphone 15");
    await health.layoutSuspect("iphone 15");
    await health.layoutSuspect("ps5");
    advance(15 * 60_000);
    await health.layoutSuspect("iphone 15");
    expect(notifyOwner).toHaveBeenCalledTimes(3);
    expect(health.snapshot().layoutSuspects).toEqual(["iphone 15", "ps5"]);
    health.clearLayoutSuspect("ps5");
    expect(health.snapshot().layoutSuspects).toEqual(["iphone 15"]);
  });

  it("counts overflow and notifies at most hourly per term", async () => {
    const { health, notifyOwner, advance } = setup();
    await health.overflow("iphone");
    advance(30 * 60_000);
    await health.overflow("iphone");
    advance(31 * 60_000);
    await health.overflow("iphone");
    expect(notifyOwner).toHaveBeenCalledTimes(2);
    expect(health.snapshot().overflowCounts).toEqual({ iphone: 3 });
  });

  it("warns when nothing has succeeded for 5 minutes, except during backoff", async () => {
    const { health, notifyOwner, advance } = setup();
    advance(4 * 60_000);
    await health.checkStale();
    expect(notifyOwner).not.toHaveBeenCalled();
    advance(60_000);
    await health.onBackoffChange({ active: true, level: 1, until: 999_999 });
    notifyOwner.mockClear();
    await health.checkStale();
    expect(notifyOwner).not.toHaveBeenCalled();
    await health.onBackoffChange({ active: false, level: 0, until: 0 });
    notifyOwner.mockClear();
    await health.checkStale();
    expect(notifyOwner).toHaveBeenCalledWith("⏳ No successful Vinted request for 5 minutes.");
    health.recordSuccess();
    notifyOwner.mockClear();
    advance(16 * 60_000);
    await health.checkStale();
    expect(notifyOwner).toHaveBeenCalledTimes(1);
  });

  it("summarises poll intervals and failures", () => {
    const { health } = setup();
    for (const ms of [30_000, 40_000, 50_000]) health.recordPollInterval(ms);
    health.recordFailure("x", "HTTP 500");
    health.recordSuccess();
    expect(health.snapshot()).toMatchObject({ medianPollIntervalMs: 40_000, failureCount: 1, lastSuccessAt: 0 });
  });

  it("never throws when messaging the owner fails", async () => {
    const health = new Health({ notifyOwner: async () => Promise.reject(new Error("telegram down")), now: () => 0 });
    await expect(health.restartNotice()).resolves.toBeUndefined();
  });
});
