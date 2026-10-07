import { createAlert } from "../db/alerts.js";
import type { Db } from "../db/database.js";
import { getItem, saveItemDetail } from "../db/items.js";
import { groupPrices, upsertPriceObservation } from "../db/prices.js";
import { activeSearchesForTerm } from "../db/searches.js";
import { groupFor } from "../insight/groups.js";
import { computeInsight } from "../insight/stats.js";
import { cardStageMatch, detailStageMatch, effectivePricePence } from "../matching/match.js";
import type { ItemResult } from "../vinted/client.js";
import type { CardListing, ItemDetail } from "../vinted/types.js";

export interface NewCard {
  card: CardListing;
  firstSeenAt: number;
}

export interface PipelineDeps {
  db: Db;
  fetchItem: (url: string) => Promise<ItemResult>;
  now: () => number;
}

export const INSIGHT_WINDOW_MS = 30 * 86_400_000;

/** Spec §6–§8: card stage → item page once → detail stage → insight → alert rows. */
export async function processNewItems(deps: PipelineDeps, termKey: string, newCards: NewCard[]): Promise<number> {
  const searches = activeSearchesForTerm(deps.db, termKey);
  if (searches.length === 0) return 0;
  let created = 0;

  for (const { card, firstSeenAt } of newCards) {
    const eligible = searches.filter((search) => search.activeSince < firstSeenAt && cardStageMatch(search, card));
    if (eligible.length === 0) continue;

    let detail: ItemDetail | null = getItem(deps.db, card.vintedId)?.detail ?? null;
    if (!detail) {
      const result = await deps.fetchItem(card.url);
      if (result.kind === "ok") {
        detail = result.detail;
        saveItemDetail(deps.db, card.vintedId, detail, deps.now());
      }
    }

    const price = effectivePricePence(card);
    if (price === null) continue; // unreachable after cardStageMatch, kept for the type checker
    const group = groupFor(termKey, card, detail?.attributes["internal_memory_capacity"] ?? null);
    upsertPriceObservation(deps.db, { vintedId: card.vintedId, groupKey: group.groupKey, modelKnown: group.modelKnown, pricePence: price }, deps.now());
    const comparable = groupPrices(deps.db, group.groupKey, deps.now() - INSIGHT_WINDOW_MS, card.vintedId);
    const insight = computeInsight(price, comparable, group.modelKnown);

    for (const search of eligible) {
      if (detail && !detailStageMatch(search, detail)) continue;
      const alert = createAlert(deps.db, {
        searchId: search.id,
        vintedId: card.vintedId,
        insight,
        detailsUnavailable: detail === null,
        createdAt: firstSeenAt,
      });
      if (alert) created += 1;
    }
  }
  return created;
}
