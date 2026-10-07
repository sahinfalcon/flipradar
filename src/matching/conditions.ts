export const CONDITION_CODES = [
  "new_with_tags",
  "new_without_tags",
  "very_good",
  "good",
  "satisfactory",
  "not_fully_functional",
] as const;

export type KnownCondition = (typeof CONDITION_CODES)[number];
export type ConditionCode = KnownCondition | "unknown";

export const CONDITION_LABELS: Record<KnownCondition, string> = {
  new_with_tags: "New with tags",
  new_without_tags: "New without tags",
  very_good: "Very good",
  good: "Good",
  satisfactory: "Satisfactory",
  not_fully_functional: "Not fully functional",
};

const BY_LABEL = new Map<string, KnownCondition>(
  CONDITION_CODES.map((code) => [CONDITION_LABELS[code].toLowerCase(), code]),
);

export function conditionFromLabel(label: string | null | undefined): ConditionCode {
  if (!label) return "unknown";
  return BY_LABEL.get(label.trim().toLowerCase()) ?? "unknown";
}

export function isConditionCode(value: string): value is KnownCondition {
  return (CONDITION_CODES as readonly string[]).includes(value);
}

export type ConditionBand = "new" | "good" | "worn" | "faulty" | "unknown";

export function conditionBand(code: ConditionCode): ConditionBand {
  switch (code) {
    case "new_with_tags":
    case "new_without_tags":
      return "new";
    case "very_good":
    case "good":
      return "good";
    case "satisfactory":
      return "worn";
    case "not_fully_functional":
      return "faulty";
    default:
      return "unknown";
  }
}
