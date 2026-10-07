import { describe, expect, it, vi } from "vitest";
import type { NewCard, PipelineResult } from "../src/alerts/pipeline.js";
import { knownTermItemIds } from "../src/db/items.js";
import { getTerm, markPolled } from "../src/db/terms.js";
import { Poller } from "../src/poller/poller.js";
import type { Priority } from "../src/poller/requestQueue.js";
import type { CatalogResult } from "../src/vinted/client.js";
import { makeCard } from "./helpers/cards.js";
import { memoryDb, seedSearch, seedUser } from "./helpers/db.js";

const ok = (ids: string[]): CatalogResult => ({ kind: "ok", cards: ids.map((id) => makeCard({ vintedId: id, url: `https://www.vinted.co.uk/items/${id}` })) });

function setup() {
  const db = memoryDb();
  seedUser(db);
  seedSearch(db, {}, 0);
  const state = { now: 10_000, page1: ok(["1", "2"]) as CatalogResult, warm: new Map<number, CatalogResult>() };
  const fetchCatalog = vi.fn(async (_termKey: string, page: number, _priority: Priority): Promise<CatalogResult> =>
    page === 1 ? state.page1 : (state.warm.get(page) ?? { kind: "empty" }),
  );
  const pipeline = vi.fn(async (_termKey: string, _cards: NewCard[]): Promise<PipelineResult> => ({ created: 0, failed: [] }));
  const health = {
    recordSuccess: vi.fn(),
    recordFailure: vi.fn(),
    layoutSuspect: vi.fn(async (_termKey: string) => {}),
    clearLayoutSuspect: vi.fn(),
    overflow: vi.fn(async (_termKey: string) => {}),
    recordPollInterval: vi.fn(),
  };
  const poller = new Poller({ db, fetchCatalog, pipeline, health, minTermIntervalMs: 30_000, now: () => state.now });
  return { db, state, fetchCatalog, pipeline, health, poller };
}

