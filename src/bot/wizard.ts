import { escapeHtml, formatPence } from "../alerts/format.js";
import type { MatchMode } from "../db/searches.js";
import { CONDITION_CODES, CONDITION_LABELS, isConditionCode, type KnownCondition } from "../matching/conditions.js";

export type WizardStep = "keywords" | "maxPrice" | "minPrice" | "conditions" | "exclude" | "confirm";

export interface WizardState {
  step: WizardStep;
  /** Increments with every prompt; buttons carry it so taps on an older prompt can be told apart. */
  seq?: number;
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
  | { kind: "stale" }
  | { kind: "cancelled"; reply: WizardReply }
  | { kind: "create"; draft: WizardDraft };

export interface WizardContext {
  minPriceSuggestionPence: number | null;
}

export const WIZARD_ACTIONS = {
  cancel: "cancel",
  skip: "skip",
  any: "cond:any",
  done: "cond:done",
  mode: "mode",
  create: "create",
} as const;

const MIN_PREFIX = "min:";
const COND_PREFIX = "cond:";

/** Button data is "wz:<seq>:<action>", e.g. "wz:4:cond:good". */
function buttonData(state: WizardState, action: string): string {
  return `wz:${state.seq ?? 0}:${action}`;
}

function parseButton(data: string): { seq: number; action: string } | null {
  const match = /^wz:(\d+):(.+)$/.exec(data);
  return match ? { seq: Number(match[1]), action: match[2]! } : null;
}
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

const cancelButton = (state: WizardState): WizardButton => ({ text: "✖ Cancel", data: buttonData(state, WIZARD_ACTIONS.cancel) });

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
        buttons: [[cancelButton(state)]],
      };
    case "maxPrice":
      return {
        text: "💷 <b>Max price?</b>\nThe most you'd pay including Vinted's buyer fee, e.g. <i>300</i>.",
        buttons: [[cancelButton(state)]],
      };
    case "minPrice": {
      const suggestion = ctx.minPriceSuggestionPence;
      const buttons: WizardButton[][] = [];
      if (suggestion) buttons.push([{ text: `Use ${formatPence(suggestion)}`, data: buttonData(state, `${MIN_PREFIX}${suggestion}`) }]);
      buttons.push([{ text: "Skip", data: buttonData(state, WIZARD_ACTIONS.skip) }, cancelButton(state)]);
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
      const toggles = CONDITION_CODES.map((code) => ({
        text: `${state.conditions.includes(code) ? "✅" : "▫️"} ${CONDITION_LABELS[code]}`,
        data: buttonData(state, `${COND_PREFIX}${code}`),
      }));
      const rows: WizardButton[][] = [];
      for (let i = 0; i < toggles.length; i += 2) rows.push(toggles.slice(i, i + 2)); // two per row keeps it short on phones
      rows.push([
        { text: state.conditions.length ? "Any condition" : "✅ Any condition", data: buttonData(state, WIZARD_ACTIONS.any) },
        { text: "Done ➡️", data: buttonData(state, WIZARD_ACTIONS.done) },
      ]);
      rows.push([cancelButton(state)]);
      return { text: "🏷 <b>Which conditions?</b>\nTap to toggle, then Done.", buttons: rows };
    }
    case "exclude":
      return {
        text: "🚫 <b>Words to exclude?</b> (optional)\nComma-separated, e.g. <i>icloud, cracked, box only</i>.",
        buttons: [[{ text: "Skip", data: buttonData(state, WIZARD_ACTIONS.skip) }, cancelButton(state)]],
      };
    case "confirm":
      return {
        text: summary(state),
        buttons: [
          [{ text: state.matchMode === "strict" ? "Matching: strict ✅ (tap for loose)" : "Matching: loose (tap for strict)", data: buttonData(state, WIZARD_ACTIONS.mode) }],
          [{ text: "✅ Create", data: buttonData(state, WIZARD_ACTIONS.create) }, cancelButton(state)],
        ],
      };
  }
}

