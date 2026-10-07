import type { Db } from "./database.js";

export function getMeta(db: Db, key: string): string | undefined {
  const row = db.prepare("SELECT value FROM meta WHERE key = ?").get(key) as { value: string } | undefined;
  return row?.value;
}

export function setMeta(db: Db, key: string, value: string): void {
  db.prepare("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, value);
}

export function getWizardState<T>(db: Db, telegramId: number, now: number, ttlMs: number): T | undefined {
  const row = db.prepare("SELECT state_json, updated_at FROM wizard_state WHERE telegram_id = ?").get(telegramId) as
    | { state_json: string; updated_at: number }
    | undefined;
  if (!row) return undefined;
  if (now - row.updated_at > ttlMs) {
    clearWizardState(db, telegramId);
    return undefined;
  }
  return JSON.parse(row.state_json) as T;
}

export function saveWizardState(db: Db, telegramId: number, state: unknown, now: number): void {
  db.prepare(
    "INSERT INTO wizard_state (telegram_id, state_json, updated_at) VALUES (?, ?, ?) ON CONFLICT(telegram_id) DO UPDATE SET state_json = excluded.state_json, updated_at = excluded.updated_at",
  ).run(telegramId, JSON.stringify(state), now);
}

export function clearWizardState(db: Db, telegramId: number): void {
  db.prepare("DELETE FROM wizard_state WHERE telegram_id = ?").run(telegramId);
}
