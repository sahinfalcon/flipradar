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
/** At or below this share of the typical price, an alert carries an "unusually cheap" warning. */
export const UNUSUALLY_CHEAP_RATIO = 0.5;
/** Sellers with this many reviews or fewer get the stronger warning. */
export const FEW_REVIEWS = 3;
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
    const count = detail.sellerFeedbackCount;
    const reviews = count !== null ? ` (${count} review${count === 1 ? "" : "s"})` : "";
    parts.push(`Seller ${Math.round(detail.sellerRating * 100)}%${reviews}`);
  }
  if (detail.uploadedText) {
    const uploaded = detail.uploadedText.charAt(0).toLowerCase() + detail.uploadedText.slice(1); // Vinted says "Just now"
    parts.push(`Uploaded ${escapeHtml(uploaded)}`);
  }
  return parts.length ? `⭐ ${parts.join(" · ")}` : null;
}

/**
 * Too-good-to-be-true check: at most half the typical price is a classic scam pattern,
 * especially from a seller with few reviews. Needs a known typical price (median insight).
 */
export function riskLine(item: StoredItem, insight: Insight | null): string | null {
  const price = item.pricePence ?? item.itemPricePence;
  if (!insight || insight.kind !== "median" || price === null) return null;
  if (price > insight.medianPence * UNUSUALLY_CHEAP_RATIO) return null;
  const reviews = item.detail?.sellerFeedbackCount;
  if (reviews != null && reviews <= FEW_REVIEWS) {
    return `⚠️ <b>Unusually cheap from a seller with ${reviews} review${reviews === 1 ? "" : "s"}.</b> Check the photos, ask questions, and only pay through Vinted.`;
  }
  return "⚠️ Unusually cheap for this item. Check the photos and description carefully.";
}

export function alertCaption(item: StoredItem, insight: Insight | null, detailsUnavailable: boolean): string {
  const header = [
    `🔔 <b>${escapeHtml(truncate(item.title || "Untitled listing", TITLE_LIMIT))}</b>`,
    conditionLabel(item.condition),
    item.brand ? escapeHtml(truncate(item.brand, 40)) : null,
  ]
    .filter(Boolean)
    .join(" · ");
  const lines = [header, priceLine(item), insightLine(insight), riskLine(item, insight), sellerLine(item)];
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
