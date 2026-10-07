export type Insight =
  | { kind: "median"; n: number; medianPence: number; diffPence: number; percentile: number }
  | { kind: "rough"; n: number; percentile: number }
  | { kind: "insufficient"; n: number };

export const MIN_SAMPLE = 10;

export function median(values: number[]): number {
  if (values.length === 0) throw new Error("median of an empty list");
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid]! : Math.round((sorted[mid - 1]! + sorted[mid]!) / 2);
}

/** percentile = share of comparable listings priced above this one. */
export function computeInsight(pricePence: number, comparable: number[], modelKnown: boolean): Insight {
  const n = comparable.length;
  if (n < MIN_SAMPLE) return { kind: "insufficient", n };
  const percentile = Math.round((100 * comparable.filter((price) => price > pricePence).length) / n);
  if (!modelKnown) return { kind: "rough", n, percentile };
  const medianPence = median(comparable);
  return { kind: "median", n, medianPence, diffPence: medianPence - pricePence, percentile };
}
