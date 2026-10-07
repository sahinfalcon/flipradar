import { describe, expect, it } from "vitest";
import { conditionBand, conditionFromLabel } from "../src/matching/conditions.js";
import { cardStageMatch, detailStageMatch, effectivePricePence, type MatchableSearch } from "../src/matching/match.js";
import { makeCard, makeDetail } from "./helpers/cards.js";

const search = (overrides: Partial<MatchableSearch> = {}): MatchableSearch => ({
  keywords: "iphone 15",
  maxPricePence: 30000,
  minPricePence: null,
  conditions: [],
  excludeWords: [],
  matchMode: "strict",
  ...overrides,
});

describe("conditions", () => {
  it("maps UK labels to codes and bands", () => {
    expect(conditionFromLabel("Very good")).toBe("very_good");
    expect(conditionFromLabel(" new WITH tags ")).toBe("new_with_tags");
    expect(conditionFromLabel("M")).toBe("unknown");
    expect(conditionFromLabel(null)).toBe("unknown");
    expect(conditionBand("good")).toBe("good");
    expect(conditionBand("satisfactory")).toBe("worn");
    expect(conditionBand("not_fully_functional")).toBe("faulty");
  });
});

describe("cardStageMatch", () => {
  it("passes a matching card", () => {
    expect(cardStageMatch(search(), makeCard())).toBe(true);
  });

  it("enforces fee-inclusive price bounds", () => {
    expect(cardStageMatch(search({ maxPricePence: 26319 }), makeCard())).toBe(false);
    expect(cardStageMatch(search({ maxPricePence: 26320 }), makeCard())).toBe(true);
    expect(cardStageMatch(search({ minPricePence: 26321 }), makeCard())).toBe(false);
  });

  it("falls back to the item price when the card has no total", () => {
    const card = makeCard({ pricePence: null, itemPricePence: 20000 });
    expect(effectivePricePence(card)).toBe(20000);
    expect(cardStageMatch(search({ maxPricePence: 20000 }), card)).toBe(true);
  });

  it("never matches a card with no price at all (Review Focus 3)", () => {
    expect(cardStageMatch(search(), makeCard({ pricePence: null, itemPricePence: null }))).toBe(false);
  });

  it("filters conditions; unknown passes only when no condition is chosen (Review Focus 3)", () => {
    expect(cardStageMatch(search({ conditions: ["good"] }), makeCard())).toBe(false);
    expect(cardStageMatch(search({ conditions: ["very_good", "good"] }), makeCard())).toBe(true);
    expect(cardStageMatch(search({ conditions: ["good"] }), makeCard({ condition: "unknown" }))).toBe(false);
    expect(cardStageMatch(search(), makeCard({ condition: "unknown" }))).toBe(true);
  });

  it("applies strict matching only in strict mode", () => {
    const handbag = makeCard({ title: "Juicy Couture pink handbag", brand: "Juicy Couture", model: null });
    expect(cardStageMatch(search(), handbag)).toBe(false);
    expect(cardStageMatch(search({ matchMode: "loose" }), handbag)).toBe(true);
  });

  it("uses brand and model in strict matching", () => {
    expect(cardStageMatch(search({ keywords: "apple iphone 15" }), makeCard({ title: "Phone 15 128GB", model: "iPhone 15" }))).toBe(true);
  });

  it("rejects exclude words found in the title", () => {
    expect(cardStageMatch(search({ excludeWords: ["box only"] }), makeCard({ title: "iPhone 15 box only" }))).toBe(false);
  });
});

describe("detailStageMatch", () => {
  it("passes a normal detail", () => {
    expect(detailStageMatch(search({ excludeWords: ["locked"] }), makeDetail())).toBe(true);
  });
  it("drops sold or reserved items", () => {
    expect(detailStageMatch(search(), makeDetail({ unavailable: true }))).toBe(false);
  });
  it("checks exclude words in description and attributes", () => {
    expect(detailStageMatch(search({ excludeWords: ["icloud"] }), makeDetail({ description: "iCloud locked" }))).toBe(false);
    expect(detailStageMatch(search({ excludeWords: ["network locked"] }), makeDetail({ attributes: { sim_lock: "Network locked" } }))).toBe(false);
  });
});
