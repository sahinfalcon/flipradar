import { escapeHtml } from "../alerts/format.js";
import { sentLatencies } from "../db/alerts.js";
import type { Db } from "../db/database.js";
import { DAY_MS } from "../db/retention.js";
import { countActiveSearches } from "../db/searches.js";
import { listActiveTerms } from "../db/terms.js";
import { countUsersByStatus, createInvites, listWaitlist } from "../db/users.js";
import type { HealthSnapshot } from "../health/health.js";
import type { BotReply } from "./types.js";

export function inviteReply(db: Db, adminId: number, arg: string, now: number, botUsername: string): BotReply {
  const count = Math.min(10, Math.max(1, Number.parseInt(arg, 10) || 1));
  const codes = createInvites(db, adminId, count, now);
  return {
    text: [`🎟 ${count} invite link${count === 1 ? "" : "s"} (each works once):`, ...codes.map((code) => `https://t.me/${botUsername}?start=${code}`)].join("\n"),
  };
}

export function statsReply(db: Db, snapshot: HealthSnapshot, now: number): BotReply {
  const users = countUsersByStatus(db);
  const latencies = sentLatencies(db, now - DAY_MS).sort((a, b) => a - b);
  const medianLatency = latencies.length ? latencies[Math.floor(latencies.length / 2)]! : null;
  const seconds = (ms: number | null) => (ms === null ? "n/a" : `${Math.round(ms / 1000)} s`);
  return {
    text: [
      "📈 <b>Stats</b>",
      `Testers: ${users.beta} beta · ${users.admin} admin · ${users.waitlist} waitlist`,
      `Searches: ${countActiveSearches(db)} active across ${listActiveTerms(db).length} terms`,
      `Alerts sent (24 h): ${latencies.length}`,
      `Median alert time (24 h): ${seconds(medianLatency)}`,
      `Typical gap between checks of a term: ${seconds(snapshot.medianPollIntervalMs)}`,
    ].join("\n"),
  };
}

export function healthReply(db: Db, snapshot: HealthSnapshot, now: number): BotReply {
  const ago = (time: number | null) => (time === null ? "never" : `${Math.round((now - time) / 1000)} s ago`);
  const lines = [
    "🩺 <b>Health</b>",
    snapshot.backoff.active
      ? `Backoff: ON until ${new Date(snapshot.backoff.until).toISOString().slice(11, 16)} UTC (level ${snapshot.backoff.level})`
      : "Backoff: off",
    `Last successful Vinted request: ${ago(snapshot.lastSuccessAt)}`,
    `Failed requests since start: ${snapshot.failureCount}`,
  ];
  if (snapshot.layoutSuspects.length) lines.push(`⚠️ Layout suspects: ${snapshot.layoutSuspects.map(escapeHtml).join(", ")}`);
  for (const term of listActiveTerms(db)) {
    lines.push(
      `• ${escapeHtml(term.termKey)}: polled ${ago(term.lastPolledAt)}, empty streak ${term.emptyStreak}, overflow ${snapshot.overflowCounts[term.termKey] ?? 0}`,
    );
  }
  return { text: lines.join("\n") };
}

export function waitlistReply(db: Db): BotReply {
  const total = countUsersByStatus(db).waitlist;
  const newest = listWaitlist(db, 10).map((user) =>
    user.username ? `@${escapeHtml(user.username)}` : `${escapeHtml(user.firstName ?? "unknown")} (${user.telegramId})`,
  );
  return { text: [`⏳ <b>Waitlist: ${total}</b>`, ...newest.map((name) => `• ${name}`)].join("\n") };
}
