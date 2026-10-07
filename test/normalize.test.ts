import { describe, expect, it } from "vitest";
import { containsPhrase, normalizeText, strictKeywordMatch, toTermKey, toWords } from "../src/matching/normalize.js";

describe("normalizeText", () => {
  it("lowercases, strips accents and punctuation", () => {
    expect(normalizeText("  Café-Crème, 128GB!! ")).toBe("cafe creme 128gb");
  });
  it("splits into words", () => {
    expect(toWords("I Phone . 15")).toEqual(["i", "phone", "15"]);
    expect(toWords("🔥🔥")).toEqual([]);
  });
});

describe("toTermKey", () => {
  it("keeps + and - but drops other punctuation and emoji", () => {
    expect(toTermKey("  Nike Air Max 90 🔥 ")).toBe("nike air max 90");
    expect(toTermKey("Carhartt-WIP  Detroit")).toBe("carhartt-wip detroit");
    expect(toTermKey("Zara’s Blazer")).toBe("zara s blazer");
  });
});

describe("strictKeywordMatch (spec §6 table)", () => {
  const cases: Array<[string, string, boolean]> = [
    ["ralph lauren polo", "Ralph Lauren Polo Shirt Navy M", true],
    ["ralph lauren polo", "Polo Ralph Lauren cap", true],
    ["ralph lauren polo", "RalphLauren polo tee", true],
    ["ralph lauren polo", "Lauren Ralph Lauren dress", false],
    ["polo", "Ralph Lauren polos bundle", true],
    ["iphone 15", "I Phone 15 . Good Condition", true],
    ["i phone 15", "iPhone 15 128GB", true],
    ["iphone 15 pro", "iPhone 15 screen protector", false],
    ["128gb", "iPhone 15 128 GB", true],
    ["cap", "Capri trousers", false],
  ];
  it.each(cases)("%s vs %s → %s", (keywords, listing, expected) => {
    expect(strictKeywordMatch(keywords, listing)).toBe(expected);
  });

  it("handles hyphens, apostrophes and emoji in keywords (Review Focus 1)", () => {
    expect(strictKeywordMatch("carhartt-wip", "Carhartt WIP jacket")).toBe(true);
    expect(strictKeywordMatch("zara’s blazer", "Zara blazer black")).toBe(true);
    expect(strictKeywordMatch("nike air max 90 🔥", "Nike Air Max 90 white")).toBe(true);
    expect(strictKeywordMatch("dress", "Floral dresses x2")).toBe(true);
  });
});

describe("containsPhrase", () => {
  it("matches whole words and phrases only", () => {
    expect(containsPhrase("Sim lock: Unlocked", "locked")).toBe(false);
    expect(containsPhrase("iCloud locked, sold as is", "icloud locked")).toBe(true);
    expect(containsPhrase("Box only!", "box only")).toBe(true);
    expect(containsPhrase("anything", "  ")).toBe(false);
  });
});
