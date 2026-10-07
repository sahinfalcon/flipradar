import { escapeHtml, formatPence } from "../alerts/format.js";
import { INSIGHT_WINDOW_MS } from "../alerts/pipeline.js";
import type { Db } from "../db/database.js";
import { recentItemsForTerm } from "../db/items.js";
import { groupPrices, termModelPrices } from "../db/prices.js";
import type { Search } from "../db/searches.js";
import { groupFor } from "../insight/groups.js";
import { median, MIN_SAMPLE } from "../insight/stats.js";
import { conditionBand, type ConditionBand } from "../matching/conditions.js";
import { cardStageMatch, effectivePricePence } from "../matching/match.js";
import type { BotReply } from "./types.js";

/** Spec §9 step 3: 40% of the median of model-known prices, rounded down to £10. */
export function suggestMinPrice(db: Db, termKey: string, now: number): number | null {
  const prices = termModelPrices(db, termKey, now - INSIGHT_WINDOW_MS);
  if (prices.length < MIN_SAMPLE) return null;
  const suggestion = Math.floor((median(prices) * 0.4) / 1000) * 1000;
  return suggestion > 0 ? suggestion : null;
}

const BAND_LABEL: Record<ConditionBand, string> = {
  new: "new",
  good: "used, good",
  worn: "worn",
  faulty: "faulty",
  unknown: "any condition",
};

/** Spec §8 preview: typical price of the most common model group + the 3 newest matches. */
export function buildPreview(db: Db, search: Search, now: number): BotReply {
  const matching = recentItemsForTerm(db, search.termKey, 96).filter((item) => cardStageMatch(search, item));
  const lines = [`✅ Watching <b>${escapeHtml(search.keywords)}</b> · max ${formatPence(search.maxPricePence)}`];

  const groups = new Map<string, { count: number; band: ConditionBand }>();
  for (const item of matching) {
    const group = groupFor(search.termKey, item);
    if (!group.modelKnown) continue;
    const entry = groups.get(group.groupKey) ?? { count: 0, band: conditionBand(item.condition) };
    entry.count += 1;
    groups.set(group.groupKey, entry);
  }
  const top = [...groups.entries()].sort((a, b) => b[1].count - a[1].count)[0];
  if (top) {
    const prices = groupPrices(db, top[0], now - INSIGHT_WINDOW_MS);
    if (prices.length >= MIN_SAMPLE) {
      lines.push(`📊 Typical listing price (${BAND_LABEL[top[1].band]}): <b>${formatPence(median(prices))}</b>, from ${prices.length} listings`);
    }
  }

  if (matching.length === 0) {
    lines.push("No current listings match. I'll message you as soon as one appears.");
  } else {
    lines.push("Latest matches right now:");
    for (const item of matching.slice(0, 3)) {
      const price = effectivePricePence(item);
      lines.push(`• <a href="${escapeHtml(item.url)}">${escapeHtml(item.title.slice(0, 80))}</a>${price === null ? "" : ` · ${formatPence(price)}`}`);
    }
  }
  lines.push("From now on you'll get an alert for every new match.");
  return { text: lines.join("\n") };
}
