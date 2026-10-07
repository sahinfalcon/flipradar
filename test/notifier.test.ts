import { describe, expect, it, vi } from "vitest";
import { FLOOD_WINDOW_MS } from "../src/alerts/flood.js";
import { classifyTelegramError, Notifier, type TelegramSender } from "../src/alerts/notifier.js";
import { createAlert, getAlert, setAlertStatus } from "../src/db/alerts.js";
import { saveItemDetail, upsertItemCard } from "../src/db/items.js";
import { getSearch, setSearchStatus } from "../src/db/searches.js";
import { getUser } from "../src/db/users.js";
import { makeCard, makeDetail } from "./helpers/cards.js";
import { memoryDb, seedSearch, seedUser } from "./helpers/db.js";

function telegramError(error_code: number, description: string, retry_after?: number) {
  return Object.assign(new Error(description), { error_code, description, parameters: retry_after ? { retry_after } : {} });
}

function setup() {
  const db = memoryDb();
  seedUser(db, 111);
  const search = seedSearch(db, {}, 0);
  let now = 1_000_000;
  const api = {
    sendMessage: vi.fn<TelegramSender["sendMessage"]>(async () => ({})),
    sendPhoto: vi.fn<TelegramSender["sendPhoto"]>(async () => ({})),
  };
  const sleep = vi.fn(async (ms: number) => {
    now += ms;
  });
  const notifier = new Notifier({ db, api, now: () => now, sleep, retryDelaysMs: [2000, 4000, 8000] });
  const addAlert = (vintedId: string, createdAt = now) => {
    upsertItemCard(db, makeCard({ vintedId, url: `https://www.vinted.co.uk/items/${vintedId}` }), createdAt);
    saveItemDetail(db, vintedId, makeDetail(), createdAt);
    return createAlert(db, { searchId: search.id, vintedId, insight: null, detailsUnavailable: false, createdAt })!;
  };
  return { db, search, api, sleep, notifier, addAlert, advance: (ms: number) => (now += ms), nowValue: () => now };
}

describe("classifyTelegramError", () => {
  it("recognises Telegram failure kinds", () => {
    expect(classifyTelegramError(telegramError(429, "Too Many Requests", 7))).toEqual({ kind: "retry_after", seconds: 7 });
    expect(classifyTelegramError(telegramError(403, "Forbidden: bot was blocked by the user"))).toEqual({ kind: "blocked" });
    expect(classifyTelegramError(telegramError(400, "Bad Request: wrong file"))).toEqual({ kind: "bad_request", description: "Bad Request: wrong file" });
    expect(classifyTelegramError(new Error("socket hang up"))).toEqual({ kind: "other", description: "socket hang up" });
  });
});

describe("Notifier", () => {
  it("sends a pending alert as a photo with caption and buttons", async () => {
    const { db, api, notifier, addAlert, search } = setup();
    const alert = addAlert("1");
    await notifier.tick();
    expect(api.sendPhoto).toHaveBeenCalledTimes(1);
    const [chatId, photo, other] = api.sendPhoto.mock.calls[0]!;
    expect(chatId).toBe(111);
    expect(photo).toBe(makeCard().photoUrl);
    expect(other?.caption).toContain("iPhone 15 128GB");
    expect(other?.reply_markup?.inline_keyboard[0]?.[1]?.callback_data).toBe(`pause:${search.id}`);
    expect(getAlert(db, alert.id)?.status).toBe("sent");
  });

  it("falls back to a text message when Telegram rejects the photo", async () => {
    const { db, api, notifier, addAlert } = setup();
    api.sendPhoto.mockRejectedValueOnce(telegramError(400, "Bad Request: wrong file identifier"));
    const alert = addAlert("1");
    await notifier.tick();
    expect(api.sendMessage).toHaveBeenCalledTimes(1);
    expect(getAlert(db, alert.id)?.status).toBe("sent");
  });

  it("waits retry_after on 429 then succeeds", async () => {
    const { db, api, sleep, notifier, addAlert } = setup();
    api.sendPhoto.mockRejectedValueOnce(telegramError(429, "Too Many Requests", 3));
    const alert = addAlert("1");
    await notifier.tick();
    expect(sleep).toHaveBeenCalledWith(3000);
    expect(getAlert(db, alert.id)?.status).toBe("sent");
  });

  it("marks the alert failed after retries are exhausted", async () => {
    const { db, api, sleep, notifier, addAlert } = setup();
    api.sendPhoto.mockRejectedValue(new Error("network down"));
    const alert = addAlert("1");
    await notifier.tick();
    expect(api.sendPhoto).toHaveBeenCalledTimes(4);
    expect(sleep.mock.calls.map(([ms]) => ms).filter((ms) => ms >= 2000)).toEqual([2000, 4000, 8000]);
    expect(getAlert(db, alert.id)?.status).toBe("failed");
  });

  it("pauses everything for a user who blocked the bot", async () => {
    const { db, api, notifier, addAlert, search } = setup();
    api.sendPhoto.mockRejectedValue(telegramError(403, "Forbidden: bot was blocked by the user"));
    const alert = addAlert("1");
    await notifier.tick();
    expect(getAlert(db, alert.id)?.status).toBe("failed");
    expect(getUser(db, 111)?.botBlocked).toBe(true);
    expect(getSearch(db, search.id)?.status).toBe("paused");
  });

  it("drops alerts for paused searches", async () => {
    const { db, api, notifier, addAlert, search } = setup();
    const alert = addAlert("1");
    setSearchStatus(db, search.id, "paused", 0);
    await notifier.tick();
    expect(api.sendPhoto).not.toHaveBeenCalled();
    expect(getAlert(db, alert.id)?.status).toBe("dropped");
  });

  it("keeps at least 1.1 s between messages to the same chat", async () => {
    const { api, sleep, notifier, addAlert } = setup();
    addAlert("1");
    addAlert("2");
    await notifier.tick();
    expect(api.sendPhoto).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(1100);
  });

  it("holds alerts during a flood and later sends one digest", async () => {
    const { db, api, notifier, addAlert, advance, nowValue } = setup();
    for (let i = 0; i < 10; i += 1) setAlertStatus(db, addAlert(`s${i}`).id, "sent", nowValue());
    const held = [addAlert("h1"), addAlert("h2")];
    await notifier.tick();
    expect(held.map((alert) => getAlert(db, alert.id)?.status)).toEqual(["digested", "digested"]);
    expect(api.sendMessage).not.toHaveBeenCalled();
    advance(FLOOD_WINDOW_MS + 1);
    await notifier.tick();
    expect(api.sendMessage).toHaveBeenCalledTimes(1);
    expect(api.sendMessage.mock.calls[0]?.[1]).toContain("2 more matches");
    expect(held.map((alert) => getAlert(db, alert.id)?.status)).toEqual(["digest_sent", "digest_sent"]);
  });

  it("drops pending alerts older than 10 minutes at startup", () => {
    const { db, notifier, addAlert, nowValue } = setup();
    const stale = addAlert("old", nowValue() - 11 * 60_000);
    const fresh = addAlert("new");
    expect(notifier.dropStale()).toBe(1);
    expect(getAlert(db, stale.id)?.status).toBe("dropped");
    expect(getAlert(db, fresh.id)?.status).toBe("pending");
  });
});
