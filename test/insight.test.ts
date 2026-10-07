import { describe, expect, it } from "vitest";
import { groupFor, storageFromText } from "../src/insight/groups.js";
import { computeInsight, median } from "../src/insight/stats.js";

describe("storageFromText", () => {
  it("finds storage sizes", () => {
    expect(storageFromText("iPhone 15 128GB pink")).toBe("128gb");
    expect(storageFromText("iPhone 15 256 GB")).toBe("256gb");
    expect(storageFromText("MacBook 1TB")).toBe("1tb");
    expect(storageFromText("iPhone 15")).toBeNull();
    expect(storageFromText(null)).toBeNull();
  });
});

describe("groupFor", () => {
  it("builds term|model|storage|band keys", () => {
    expect(groupFor("iphone 15", { title: "iPhone 15 128GB", model: "iPhone 15", condition: "very_good" })).toEqual({
      groupKey: "iphone 15|iphone 15|128gb|good",
      modelKnown: true,
    });
  });
  it("uses detail storage when the title has none, and '-' for missing parts", () => {
    expect(groupFor("iphone 15", { title: "iPhone 15", model: "iPhone 15", condition: "good" }, "256 GB").groupKey).toBe(
      "iphone 15|iphone 15|256gb|good",
    );
    expect(groupFor("ralph lauren polo", { title: "RL polo", model: null, condition: "unknown" })).toEqual({
      groupKey: "ralph lauren polo|-|-|unknown",
      modelKnown: false,
    });
  });
});

describe("statistics", () => {
  it("computes the median", () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([1, 2, 3, 4])).toBe(3);
    expect(() => median([])).toThrow();
  });

  const ten = [30000, 31000, 32000, 33000, 34000, 35000, 36000, 37000, 38000, 39000];

  it("needs at least 10 comparable listings", () => {
    expect(computeInsight(25000, ten.slice(0, 9), true)).toEqual({ kind: "insufficient", n: 9 });
  });
  it("gives median difference and percentile when the model is known", () => {
    expect(computeInsight(26000, ten, true)).toEqual({ kind: "median", n: 10, medianPence: 34500, diffPence: 8500, percentile: 100 });
    expect(computeInsight(36500, ten, true)).toMatchObject({ diffPence: -2000, percentile: 30 });
  });
  it("gives only a rough percentile without a model", () => {
    expect(computeInsight(33500, ten, false)).toEqual({ kind: "rough", n: 10, percentile: 60 });
  });
});
