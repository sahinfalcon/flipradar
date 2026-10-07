import type { Db } from "./database.js";

export interface PriceObservation {
  vintedId: string;
  groupKey: string;
  modelKnown: boolean;
  pricePence: number;
}

export function upsertPriceObservation(db: Db, obs: PriceObservation, now: number): void {
  db.prepare(
    `INSERT INTO price_observations (vinted_id, group_key, model_known, price_p, first_observed_at, observed_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(vinted_id) DO UPDATE SET
       group_key = excluded.group_key, model_known = excluded.model_known,
       price_p = excluded.price_p, observed_at = excluded.observed_at`,
  ).run(obs.vintedId, obs.groupKey, obs.modelKnown ? 1 : 0, obs.pricePence, now, now);
}

export function groupPrices(db: Db, groupKey: string, since: number, excludeVintedId?: string): number[] {
  const rows = db
    .prepare("SELECT price_p FROM price_observations WHERE group_key = ? AND observed_at >= ? AND vinted_id != ?")
    .all(groupKey, since, excludeVintedId ?? "") as Array<{ price_p: number }>;
  return rows.map((row) => row.price_p);
}

/** Prices of listings with a known model for any group of this term (used for the min-price suggestion). */
export function termModelPrices(db: Db, termKey: string, since: number): number[] {
  const prefix = `${termKey}|`;
  const rows = db
    .prepare("SELECT price_p FROM price_observations WHERE substr(group_key, 1, ?) = ? AND model_known = 1 AND observed_at >= ?")
    .all(prefix.length, prefix, since) as Array<{ price_p: number }>;
  return rows.map((row) => row.price_p);
}
