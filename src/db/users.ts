import { randomBytes } from "node:crypto";
import type { Db } from "./database.js";

export type UserStatus = "waitlist" | "beta" | "admin";

export interface User {
  telegramId: number;
  username: string | null;
  firstName: string | null;
  status: UserStatus;
  searchLimit: number;
  botBlocked: boolean;
  createdAt: number;
}

export interface UserProfile {
  telegramId: number;
  username: string | null;
  firstName: string | null;
}

interface UserRow {
  telegram_id: number;
  username: string | null;
  first_name: string | null;
  status: UserStatus;
  search_limit: number;
  bot_blocked: number;
  created_at: number;
}

const toUser = (row: UserRow): User => ({
  telegramId: row.telegram_id,
  username: row.username,
  firstName: row.first_name,
  status: row.status,
  searchLimit: row.search_limit,
  botBlocked: row.bot_blocked === 1,
  createdAt: row.created_at,
});

export function getUser(db: Db, telegramId: number): User | undefined {
  const row = db.prepare("SELECT * FROM users WHERE telegram_id = ?").get(telegramId) as UserRow | undefined;
  return row ? toUser(row) : undefined;
}

export function createUser(db: Db, profile: UserProfile, status: UserStatus, searchLimit: number, now: number): User {
  db.prepare(
    "INSERT INTO users (telegram_id, username, first_name, status, search_limit, bot_blocked, created_at) VALUES (?, ?, ?, ?, ?, 0, ?)",
  ).run(profile.telegramId, profile.username, profile.firstName, status, searchLimit, now);
  return getUser(db, profile.telegramId)!;
}

/** Called whenever a user messages the bot: refresh their name and clear the blocked flag. */
export function touchUserProfile(db: Db, profile: UserProfile): void {
  db.prepare("UPDATE users SET username = ?, first_name = ?, bot_blocked = 0 WHERE telegram_id = ?").run(
    profile.username,
    profile.firstName,
    profile.telegramId,
  );
}

export function setUserStatus(db: Db, telegramId: number, status: UserStatus): void {
  db.prepare("UPDATE users SET status = ? WHERE telegram_id = ?").run(status, telegramId);
}

export function setBotBlocked(db: Db, telegramId: number, blocked: boolean): void {
  db.prepare("UPDATE users SET bot_blocked = ? WHERE telegram_id = ?").run(blocked ? 1 : 0, telegramId);
}

/** 1-based position by join time; same-millisecond joins are ordered by Telegram ID so positions stay distinct. */
export function waitlistPosition(db: Db, telegramId: number): number {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS n FROM users w, users me
       WHERE me.telegram_id = ? AND w.status = 'waitlist'
         AND (w.created_at < me.created_at OR (w.created_at = me.created_at AND w.telegram_id <= me.telegram_id))`,
    )
    .get(telegramId) as { n: number };
  return row.n;
}

export function listWaitlist(db: Db, limit: number): User[] {
  const rows = db.prepare("SELECT * FROM users WHERE status = 'waitlist' ORDER BY created_at DESC LIMIT ?").all(limit) as UserRow[];
  return rows.map(toUser);
}

export function countUsersByStatus(db: Db): Record<UserStatus, number> {
  const counts: Record<UserStatus, number> = { waitlist: 0, beta: 0, admin: 0 };
  const rows = db.prepare("SELECT status, COUNT(*) AS n FROM users GROUP BY status").all() as Array<{ status: UserStatus; n: number }>;
  for (const row of rows) counts[row.status] = row.n;
  return counts;
}

/** /deleteme: remove everything about a user; invites they used stay consumed but anonymous. */
export function deleteUserData(db: Db, telegramId: number): void {
  db.transaction((id: number) => {
    db.prepare("DELETE FROM alerts WHERE search_id IN (SELECT id FROM searches WHERE user_id = ?)").run(id);
    db.prepare("DELETE FROM searches WHERE user_id = ?").run(id);
    db.prepare("DELETE FROM wizard_state WHERE telegram_id = ?").run(id);
    db.prepare("UPDATE invites SET used_by = NULL WHERE used_by = ?").run(id);
    db.prepare("DELETE FROM users WHERE telegram_id = ?").run(id);
  })(telegramId);
}

export function createInvites(db: Db, createdBy: number, count: number, now: number): string[] {
  const insert = db.prepare("INSERT INTO invites (code, created_by, created_at) VALUES (?, ?, ?)");
  const codes: string[] = [];
  db.transaction(() => {
    while (codes.length < count) {
      const code = randomBytes(6).toString("base64url");
      if (insert.run(code, createdBy, now).changes === 1) codes.push(code);
    }
  })();
  return codes;
}

/** Atomically consume an unused invite. */
export function redeemInvite(db: Db, code: string, telegramId: number, now: number): boolean {
  const result = db.prepare("UPDATE invites SET used_by = ?, used_at = ? WHERE code = ? AND used_at IS NULL").run(telegramId, now, code);
  return result.changes === 1;
}
