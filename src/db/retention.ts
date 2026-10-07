import type { Db } from "./database.js";
import { deleteIdleTerms } from "./terms.js";

export const DAY_MS = 86_400_000;
export const ITEM_RETENTION_MS = 7 * DAY_MS;
export const PRICE_RETENTION_MS = 30 * DAY_MS;
export const ALERT_RETENTION_MS = 30 * DAY_MS;
export const WIZARD_TTL_MS = 60 * 60_000;

/** Spec §5 retention; run hourly. */
export function runRetention(db: Db, now: number): void {
  db.transaction(() => {
    db.prepare("DELETE FROM term_items WHERE last_seen_at < ?").run(now - ITEM_RETENTION_MS);
    db.prepare(
      "DELETE FROM items WHERE card_seen_at < ? AND vinted_id NOT IN (SELECT vinted_id FROM alerts WHERE status IN ('pending','digested'))",
    ).run(now - ITEM_RETENTION_MS);
    db.prepare("DELETE FROM price_observations WHERE observed_at < ?").run(now - PRICE_RETENTION_MS);
    db.prepare("DELETE FROM alerts WHERE created_at < ?").run(now - ALERT_RETENTION_MS);
    db.prepare("DELETE FROM wizard_state WHERE updated_at < ?").run(now - WIZARD_TTL_MS);
    deleteIdleTerms(db);
  })();
}
