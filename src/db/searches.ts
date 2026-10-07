import type { ConditionCode } from "../matching/conditions.js";
import type { MatchableSearch } from "../matching/match.js";
import { toTermKey } from "../matching/normalize.js";
import type { Db } from "./database.js";
import { ensureTerm, resetBaseline } from "./terms.js";

export type MatchMode = "strict" | "loose";
export type SearchStatus = "active" | "paused";

export interface Search extends MatchableSearch {
  id: number;
  userId: number;
  termKey: string;
  status: SearchStatus;
  activeSince: number;
  createdAt: number;
}

export interface NewSearch {
  userId: number;
  keywords: string;
  maxPricePence: number;
  minPricePence: number | null;
  conditions: ConditionCode[];
  excludeWords: string[];
  matchMode: MatchMode;
}

interface SearchRow {
  id: number;
  user_id: number;
  keywords: string;
  term_key: string;
  max_price_p: number;
  min_price_p: number | null;
  conditions: string;
  exclude_words: string;
  match_mode: MatchMode;
  status: SearchStatus;
  active_since: number;
  created_at: number;
}

const toSearch = (row: SearchRow): Search => ({
  id: row.id,
  userId: row.user_id,
  keywords: row.keywords,
  termKey: row.term_key,
  maxPricePence: row.max_price_p,
  minPricePence: row.min_price_p,
  conditions: JSON.parse(row.conditions) as ConditionCode[],
  excludeWords: JSON.parse(row.exclude_words) as string[],
  matchMode: row.match_mode,
  status: row.status,
  activeSince: row.active_since,
  createdAt: row.created_at,
});

export function getSearch(db: Db, id: number): Search | undefined {
  const row = db.prepare("SELECT * FROM searches WHERE id = ?").get(id) as SearchRow | undefined;
  return row ? toSearch(row) : undefined;
}

export function createSearch(db: Db, input: NewSearch, now: number): Search {
  const termKey = toTermKey(input.keywords);
  ensureTerm(db, termKey);
  const info = db
    .prepare(
      `INSERT INTO searches (user_id, keywords, term_key, max_price_p, min_price_p, conditions, exclude_words, match_mode, status, active_since, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)`,
    )
    .run(
      input.userId,
      input.keywords,
      termKey,
      input.maxPricePence,
      input.minPricePence,
      JSON.stringify(input.conditions),
      JSON.stringify(input.excludeWords),
      input.matchMode,
      now,
      now,
    );
  return getSearch(db, Number(info.lastInsertRowid))!;
}

export function listSearchesByUser(db: Db, userId: number): Search[] {
  return (db.prepare("SELECT * FROM searches WHERE user_id = ? ORDER BY id").all(userId) as SearchRow[]).map(toSearch);
}

export function countSearchesByUser(db: Db, userId: number): number {
  return (db.prepare("SELECT COUNT(*) AS n FROM searches WHERE user_id = ?").get(userId) as { n: number }).n;
}

/**
 * Resuming resets active_since. If no other active search shares the term, the term's
 * baseline is reset too: nobody polled it while paused, so its unseen listings are old.
 */
export function setSearchStatus(db: Db, id: number, status: SearchStatus, now: number): void {
  if (status === "active") {
    const before = getSearch(db, id);
    if (!before || before.status === "active") return;
    db.prepare("UPDATE searches SET status = 'active', active_since = ? WHERE id = ?").run(now, id);
    ensureTerm(db, before.termKey);
    const others = db
      .prepare("SELECT COUNT(*) AS n FROM searches WHERE term_key = ? AND status = 'active' AND id != ?")
      .get(before.termKey, id) as { n: number };
    if (others.n === 0) resetBaseline(db, before.termKey);
  } else {
    db.prepare("UPDATE searches SET status = 'paused' WHERE id = ?").run(id);
  }
}

export function deleteSearch(db: Db, id: number): void {
  db.transaction((searchId: number) => {
    db.prepare("DELETE FROM alerts WHERE search_id = ?").run(searchId);
    db.prepare("DELETE FROM searches WHERE id = ?").run(searchId);
  })(id);
}

export function activeSearchesForTerm(db: Db, termKey: string): Search[] {
  return (db.prepare("SELECT * FROM searches WHERE term_key = ? AND status = 'active' ORDER BY id").all(termKey) as SearchRow[]).map(toSearch);
}

export function pauseAllSearchesForUser(db: Db, userId: number): void {
  db.prepare("UPDATE searches SET status = 'paused' WHERE user_id = ?").run(userId);
}

export function countActiveSearches(db: Db): number {
  return (db.prepare("SELECT COUNT(*) AS n FROM searches WHERE status = 'active'").get() as { n: number }).n;
}
