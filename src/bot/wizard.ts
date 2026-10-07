import { escapeHtml, formatPence } from "../alerts/format.js";
import type { MatchMode } from "../db/searches.js";
import { CONDITION_CODES, CONDITION_LABELS, isConditionCode, type KnownCondition } from "../matching/conditions.js";

export type WizardStep = "keywords" | "maxPrice" | "minPrice" | "conditions" | "exclude" | "confirm";

export interface WizardState {
  step: WizardStep;
  keywords?: string;
  maxPricePence?: number;
  minPricePence?: number | null;
  conditions: KnownCondition[];
  excludeWords: string[];
  matchMode: MatchMode;
}

export interface WizardDraft {
  keywords: string;
  maxPricePence: number;
  minPricePence: number | null;
  conditions: KnownCondition[];
  excludeWords: string[];
  matchMode: MatchMode;
}

export type WizardInput = { kind: "text"; text: string } | { kind: "button"; data: string };

export interface WizardButton {
  text: string;
  data: string;
}

export interface WizardReply {
  text: string;
  buttons: WizardButton[][];
}

export type WizardOutcome =
  | { kind: "continue"; state: WizardState; reply: WizardReply }
  | { kind: "cancelled"; reply: WizardReply }
  | { kind: "create"; draft: WizardDraft };

export interface WizardContext {
  minPriceSuggestionPence: number | null;
}

export const WIZARD_BUTTONS = {
  cancel: "wz:cancel",
  skip: "wz:skip",
  any: "wz:cond:any",
  done: "wz:cond:done",
  mode: "wz:mode",
  create: "wz:create",
} as const;

const MIN_PREFIX = "wz:min:";
const COND_PREFIX = "wz:cond:";
const MAX_EXCLUDE_WORDS = 20;
const MAX_EXCLUDE_LENGTH = 40;
const MIN_PRICE_PENCE = 100;
const MAX_PRICE_PENCE = 1_000_000;

/** "300", "£300", "£ 300", "300.5", "£1,200", "1,200.50" → pence; anything else → null. */
export function parsePriceInput(text: string): number | null {
  const cleaned = text.trim().replace(/^£\s*/, "").replace(/,(?=\d{3}(?:\D|$))/g, "");
  if (!/^\d+(?:\.\d{1,2})?$/.test(cleaned)) return null;
  return Math.round(Number.parseFloat(cleaned) * 100);
}

const cancelButton = (): WizardButton => ({ text: "✖ Cancel", data: WIZARD_BUTTONS.cancel });

function summary(state: WizardState): string {
  const conditions = state.conditions.length ? state.conditions.map((code) => CONDITION_LABELS[code]).join(", ") : "Any";
  return [
    "📝 <b>Check your search</b>",
    `Keywords: <b>${escapeHtml(state.keywords ?? "")}</b>`,
    `Max price: ${formatPence(state.maxPricePence ?? 0)} (incl. Vinted fee)`,
    `Min price: ${state.minPricePence != null ? formatPence(state.minPricePence) : "none"}`,
    `Conditions: ${conditions}`,
    `Excluding: ${state.excludeWords.length ? escapeHtml(state.excludeWords.join(", ")) : "nothing"}`,
    state.matchMode === "strict"
      ? "Matching: strict (every keyword must be in the title, brand or model)"
      : "Matching: loose (Vinted's own matching)",
  ].join("\n");
}

function promptFor(state: WizardState, ctx: WizardContext): WizardReply {
  switch (state.step) {
    case "keywords":
      return {
        text: "🔎 <b>What are you looking for?</b>\nSend the search words, e.g. <i>iphone 15 128gb</i> or <i>ralph lauren polo</i>.",
        buttons: [[cancelButton()]],
      };
    case "maxPrice":
      return {
        text: "💷 <b>Max price?</b>\nThe most you'd pay including Vinted's buyer fee, e.g. <i>300</i>.",
        buttons: [[cancelButton()]],
      };
    case "minPrice": {
      const suggestion = ctx.minPriceSuggestionPence;
      const buttons: WizardButton[][] = [];
      if (suggestion) buttons.push([{ text: `Use ${formatPence(suggestion)}`, data: `${MIN_PREFIX}${suggestion}` }]);
      buttons.push([{ text: "Skip", data: WIZARD_BUTTONS.skip }, cancelButton()]);
      return {
        text: [
          "⬇️ <b>Min price?</b> (optional)",
          "Handy for skipping cases and empty boxes.",
          ...(suggestion ? [`Suggested: <b>${formatPence(suggestion)}</b>`] : []),
          "Send a price or tap Skip.",
        ].join("\n"),
        buttons,
      };
    }
    case "conditions": {
      const rows: WizardButton[][] = CONDITION_CODES.map((code) => [
        { text: `${state.conditions.includes(code) ? "✅" : "▫️"} ${CONDITION_LABELS[code]}`, data: `${COND_PREFIX}${code}` },
      ]);
      rows.push([
        { text: state.conditions.length ? "Any condition" : "✅ Any condition", data: WIZARD_BUTTONS.any },
        { text: "Done ➡️", data: WIZARD_BUTTONS.done },
      ]);
      rows.push([cancelButton()]);
      return { text: "🏷 <b>Which conditions?</b>\nTap to toggle, then Done.", buttons: rows };
    }
    case "exclude":
      return {
        text: "🚫 <b>Words to exclude?</b> (optional)\nComma-separated, e.g. <i>icloud, cracked, box only</i>.",
        buttons: [[{ text: "Skip", data: WIZARD_BUTTONS.skip }, cancelButton()]],
      };
    case "confirm":
      return {
        text: summary(state),
        buttons: [
          [{ text: state.matchMode === "strict" ? "Matching: strict ✅ (tap for loose)" : "Matching: loose (tap for strict)", data: WIZARD_BUTTONS.mode }],
          [{ text: "✅ Create", data: WIZARD_BUTTONS.create }, cancelButton()],
        ],
      };
  }
}

