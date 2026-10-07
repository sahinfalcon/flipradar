import { escapeHtml, formatPence } from "../alerts/format.js";
import type { Db } from "../db/database.js";
import { clearWizardState, getWizardState, saveWizardState } from "../db/meta.js";
import { WIZARD_TTL_MS } from "../db/retention.js";
import { countSearchesByUser, createSearch, deleteSearch, getSearch, listSearchesByUser, setSearchStatus, type Search } from "../db/searches.js";
import {
  createUser,
  deleteUserData,
  getUser,
  redeemInvite,
  setUserStatus,
  touchUserProfile,
  waitlistPosition,
  type User,
} from "../db/users.js";
import type { HealthSnapshot } from "../health/health.js";
import { CONDITION_LABELS, type KnownCondition } from "../matching/conditions.js";
import { toTermKey } from "../matching/normalize.js";
import { healthReply, inviteReply, statsReply, waitlistReply } from "./admin.js";
import { buildPreview, suggestMinPrice } from "./preview.js";
import type { Actor, BotReply, ServiceResult } from "./types.js";
import { advanceWizard, startWizard, type WizardInput, type WizardReply, type WizardState } from "./wizard.js";

export interface BotServiceDeps {
  db: Db;
  adminTelegramId: number;
  defaultSearchLimit: number;
  botUsername: () => string;
  now: () => number;
  ensureFresh: (termKey: string) => Promise<void>;
  notifyOwner: (text: string) => Promise<void>;
  healthSnapshot: () => HealthSnapshot;
}

const ADMIN_SEARCH_LIMIT = 100;
const PRIVACY = "🔒 I store your Telegram ID, username and searches, nothing else. /deleteme erases them.";

const say = (...texts: string[]): ServiceResult => ({ replies: texts.map((text) => ({ text })) });
const toBotReply = (reply: WizardReply): BotReply => (reply.buttons.length ? { text: reply.text, buttons: reply.buttons } : { text: reply.text });
/** Button presses update their own message in place; typed answers get a new message. */
const respond = (input: WizardInput, reply: BotReply): ServiceResult =>
  input.kind === "button" ? { replies: [], edit: reply } : { replies: [reply] };
const displayName = (actor: Actor) => (actor.username ? `@${actor.username}` : actor.firstName ?? String(actor.telegramId));

export class BotService {
  constructor(private readonly deps: BotServiceDeps) {}

  /** Look up the user, promote the owner to admin, refresh profile details. */
  private resolve(actor: Actor): User | undefined {
    const { db } = this.deps;
    const existing = getUser(db, actor.telegramId);
    if (actor.telegramId === this.deps.adminTelegramId) {
      if (!existing) createUser(db, actor, "admin", ADMIN_SEARCH_LIMIT, this.deps.now());
      else if (existing.status !== "admin") setUserStatus(db, actor.telegramId, "admin");
    } else if (!existing) {
      return undefined;
    }
    touchUserProfile(db, actor);
    return getUser(db, actor.telegramId);
  }

  private isMember(user: User | undefined): user is User {
    return user?.status === "beta" || user?.status === "admin";
  }

  private notMember(user: User | undefined): ServiceResult {
    if (!user) return say("Send /start to join the waitlist.");
    return say(`You're on the waitlist (#${waitlistPosition(this.deps.db, user.telegramId)}). I'll message you here when a spot opens.`);
  }

  private welcome(): string {
    return [
      "👋 <b>Welcome to flipradar!</b>",
      "I watch Vinted UK and message you the moment a listing matches your search, with how its price compares to similar listings.",
      "",
      "/new: create a search",
      "/searches: pause or delete searches",
      "/help: all commands",
      "",
      PRIVACY,
    ].join("\n");
  }

  async start(actor: Actor, payload: string): Promise<ServiceResult> {
    const { db } = this.deps;
    const now = this.deps.now();
    const user = this.resolve(actor);
    if (this.isMember(user)) return say(this.welcome());

    const code = payload.trim();
    if (code && redeemInvite(db, code, actor.telegramId, now)) {
      if (user) setUserStatus(db, actor.telegramId, "beta");
      else createUser(db, actor, "beta", this.deps.defaultSearchLimit, now);
      void this.deps.notifyOwner(`🎟 ${escapeHtml(displayName(actor))} joined the beta.`).catch(() => {});
      return say(this.welcome());
    }

    if (!user) createUser(db, actor, "waitlist", this.deps.defaultSearchLimit, now);
    const position = waitlistPosition(db, actor.telegramId);
    const invalid = code ? "That invite link isn't valid or has already been used.\n\n" : "";
    return say(`${invalid}👋 flipradar is in private beta. You're <b>#${position}</b> on the waitlist, and I'll message you here when a spot opens.\n\n${PRIVACY}`);
  }

