import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { isChallengePage, parseCatalogHtml, parseItemHtml } from "../src/vinted/parse.js";

const HOST = "www.vinted.co.uk";
const read = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");

describe("real Vinted UK pages", () => {
  it("parses a real catalog page", () => {
    const html = read("catalog-uk.html");
    expect(isChallengePage(html)).toBe(false);
    const page = parseCatalogHtml(html, HOST);
    expect(page.kind).toBe("ok");
    if (page.kind !== "ok") return;
    expect(page.cards.length).toBeGreaterThanOrEqual(90);
    for (const card of page.cards) {
      expect(card.vintedId).toMatch(/^\d+$/);
      expect(card.url.startsWith(`https://${HOST}/items/`)).toBe(true);
      expect(card.title.length).toBeGreaterThan(0);
    }
    const priced = page.cards.filter((card) => card.pricePence !== null && card.itemPricePence !== null);
    expect(priced.length / page.cards.length).toBeGreaterThanOrEqual(0.9);
    expect(priced.every((card) => (card.pricePence ?? 0) >= (card.itemPricePence ?? 0))).toBe(true);
    expect(page.cards.some((card) => card.model !== null)).toBe(true);
    expect(page.cards.some((card) => card.condition !== "unknown")).toBe(true);
  });

  it("parses a real item page", () => {
    const detail = parseItemHtml(read("item-uk.html"));
    expect(detail).not.toBeNull();
    expect(typeof detail?.description).toBe("string");
    expect(detail?.photos.length).toBeGreaterThanOrEqual(1);
    expect(Object.keys(detail?.attributes ?? {}).length).toBeGreaterThanOrEqual(1);
  });

  it("recognises a real empty search", () => {
    expect(parseCatalogHtml(read("empty-uk.html"), HOST)).toEqual({ kind: "empty" });
  });
});
