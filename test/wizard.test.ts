import { describe, expect, it } from "vitest";
import { advanceWizard, parsePriceInput, startWizard, WIZARD_ACTIONS, type WizardOutcome, type WizardState } from "../src/bot/wizard.js";

const ctx = { minPriceSuggestionPence: null };
const text = (value: string) => ({ kind: "text" as const, text: value });
/** A tap on a button of the prompt that was shown for this state (buttons carry the state's seq). */
const tap = (state: WizardState, action: string) => ({ kind: "button" as const, data: `wz:${state.seq ?? 0}:${action}` });

function continueState(outcome: WizardOutcome): WizardState {
  if (outcome.kind !== "continue") throw new Error(`expected continue, got ${outcome.kind}`);
  return outcome.state;
}

describe("parsePriceInput (Review Focus 2)", () => {
  it.each([
    ["300", 30000],
    ["£300", 30000],
    ["£ 300", 30000],
    ["300.5", 30050],
    ["£1,200", 120000],
    ["1,200.50", 120050],
    [" 75 ", 7500],
  ])("%s → %s", (input, pence) => {
    expect(parsePriceInput(input)).toBe(pence);
  });
  it.each(["abc", "1,20", "-5", "", "12.345", "£"])("rejects %s", (input) => {
    expect(parsePriceInput(input)).toBeNull();
  });
});

describe("wizard", () => {
  it("walks through every step to a complete draft", () => {
    let state = startWizard(ctx).state;
    state = continueState(advanceWizard(state, text("  iPhone   15 "), ctx));
    expect(state).toMatchObject({ step: "maxPrice", keywords: "iPhone 15" });
    state = continueState(advanceWizard(state, text("£300"), ctx));
    expect(state).toMatchObject({ step: "minPrice", maxPricePence: 30000 });
    state = continueState(advanceWizard(state, text("150"), ctx));
    expect(state).toMatchObject({ step: "conditions", minPricePence: 15000 });
    state = continueState(advanceWizard(state, tap(state, "cond:good"), ctx));
    state = continueState(advanceWizard(state, tap(state, "cond:very_good"), ctx));
    expect(state.conditions).toEqual(["very_good", "good"]);
    state = continueState(advanceWizard(state, tap(state, "cond:good"), ctx));
    expect(state.conditions).toEqual(["very_good"]);
    state = continueState(advanceWizard(state, tap(state, WIZARD_ACTIONS.done), ctx));
    state = continueState(advanceWizard(state, text("iCloud, cracked , box only,,"), ctx));
    expect(state).toMatchObject({ step: "confirm", excludeWords: ["icloud", "cracked", "box only"] });
    state = continueState(advanceWizard(state, tap(state, WIZARD_ACTIONS.mode), ctx));
    expect(state.matchMode).toBe("loose");
    state = continueState(advanceWizard(state, tap(state, WIZARD_ACTIONS.mode), ctx));
    expect(advanceWizard(state, tap(state, WIZARD_ACTIONS.create), ctx)).toEqual({
      kind: "create",
      draft: { keywords: "iPhone 15", maxPricePence: 30000, minPricePence: 15000, conditions: ["very_good"], excludeWords: ["icloud", "cracked", "box only"], matchMode: "strict" },
    });
  });

  it("re-asks with a warning on invalid input", () => {
    const start = startWizard(ctx).state;
    const badKeywords = advanceWizard(start, text("a"), ctx);
    expect(badKeywords.kind === "continue" && badKeywords.state.step).toBe("keywords");
    expect(badKeywords.kind === "continue" && badKeywords.reply.text.startsWith("⚠️")).toBe(true);

    const atMax = continueState(advanceWizard(start, text("ps5"), ctx));
    for (const bad of ["abc", "0.50", "20000"]) {
      expect(continueState(advanceWizard(atMax, text(bad), ctx)).step).toBe("maxPrice");
    }
    const atMin = continueState(advanceWizard(atMax, text("200"), ctx));
    expect(continueState(advanceWizard(atMin, text("250"), ctx)).step).toBe("minPrice");
    const atConditions = continueState(advanceWizard(atMin, tap(atMin, WIZARD_ACTIONS.skip), ctx));
    expect(atConditions.minPricePence).toBeNull();
    expect(continueState(advanceWizard(atConditions, text("good"), ctx)).step).toBe("conditions");
    expect(continueState(advanceWizard(atConditions, tap(atConditions, "cond:bogus"), ctx)).step).toBe("conditions");
    const atExclude = continueState(advanceWizard(atConditions, tap(atConditions, WIZARD_ACTIONS.done), ctx));
    const tooMany = Array.from({ length: 21 }, (_, i) => `w${i}`).join(",");
    expect(continueState(advanceWizard(atExclude, text(tooMany), ctx)).step).toBe("exclude");
  });

  it("offers the suggested min price as a button", () => {
    const suggest = { minPriceSuggestionPence: 15000 };
    let state = continueState(advanceWizard(startWizard(suggest).state, text("iphone 15"), suggest));
    const toMin = advanceWizard(state, text("300"), suggest);
    if (toMin.kind !== "continue") throw new Error("expected continue");
    expect(toMin.reply.text).toContain("£150.00");
    expect(toMin.reply.buttons[0]).toEqual([{ text: "Use £150.00", data: `wz:${toMin.state.seq}:min:15000` }]);
    state = continueState(advanceWizard(toMin.state, tap(toMin.state, "min:15000"), suggest));
    expect(state).toMatchObject({ step: "conditions", minPricePence: 15000 });
  });

  it("'Any condition' clears the selection", () => {
    let state = continueState(advanceWizard(continueState(advanceWizard(startWizard(ctx).state, text("ps5"), ctx)), text("300"), ctx));
    state = continueState(advanceWizard(state, tap(state, WIZARD_ACTIONS.skip), ctx));
    state = continueState(advanceWizard(state, tap(state, "cond:good"), ctx));
    state = continueState(advanceWizard(state, tap(state, WIZARD_ACTIONS.any), ctx));
    expect(state.conditions).toEqual([]);
  });

  it("shows the condition buttons two per row", () => {
    const state = continueState(advanceWizard(continueState(advanceWizard(startWizard(ctx).state, text("ps5"), ctx)), text("300"), ctx));
    const toConditions = advanceWizard(state, tap(state, WIZARD_ACTIONS.skip), ctx);
    if (toConditions.kind !== "continue") throw new Error("expected continue");
    expect(toConditions.reply.buttons.slice(0, 3).map((row) => row.map((button) => button.text))).toEqual([
      ["▫️ New with tags", "▫️ New without tags"],
      ["▫️ Very good", "▫️ Good"],
      ["▫️ Satisfactory", "▫️ Not fully functional"],
    ]);
  });

  it("cancels from any step", () => {
    const start = startWizard(ctx).state;
    const outcome = advanceWizard(start, tap(start, WIZARD_ACTIONS.cancel), ctx);
    expect(outcome).toEqual({ kind: "cancelled", reply: { text: "Cancelled. Nothing was saved.", buttons: [] } });
  });
});

