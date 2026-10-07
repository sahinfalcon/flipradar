import { Bot } from "grammy";
import { describe, expect, it, vi } from "vitest";
import { attachHandlers, toInlineMarkup } from "../src/bot/bot.js";
import { BotService } from "../src/bot/service.js";
import { Health } from "../src/health/health.js";
import { createSearch } from "../src/db/searches.js";
import { createUser } from "../src/db/users.js";
import { memoryDb } from "./helpers/db.js";

const botInfo = {
  id: 1,
  is_bot: true,
  first_name: "flipradar",
  username: "flipradar_bot",
  can_join_groups: false,
  can_read_all_group_messages: false,
  supports_inline_queries: false,
  can_connect_to_business: false,
  has_main_web_app: false,
};

function setup(failEdit?: { error_code: number; description: string }) {
  const db = memoryDb();
  const service = new BotService({
    db,
    adminTelegramId: 42,
    defaultSearchLimit: 5,
    botUsername: () => "flipradar_bot",
    now: () => 1_000,
    ensureFresh: async () => {},
    notifyOwner: async () => {},
    healthSnapshot: () => new Health({ notifyOwner: async () => {} }).snapshot(),
  });
  const bot = new Bot("123:test", { botInfo: botInfo as never });
  const calls: Array<{ method: string; payload: Record<string, unknown> }> = [];
  bot.api.config.use(async (_prev, method, payload) => {
    calls.push({ method, payload: payload as Record<string, unknown> });
    if (method === "editMessageText" && failEdit) return { ok: false, ...failEdit } as never;
    const result = method === "sendMessage" ? { message_id: 1, date: 0, chat: { id: 7, type: "private" }, text: "" } : true;
    return { ok: true, result } as never;
  });
  const log = { error: vi.fn() };
  attachHandlers(bot, service, log);
  return { bot, calls, log, db };
}

const from = { id: 7, is_bot: false, first_name: "T", username: "tester" };
const chat = { id: 7, type: "private", first_name: "T" };

describe("toInlineMarkup", () => {
  it("converts buttons and omits empty keyboards", () => {
    expect(toInlineMarkup(undefined)).toBeUndefined();
    expect(toInlineMarkup([])).toBeUndefined();
    expect(toInlineMarkup([[{ text: "Open", url: "https://x" }, { text: "Pause", data: "pause:1" }]])).toEqual({
      inline_keyboard: [[{ text: "Open", url: "https://x" }, { text: "Pause", callback_data: "pause:1" }]],
    });
  });
});

describe("attachHandlers", () => {
  it("routes /start to the service and replies in HTML", async () => {
    const { bot, calls } = setup();
    await bot.handleUpdate({
      update_id: 1,
      message: { message_id: 1, date: 0, chat, from, text: "/start", entities: [{ type: "bot_command", offset: 0, length: 6 }] },
    } as never);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.method).toBe("sendMessage");
    expect(calls[0]?.payload["parse_mode"]).toBe("HTML");
    expect(String(calls[0]?.payload["text"])).toContain("waitlist");
  });

  it("answers callback queries with a toast", async () => {
    const { bot, calls } = setup();
    await bot.handleUpdate({
      update_id: 2,
      callback_query: { id: "cb1", from, chat_instance: "x", data: "pause:1", message: { message_id: 5, date: 0, chat, text: "x" } },
    } as never);
    expect(calls[0]?.method).toBe("answerCallbackQuery");
    expect(calls[0]?.payload["text"]).toBe("Not available");
  });

  it("ignores group chats", async () => {
    const { bot, calls } = setup();
    await bot.handleUpdate({
      update_id: 3,
      message: { message_id: 1, date: 0, chat: { id: -5, type: "group", title: "g" }, from, text: "/start", entities: [{ type: "bot_command", offset: 0, length: 6 }] },
    } as never);
    expect(calls).toHaveLength(0);
  });
});

describe("editing messages in place", () => {
  const member = (db: ReturnType<typeof memoryDb>) => {
    createUser(db, { telegramId: 7, username: "tester", firstName: "T" }, "beta", 5, 0);
    return createSearch(db, { userId: 7, keywords: "ps5", maxPricePence: 30_000, minPricePence: null, conditions: [], excludeWords: [], matchMode: "strict" }, 0);
  };
  const press = (data: string, message: Record<string, unknown>) =>
    ({ update_id: 10, callback_query: { id: "cb", from, chat_instance: "x", data, message: { message_id: 5, date: 0, chat, ...message } } }) as never;

  it("edits the text message that holds the button", async () => {
    const { bot, calls, db } = setup();
    const search = member(db);
    await bot.handleUpdate(press(`pause:${search.id}`, { text: "ps5 card" }));
    expect(calls.map((call) => call.method)).toEqual(["answerCallbackQuery", "editMessageText"]);
    expect(calls[1]?.payload).toMatchObject({ chat_id: 7, message_id: 5, parse_mode: "HTML" });
    expect(String(calls[1]?.payload["text"])).toContain("⏸ Paused");
  });

  it("treats 'message is not modified' as success", async () => {
    const { bot, calls, db, log } = setup({ error_code: 400, description: "Bad Request: message is not modified" });
    const search = member(db);
    await bot.handleUpdate(press(`pause:${search.id}`, { text: "ps5 card" }));
    expect(calls.map((call) => call.method)).toEqual(["answerCallbackQuery", "editMessageText"]);
    expect(log.error).not.toHaveBeenCalled();
  });

  it("sends a new message when the button sits on an alert photo", async () => {
    const { bot, calls, db } = setup();
    const search = member(db);
    await bot.handleUpdate(press(`pause:${search.id}`, { photo: [{ file_id: "p", file_unique_id: "u", width: 1, height: 1 }], caption: "alert" }));
    expect(calls.map((call) => call.method)).toEqual(["answerCallbackQuery", "sendMessage"]);
  });

  it("falls back to a new message when editing fails for another reason", async () => {
    const { bot, calls, db } = setup({ error_code: 400, description: "Bad Request: message can't be edited" });
    const search = member(db);
    await bot.handleUpdate(press(`pause:${search.id}`, { text: "ps5 card" }));
    expect(calls.map((call) => call.method)).toEqual(["answerCallbackQuery", "editMessageText", "sendMessage"]);
  });
});
