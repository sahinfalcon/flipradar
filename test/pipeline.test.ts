import { describe, expect, it, vi } from "vitest";
import { processNewItems } from "../src/alerts/pipeline.js";
import { listPendingAlerts } from "../src/db/alerts.js";
import { upsertItemCard } from "../src/db/items.js";
import { upsertPriceObservation } from "../src/db/prices.js";
import type { ItemResult } from "../src/vinted/client.js";
import type { CardListing } from "../src/vinted/types.js";
import { makeCard, makeDetail } from "./helpers/cards.js";
import { memoryDb, seedSearch, seedUser } from "./helpers/db.js";

function setup(itemResult: ItemResult = { kind: "ok", detail: makeDetail() }) {
  const db = memoryDb();
  seedUser(db, 111);
  const fetchItem = vi.fn(async (_url: string) => itemResult);
  const deps = { db, fetchItem, now: () => 5_000 };
  const seen = (card: CardListing) => {
    upsertItemCard(db, card, 2_000);
    return { card, firstSeenAt: 2_000 };
  };
  return { db, fetchItem, deps, seen };
}

describe("processNewItems", () => {
  it("creates one pending alert per matching search, once", async () => {
    const { db, fetchItem, deps, seen } = setup();
    const search = seedSearch(db, {}, 1_000);
    const item = seen(makeCard());
    expect(await processNewItems(deps, "iphone 15", [item])).toBe(1);
    expect(await processNewItems(deps, "iphone 15", [item])).toBe(0);
    expect(fetchItem).toHaveBeenCalledTimes(1);
    const [alert] = listPendingAlerts(db, 10);
    expect(alert).toMatchObject({ searchId: search.id, vintedId: "1001", detailsUnavailable: false, createdAt: 2_000, insight: { kind: "insufficient", n: 0 } });
  });

  it("ignores items first seen before the search became active", async () => {
    const { db, deps, seen } = setup();
    seedSearch(db, {}, 3_000);
    expect(await processNewItems(deps, "iphone 15", [seen(makeCard())])).toBe(0);
  });

  it("does not fetch details when no search passes the card stage", async () => {
    const { db, fetchItem, deps, seen } = setup();
    seedSearch(db, { maxPricePence: 100 }, 1_000);
    expect(await processNewItems(deps, "iphone 15", [seen(makeCard())])).toBe(0);
    expect(fetchItem).not.toHaveBeenCalled();
  });

  it("still alerts, flagged, when the item page cannot be read", async () => {
    const { db, deps, seen } = setup({ kind: "error", message: "HTTP 500" });
    seedSearch(db, {}, 1_000);
    expect(await processNewItems(deps, "iphone 15", [seen(makeCard())])).toBe(1);
    expect(listPendingAlerts(db, 10)[0]?.detailsUnavailable).toBe(true);
  });

  it("skips sold items", async () => {
    const { db, deps, seen } = setup({ kind: "ok", detail: makeDetail({ unavailable: true }) });
    seedSearch(db, {}, 1_000);
    expect(await processNewItems(deps, "iphone 15", [seen(makeCard())])).toBe(0);
  });

  it("applies description exclusions per search but fetches the page once", async () => {
    const { db, fetchItem, deps, seen } = setup({ kind: "ok", detail: makeDetail({ description: "iCloud locked, parts" }) });
    seedUser(db, 222);
    seedSearch(db, { userId: 111, excludeWords: ["icloud"] }, 1_000);
    const open = seedSearch(db, { userId: 222 }, 1_000);
    expect(await processNewItems(deps, "iphone 15", [seen(makeCard())])).toBe(1);
    expect(fetchItem).toHaveBeenCalledTimes(1);
    expect(listPendingAlerts(db, 10).map((alert) => alert.searchId)).toEqual([open.id]);
  });

  it("attaches median insight when 10+ comparable prices exist", async () => {
    const { db, deps, seen } = setup();
    seedSearch(db, {}, 1_000);
    for (let i = 0; i < 10; i += 1) {
      upsertPriceObservation(db, { vintedId: `c${i}`, groupKey: "iphone 15|iphone 15|128gb|good", modelKnown: true, pricePence: 30_000 + i * 1_000 }, 4_000);
    }
    await processNewItems(deps, "iphone 15", [seen(makeCard())]);
    expect(listPendingAlerts(db, 10)[0]?.insight).toEqual({ kind: "median", n: 10, medianPence: 34_500, diffPence: 8_180, percentile: 100 });
  });
});