export function startWizard(ctx: WizardContext): { state: WizardState; reply: WizardReply } {
  const state: WizardState = { step: "keywords", conditions: [], excludeWords: [], matchMode: "strict" };
  return { state, reply: promptFor(state, ctx) };
}

function next(state: WizardState, ctx: WizardContext): WizardOutcome {
  return { kind: "continue", state, reply: promptFor(state, ctx) };
}

function again(state: WizardState, ctx: WizardContext, problem: string): WizardOutcome {
  const prompt = promptFor(state, ctx);
  return { kind: "continue", state, reply: { text: `⚠️ ${problem}\n\n${prompt.text}`, buttons: prompt.buttons } };
}

export function advanceWizard(state: WizardState, input: WizardInput, ctx: WizardContext): WizardOutcome {
  if (input.kind === "button" && input.data === WIZARD_BUTTONS.cancel) {
    return { kind: "cancelled", reply: { text: "Cancelled. Nothing was saved.", buttons: [] } };
  }

  switch (state.step) {
    case "keywords": {
      if (input.kind !== "text") return again(state, ctx, "Please type the search words.");
      const keywords = input.text.trim().replace(/\s+/g, " ");
      if (keywords.length < 2 || keywords.length > 60 || !/[\p{L}\p{N}]/u.test(keywords)) {
        return again(state, ctx, "Search words must be 2–60 characters.");
      }
      return next({ ...state, step: "maxPrice", keywords }, ctx);
    }

    case "maxPrice": {
      const price = input.kind === "text" ? parsePriceInput(input.text) : null;
      if (price === null || price < MIN_PRICE_PENCE || price > MAX_PRICE_PENCE) {
        return again(state, ctx, "Send a price between £1 and £10,000, e.g. 300.");
      }
      return next({ ...state, step: "minPrice", maxPricePence: price }, ctx);
    }

    case "minPrice": {
      if (input.kind === "button" && input.data === WIZARD_BUTTONS.skip) {
        return next({ ...state, step: "conditions", minPricePence: null }, ctx);
      }
      let min: number | null = null;
      if (input.kind === "button" && input.data.startsWith(MIN_PREFIX)) min = Number.parseInt(input.data.slice(MIN_PREFIX.length), 10);
      else if (input.kind === "text") min = parsePriceInput(input.text);
      if (min === null || !Number.isFinite(min)) return again(state, ctx, "Send a price like 150, or tap Skip.");
      const max = state.maxPricePence ?? 0;
      if (min >= max) return again(state, ctx, `Min price must be below your max of ${formatPence(max)}.`);
      return next({ ...state, step: "conditions", minPricePence: min }, ctx);
    }

    case "conditions": {
      if (input.kind !== "button") return again(state, ctx, "Tap the buttons to choose, then Done.");
      if (input.data === WIZARD_BUTTONS.done) return next({ ...state, step: "exclude" }, ctx);
      if (input.data === WIZARD_BUTTONS.any) return next({ ...state, conditions: [] }, ctx);
      const code = input.data.startsWith(COND_PREFIX) ? input.data.slice(COND_PREFIX.length) : "";
      if (!isConditionCode(code)) return again(state, ctx, "Please use the buttons on the latest message.");
      const conditions = state.conditions.includes(code)
        ? state.conditions.filter((existing) => existing !== code)
        : CONDITION_CODES.filter((existing) => existing === code || state.conditions.includes(existing));
      return next({ ...state, conditions }, ctx);
    }

    case "exclude": {
      if (input.kind === "button" && input.data === WIZARD_BUTTONS.skip) return next({ ...state, step: "confirm", excludeWords: [] }, ctx);
      if (input.kind !== "text") return again(state, ctx, "Type words separated by commas, or tap Skip.");
      const words = [...new Set(input.text.split(",").map((word) => word.trim().replace(/\s+/g, " ").toLowerCase()).filter(Boolean))];
      if (words.length === 0) return again(state, ctx, "Type words separated by commas, or tap Skip.");
      if (words.length > MAX_EXCLUDE_WORDS || words.some((word) => word.length > MAX_EXCLUDE_LENGTH)) {
        return again(state, ctx, `Up to ${MAX_EXCLUDE_WORDS} words, each under ${MAX_EXCLUDE_LENGTH} characters.`);
      }
      return next({ ...state, step: "confirm", excludeWords: words }, ctx);
    }

    case "confirm": {
      if (input.kind === "button" && input.data === WIZARD_BUTTONS.mode) {
        return next({ ...state, matchMode: state.matchMode === "strict" ? "loose" : "strict" }, ctx);
      }
      if (input.kind === "button" && input.data === WIZARD_BUTTONS.create && state.keywords && state.maxPricePence !== undefined) {
        return {
          kind: "create",
          draft: {
            keywords: state.keywords,
            maxPricePence: state.maxPricePence,
            minPricePence: state.minPricePence ?? null,
            conditions: state.conditions,
            excludeWords: state.excludeWords,
            matchMode: state.matchMode,
          },
        };
      }
      return again(state, ctx, "Tap Create to save, or Cancel.");
    }
  }
}