  async help(actor: Actor): Promise<ServiceResult> {
    const user = this.resolve(actor);
    if (!this.isMember(user)) return this.notMember(user);
    const lines = [
      "<b>Commands</b>",
      `/new: create a search (up to ${user.searchLimit})`,
      "/searches: pause, resume or delete your searches",
      "/cancel: stop creating a search",
      "/feedback &lt;message&gt;: send feedback to the team",
      "/deleteme: erase your data",
    ];
    if (user.status === "admin") lines.push("", "<b>Admin</b>", "/invite [n], /stats, /health, /waitlist");
    return say(lines.join("\n"));
  }

  async newSearch(actor: Actor): Promise<ServiceResult> {
    const user = this.resolve(actor);
    if (!this.isMember(user)) return this.notMember(user);
    if (countSearchesByUser(this.deps.db, user.telegramId) >= user.searchLimit) {
      return say(`You've used all ${user.searchLimit} searches. Delete one in /searches first.`);
    }
    const { state, reply } = startWizard({ minPriceSuggestionPence: null });
    saveWizardState(this.deps.db, user.telegramId, state, this.deps.now());
    return { replies: [toBotReply(reply)] };
  }

  async text(actor: Actor, text: string): Promise<ServiceResult> {
    const user = this.resolve(actor);
    if (!this.isMember(user)) return this.notMember(user);
    if (text.startsWith("/")) return say("I don't know that command. Try /help.");
    return this.wizardInput(user, { kind: "text", text });
  }

  async button(actor: Actor, data: string): Promise<ServiceResult> {
    const { db } = this.deps;
    const now = this.deps.now();
    const user = this.resolve(actor);

    if (data === "deleteme:ok") {
      if (user) deleteUserData(db, user.telegramId);
      return { replies: [{ text: "🗑 All your data has been deleted. Send /start any time to come back." }], toast: "Deleted" };
    }
    if (!this.isMember(user)) return { ...this.notMember(user), toast: "Not available" };
    if (data.startsWith("wz:")) return this.wizardInput(user, { kind: "button", data });

    const match = /^(pause|resume|del|delok|keep):(\d+)$/.exec(data);
    if (!match) return { replies: [], toast: "That button has expired." };
    const search = getSearch(db, Number(match[2]));
    if (!search || search.userId !== user.telegramId) return { replies: [], toast: "Search not found." };
    const name = `<b>${escapeHtml(search.keywords)}</b>`;

    // Search cards update in place: the card that was tapped is the one that changes.
    switch (match[1]) {
      case "pause":
        setSearchStatus(db, search.id, "paused", now);
        return { replies: [], edit: this.searchCard(getSearch(db, search.id) ?? search), toast: "Paused" };
      case "resume":
        setSearchStatus(db, search.id, "active", now);
        return { replies: [], edit: this.searchCard(getSearch(db, search.id) ?? search), toast: "Resumed" };
      case "keep":
        return { replies: [], edit: this.searchCard(search) };
      case "del":
        return {
          replies: [],
          edit: {
            text: `Delete ${name}? This can't be undone.`,
            buttons: [[{ text: "🗑 Yes, delete", data: `delok:${search.id}` }, { text: "Keep it", data: `keep:${search.id}` }]],
          },
        };
      default:
        deleteSearch(db, search.id);
        return { replies: [], edit: { text: `🗑 Deleted ${name}.` }, toast: "Deleted" };
    }
  }

  async searches(actor: Actor): Promise<ServiceResult> {
    const user = this.resolve(actor);
    if (!this.isMember(user)) return this.notMember(user);
    const list = listSearchesByUser(this.deps.db, user.telegramId);
    if (list.length === 0) return say("You have no searches yet. Send /new to create one.");
    return { replies: [{ text: `<b>Your searches</b> (${list.length}/${user.searchLimit})` }, ...list.map((search) => this.searchCard(search))] };
  }

  async cancel(actor: Actor): Promise<ServiceResult> {
    clearWizardState(this.deps.db, actor.telegramId);
    return say("Cancelled.");
  }

