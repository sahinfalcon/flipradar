import type { Insight } from "../insight/stats.js";
import type { Db } from "./database.js";

export type AlertStatus = "pending" | "sent" | "digested" | "digest_sent" | "dropped" | "failed";

export interface Alert {
  id: number;
  searchId: number;
  vintedId: string;
  status: AlertStatus;
  insight: Insight | null;
  detailsUnavailable: boolean;
  createdAt: number;
  sentAt: number | null;
}

export interface PendingAlert extends Alert {
  chatId: number;
}

interface AlertRow {
  id: number;
  search_id: number;
  vinted_id: string;
  status: AlertStatus;
  insight_json: string | null;
  details_unavailable: number;
  created_at: number;
  sent_at: number | null;
}

const toAlert = (row: AlertRow): Alert => ({
  id: row.id,
  searchId: row.search_id,
  vintedId: row.vinted_id,
  status: row.status,
  insight: row.insight_json ? (JSON.parse(row.insight_json) as Insight) : null,
  detailsUnavailable: row.details_unavailable === 1,
  createdAt: row.created_at,
  sentAt: row.sent_at,
});

export function getAlert(db: Db, id: number): Alert | undefined {
  const row = db.prepare("SELECT * FROM alerts WHERE id = ?").get(id) as AlertRow | undefined;
  return row ? toAlert(row) : undefined;
}

/** Returns null when this (search, item) pair already has an alert. */
export function createAlert(
  db: Db,
  input: { searchId: number; vintedId: string; insight: Insight | null; detailsUnavailable: boolean; createdAt: number },
): Alert | null {
  const info = db
    .prepare(
      "INSERT OR IGNORE INTO alerts (search_id, vinted_id, status, insight_json, details_unavailable, created_at) VALUES (?, ?, 'pending', ?, ?, ?)",
    )
    .run(input.searchId, input.vintedId, input.insight ? JSON.stringify(input.insight) : null, input.detailsUnavailable ? 1 : 0, input.createdAt);
  return info.changes === 0 ? null : getAlert(db, Number(info.lastInsertRowid))!;
}

export function listPendingAlerts(db: Db, limit: number): PendingAlert[] {
  const rows = db
    .prepare(
      "SELECT a.*, s.user_id AS chat_id FROM alerts a JOIN searches s ON s.id = a.search_id WHERE a.status = 'pending' ORDER BY a.created_at, a.id LIMIT ?",
    )
    .all(limit) as Array<AlertRow & { chat_id: number }>;
  return rows.map((row) => ({ ...toAlert(row), chatId: row.chat_id }));
}

export function setAlertStatus(db: Db, id: number, status: AlertStatus, sentAt: number | null = null): void {
  db.prepare("UPDATE alerts SET status = ?, sent_at = COALESCE(?, sent_at) WHERE id = ?").run(status, sentAt, id);
}

export function sentTimesForSearch(db: Db, searchId: number, since: number): number[] {
  const rows = db
    .prepare("SELECT sent_at FROM alerts WHERE search_id = ? AND status = 'sent' AND sent_at >= ? ORDER BY sent_at")
    .all(searchId, since) as Array<{ sent_at: number }>;
  return rows.map((row) => row.sent_at);
}

export function heldAlertsForSearch(db: Db, searchId: number): Alert[] {
  const rows = db.prepare("SELECT * FROM alerts WHERE search_id = ? AND status = 'digested' ORDER BY created_at, id").all(searchId) as AlertRow[];
  return rows.map(toAlert);
}

export function searchesWithHeldAlerts(db: Db): number[] {
  const rows = db.prepare("SELECT DISTINCT search_id FROM alerts WHERE status = 'digested' ORDER BY search_id").all() as Array<{ search_id: number }>;
  return rows.map((row) => row.search_id);
}

export function dropStalePending(db: Db, olderThan: number): number {
  return db.prepare("UPDATE alerts SET status = 'dropped' WHERE status = 'pending' AND created_at < ?").run(olderThan).changes;
}

export function sentLatencies(db: Db, since: number): number[] {
  const rows = db
    .prepare("SELECT sent_at - created_at AS latency FROM alerts WHERE status = 'sent' AND sent_at >= ?")
    .all(since) as Array<{ latency: number }>;
  return rows.map((row) => row.latency);
}
