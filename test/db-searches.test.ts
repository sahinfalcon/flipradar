import { describe, expect, it } from "vitest";
import {
  activeSearchesForTerm,
  countActiveSearches,
  countSearchesByUser,
  deleteSearch,
  getSearch,
  listSearchesByUser,
  pauseAllSearchesForUser,
  setSearchStatus,
} from "../src/db/searches.js";
import {
  bumpEmptyStreak,
  deleteIdleTerms,
  getTerm,
  listActiveTerms,
  markPolled,
  markSuccess,
  setBaseline,
  setWarmedUp,
} from "../src/db/terms.js";
import { memoryDb, seedSearch, seedUser } from "./helpers/db.js";

describe("searches", () => {
  it("creates a search with a normalised term key and a term row", () => {
    const db = memoryDb();
    seedUser(db);
    const search = seedSearch(db, { keywords: "  iPhone 15 🔥 ", conditions: ["very_good"], excludeWords: ["icloud"] }, 500);
    expect(search).toEqual({
      id: search.id,
      userId: 111,
      keywords: "  iPhone 15 🔥 ",
      termKey: "iphone 15",
      maxPricePence: 30000,
      minPricePence: null,
      conditions: ["very_good"],
      excludeWords: ["icloud"],
      matchMode: "strict",
      status: "active",
      activeSince: 500,
      createdAt: 500,
    });
    expect(getTerm(db, "iphone 15")?.baselineAt).toBeNull();
  });

  it("lists, counts, pauses, resumes and deletes", () => {
    const db = memoryDb();
    seedUser(db);
    const a = seedSearch(db, { keywords: "iphone 15" }, 1);
    const b = seedSearch(db, { keywords: "ps5" }, 2);
    expect(listSearchesByUser(db, 111).map((s) => s.id)).toEqual([a.id, b.id]);
    expect(countSearchesByUser(db, 111)).toBe(2);

    setSearchStatus(db, a.id, "paused", 10);
    expect(getSearch(db, a.id)?.status).toBe("paused");
    expect(countActiveSearches(db)).toBe(1);
    setSearchStatus(db, a.id, "active", 20);
    expect(getSearch(db, a.id)).toMatchObject({ status: "active", activeSince: 20 });

    db.prepare("INSERT INTO alerts (search_id, vinted_id, status, created_at) VALUES (?, '1', 'pending', 0)").run(b.id);
    deleteSearch(db, b.id);
    expect(getSearch(db, b.id)).toBeUndefined();
    expect(db.prepare("SELECT COUNT(*) AS n FROM alerts").get()).toEqual({ n: 0 });
  });

  it("finds active searches for a term and pauses all of a user's searches", () => {
    const db = memoryDb();
    seedUser(db, 111);
    seedUser(db, 222);
    seedSearch(db, { userId: 111 });
    seedSearch(db, { userId: 222 });
    seedSearch(db, { userId: 222, keywords: "ps5" });
    expect(activeSearchesForTerm(db, "iphone 15")).toHaveLength(2);
    pauseAllSearchesForUser(db, 222);
    expect(activeSearchesForTerm(db, "iphone 15").map((s) => s.userId)).toEqual([111]);
  });
});

describe("terms", () => {
  it("lists only terms with active searches", () => {
    const db = memoryDb();
    seedUser(db);
    const a = seedSearch(db, { keywords: "iphone 15" });
    seedSearch(db, { keywords: "ps5" });
    setSearchStatus(db, a.id, "paused", 5);
    expect(listActiveTerms(db).map((t) => t.termKey)).toEqual(["ps5"]);
    expect(deleteIdleTerms(db)).toBe(1);
    expect(getTerm(db, "iphone 15")).toBeUndefined();
    setSearchStatus(db, a.id, "active", 6);
    expect(getTerm(db, "iphone 15")).toBeDefined();
  });

  it("tracks polling state", () => {
    const db = memoryDb();
    seedUser(db);
    seedSearch(db);
    markPolled(db, "iphone 15", 100);
    expect(bumpEmptyStreak(db, "iphone 15")).toBe(1);
    expect(bumpEmptyStreak(db, "iphone 15")).toBe(2);
    markSuccess(db, "iphone 15", 200, false);
    expect(getTerm(db, "iphone 15")).toMatchObject({ lastPolledAt: 100, lastSuccessAt: 200, hadResults: false, emptyStreak: 0 });
    markSuccess(db, "iphone 15", 300, true);
    markSuccess(db, "iphone 15", 400, false);
    expect(getTerm(db, "iphone 15")?.hadResults).toBe(true);
    setBaseline(db, "iphone 15", 500);
    setWarmedUp(db, "iphone 15", 600);
    expect(getTerm(db, "iphone 15")).toMatchObject({ baselineAt: 500, warmedUpAt: 600 });
  });
});
