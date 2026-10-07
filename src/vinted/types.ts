import type { ConditionCode } from "../matching/conditions.js";

export interface CardListing {
  vintedId: string;
  title: string;
  brand: string | null;
  model: string | null;
  condition: ConditionCode;
  /** Fee-inclusive total shown on the card, or null when the card has none. */
  pricePence: number | null;
  itemPricePence: number | null;
  photoUrl: string | null;
  url: string;
}

export interface ItemDetail {
  description: string;
  attributes: Record<string, string>;
  photos: string[];
  /** 0..1 */
  sellerRating: number | null;
  sellerFeedbackCount: number | null;
  /** Sold or reserved. */
  unavailable: boolean;
  /** e.g. "2 min ago" */
  uploadedText: string | null;
}

export type CatalogPage = { kind: "ok"; cards: CardListing[] } | { kind: "empty" } | { kind: "unrecognised" };
