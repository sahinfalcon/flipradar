import { openDatabase, type Db } from "../../src/db/database.js";
import { createSearch, type NewSearch, type Search } from "../../src/db/searches.js";
import { createUser, type User, type UserStatus } from "../../src/db/users.js";

export function memoryDb(): Db {
  return openDatabase(":memory:");
}

export function seedUser(db: Db, telegramId = 111, status: UserStatus = "beta", now = 0): User {
  return createUser(db, { telegramId, username: `user${telegramId}`, firstName: "Test" }, status, 5, now);
}

export function seedSearch(db: Db, overrides: Partial<NewSearch> = {}, now = 1_000): Search {
  return createSearch(
    db,
    {
      userId: 111,
      keywords: "iphone 15",
      maxPricePence: 30000,
      minPricePence: null,
      conditions: [],
      excludeWords: [],
      matchMode: "strict",
      ...overrides,
    },
    now,
  );
}
