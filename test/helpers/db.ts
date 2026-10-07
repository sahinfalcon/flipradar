import { openDatabase, type Db } from "../../src/db/database.js";
import { createUser, type User, type UserStatus } from "../../src/db/users.js";

export function memoryDb(): Db {
  return openDatabase(":memory:");
}

export function seedUser(db: Db, telegramId = 111, status: UserStatus = "beta", now = 0): User {
  return createUser(db, { telegramId, username: `user${telegramId}`, firstName: "Test" }, status, 5, now);
}