describe("stale buttons (Telegram review)", () => {
  it("ignores a button from an older prompt instead of acting on it", () => {
    const atMax = continueState(advanceWizard(startWizard(ctx).state, text("ps5"), ctx));
    const atMin = continueState(advanceWizard(atMax, text("300"), ctx));
    const reAsked = continueState(advanceWizard(atMin, text("400"), ctx));
    expect(reAsked.step).toBe("minPrice");
    expect(advanceWizard(reAsked, tap(atMin, WIZARD_ACTIONS.skip), ctx)).toEqual({ kind: "stale" });
    expect(continueState(advanceWizard(reAsked, tap(reAsked, WIZARD_ACTIONS.skip), ctx)).step).toBe("conditions");
  });

  it("treats buttons from before this change as stale", () => {
    const atMin = continueState(advanceWizard(continueState(advanceWizard(startWizard(ctx).state, text("ps5"), ctx)), text("300"), ctx));
    expect(advanceWizard(atMin, { kind: "button", data: "wz:skip" }, ctx)).toEqual({ kind: "stale" });
  });

  it("still cancels from an older prompt's Cancel button", () => {
    const start = startWizard(ctx).state;
    const atMax = continueState(advanceWizard(start, text("ps5"), ctx));
    expect(advanceWizard(atMax, tap(start, WIZARD_ACTIONS.cancel), ctx).kind).toBe("cancelled");
  });
});