  async feedback(actor: Actor, text: string): Promise<ServiceResult> {
    const user = this.resolve(actor);
    if (!user) return say("Send /start first.");
    const message = text.trim();
    if (!message) return say("Usage: /feedback your message");
    await this.deps
      .notifyOwner(`💬 Feedback from ${escapeHtml(displayName(actor))} (${actor.telegramId}):\n${escapeHtml(message.slice(0, 1000))}`)
      .catch(() => {});
    return say("Thanks! Sent to the team.");
  }

  async deleteMe(actor: Actor): Promise<ServiceResult> {
    const user = this.resolve(actor);
    if (!user) return say("I don't have any data about you.");
    return {
      replies: [{ text: "This deletes your searches and everything I store about you. Continue?", buttons: [[{ text: "🗑 Yes, delete my data", data: "deleteme:ok" }]] }],
    };
  }

  async invite(actor: Actor, arg: string): Promise<ServiceResult> {
    if (this.resolve(actor)?.status !== "admin") return say("Admins only.");
    return { replies: [inviteReply(this.deps.db, actor.telegramId, arg, this.deps.now(), this.deps.botUsername())] };
  }

  async stats(actor: Actor): Promise<ServiceResult> {
    if (this.resolve(actor)?.status !== "admin") return say("Admins only.");
    return { replies: [statsReply(this.deps.db, this.deps.healthSnapshot(), this.deps.now())] };
  }

  async health(actor: Actor): Promise<ServiceResult> {
    if (this.resolve(actor)?.status !== "admin") return say("Admins only.");
    return { replies: [healthReply(this.deps.db, this.deps.healthSnapshot(), this.deps.now())] };
  }

  async waitlist(actor: Actor): Promise<ServiceResult> {
    if (this.resolve(actor)?.status !== "admin") return say("Admins only.");
    return { replies: [waitlistReply(this.deps.db)] };
  }

  private async wizardInput(user: User, input: WizardInput): Promise<ServiceResult> {
    const { db } = this.deps;
    const now = this.deps.now();
    const state = getWizardState<WizardState>(db, user.telegramId, now, WIZARD_TTL_MS);
    if (!state) {
      return input.kind === "text"
        ? say("Send /new to create a search, or /help for commands.")
        : respond(input, { text: "That menu has expired. Send /new to start again." });
    }
    const ctx = { minPriceSuggestionPence: state.keywords ? suggestMinPrice(db, toTermKey(state.keywords), now) : null };
    const outcome = advanceWizard(state, input, ctx);
    if (outcome.kind === "continue") {
      saveWizardState(db, user.telegramId, outcome.state, now);
      return respond(input, toBotReply(outcome.reply));
    }
    clearWizardState(db, user.telegramId);
    if (outcome.kind === "cancelled") return respond(input, toBotReply(outcome.reply));

    if (countSearchesByUser(db, user.telegramId) >= user.searchLimit) {
      return respond(input, { text: `You've used all ${user.searchLimit} searches. Delete one in /searches first.` });
    }
    const search = createSearch(db, { userId: user.telegramId, ...outcome.draft }, now);
    const followUp = this.deps
      .ensureFresh(search.termKey)
      .catch(() => undefined)
      .then(() => [buildPreview(db, getSearch(db, search.id) ?? search, this.deps.now())]);
    const saved = `✅ Search saved: <b>${escapeHtml(search.keywords)}</b> · max ${formatPence(search.maxPricePence)}. Checking current listings…`;
    return { ...respond(input, { text: saved }), followUp };
  }

  private searchCard(search: Search): BotReply {
    const parts = [`max ${formatPence(search.maxPricePence)}`];
    if (search.minPricePence !== null) parts.push(`min ${formatPence(search.minPricePence)}`);
    const known = search.conditions.filter((code): code is KnownCondition => code !== "unknown");
    parts.push(known.length ? known.map((code) => CONDITION_LABELS[code]).join(", ") : "any condition");
    if (search.excludeWords.length) parts.push(`excluding ${search.excludeWords.join(", ")}`);
    const status = search.status === "active" ? "🟢 Active" : "⏸ Paused";
    return {
      text: `<b>${escapeHtml(search.keywords)}</b>\n${escapeHtml(parts.join(" · "))}\n${status} · ${search.matchMode} matching`,
      buttons: [
        [
          search.status === "active" ? { text: "⏸ Pause", data: `pause:${search.id}` } : { text: "▶️ Resume", data: `resume:${search.id}` },
          { text: "🗑 Delete", data: `del:${search.id}` },
        ],
      ],
    };
  }
}
