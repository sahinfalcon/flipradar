import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { SCHEMA_V1 } from "./schema.js";

export type Db = Database.Database;

export function migrate(db: Db): void {
  const version = db.pragma("user_version", { simple: true }) as number;
  if (version < 1) {
    db.exec(SCHEMA_V1);
    db.pragma("user_version = 1");
  }
}

export function openDatabase(path: string): Db {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  migrate(db);
  return db;
}
