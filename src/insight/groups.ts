import { conditionBand, type ConditionCode } from "../matching/conditions.js";
import { normalizeText } from "../matching/normalize.js";

export function storageFromText(text: string | null | undefined): string | null {
  const match = /\b(\d{1,4}) ?(gb|tb)\b/.exec(normalizeText(text ?? ""));
  return match ? `${match[1]}${match[2]}` : null;
}

export interface Group {
  groupKey: string;
  modelKnown: boolean;
}

/** Spec §8: term | model | storage | condition band. */
export function groupFor(
  termKey: string,
  card: { title: string; model: string | null; condition: ConditionCode },
  detailStorage: string | null = null,
): Group {
  const model = card.model ? normalizeText(card.model) : "";
  const storage = storageFromText(card.title) ?? storageFromText(detailStorage) ?? "-";
  return {
    groupKey: [termKey, model || "-", storage, conditionBand(card.condition)].join("|"),
    modelKnown: model !== "",
  };
}
