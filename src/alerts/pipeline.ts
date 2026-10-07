import { createAlert } from "../db/alerts.js";
import type { Db } from "../db/database.js";
import { getItem, saveItemDetail } from "../db/items.js";
import { groupPrices, upsertPriceObservation } from "../db/prices.js";
import { activeSearchesForTerm, type Search } from "../db/searches.js";
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
  log?: { error(obj: object, msg: string): void };
}

/** failed: items whose processing threw; the poller leaves them unseen so the next poll retries them. */
export interface PipelineResult {
  created: number;
  failed: string[];
}

export const INSIGHT_WINDOW_MS = 30 * 86_400_000;

/** Spec §6–§8: card stage → item page once → detail stage → insight → alert rows. One item's failure never affects another. */
export async function processNewItems(deps: PipelineDeps, termKey: string, newCards: NewCard[]): Promise<PipelineResult> {
  const searches = activeSearchesForTerm(deps.db, termKey);
  const result: PipelineResult = { created: 0, failed: [] };
  if (searches.length === 0) return result;
  for (const newCard of newCards) {
    try {
      result.created += await processCard(deps, termKey, searches, newCard);
    } catch (error) {
      result.failed.push(newCard.card.vintedId);
      deps.log?.error({ err: error, vintedId: newCard.card.vintedId, termKey }, "pipeline failed for item");
    }
  }
  return result;
}

async function processCard(deps: PipelineDeps, termKey: string, searches: Search[], { card, firstSeenAt }: NewCard): Promise<number> {
  const eligible = searches.filter((search) => search.activeSince < firstSeenAt && cardStageMatch(search, card));
  if (eligible.length === 0) return 0;

  let detail: ItemDetail | null = getItem(deps.db, card.vintedId)?.detail ?? null;
  if (!detail) {
    const result = await deps.fetchItem(card.url);
    if (result.kind === "ok") {
      detail = result.detail;
      saveItemDetail(deps.db, card.vintedId, detail, deps.now());
    }
  }

  const price = effectivePricePence(card);
  if (price === null) return 0; // unreachable after cardStageMatch, kept for the type checker
  const group = groupFor(termKey, card, detail?.attributes["internal_memory_capacity"] ?? null);
  upsertPriceObservation(deps.db, { vintedId: card.vintedId, groupKey: group.groupKey, modelKnown: group.modelKnown, pricePence: price }, deps.now());
  const comparable = groupPrices(deps.db, group.groupKey, deps.now() - INSIGHT_WINDOW_MS, card.vintedId);
  const insight = computeInsight(price, comparable, group.modelKnown);

  let created = 0;
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
  return created;
}