export function startWizard(ctx: WizardContext): { state: WizardState; reply: WizardReply } {
  const state: WizardState = { step: "keywords", seq: 0, conditions: [], excludeWords: [], matchMode: "strict" };
  return { state, reply: promptFor(state, ctx) };
}

function next(state: WizardState, ctx: WizardContext): WizardOutcome {
  const bumped = { ...state, seq: (state.seq ?? 0) + 1 };
  return { kind: "continue", state: bumped, reply: promptFor(bumped, ctx) };
}

function again(state: WizardState, ctx: WizardContext, problem: string): WizardOutcome {
  const bumped = { ...state, seq: (state.seq ?? 0) + 1 };
  const prompt = promptFor(bumped, ctx);
  return { kind: "continue", state: bumped, reply: { text: `⚠️ ${problem}\n\n${prompt.text}`, buttons: prompt.buttons } };
}

export function advanceWizard(state: WizardState, input: WizardInput, ctx: WizardContext): WizardOutcome {
  let action: string | null = null;
  if (input.kind === "button") {
    const parsed = parseButton(input.data);
    // Cancel means cancel, whichever prompt it was tapped on.
    if (parsed?.action === WIZARD_ACTIONS.cancel) return { kind: "cancelled", reply: { text: "Cancelled. Nothing was saved.", buttons: [] } };
    // A tap on an older prompt must not act on the current step (it would edit the wrong message).
    if (!parsed || parsed.seq !== (state.seq ?? 0)) return { kind: "stale" };
    action = parsed.action;
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
      if (action === WIZARD_ACTIONS.skip) {
        return next({ ...state, step: "conditions", minPricePence: null }, ctx);
      }
      let min: number | null = null;
      if (action?.startsWith(MIN_PREFIX)) min = Number.parseInt(action.slice(MIN_PREFIX.length), 10);
      else if (input.kind === "text") min = parsePriceInput(input.text);
      if (min === null || !Number.isFinite(min)) return again(state, ctx, "Send a price like 150, or tap Skip.");
      const max = state.maxPricePence ?? 0;
      if (min >= max) return again(state, ctx, `Min price must be below your max of ${formatPence(max)}.`);
      return next({ ...state, step: "conditions", minPricePence: min }, ctx);
    }

    case "conditions": {
      if (input.kind !== "button") return again(state, ctx, "Tap the buttons to choose, then Done.");
      if (action === WIZARD_ACTIONS.done) return next({ ...state, step: "exclude" }, ctx);
      if (action === WIZARD_ACTIONS.any) return next({ ...state, conditions: [] }, ctx);
      const code = action?.startsWith(COND_PREFIX) ? action.slice(COND_PREFIX.length) : "";
      if (!isConditionCode(code)) return again(state, ctx, "Please use the buttons on the latest message.");
      const conditions = state.conditions.includes(code)
        ? state.conditions.filter((existing) => existing !== code)
        : CONDITION_CODES.filter((existing) => existing === code || state.conditions.includes(existing));
      return next({ ...state, conditions }, ctx);
    }

    case "exclude": {
      if (action === WIZARD_ACTIONS.skip) return next({ ...state, step: "confirm", excludeWords: [] }, ctx);
      if (input.kind !== "text") return again(state, ctx, "Type words separated by commas, or tap Skip.");
      const words = [...new Set(input.text.split(",").map((word) => word.trim().replace(/\s+/g, " ").toLowerCase()).filter(Boolean))];
      if (words.length === 0) return again(state, ctx, "Type words separated by commas, or tap Skip.");
      if (words.length > MAX_EXCLUDE_WORDS || words.some((word) => word.length > MAX_EXCLUDE_LENGTH)) {
        return again(state, ctx, `Up to ${MAX_EXCLUDE_WORDS} words, each under ${MAX_EXCLUDE_LENGTH} characters.`);
      }
      return next({ ...state, step: "confirm", excludeWords: words }, ctx);
    }

    case "confirm": {
      if (action === WIZARD_ACTIONS.mode) {
        return next({ ...state, matchMode: state.matchMode === "strict" ? "loose" : "strict" }, ctx);
      }
      if (action === WIZARD_ACTIONS.create && state.keywords && state.maxPricePence !== undefined) {
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
