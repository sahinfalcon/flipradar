import { describe, expect, it } from "vitest";
import { digestDue, FLOOD_WINDOW_MS, shouldHold } from "../src/alerts/flood.js";
import { alertCaption, alertMarkup, CAPTION_LIMIT, digestText, formatPence, formatPounds, insightLine, riskLine } from "../src/alerts/format.js";
import type { StoredItem } from "../src/db/items.js";
import { makeCard, makeDetail } from "./helpers/cards.js";

const stored = (overrides: Partial<StoredItem> = {}): StoredItem => ({
  ...makeCard(),
  cardSeenAt: 0,
  detail: makeDetail(),
  detailFetchedAt: 0,
  ...overrides,
});

describe("money", () => {
  it("formats pence", () => {
    expect(formatPence(26320)).toBe("£263.20");
    expect(formatPence(123456)).toBe("£1,234.56");
    expect(formatPounds(5849)).toBe("£58");
  });
});

describe("insightLine", () => {
  it("renders each kind", () => {
    expect(insightLine(null)).toBeNull();
    expect(insightLine({ kind: "insufficient", n: 3 })).toBe("📊 Not enough price data yet");
    expect(insightLine({ kind: "rough", n: 40, percentile: 75 })).toBe("💰 Cheaper than 75% of 40 similar (rough)");
    expect(insightLine({ kind: "median", n: 47, medianPence: 32100, diffPence: 5800, percentile: 91 })).toBe(
      "💰 <b>£58 below typical</b> · cheaper than 91% of 47 similar",
    );
    expect(insightLine({ kind: "median", n: 12, medianPence: 30000, diffPence: -2500, percentile: 20 })).toBe(
      "💰 £25 above typical · cheaper than 20% of 12 similar",
    );
    expect(insightLine({ kind: "median", n: 12, medianPence: 30000, diffPence: 40, percentile: 50 })).toBe(
      "💰 About the typical price · cheaper than 50% of 12 similar",
    );
  });
});

describe("alertCaption", () => {
  it("shows title, condition, brand, fee breakdown, insight and seller", () => {
    const caption = alertCaption(stored(), { kind: "median", n: 47, medianPence: 32100, diffPence: 5780, percentile: 91 }, false);
    expect(caption).toBe(
      [
        "🔔 <b>iPhone 15 128GB</b> · Very good · Apple",
        "£263.20 (£249.99 + £13.21 fee) + postage",
        "💰 <b>£58 below typical</b> · cheaper than 91% of 47 similar",
        "⭐ Seller 98% (122 reviews) · Uploaded 2 min ago",
      ].join("\n"),
    );
  });

  it("omits missing parts and flags unavailable details", () => {
    const caption = alertCaption(stored({ brand: null, condition: "unknown", pricePence: null, detail: null }), null, true);
    expect(caption).toBe(["🔔 <b>iPhone 15 128GB</b>", "£249.99 + postage", "ℹ️ Details unavailable, check the listing"].join("\n"));
  });

  it("escapes HTML and stays within Telegram's caption limit (Review Focus 5)", () => {
    const title = "<b>&amp;</b> ".repeat(60);
    const caption = alertCaption(stored({ title, brand: "R&D <Labs>" }), null, false);
    expect(caption.length).toBeLessThanOrEqual(CAPTION_LIMIT);
    expect(caption).toContain("&lt;b&gt;&amp;amp;");
    expect(caption).toContain("R&amp;D &lt;Labs&gt;");
    expect(caption).not.toContain("<b>&amp;</b>");
  });
});

describe("markup and digest", () => {
  it("links to the listing and offers pause", () => {
    expect(alertMarkup(7, "https://www.vinted.co.uk/items/1")).toEqual({
      inline_keyboard: [[{ text: "Open on Vinted", url: "https://www.vinted.co.uk/items/1" }, { text: "⏸ Pause search", callback_data: "pause:7" }]],
    });
  });

  it("lists up to 5 held items", () => {
    const items = Array.from({ length: 6 }, (_, i) => stored({ vintedId: String(i), title: `Item ${i} <x>`, url: `https://v/${i}` }));
    const text = digestText("iphone 15", items, 8);
    expect(text.split("\n")[0]).toBe('📦 <b>8 more matches</b> for "iphone 15" in the last few minutes:');
    expect(text).toContain('• <a href="https://v/0">Item 0 &lt;x&gt;</a> · £263.20');
    expect(text).not.toContain("Item 5");
    expect(text).toContain("…and 3 more.");
  });
});

describe("flood control", () => {
  const now = 10 * FLOOD_WINDOW_MS;
  const recent = (count: number) => Array.from({ length: count }, (_, i) => now - 1000 * (i + 1));

  it("holds after 10 sends in the window", () => {
    expect(shouldHold(recent(9), now)).toBe(false);
    expect(shouldHold(recent(10), now)).toBe(true);
    expect(shouldHold([...recent(9), now - FLOOD_WINDOW_MS - 1], now)).toBe(false);
  });

  it("sends a digest when the flood ends or the oldest held alert is 10 minutes old", () => {
    expect(digestDue(recent(10), [], now)).toBe(false);
    expect(digestDue(recent(10), [now - 1000], now)).toBe(false);
    expect(digestDue(recent(5), [now - 1000], now)).toBe(true);
    expect(digestDue(recent(10), [now - FLOOD_WINDOW_MS], now)).toBe(true);
  });
});

describe("seller line polish (Telegram review)", () => {
  it("uses the singular for one review and lowercases Vinted's upload text", () => {
    const caption = alertCaption(stored({ detail: makeDetail({ sellerFeedbackCount: 1, uploadedText: "Just now" }) }), null, false);
    expect(caption).toContain("⭐ Seller 98% (1 review) · Uploaded just now");
  });
});

describe("unusually cheap warning (Telegram review)", () => {
  const median = (medianPence: number) => ({ kind: "median" as const, n: 13, medianPence, diffPence: medianPence - 26320, percentile: 100 });
  const withReviews = (count: number | null) => stored({ detail: makeDetail({ sellerFeedbackCount: count }) });

  it("warns strongly when the price is at most half the typical price and the seller has 3 or fewer reviews", () => {
    expect(riskLine(withReviews(1), median(52640))).toBe(
      "⚠️ <b>Unusually cheap from a seller with 1 review.</b> Check the photos, ask questions, and only pay through Vinted.",
    );
    expect(riskLine(withReviews(0), median(60000))).toContain("seller with 0 reviews");
    expect(riskLine(withReviews(3), median(60000))).toContain("seller with 3 reviews");
  });

  it("warns softly when it is that cheap but the seller is established or unknown", () => {
    const soft = "⚠️ Unusually cheap for this item. Check the photos and description carefully.";
    expect(riskLine(withReviews(4), median(60000))).toBe(soft);
    expect(riskLine(stored({ detail: null }), median(60000))).toBe(soft);
  });

  it("stays quiet above half the typical price or without a typical price", () => {
    expect(riskLine(withReviews(1), median(52639))).toBeNull();
    expect(riskLine(withReviews(1), { kind: "rough", n: 40, percentile: 99 })).toBeNull();
    expect(riskLine(withReviews(1), { kind: "insufficient", n: 2 })).toBeNull();
    expect(riskLine(withReviews(1), null)).toBeNull();
  });

  it("puts the warning straight after the price comparison", () => {
    const lines = alertCaption(withReviews(1), median(60000), false).split("\n");
    expect(lines[2]).toContain("below typical");
    expect(lines[3]).toContain("Unusually cheap from a seller with 1 review");
  });
});
