import type { CardListing, ItemDetail } from "../vinted/types.js";
import type { ConditionCode } from "./conditions.js";
import { containsPhrase, strictKeywordMatch } from "./normalize.js";

export interface MatchableSearch {
  keywords: string;
  maxPricePence: number;
  minPricePence: number | null;
  conditions: ConditionCode[];
  excludeWords: string[];
  matchMode: "strict" | "loose";
}

export function effectivePricePence(card: Pick<CardListing, "pricePence" | "itemPricePence">): number | null {
  return card.pricePence ?? card.itemPricePence;
}

/** Spec §6 card stage: price, condition, strict keywords, title exclusions. */
export function cardStageMatch(search: MatchableSearch, card: CardListing): boolean {
  const price = effectivePricePence(card);
  if (price === null) return false;
  if (price > search.maxPricePence) return false;
  if (search.minPricePence !== null && price < search.minPricePence) return false;
  if (search.conditions.length > 0 && !search.conditions.includes(card.condition)) return false;
  if (search.matchMode === "strict") {
    const text = [card.title, card.brand ?? "", card.model ?? ""].join(" ");
    if (!strictKeywordMatch(search.keywords, text)) return false;
  }
  return !search.excludeWords.some((word) => containsPhrase(card.title, word));
}

/** Spec §6 detail stage: availability and exclusions in description/attributes. */
export function detailStageMatch(search: MatchableSearch, detail: ItemDetail): boolean {
  if (detail.unavailable) return false;
  const text = [detail.description, ...Object.values(detail.attributes)].join("\n");
  return !search.excludeWords.some((word) => containsPhrase(text, word));
}
