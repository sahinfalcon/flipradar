import { describe, expect, it } from "vitest";
import { migrate } from "../src/db/database.js";
import { clearWizardState, getMeta, getWizardState, saveWizardState, setMeta } from "../src/db/meta.js";
import {
  countUsersByStatus,
  createInvites,
  deleteUserData,
  getUser,
  listWaitlist,
  redeemInvite,
  setBotBlocked,
  setUserStatus,
  touchUserProfile,
  waitlistPosition,
} from "../src/db/users.js";
import { memoryDb, seedUser } from "./helpers/db.js";

describe("database", () => {
  it("migrates idempotently", () => {
    const db = memoryDb();
    expect(() => migrate(db)).not.toThrow();
    expect(db.pragma("user_version", { simple: true })).toBe(1);
  });
});

describe("users", () => {
  it("creates, reads and updates users", () => {
    const db = memoryDb();
    seedUser(db, 7, "waitlist", 100);
    expect(getUser(db, 7)).toEqual({ telegramId: 7, username: "user7", firstName: "Test", status: "waitlist", searchLimit: 5, botBlocked: false, createdAt: 100 });
    setBotBlocked(db, 7, true);
    expect(getUser(db, 7)?.botBlocked).toBe(true);
    touchUserProfile(db, { telegramId: 7, username: "renamed", firstName: "New" });
    expect(getUser(db, 7)).toMatchObject({ username: "renamed", firstName: "New", botBlocked: false });
    setUserStatus(db, 7, "beta");
    expect(getUser(db, 7)?.status).toBe("beta");
    expect(getUser(db, 999)).toBeUndefined();
  });

  it("numbers the waitlist in join order and lists newest first", () => {
    const db = memoryDb();
    seedUser(db, 1, "waitlist", 10);
    seedUser(db, 2, "beta", 15);
    seedUser(db, 3, "waitlist", 20);
    seedUser(db, 4, "waitlist", 30);
    expect([1, 3, 4].map((id) => waitlistPosition(db, id))).toEqual([1, 2, 3]);
    expect(listWaitlist(db, 2).map((u) => u.telegramId)).toEqual([4, 3]);
    expect(countUsersByStatus(db)).toEqual({ waitlist: 3, beta: 1, admin: 0 });
  });
});

describe("invites", () => {
  it("creates unique codes that redeem exactly once", () => {
    const db = memoryDb();
    const codes = createInvites(db, 42, 3, 0);
    expect(codes).toHaveLength(3);
    expect(new Set(codes).size).toBe(3);
    for (const code of codes) expect(code).toMatch(/^[A-Za-z0-9_-]{8}$/);
    expect(redeemInvite(db, codes[0]!, 7, 1)).toBe(true);
    expect(redeemInvite(db, codes[0]!, 8, 2)).toBe(false);
    expect(redeemInvite(db, "nope", 8, 2)).toBe(false);
  });
});

describe("deleteUserData", () => {
  it("removes searches, alerts, wizard state and the user, and anonymises invites", () => {
    const db = memoryDb();
    seedUser(db, 111);
    const [code] = createInvites(db, 42, 1, 0);
    redeemInvite(db, code!, 111, 1);
    db.prepare(
      "INSERT INTO searches (id,user_id,keywords,term_key,max_price_p,min_price_p,conditions,exclude_words,match_mode,status,active_since,created_at) VALUES (1,111,'x','x',100,NULL,'[]','[]','strict','active',0,0)",
    ).run();
    db.prepare("INSERT INTO alerts (search_id,vinted_id,status,created_at) VALUES (1,'9','pending',0)").run();
    saveWizardState(db, 111, { step: "keywords" }, 0);

    deleteUserData(db, 111);

    expect(getUser(db, 111)).toBeUndefined();
    expect(db.prepare("SELECT COUNT(*) AS n FROM searches").get()).toEqual({ n: 0 });
    expect(db.prepare("SELECT COUNT(*) AS n FROM alerts").get()).toEqual({ n: 0 });
    expect(db.prepare("SELECT COUNT(*) AS n FROM wizard_state").get()).toEqual({ n: 0 });
    expect(db.prepare("SELECT used_by FROM invites").get()).toEqual({ used_by: null });
    expect(redeemInvite(db, code!, 222, 2)).toBe(false);
  });
});

describe("meta and wizard state", () => {
  it("stores key/values", () => {
    const db = memoryDb();
    expect(getMeta(db, "started_at")).toBeUndefined();
    setMeta(db, "started_at", "5");
    setMeta(db, "started_at", "6");
    expect(getMeta(db, "started_at")).toBe("6");
  });

  it("expires wizard state after the TTL", () => {
    const db = memoryDb();
    saveWizardState(db, 1, { step: "maxPrice" }, 1_000);
    expect(getWizardState(db, 1, 2_000, 3_600_000)).toEqual({ step: "maxPrice" });
    expect(getWizardState(db, 1, 1_000 + 3_600_001, 3_600_000)).toBeUndefined();
    saveWizardState(db, 1, { step: "keywords" }, 0);
    clearWizardState(db, 1);
    expect(getWizardState(db, 1, 0, 3_600_000)).toBeUndefined();
  });
});
