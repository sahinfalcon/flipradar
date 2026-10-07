import type { StoredItem } from "../db/items.js";
import type { Insight } from "../insight/stats.js";
import { CONDITION_LABELS, type ConditionCode } from "../matching/conditions.js";

export interface InlineButton {
  text: string;
  url?: string;
  callback_data?: string;
}

export interface InlineMarkup {
  inline_keyboard: InlineButton[][];
}

export const CAPTION_LIMIT = 1024;
const TITLE_LIMIT = 120;

export function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function truncate(text: string, limit: number): string {
  return text.length <= limit ? text : `${text.slice(0, limit - 1).trimEnd()}…`;
}

export function formatPence(pence: number): string {
  return `£${(pence / 100).toLocaleString("en-GB", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export function formatPounds(pence: number): string {
  return `£${Math.round(pence / 100).toLocaleString("en-GB")}`;
}

export function conditionLabel(code: ConditionCode): string | null {
  return code === "unknown" ? null : CONDITION_LABELS[code];
}

export function insightLine(insight: Insight | null): string | null {
  if (!insight) return null;
  switch (insight.kind) {
    case "insufficient":
      return "📊 Not enough price data yet";
    case "rough":
      return `💰 Cheaper than ${insight.percentile}% of ${insight.n} similar (rough)`;
    case "median": {
      const tail = `cheaper than ${insight.percentile}% of ${insight.n} similar`;
      if (Math.abs(insight.diffPence) < 100) return `💰 About the typical price · ${tail}`;
      if (insight.diffPence > 0) return `💰 <b>${formatPounds(insight.diffPence)} below typical</b> · ${tail}`;
      return `💰 ${formatPounds(-insight.diffPence)} above typical · ${tail}`;
    }
  }
}

function priceLine(item: StoredItem): string | null {
  const total = item.pricePence;
  const base = item.itemPricePence;
  if (total !== null && base !== null && total > base) {
    return `${formatPence(total)} (${formatPence(base)} + ${formatPence(total - base)} fee) + postage`;
  }
  const only = total ?? base;
  return only === null ? null : `${formatPence(only)} + postage`;
}

function sellerLine(item: StoredItem): string | null {
  const detail = item.detail;
  if (!detail) return null;
  const parts: string[] = [];
  if (detail.sellerRating !== null) {
    const reviews = detail.sellerFeedbackCount !== null ? ` (${detail.sellerFeedbackCount} reviews)` : "";
    parts.push(`Seller ${Math.round(detail.sellerRating * 100)}%${reviews}`);
  }
  if (detail.uploadedText) parts.push(`Uploaded ${escapeHtml(detail.uploadedText)}`);
  return parts.length ? `⭐ ${parts.join(" · ")}` : null;
}

export function alertCaption(item: StoredItem, insight: Insight | null, detailsUnavailable: boolean): string {
  const header = [
    `🔔 <b>${escapeHtml(truncate(item.title || "Untitled listing", TITLE_LIMIT))}</b>`,
    conditionLabel(item.condition),
    item.brand ? escapeHtml(truncate(item.brand, 40)) : null,
  ]
    .filter(Boolean)
    .join(" · ");
  const lines = [header, priceLine(item), insightLine(insight), sellerLine(item)];
  if (detailsUnavailable) lines.push("ℹ️ Details unavailable, check the listing");
  return lines.filter((line): line is string => Boolean(line)).join("\n");
}

export function alertMarkup(searchId: number, url: string): InlineMarkup {
  return {
    inline_keyboard: [[{ text: "Open on Vinted", url }, { text: "⏸ Pause search", callback_data: `pause:${searchId}` }]],
  };
}

export function digestText(keywords: string, items: StoredItem[], heldCount: number): string {
  const shown = items.slice(0, 5);
  const lines = [`📦 <b>${heldCount} more matches</b> for "${escapeHtml(keywords)}" in the last few minutes:`];
  for (const item of shown) {
    const price = item.pricePence ?? item.itemPricePence;
    lines.push(`• <a href="${escapeHtml(item.url)}">${escapeHtml(truncate(item.title, 80))}</a>${price === null ? "" : ` · ${formatPence(price)}`}`);
  }
  if (heldCount > shown.length) lines.push(`…and ${heldCount - shown.length} more.`);
  lines.push("Too many? Pause this search in /searches and create a narrower one.");
  return lines.join("\n");
}
