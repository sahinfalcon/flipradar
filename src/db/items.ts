import type { ConditionCode } from "../matching/conditions.js";
import type { CardListing, ItemDetail } from "../vinted/types.js";
import type { Db } from "./database.js";

export interface StoredItem extends CardListing {
  cardSeenAt: number;
  detail: ItemDetail | null;
  detailFetchedAt: number | null;
}

interface ItemRow {
  vinted_id: string;
  title: string;
  brand: string | null;
  model: string | null;
  condition: string;
  price_p: number | null;
  item_price_p: number | null;
  photo_url: string | null;
  url: string;
  card_seen_at: number;
  detail_json: string | null;
  detail_fetched_at: number | null;
}

const toItem = (row: ItemRow): StoredItem => ({
  vintedId: row.vinted_id,
  title: row.title,
  brand: row.brand,
  model: row.model,
  condition: row.condition as ConditionCode,
  pricePence: row.price_p,
  itemPricePence: row.item_price_p,
  photoUrl: row.photo_url,
  url: row.url,
  cardSeenAt: row.card_seen_at,
  detail: row.detail_json ? (JSON.parse(row.detail_json) as ItemDetail) : null,
  detailFetchedAt: row.detail_fetched_at,
});

export function upsertItemCard(db: Db, card: CardListing, now: number): void {
  db.prepare(
    `INSERT INTO items (vinted_id, title, brand, model, condition, price_p, item_price_p, photo_url, url, card_seen_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(vinted_id) DO UPDATE SET
       title = excluded.title, brand = excluded.brand, model = excluded.model, condition = excluded.condition,
       price_p = excluded.price_p, item_price_p = excluded.item_price_p, photo_url = excluded.photo_url,
       url = excluded.url, card_seen_at = excluded.card_seen_at`,
  ).run(card.vintedId, card.title, card.brand, card.model, card.condition, card.pricePence, card.itemPricePence, card.photoUrl, card.url, now);
}

export function getItem(db: Db, vintedId: string): StoredItem | undefined {
  const row = db.prepare("SELECT * FROM items WHERE vinted_id = ?").get(vintedId) as ItemRow | undefined;
  return row ? toItem(row) : undefined;
}

export function saveItemDetail(db: Db, vintedId: string, detail: ItemDetail, now: number): void {
  db.prepare("UPDATE items SET detail_json = ?, detail_fetched_at = ? WHERE vinted_id = ?").run(JSON.stringify(detail), now, vintedId);
}

export function knownTermItemIds(db: Db, termKey: string, ids: string[]): Set<string> {
  if (ids.length === 0) return new Set();
  const rows = db
    .prepare("SELECT vinted_id FROM term_items WHERE term_key = ? AND vinted_id IN (SELECT value FROM json_each(?))")
    .all(termKey, JSON.stringify(ids)) as Array<{ vinted_id: string }>;
  return new Set(rows.map((row) => row.vinted_id));
}

export function insertTermItems(db: Db, termKey: string, ids: string[], now: number): void {
  const insert = db.prepare("INSERT OR IGNORE INTO term_items (term_key, vinted_id, first_seen_at, last_seen_at) VALUES (?, ?, ?, ?)");
  db.transaction(() => {
    for (const id of ids) insert.run(termKey, id, now, now);
  })();
}

export function touchTermItems(db: Db, termKey: string, ids: string[], now: number): void {
  const update = db.prepare("UPDATE term_items SET last_seen_at = ? WHERE term_key = ? AND vinted_id = ?");
  db.transaction(() => {
    for (const id of ids) update.run(now, termKey, id);
  })();
}

export function recentItemsForTerm(db: Db, termKey: string, limit: number): StoredItem[] {
  const rows = db
    .prepare(
      "SELECT i.* FROM items i JOIN term_items t ON t.vinted_id = i.vinted_id WHERE t.term_key = ? ORDER BY CAST(i.vinted_id AS INTEGER) DESC LIMIT ?",
    )
    .all(termKey, limit) as ItemRow[];
  return rows.map(toItem);
}
