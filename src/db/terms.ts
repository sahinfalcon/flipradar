import type { Db } from "./database.js";

export interface Term {
  termKey: string;
  baselineAt: number | null;
  warmedUpAt: number | null;
  lastPolledAt: number | null;
  lastSuccessAt: number | null;
  hadResults: boolean;
  emptyStreak: number;
}

interface TermRow {
  term_key: string;
  baseline_at: number | null;
  warmed_up_at: number | null;
  last_polled_at: number | null;
  last_success_at: number | null;
  had_results: number;
  empty_streak: number;
}

const toTerm = (row: TermRow): Term => ({
  termKey: row.term_key,
  baselineAt: row.baseline_at,
  warmedUpAt: row.warmed_up_at,
  lastPolledAt: row.last_polled_at,
  lastSuccessAt: row.last_success_at,
  hadResults: row.had_results === 1,
  emptyStreak: row.empty_streak,
});

export function ensureTerm(db: Db, termKey: string): void {
  db.prepare("INSERT OR IGNORE INTO terms (term_key) VALUES (?)").run(termKey);
}

export function getTerm(db: Db, termKey: string): Term | undefined {
  const row = db.prepare("SELECT * FROM terms WHERE term_key = ?").get(termKey) as TermRow | undefined;
  return row ? toTerm(row) : undefined;
}

export function listActiveTerms(db: Db): Term[] {
  const rows = db
    .prepare(
      "SELECT t.* FROM terms t WHERE EXISTS (SELECT 1 FROM searches s WHERE s.term_key = t.term_key AND s.status = 'active') ORDER BY t.term_key",
    )
    .all() as TermRow[];
  return rows.map(toTerm);
}

export function markPolled(db: Db, termKey: string, now: number): void {
  db.prepare("UPDATE terms SET last_polled_at = ? WHERE term_key = ?").run(now, termKey);
}

/** A recognised result (cards or the empty state): reset the layout-alarm streak. */
export function markSuccess(db: Db, termKey: string, now: number, hadCards: boolean): void {
  db.prepare("UPDATE terms SET last_success_at = ?, empty_streak = 0, had_results = MAX(had_results, ?) WHERE term_key = ?").run(
    now,
    hadCards ? 1 : 0,
    termKey,
  );
}

export function bumpEmptyStreak(db: Db, termKey: string): number {
  db.prepare("UPDATE terms SET empty_streak = empty_streak + 1 WHERE term_key = ?").run(termKey);
  return getTerm(db, termKey)?.emptyStreak ?? 0;
}

export function setBaseline(db: Db, termKey: string, now: number): void {
  db.prepare("UPDATE terms SET baseline_at = ? WHERE term_key = ?").run(now, termKey);
}

export function setWarmedUp(db: Db, termKey: string, now: number): void {
  db.prepare("UPDATE terms SET warmed_up_at = ? WHERE term_key = ?").run(now, termKey);
}

export function deleteIdleTerms(db: Db): number {
  return db
    .prepare("DELETE FROM terms WHERE NOT EXISTS (SELECT 1 FROM searches s WHERE s.term_key = terms.term_key AND s.status = 'active')")
    .run().changes;
}
