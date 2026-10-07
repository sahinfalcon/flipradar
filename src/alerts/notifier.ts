import {
  dropStalePending,
  heldAlertsForSearch,
  listPendingAlerts,
  searchesWithHeldAlerts,
  sentTimesForSearch,
  setAlertStatus,
  type PendingAlert,
} from "../db/alerts.js";
import type { Db } from "../db/database.js";
import { getItem, type StoredItem } from "../db/items.js";
import { getSearch, pauseAllSearchesForUser } from "../db/searches.js";
import { setBotBlocked } from "../db/users.js";
import { digestDue, FLOOD_WINDOW_MS, shouldHold } from "./flood.js";
import { alertCaption, alertMarkup, digestText, type InlineMarkup } from "./format.js";

export interface TelegramSender {
  sendMessage(
    chatId: number,
    text: string,
    other?: { parse_mode?: "HTML"; reply_markup?: InlineMarkup; link_preview_options?: { is_disabled: boolean } },
  ): Promise<unknown>;
  sendPhoto(chatId: number, photo: string, other?: { caption?: string; parse_mode?: "HTML"; reply_markup?: InlineMarkup }): Promise<unknown>;
}

export type TelegramFailure =
  | { kind: "retry_after"; seconds: number }
  | { kind: "blocked" }
  | { kind: "bad_request"; description: string }
  | { kind: "other"; description: string };

/** grammY's GrammyError carries error_code, description and parameters.retry_after. */
export function classifyTelegramError(error: unknown): TelegramFailure {
  const e = error as { error_code?: number; description?: string; parameters?: { retry_after?: number } } | null;
  const description = e?.description ?? (error instanceof Error ? error.message : String(error));
  if (e?.error_code === 429) return { kind: "retry_after", seconds: e.parameters?.retry_after ?? 5 };
  if (e?.error_code === 403) return { kind: "blocked" };
  if (e?.error_code === 400) return { kind: "bad_request", description };
  return { kind: "other", description };
}

export const STALE_PENDING_MS = 10 * 60_000;

export interface NotifierOptions {
  db: Db;
  api: TelegramSender;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  perChatGapMs?: number;
  globalGapMs?: number;
  retryDelaysMs?: number[];
  log?: { error(obj: object, msg: string): void };
}

interface Outgoing {
  photo?: string | null;
  caption?: string;
  text?: string;
  markup?: InlineMarkup;
}

const realSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export class Notifier {
  private readonly lastSendByChat = new Map<number, number>();
  private lastSendAny = Number.NEGATIVE_INFINITY;
  private running = false;
  private timer: NodeJS.Timeout | null = null;
  private current: Promise<void> | null = null;

  constructor(private readonly opts: NotifierOptions) {}

  private now(): number {
    return (this.opts.now ?? Date.now)();
  }

  private sleep(ms: number): Promise<void> {
    return (this.opts.sleep ?? realSleep)(ms);
  }

  /** Startup: an alert that waited more than 10 minutes is no longer worth sending. */
  dropStale(): number {
    return dropStalePending(this.opts.db, this.now() - STALE_PENDING_MS);
  }

  async tick(): Promise<void> {
    for (const alert of listPendingAlerts(this.opts.db, 50)) await this.handle(alert);
    for (const searchId of searchesWithHeldAlerts(this.opts.db)) await this.maybeDigest(searchId);
  }

  start(intervalMs = 500): void {
    if (this.running) return;
    this.running = true;
    const loop = () => {
      this.current = this.tick()
        .catch((error: unknown) => this.opts.log?.error({ err: error }, "notifier tick failed"))
        .finally(() => {
          this.current = null;
          if (this.running) this.timer = setTimeout(loop, intervalMs);
        });
    };
    loop();
  }

  async stop(flushMs = 5000): Promise<void> {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    if (this.current) await Promise.race([this.current, realSleep(flushMs)]);
  }

  private async handle(alert: PendingAlert): Promise<void> {
    const { db } = this.opts;
    const search = getSearch(db, alert.searchId);
    const item = getItem(db, alert.vintedId);
    if (!search || search.status !== "active" || !item) {
      setAlertStatus(db, alert.id, "dropped");
      return;
    }
    const now = this.now();
    if (shouldHold(sentTimesForSearch(db, search.id, now - FLOOD_WINDOW_MS), now)) {
      setAlertStatus(db, alert.id, "digested");
      return;
    }
    const delivered = await this.deliver(alert.chatId, {
      photo: item.photoUrl,
      caption: alertCaption(item, alert.insight, alert.detailsUnavailable),
      markup: alertMarkup(search.id, item.url),
    });
    if (delivered) setAlertStatus(db, alert.id, "sent", this.now());
    else setAlertStatus(db, alert.id, "failed");
  }

  private async maybeDigest(searchId: number): Promise<void> {
    const { db } = this.opts;
    const held = heldAlertsForSearch(db, searchId);
    const now = this.now();
    if (!digestDue(sentTimesForSearch(db, searchId, now - FLOOD_WINDOW_MS), held.map((alert) => alert.createdAt), now)) return;
    const search = getSearch(db, searchId);
    if (!search || search.status !== "active") {
      for (const alert of held) setAlertStatus(db, alert.id, "dropped");
      return;
    }
    const items = held.map((alert) => getItem(db, alert.vintedId)).filter((item): item is StoredItem => item !== undefined);
    const delivered = await this.deliver(search.userId, { text: digestText(search.keywords, items, held.length) });
    for (const alert of held) setAlertStatus(db, alert.id, delivered ? "digest_sent" : "failed", delivered ? this.now() : null);
  }

  /** Telegram send with pacing, 429 handling, photo→text fallback and 2/4/8 s retries. */
  private async deliver(chatId: number, message: Outgoing): Promise<boolean> {
    const delays = this.opts.retryDelaysMs ?? [2000, 4000, 8000];
    let usePhoto = Boolean(message.photo);
    for (let attempt = 0; attempt <= delays.length; attempt += 1) {
      await this.pace(chatId);
      try {
        if (usePhoto && message.photo) {
          await this.opts.api.sendPhoto(chatId, message.photo, { caption: message.caption, parse_mode: "HTML", reply_markup: message.markup });
        } else {
          await this.opts.api.sendMessage(chatId, message.text ?? message.caption ?? "", {
            parse_mode: "HTML",
            reply_markup: message.markup,
            link_preview_options: { is_disabled: true },
          });
        }
        return true;
      } catch (error) {
        const failure = classifyTelegramError(error);
        if (failure.kind === "blocked") {
          setBotBlocked(this.opts.db, chatId, true);
          pauseAllSearchesForUser(this.opts.db, chatId);
          return false;
        }
        if (failure.kind === "retry_after") {
          await this.sleep(failure.seconds * 1000);
          continue;
        }
        if (failure.kind === "bad_request" && usePhoto) {
          usePhoto = false; // e.g. Telegram could not fetch the photo URL
          continue;
        }
        this.opts.log?.error({ err: error, chatId }, "telegram send failed");
        const delay = delays[attempt];
        if (delay !== undefined) await this.sleep(delay);
      }
    }
    return false;
  }

  private async pace(chatId: number): Promise<void> {
    const perChat = this.opts.perChatGapMs ?? 1100;
    const global = this.opts.globalGapMs ?? 40;
    const last = this.lastSendByChat.get(chatId);
    const wait = Math.max(last === undefined ? 0 : last + perChat - this.now(), this.lastSendAny + global - this.now());
    if (wait > 0) await this.sleep(wait);
    this.lastSendByChat.set(chatId, this.now());
    this.lastSendAny = this.now();
  }
}
