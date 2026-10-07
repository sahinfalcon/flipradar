import type { NewCard } from "../alerts/pipeline.js";
import type { Db } from "../db/database.js";
import { insertTermItems, knownTermItemIds, touchTermItems, upsertItemCard } from "../db/items.js";
import { upsertPriceObservation } from "../db/prices.js";
import { bumpEmptyStreak, getTerm, listActiveTerms, markPolled, markSuccess, setBaseline, setWarmedUp, type Term } from "../db/terms.js";
import type { Health } from "../health/health.js";
import { groupFor } from "../insight/groups.js";
import { effectivePricePence } from "../matching/match.js";
import type { CatalogResult } from "../vinted/client.js";
import type { CardListing } from "../vinted/types.js";
import type { Priority } from "./requestQueue.js";

export const WARMUP_PAGES = [2, 3, 4, 5];
export const LAYOUT_ALARM_STREAK = 3;
export const OVERFLOW_MIN_CARDS = 90;

export interface PollerDeps {
  db: Db;
  fetchCatalog: (termKey: string, page: number, priority: Priority) => Promise<CatalogResult>;
  pipeline: (termKey: string, cards: NewCard[]) => Promise<number>;
  health: Pick<Health, "recordSuccess" | "recordFailure" | "layoutSuspect" | "clearLayoutSuspect" | "overflow" | "recordPollInterval">;
  minTermIntervalMs: number;
  now?: () => number;
  log?: { error(obj: object, msg: string): void };
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export class Poller {
  private running = false;
  private readonly inFlight = new Map<string, Promise<void>>();
  private readonly warmups = new Map<string, Promise<void>>();

  constructor(private readonly deps: PollerDeps) {}

  private now(): number {
    return (this.deps.now ?? Date.now)();
  }

  /** The due term polled longest ago (never-polled terms first). */
  dueTerm(): Term | undefined {
    const now = this.now();
    return listActiveTerms(this.deps.db)
      .filter((term) => term.lastPolledAt === null || now - term.lastPolledAt >= this.deps.minTermIntervalMs)
      .sort((a, b) => (a.lastPolledAt ?? -1) - (b.lastPolledAt ?? -1))[0];
  }

  /** Concurrent calls for the same term share one poll. */
  pollTerm(termKey: string): Promise<void> {
    const existing = this.inFlight.get(termKey);
    if (existing) return existing;
    const poll = this.doPoll(termKey).finally(() => this.inFlight.delete(termKey));
    this.inFlight.set(termKey, poll);
    return poll;
  }

  /** Used by the search preview: make sure a brand-new term has a baseline. */
  async ensureFresh(termKey: string): Promise<void> {
    const inFlight = this.inFlight.get(termKey);
    if (inFlight) return inFlight;
    if (!getTerm(this.deps.db, termKey)?.baselineAt) await this.pollTerm(termKey);
  }

  async whenIdle(): Promise<void> {
    await Promise.all([...this.inFlight.values(), ...this.warmups.values()]);
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    void this.loop();
  }

  stop(): void {
    this.running = false;
  }

  private async loop(): Promise<void> {
    while (this.running) {
      const term = this.dueTerm();
      if (!term) {
        await sleep(500);
        continue;
      }
      try {
        await this.pollTerm(term.termKey);
      } catch (error) {
        this.deps.log?.error({ err: error, termKey: term.termKey }, "poll failed");
      }
    }
  }

  private recordCards(termKey: string, cards: CardListing[], now: number): void {
    for (const card of cards) {
      upsertItemCard(this.deps.db, card, now);
      const price = effectivePricePence(card);
      if (price === null) continue;
      const group = groupFor(termKey, card);
      upsertPriceObservation(this.deps.db, { vintedId: card.vintedId, groupKey: group.groupKey, modelKnown: group.modelKnown, pricePence: price }, now);
    }
  }

  private async doPoll(termKey: string): Promise<void> {
    const before = getTerm(this.deps.db, termKey);
    const startedAt = this.now();
    if (before?.lastPolledAt != null) this.deps.health.recordPollInterval(startedAt - before.lastPolledAt);
    markPolled(this.deps.db, termKey, startedAt);

    const result = await this.deps.fetchCatalog(termKey, 1, "poll");
    const now = this.now();

    switch (result.kind) {
      case "blocked":
        return; // the request queue is already backing off
      case "error":
        this.deps.health.recordFailure(termKey, result.message);
        return;
      case "unrecognised": {
        const streak = bumpEmptyStreak(this.deps.db, termKey);
        if (before?.hadResults && streak >= LAYOUT_ALARM_STREAK) await this.deps.health.layoutSuspect(termKey);
        return;
      }
      case "empty":
        markSuccess(this.deps.db, termKey, now, false);
        this.deps.health.recordSuccess();
        this.deps.health.clearLayoutSuspect(termKey);
        if (!before?.baselineAt) setBaseline(this.deps.db, termKey, now);
        return;
      case "ok":
        break;
    }

    const cards = result.cards;
    this.recordCards(termKey, cards, now);
    markSuccess(this.deps.db, termKey, now, cards.length > 0);
    this.deps.health.recordSuccess();
    this.deps.health.clearLayoutSuspect(termKey);
    const ids = cards.map((card) => card.vintedId);

    if (!before?.baselineAt) {
      insertTermItems(this.deps.db, termKey, ids, now);
      setBaseline(this.deps.db, termKey, now);
      this.startWarmUp(termKey);
      return;
    }

    const known = knownTermItemIds(this.deps.db, termKey, ids);
    const fresh = cards.filter((card) => !known.has(card.vintedId));
    touchTermItems(this.deps.db, termKey, [...known], now);
    insertTermItems(this.deps.db, termKey, fresh.map((card) => card.vintedId), now);
    if (!before.warmedUpAt) this.startWarmUp(termKey);
    if (cards.length >= OVERFLOW_MIN_CARDS && fresh.length === cards.length) await this.deps.health.overflow(termKey);
    if (fresh.length > 0) await this.deps.pipeline(termKey, fresh.map((card) => ({ card, firstSeenAt: now })));
  }

  private startWarmUp(termKey: string): void {
    if (this.warmups.has(termKey)) return;
    const warmup = this.warmUp(termKey)
      .catch((error: unknown) => this.deps.log?.error({ err: error, termKey }, "warm-up failed"))
      .finally(() => this.warmups.delete(termKey));
    this.warmups.set(termKey, warmup);
  }

  /** Pages 2–5 feed price data only; on a block or error, the next poll retries. */
  private async warmUp(termKey: string): Promise<void> {
    for (const page of WARMUP_PAGES) {
      const result = await this.deps.fetchCatalog(termKey, page, "warmup");
      if (result.kind === "empty") break;
      if (result.kind !== "ok") return;
      this.recordCards(termKey, result.cards, this.now());
    }
    setWarmedUp(this.deps.db, termKey, this.now());
  }
}
