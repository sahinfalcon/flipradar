import { describe, expect, it } from "vitest";
import {
  createAlert,
  dropStalePending,
  heldAlertsForSearch,
  listPendingAlerts,
  searchesWithHeldAlerts,
  sentLatencies,
  sentTimesForSearch,
  setAlertStatus,
} from "../src/db/alerts.js";
import { getItem, insertTermItems, knownTermItemIds, recentItemsForTerm, saveItemDetail, touchTermItems, upsertItemCard } from "../src/db/items.js";
import { groupPrices, termModelPrices, upsertPriceObservation } from "../src/db/prices.js";
import { DAY_MS, runRetention } from "../src/db/retention.js";
import { getTerm } from "../src/db/terms.js";
import { deleteSearch, setSearchStatus } from "../src/db/searches.js";
import { makeCard, makeDetail } from "./helpers/cards.js";
import { memoryDb, seedSearch, seedUser } from "./helpers/db.js";

describe("items", () => {
  it("upserts cards and stores details", () => {
    const db = memoryDb();
    upsertItemCard(db, makeCard(), 10);
    upsertItemCard(db, makeCard({ pricePence: 25000 }), 20);
    expect(getItem(db, "1001")).toEqual({ ...makeCard({ pricePence: 25000 }), cardSeenAt: 20, detail: null, detailFetchedAt: null });
    saveItemDetail(db, "1001", makeDetail(), 30);
    expect(getItem(db, "1001")).toMatchObject({ detail: makeDetail(), detailFetchedAt: 30 });
  });

  it("tracks which items each term has seen", () => {
    const db = memoryDb();
    insertTermItems(db, "iphone 15", ["1", "2"], 100);
    expect(knownTermItemIds(db, "iphone 15", ["1", "2", "3"])).toEqual(new Set(["1", "2"]));
    expect(knownTermItemIds(db, "ps5", ["1"])).toEqual(new Set());
    insertTermItems(db, "iphone 15", ["2"], 999);
    touchTermItems(db, "iphone 15", ["1"], 200);
    const rows = db.prepare("SELECT vinted_id, first_seen_at, last_seen_at FROM term_items ORDER BY vinted_id").all();
    expect(rows).toEqual([
      { vinted_id: "1", first_seen_at: 100, last_seen_at: 200 },
      { vinted_id: "2", first_seen_at: 100, last_seen_at: 100 },
    ]);
  });

  it("lists a term's items newest first", () => {
    const db = memoryDb();
    for (const id of ["9", "100", "55"]) upsertItemCard(db, makeCard({ vintedId: id }), 1);
    insertTermItems(db, "iphone 15", ["9", "100", "55"], 1);
    expect(recentItemsForTerm(db, "iphone 15", 2).map((item) => item.vintedId)).toEqual(["100", "55"]);
  });
});

describe("price observations", () => {
  it("queries a group within a window, excluding one item", () => {
    const db = memoryDb();
    upsertPriceObservation(db, { vintedId: "1", groupKey: "iphone 15|iphone 15|128gb|good", modelKnown: true, pricePence: 30000 }, 100);
    upsertPriceObservation(db, { vintedId: "2", groupKey: "iphone 15|iphone 15|128gb|good", modelKnown: true, pricePence: 32000 }, 200);
    upsertPriceObservation(db, { vintedId: "3", groupKey: "iphone 15|-|-|new", modelKnown: false, pricePence: 500 }, 200);
    upsertPriceObservation(db, { vintedId: "1", groupKey: "iphone 15|iphone 15|128gb|good", modelKnown: true, pricePence: 29000 }, 300);
    expect(groupPrices(db, "iphone 15|iphone 15|128gb|good", 0).sort()).toEqual([29000, 32000]);
    expect(groupPrices(db, "iphone 15|iphone 15|128gb|good", 250)).toEqual([29000]);
    expect(groupPrices(db, "iphone 15|iphone 15|128gb|good", 0, "1")).toEqual([32000]);
    expect(termModelPrices(db, "iphone 15", 0).sort()).toEqual([29000, 32000]);
    expect(termModelPrices(db, "iphone", 0)).toEqual([]);
  });
});