describe("Poller", () => {
  it("records a baseline without alerting, then warms up pages 2–5", async () => {
    const { db, state, fetchCatalog, pipeline, poller } = setup();
    state.warm.set(2, ok(["3"]));
    await poller.pollTerm("iphone 15");
    await poller.whenIdle();
    expect(pipeline).not.toHaveBeenCalled();
    expect(getTerm(db, "iphone 15")).toMatchObject({ baselineAt: 10_000, warmedUpAt: 10_000, lastSuccessAt: 10_000, hadResults: true });
    expect(knownTermItemIds(db, "iphone 15", ["1", "2", "3"])).toEqual(new Set(["1", "2"]));
    expect(db.prepare("SELECT COUNT(*) AS n FROM price_observations").get()).toEqual({ n: 3 });
    expect(fetchCatalog.mock.calls.map((call) => [call[1], call[2]])).toEqual([
      [1, "poll"],
      [2, "warmup"],
      [3, "warmup"],
    ]);
  });

  it("sends only new cards to the pipeline, stamped with the poll time", async () => {
    const { state, pipeline, health, poller } = setup();
    await poller.pollTerm("iphone 15");
    await poller.whenIdle();
    state.now = 50_000;
    state.page1 = ok(["4", "1", "2"]);
    await poller.pollTerm("iphone 15");
    expect(pipeline).toHaveBeenCalledTimes(1);
    const [termKey, cards] = pipeline.mock.calls[0]!;
    expect(termKey).toBe("iphone 15");
    expect(cards.map((c) => [c.card.vintedId, c.firstSeenAt])).toEqual([["4", 50_000]]);
    expect(health.recordPollInterval).toHaveBeenCalledWith(40_000);
  });

  it("picks the never-polled term first, then the least recently polled", () => {
    const { db, state, poller } = setup();
    seedSearch(db, { keywords: "ps5" }, 0);
    seedSearch(db, { keywords: "switch" }, 0);
    markPolled(db, "iphone 15", 10_000);
    markPolled(db, "ps5", 5_000);
    expect(poller.dueTerm()?.termKey).toBe("switch");
    markPolled(db, "switch", 39_000);
    state.now = 20_000;
    expect(poller.dueTerm()).toBeUndefined();
    state.now = 40_000;
    expect(poller.dueTerm()?.termKey).toBe("ps5");
  });

  it("reports overflow when a full page is entirely new", async () => {
    const { state, health, poller } = setup();
    await poller.pollTerm("iphone 15");
    await poller.whenIdle();
    state.page1 = ok(Array.from({ length: 96 }, (_, i) => String(1000 + i)));
    await poller.pollTerm("iphone 15");
    expect(health.overflow).toHaveBeenCalledWith("iphone 15");
  });

  it("raises the layout alarm after 3 unrecognised pages for a term that had results", async () => {
    const { state, health, poller } = setup();
    await poller.pollTerm("iphone 15");
    await poller.whenIdle();
    state.page1 = { kind: "unrecognised" };
    await poller.pollTerm("iphone 15");
    await poller.pollTerm("iphone 15");
    expect(health.layoutSuspect).not.toHaveBeenCalled();
    await poller.pollTerm("iphone 15");
    expect(health.layoutSuspect).toHaveBeenCalledWith("iphone 15");
  });

  it("records failures and leaves state alone when blocked", async () => {
    const { db, state, health, pipeline, poller } = setup();
    state.page1 = { kind: "error", message: "HTTP 500" };
    await poller.pollTerm("iphone 15");
    expect(health.recordFailure).toHaveBeenCalledWith("iphone 15", "HTTP 500");
    state.page1 = { kind: "blocked", status: 429 };
    await poller.pollTerm("iphone 15");
    expect(getTerm(db, "iphone 15")).toMatchObject({ baselineAt: null, lastPolledAt: 10_000, lastSuccessAt: null });
    expect(pipeline).not.toHaveBeenCalled();
  });

  it("treats an empty search as a successful baseline", async () => {
    const { db, state, poller } = setup();
    state.page1 = { kind: "empty" };
    await poller.pollTerm("iphone 15");
    expect(getTerm(db, "iphone 15")).toMatchObject({ baselineAt: 10_000, lastSuccessAt: 10_000, hadResults: false });
  });

  it("ensureFresh polls only before the baseline, and concurrent polls share one fetch", async () => {
    const { fetchCatalog, poller } = setup();
    await Promise.all([poller.ensureFresh("iphone 15"), poller.pollTerm("iphone 15")]);
    await poller.whenIdle();
    const page1Calls = () => fetchCatalog.mock.calls.filter((call) => call[1] === 1).length;
    expect(page1Calls()).toBe(1);
    await poller.ensureFresh("iphone 15");
    expect(page1Calls()).toBe(1);
  });
});

describe("Poller retries (Final review I2)", () => {
  it("does not mark items the pipeline failed on as seen, so the next poll retries them", async () => {
    const { db, state, pipeline, poller } = setup();
    await poller.pollTerm("iphone 15");
    await poller.whenIdle();
    state.now = 50_000;
    state.page1 = ok(["4", "1", "2"]);
    pipeline.mockResolvedValueOnce({ created: 0, failed: ["4"] });
    await poller.pollTerm("iphone 15");
    expect(knownTermItemIds(db, "iphone 15", ["4"])).toEqual(new Set());
    state.now = 90_000;
    await poller.pollTerm("iphone 15");
    expect(pipeline).toHaveBeenCalledTimes(2);
    expect(pipeline.mock.calls[1]![1].map((c) => c.card.vintedId)).toEqual(["4"]);
    expect(knownTermItemIds(db, "iphone 15", ["4"])).toEqual(new Set(["4"]));
  });

  it("leaves new items unseen when the pipeline throws", async () => {
    const { db, state, pipeline, poller } = setup();
    await poller.pollTerm("iphone 15");
    await poller.whenIdle();
    state.now = 50_000;
    state.page1 = ok(["5", "1", "2"]);
    pipeline.mockRejectedValueOnce(new Error("database is locked"));
    await expect(poller.pollTerm("iphone 15")).rejects.toThrow("database is locked");
    expect(knownTermItemIds(db, "iphone 15", ["5"])).toEqual(new Set());
  });
});
