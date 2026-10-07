import { Bot } from "grammy";
import { existsSync } from "node:fs";
import pino from "pino";
import { Notifier, type TelegramSender } from "./alerts/notifier.js";
import { processNewItems } from "./alerts/pipeline.js";
import { attachHandlers, BOT_COMMANDS } from "./bot/bot.js";
import { BotService } from "./bot/service.js";
import { loadConfig } from "./config.js";
import { openDatabase } from "./db/database.js";
import { getMeta, setMeta } from "./db/meta.js";
import { runRetention } from "./db/retention.js";
import { Health } from "./health/health.js";
import { Poller } from "./poller/poller.js";
import { RequestQueue } from "./poller/requestQueue.js";
import { VintedClient } from "./vinted/client.js";

if (existsSync(".env")) process.loadEnvFile(".env");
const config = loadConfig();
const log = pino({ level: config.logLevel });
const db = openDatabase(config.databasePath);
const bot = new Bot(config.telegramBotToken);

const notifyOwner = async (text: string): Promise<void> => {
  await bot.api.sendMessage(config.adminTelegramId, text, { parse_mode: "HTML" });
};

const health = new Health({ notifyOwner });
const queue = new RequestQueue({
  spacingMs: config.requestSpacingMs,
  jitterMs: 500,
  onBackoffChange: (state) => void health.onBackoffChange(state),
});
const client = new VintedClient({ queue, fetch: (url, init) => fetch(url, init), host: config.vintedHost, userAgent: config.userAgent });
const poller = new Poller({
  db,
  fetchCatalog: (termKey, page, priority) => client.fetchCatalog(termKey, page, priority),
  pipeline: (termKey, cards) => processNewItems({ db, fetchItem: (url) => client.fetchItem(url), now: Date.now, log }, termKey, cards),
  health,
  minTermIntervalMs: config.minTermIntervalMs,
  log,
});
const api: TelegramSender = {
  sendMessage: (chatId, text, other) => bot.api.sendMessage(chatId, text, other as Parameters<typeof bot.api.sendMessage>[2]),
  sendPhoto: (chatId, photo, other) => bot.api.sendPhoto(chatId, photo, other as Parameters<typeof bot.api.sendPhoto>[2]),
};
const notifier = new Notifier({ db, api, log });
const service = new BotService({
  db,
  adminTelegramId: config.adminTelegramId,
  defaultSearchLimit: config.defaultSearchLimit,
  botUsername: () => bot.botInfo.username,
  now: Date.now,
  ensureFresh: (termKey) => poller.ensureFresh(termKey),
  notifyOwner,
  healthSnapshot: () => health.snapshot(),
});
attachHandlers(bot, service, log);

async function main(): Promise<void> {
  const previousStart = getMeta(db, "started_at");
  const cleanShutdown = getMeta(db, "clean_shutdown_at");
  setMeta(db, "started_at", String(Date.now()));

  const dropped = notifier.dropStale();
  if (dropped > 0) log.warn({ dropped }, "dropped stale pending alerts");

  await bot.init();
  await bot.api.setMyCommands(BOT_COMMANDS);
  if (previousStart && (!cleanShutdown || Number(cleanShutdown) < Number(previousStart))) await health.restartNotice();

  poller.start();
  notifier.start();
  const timers = [
    setInterval(() => {
      try {
        runRetention(db, Date.now());
      } catch (error) {
        log.error({ err: error }, "retention failed");
      }
    }, 60 * 60_000),
    setInterval(() => void health.checkStale(), 60_000),
  ];

  let stopping = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (stopping) return;
    stopping = true;
    log.info({ signal }, "shutting down");
    for (const timer of timers) clearInterval(timer);
    poller.stop();
    // Let in-flight polls finish; anything still unfinished is retried after restart.
    await Promise.race([poller.whenIdle(), new Promise((resolve) => setTimeout(resolve, 5000))]);
    queue.stop();
    await notifier.stop(5000);
    await bot.stop();
    setMeta(db, "clean_shutdown_at", String(Date.now()));
    db.close();
    process.exit(0);
  };
  process.once("SIGINT", () => void shutdown("SIGINT"));
  process.once("SIGTERM", () => void shutdown("SIGTERM"));

  log.info({ bot: bot.botInfo.username }, "flipradar started");
  await bot.start();
}

main().catch((error: unknown) => {
  log.fatal({ err: error }, "fatal error");
  process.exit(1);
});