describe("alerts", () => {
  it("creates each (search, item) alert once and lists pending with the chat id", () => {
    const db = memoryDb();
    seedUser(db, 111);
    const search = seedSearch(db);
    const insight = { kind: "insufficient" as const, n: 3 };
    const alert = createAlert(db, { searchId: search.id, vintedId: "1001", insight, detailsUnavailable: true, createdAt: 50 });
    expect(alert).toMatchObject({ searchId: search.id, vintedId: "1001", status: "pending", insight, detailsUnavailable: true, createdAt: 50, sentAt: null });
    expect(createAlert(db, { searchId: search.id, vintedId: "1001", insight: null, detailsUnavailable: false, createdAt: 60 })).toBeNull();
    expect(listPendingAlerts(db, 10)).toEqual([{ ...alert, chatId: 111 }]);
  });

  it("supports flood bookkeeping, stale drops and latency stats", () => {
    const db = memoryDb();
    seedUser(db);
    const search = seedSearch(db);
    const make = (id: string, createdAt: number) =>
      createAlert(db, { searchId: search.id, vintedId: id, insight: null, detailsUnavailable: false, createdAt })!;
    const a = make("1", 1_000);
    const b = make("2", 2_000);
    const c = make("3", 3_000);
    setAlertStatus(db, a.id, "sent", 1_500);
    setAlertStatus(db, b.id, "digested");
    expect(sentTimesForSearch(db, search.id, 1_000)).toEqual([1_500]);
    expect(sentTimesForSearch(db, search.id, 1_600)).toEqual([]);
    expect(heldAlertsForSearch(db, search.id).map((x) => x.id)).toEqual([b.id]);
    expect(searchesWithHeldAlerts(db)).toEqual([search.id]);
    expect(dropStalePending(db, 3_001)).toBe(1);
    expect(listPendingAlerts(db, 10)).toEqual([]);
    expect(sentLatencies(db, 0)).toEqual([500]);
    expect(c.id).toBeGreaterThan(0);
  });
});

describe("retention", () => {
  it("prunes by age but keeps items still visible or awaiting an alert", () => {
    const db = memoryDb();
    seedUser(db);
    const search = seedSearch(db);
    const now = 40 * DAY_MS;
    const old = now - 8 * DAY_MS;
    upsertItemCard(db, makeCard({ vintedId: "old" }), old);
    upsertItemCard(db, makeCard({ vintedId: "pending-old" }), old);
    upsertItemCard(db, makeCard({ vintedId: "fresh" }), now);
    insertTermItems(db, "iphone 15", ["old"], old);
    insertTermItems(db, "iphone 15", ["fresh"], old);
    touchTermItems(db, "iphone 15", ["fresh"], now);
    createAlert(db, { searchId: search.id, vintedId: "pending-old", insight: null, detailsUnavailable: false, createdAt: now });
    upsertPriceObservation(db, { vintedId: "old", groupKey: "g", modelKnown: true, pricePence: 1 }, now - 31 * DAY_MS);
    upsertPriceObservation(db, { vintedId: "fresh", groupKey: "g", modelKnown: true, pricePence: 1 }, now);

    runRetention(db, now);

    expect(getItem(db, "old")).toBeUndefined();
    expect(getItem(db, "pending-old")).toBeDefined();
    expect(getItem(db, "fresh")).toBeDefined();
    expect(knownTermItemIds(db, "iphone 15", ["old", "fresh"])).toEqual(new Set(["fresh"]));
    expect(groupPrices(db, "g", 0)).toEqual([1]);
    expect(getTerm(db, "iphone 15")).toBeDefined();
  });
});

describe("createAlert guards (Final review I2)", () => {
  it("creates nothing, without throwing, for a deleted or paused search", () => {
    const db = memoryDb();
    seedUser(db);
    const gone = seedSearch(db);
    const paused = seedSearch(db, { keywords: "ps5" });
    deleteSearch(db, gone.id);
    setSearchStatus(db, paused.id, "paused", 5);
    const input = { vintedId: "1", insight: null, detailsUnavailable: false, createdAt: 10 };
    expect(createAlert(db, { ...input, searchId: gone.id })).toBeNull();
    expect(createAlert(db, { ...input, searchId: paused.id })).toBeNull();
  });
});
