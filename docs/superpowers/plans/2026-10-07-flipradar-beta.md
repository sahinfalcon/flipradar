# flipradar Beta Alert Engine Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the flipradar beta: a single Node.js/TypeScript process that polls Vinted UK for testers' saved searches, sends Telegram alerts with deal insight within seconds, and lets invited testers manage searches entirely in Telegram.

**Architecture:** One process composed of small single-purpose modules (§4 of the spec): a pure Vinted parser, a rate-limited request queue, a poller that detects new listings per search term, a pure matcher and insight calculator, an alert pipeline writing to SQLite, a notifier that sends Telegram messages, a pure `/new` wizard and a `BotService` wrapped by thin grammY wiring. All state lives in one SQLite file.

**Tech Stack:** Node.js ≥ 22 (dev machine: 26), TypeScript 7 (strict, ESM/NodeNext), tsx, grammY 1.46, better-sqlite3 13, zod 4, pino 10, Vitest 5.

**Spec:** `docs/superpowers/specs/2026-10-07-flipradar-beta-design.md`

## Global Constraints

- Node ≥ 22; TypeScript `strict` + `noUncheckedIndexedAccess`; ES modules; relative imports end in `.js` (e.g. `import { x } from "./y.js"`).
- Money is integer **pence**; times are Unix **milliseconds**.
- Vinted host `www.vinted.co.uk` only; catalog URL `https://www.vinted.co.uk/catalog?search_text=…&order=newest_first[&page=N]`.
- Request queue: `REQUEST_SPACING_MS` default 1500 + uniform jitter 0–500 ms; one request in flight; priority detail > poll > warmup.
- Backoff: 1 min doubling to 30 min while blocked; block = HTTP 403/429/503 or a Cloudflare challenge page.
- `MIN_TERM_INTERVAL_MS` default 30000; warm-up pages 2–5 once per new term.
- Search: keywords 2–60 chars; max price £1–£10,000 fee-inclusive; ≤ 20 exclude words; default limit 5 per tester.
- Insight: comparable listings within 30 days, minimum 10; wording "typical listing price".
- Flood control: 10 alerts per search per 10 minutes, then digests (≤ 5 items listed).
- Telegram: ≥ 1.1 s between messages to one chat; 429 → wait `retry_after`; other errors retried after 2/4/8 s; pending alerts older than 10 min dropped at startup.
- Owner messages: ≤ 1 per condition per 15 min; overflow ≤ 1 per term per hour.
- Retention: `term_items` by `last_seen_at` and `items` by `card_seen_at` 7 days; `price_observations` and `alerts` 30 days; `wizard_state` 1 hour.
- Never store Vinted seller usernames or IDs.
- Do not use "Vinted" in the product name; the bot is "flipradar".

## Spec deviations (decided while planning; the spec was updated in the same commit as this plan)

1. **Block detection.** Normal Vinted pages contain the text "Just a moment while we process your payment" and a Cloudflare `challenge-platform` script, so body-substring detection would flag every page. A page is a challenge only when it has `<title>Just a moment` or contains `cf_chl_opt` / `cf-chl-`.
2. **Empty results.** Vinted renders `data-testid="search-empty-state"` for searches with no results; such pages are a successful "empty" result, not a layout problem. Only pages with neither item cards nor the empty-state marker count toward the layout alarm.
3. **Alert statuses** gain `digest_sent`; `alerts` gains `details_unavailable INTEGER`.
4. **Schema** lives in `src/db/schema.ts` (a string) instead of `schema.sql`, avoiding runtime file-path handling.
5. **Alert header** uses 🔔 (generic) instead of 📱.
6. **Preview** is sent as a follow-up message after "Search saved", so a slow Vinted fetch never blocks the bot's update loop.

## Review Focus

1. **Keywords with emoji, hyphens or apostrophes** ("Nike Air Max 90 🔥", "carhartt-wip", "zara’s") must produce a sensible term key and still match listings — owned by Task 2.
2. **Prices typed the way people type them** ("£1,200", "£ 300", "300.5") must parse; nonsense must re-ask — owned by Task 17.
3. **Cards with no price or an unknown condition** must never alert under a condition filter and never crash — owned by Task 3.
4. **A normal Vinted page that contains "Just a moment" text** must not trigger backoff — owned by Tasks 4 and 11.
5. **Listing titles with HTML characters or extreme length** (`<`, `&`, 300 chars) must be escaped and keep captions within Telegram's 1024-char limit — owned by Task 15.

## File map

```
flipradar/
  package.json, tsconfig.json, vitest.config.ts, .gitignore, .env.example     Task 1
  src/config.ts                                                                Task 1
  src/matching/normalize.ts                                                    Task 2
  src/matching/conditions.ts, src/vinted/types.ts, src/matching/match.ts       Task 3
  src/vinted/parse.ts, src/vinted/url.ts                                       Task 4
  scripts/capture-fixtures.ts, test/fixtures/*.html                            Task 5
  src/insight/groups.ts, src/insight/stats.ts                                  Task 6
  src/db/schema.ts, src/db/database.ts, src/db/users.ts, src/db/meta.ts        Task 7
  src/db/searches.ts, src/db/terms.ts                                          Task 8
  src/db/items.ts, src/db/prices.ts, src/db/alerts.ts, src/db/retention.ts     Task 9
  src/poller/requestQueue.ts                                                   Task 10
  src/vinted/client.ts                                                         Task 11
  src/health/health.ts                                                         Task 12
  src/alerts/pipeline.ts                                                       Task 13
  src/poller/poller.ts                                                         Task 14
  src/alerts/format.ts, src/alerts/flood.ts                                    Task 15
  src/alerts/notifier.ts                                                       Task 16
  src/bot/wizard.ts                                                            Task 17
  src/bot/preview.ts, src/bot/admin.ts, src/bot/service.ts                     Task 18
  src/bot/bot.ts, src/main.ts, scripts/probe.ts                                Task 19
  Dockerfile, docker-compose.yml, .github/workflows/probe.yml, README.md       Task 20
  test/helpers/cards.ts (T3), test/helpers/db.ts (T7, extended T8)
```

---

### Task 1: Project scaffold and configuration

**Files:**
- Create: `package.json`, `tsconfig.json`, `vitest.config.ts`, `.gitignore`, `.env.example`, `src/config.ts`
- Test: `test/config.test.ts`

**Interfaces:**
- Produces: `loadConfig(env?: Record<string, string | undefined>): Config`, `type Config`, `DEFAULT_USER_AGENT: string`.

- [ ] **Step 1: Create the project files**

`package.json`:

```json
{
  "name": "flipradar",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "engines": { "node": ">=22" },
  "scripts": {
    "start": "tsx src/main.ts",
    "start:mac": "caffeinate -is tsx src/main.ts",
    "dev": "tsx watch src/main.ts",
    "test": "vitest run",
    "test:watch": "vitest",
    "typecheck": "tsc --noEmit",
    "probe": "tsx scripts/probe.ts",
    "capture-fixtures": "tsx scripts/capture-fixtures.ts"
  }
}
```

`tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2023",
    "lib": ["ES2023"],
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "noEmit": true,
    "types": ["node"]
  },
  "include": ["src", "test", "scripts", "vitest.config.ts"]
}
```

`vitest.config.ts`:

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
  },
});
```

`.gitignore`:

```
node_modules/
data/
.env
*.db
*.db-shm
*.db-wal
coverage/
```

`.env.example`:

```
# Required
TELEGRAM_BOT_TOKEN=
ADMIN_TELEGRAM_ID=

# Optional — defaults shown
# DATABASE_PATH=./data/flipradar.db
# VINTED_HOST=www.vinted.co.uk
# REQUEST_SPACING_MS=1500
# MIN_TERM_INTERVAL_MS=30000
# DEFAULT_SEARCH_LIMIT=5
# USER_AGENT=
# LOG_LEVEL=info
```

- [ ] **Step 2: Install dependencies**

```bash
npm install grammy@^1.46 better-sqlite3@^13 zod@^4 pino@^10 tsx@^4.23
npm install -D typescript@^7 vitest@^5 @types/better-sqlite3@^9 @types/node@^22
```

Expected: both commands finish without errors; `package.json` now lists them. (`tsx` is a runtime dependency because the app runs TypeScript directly.)

- [ ] **Step 3: Write the failing test**

`test/config.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { DEFAULT_USER_AGENT, loadConfig } from "../src/config.js";

const required = { TELEGRAM_BOT_TOKEN: "123:abc", ADMIN_TELEGRAM_ID: "42" };

describe("loadConfig", () => {
  it("applies defaults", () => {
    expect(loadConfig(required)).toEqual({
      telegramBotToken: "123:abc",
      adminTelegramId: 42,
      databasePath: "./data/flipradar.db",
      vintedHost: "www.vinted.co.uk",
      requestSpacingMs: 1500,
      minTermIntervalMs: 30000,
      defaultSearchLimit: 5,
      userAgent: DEFAULT_USER_AGENT,
      logLevel: "info",
    });
  });

  it("reads overrides as numbers", () => {
    const config = loadConfig({ ...required, REQUEST_SPACING_MS: "2000", DEFAULT_SEARCH_LIMIT: "3" });
    expect(config.requestSpacingMs).toBe(2000);
    expect(config.defaultSearchLimit).toBe(3);
  });

  it("treats empty strings as unset", () => {
    expect(loadConfig({ ...required, DATABASE_PATH: "", USER_AGENT: "" }).databasePath).toBe("./data/flipradar.db");
  });

  it("names the missing variable", () => {
    expect(() => loadConfig({ ADMIN_TELEGRAM_ID: "42" })).toThrow(/TELEGRAM_BOT_TOKEN/);
  });

  it("rejects a non-numeric spacing", () => {
    expect(() => loadConfig({ ...required, REQUEST_SPACING_MS: "fast" })).toThrow(/REQUEST_SPACING_MS/);
  });
});
```

- [ ] **Step 4: Run test to verify it fails**

Run: `npx vitest run test/config.test.ts`
Expected: FAIL — cannot resolve `../src/config.js`.

- [ ] **Step 5: Write the implementation**

`src/config.ts`:

```ts
import { z } from "zod";

export const DEFAULT_USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36";

const Schema = z.object({
  TELEGRAM_BOT_TOKEN: z.string().min(1),
  ADMIN_TELEGRAM_ID: z.coerce.number().int().positive(),
  DATABASE_PATH: z.string().min(1).default("./data/flipradar.db"),
  VINTED_HOST: z.string().min(1).default("www.vinted.co.uk"),
  REQUEST_SPACING_MS: z.coerce.number().int().min(250).default(1500),
  MIN_TERM_INTERVAL_MS: z.coerce.number().int().min(5000).default(30000),
  DEFAULT_SEARCH_LIMIT: z.coerce.number().int().min(1).max(100).default(5),
  USER_AGENT: z.string().min(1).default(DEFAULT_USER_AGENT),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),
});

export interface Config {
  telegramBotToken: string;
  adminTelegramId: number;
  databasePath: string;
  vintedHost: string;
  requestSpacingMs: number;
  minTermIntervalMs: number;
  defaultSearchLimit: number;
  userAgent: string;
  logLevel: "fatal" | "error" | "warn" | "info" | "debug" | "trace" | "silent";
}

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const present = Object.fromEntries(Object.entries(env).filter(([, value]) => value !== undefined && value !== ""));
  const result = Schema.safeParse(present);
  if (!result.success) {
    const problems = result.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ");
    throw new Error(`Invalid configuration — ${problems}`);
  }
  const e = result.data;
  return {
    telegramBotToken: e.TELEGRAM_BOT_TOKEN,
    adminTelegramId: e.ADMIN_TELEGRAM_ID,
    databasePath: e.DATABASE_PATH,
    vintedHost: e.VINTED_HOST,
    requestSpacingMs: e.REQUEST_SPACING_MS,
    minTermIntervalMs: e.MIN_TERM_INTERVAL_MS,
    defaultSearchLimit: e.DEFAULT_SEARCH_LIMIT,
    userAgent: e.USER_AGENT,
    logLevel: e.LOG_LEVEL,
  };
}
```

- [ ] **Step 6: Run tests and type-check**

Run: `npx vitest run test/config.test.ts && npm run typecheck`
Expected: 5 tests PASS; type-check prints nothing.

- [ ] **Step 7: Commit**

```bash
git add package.json package-lock.json tsconfig.json vitest.config.ts .gitignore .env.example src/config.ts test/config.test.ts
git commit -m "feat: project scaffold and validated configuration"
```

---

### Task 2: Text normalisation and strict keyword matching

**Files:**
- Create: `src/matching/normalize.ts`
- Test: `test/normalize.test.ts`

**Interfaces:**
- Produces:
  - `normalizeText(text: string): string`
  - `toWords(text: string): string[]`
  - `toTermKey(keywords: string): string`
  - `strictKeywordMatch(keywords: string, listingText: string): boolean`
  - `containsPhrase(text: string, phrase: string): boolean`

- [ ] **Step 1: Write the failing test**

`test/normalize.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { containsPhrase, normalizeText, strictKeywordMatch, toTermKey, toWords } from "../src/matching/normalize.js";

describe("normalizeText", () => {
  it("lowercases, strips accents and punctuation", () => {
    expect(normalizeText("  Café-Crème, 128GB!! ")).toBe("cafe creme 128gb");
  });
  it("splits into words", () => {
    expect(toWords("I Phone . 15")).toEqual(["i", "phone", "15"]);
    expect(toWords("🔥🔥")).toEqual([]);
  });
});

describe("toTermKey", () => {
  it("keeps + and - but drops other punctuation and emoji", () => {
    expect(toTermKey("  Nike Air Max 90 🔥 ")).toBe("nike air max 90");
    expect(toTermKey("Carhartt-WIP  Detroit")).toBe("carhartt-wip detroit");
    expect(toTermKey("Zara’s Blazer")).toBe("zara s blazer");
  });
});

describe("strictKeywordMatch (spec §6 table)", () => {
  const cases: Array<[string, string, boolean]> = [
    ["ralph lauren polo", "Ralph Lauren Polo Shirt Navy M", true],
    ["ralph lauren polo", "Polo Ralph Lauren cap", true],
    ["ralph lauren polo", "RalphLauren polo tee", true],
    ["ralph lauren polo", "Lauren Ralph Lauren dress", false],
    ["polo", "Ralph Lauren polos bundle", true],
    ["iphone 15", "I Phone 15 . Good Condition", true],
    ["i phone 15", "iPhone 15 128GB", true],
    ["iphone 15 pro", "iPhone 15 screen protector", false],
    ["128gb", "iPhone 15 128 GB", true],
    ["cap", "Capri trousers", false],
  ];
  it.each(cases)("%s vs %s → %s", (keywords, listing, expected) => {
    expect(strictKeywordMatch(keywords, listing)).toBe(expected);
  });

  it("handles hyphens, apostrophes and emoji in keywords (Review Focus 1)", () => {
    expect(strictKeywordMatch("carhartt-wip", "Carhartt WIP jacket")).toBe(true);
    expect(strictKeywordMatch("zara’s blazer", "Zara blazer black")).toBe(true);
    expect(strictKeywordMatch("nike air max 90 🔥", "Nike Air Max 90 white")).toBe(true);
    expect(strictKeywordMatch("dress", "Floral dresses x2")).toBe(true);
  });
});

describe("containsPhrase", () => {
  it("matches whole words and phrases only", () => {
    expect(containsPhrase("Sim lock: Unlocked", "locked")).toBe(false);
    expect(containsPhrase("iCloud locked, sold as is", "icloud locked")).toBe(true);
    expect(containsPhrase("Box only!", "box only")).toBe(true);
    expect(containsPhrase("anything", "  ")).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/normalize.test.ts`
Expected: FAIL — cannot resolve `../src/matching/normalize.js`.

- [ ] **Step 3: Write the implementation**

`src/matching/normalize.ts`:

```ts
const NON_WORD = /[^\p{L}\p{N}]+/gu;
const MARKS = /\p{M}+/gu;

/** Lowercase, strip accents, turn punctuation/emoji into spaces, collapse whitespace. */
export function normalizeText(text: string): string {
  return text.normalize("NFKD").replace(MARKS, "").toLowerCase().replace(NON_WORD, " ").trim().replace(/\s+/g, " ");
}

export function toWords(text: string): string[] {
  const normalized = normalizeText(text);
  return normalized ? normalized.split(" ") : [];
}

/** Shared fetch key for a search: like normalizeText but keeps "+" and "-". */
export function toTermKey(keywords: string): string {
  return keywords
    .normalize("NFKD")
    .replace(MARKS, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}+\-]+/gu, " ")
    .trim()
    .replace(/\s+/g, " ");
}

/** Every listing word plus every run of 2–3 adjacent words joined without spaces. */
function phraseSet(listingWords: string[]): Set<string> {
  const phrases = new Set<string>();
  for (let i = 0; i < listingWords.length; i += 1) {
    let joined = "";
    for (let k = 0; k < 3 && i + k < listingWords.length; k += 1) {
      joined += listingWords[i + k];
      phrases.add(joined);
    }
  }
  return phrases;
}

/** True when some phrase equals the candidate, allowing a trailing "s"/"es" on either side. */
function hasSameWord(phrases: Set<string>, candidate: string): boolean {
  if (phrases.has(candidate) || phrases.has(`${candidate}s`) || phrases.has(`${candidate}es`)) return true;
  if (candidate.endsWith("es") && phrases.has(candidate.slice(0, -2))) return true;
  if (candidate.endsWith("s") && phrases.has(candidate.slice(0, -1))) return true;
  return false;
}

/**
 * Spec §6 "Strict keyword matching": whole words only; adjacent search words or
 * adjacent listing words may be joined (up to 3); plurals allowed; one-character
 * search words that cannot be joined are ignored.
 */
export function strictKeywordMatch(keywords: string, listingText: string): boolean {
  const search = toWords(keywords);
  const phrases = phraseSet(toWords(listingText));
  let i = 0;
  while (i < search.length) {
    let consumed = 0;
    for (let k = Math.min(3, search.length - i); k >= 1; k -= 1) {
      if (hasSameWord(phrases, search.slice(i, i + k).join(""))) {
        consumed = k;
        break;
      }
    }
    if (consumed === 0) {
      if ((search[i] ?? "").length === 1) {
        i += 1;
        continue;
      }
      return false;
    }
    i += consumed;
  }
  return true;
}

/** Whole-word/phrase containment on normalised text ("locked" does not match "unlocked"). */
export function containsPhrase(text: string, phrase: string): boolean {
  const needle = normalizeText(phrase);
  if (!needle) return false;
  return ` ${normalizeText(text)} `.includes(` ${needle} `);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/normalize.test.ts`
Expected: all tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/matching/normalize.ts test/normalize.test.ts
git commit -m "feat: text normalisation and whole-word strict keyword matching"
```

---

### Task 3: Conditions, Vinted types and the matcher

**Files:**
- Create: `src/matching/conditions.ts`, `src/vinted/types.ts`, `src/matching/match.ts`, `test/helpers/cards.ts`
- Test: `test/match.test.ts`

**Interfaces:**
- Consumes: `strictKeywordMatch`, `containsPhrase` (Task 2).
- Produces:
  - `CONDITION_CODES`, `type KnownCondition`, `type ConditionCode` (`KnownCondition | "unknown"`), `CONDITION_LABELS: Record<KnownCondition, string>`, `conditionFromLabel(label?: string | null): ConditionCode`, `isConditionCode(value: string): value is KnownCondition`, `type ConditionBand`, `conditionBand(code: ConditionCode): ConditionBand`
  - `interface CardListing { vintedId; title; brand: string | null; model: string | null; condition: ConditionCode; pricePence: number | null; itemPricePence: number | null; photoUrl: string | null; url: string }`
  - `interface ItemDetail { description; attributes: Record<string, string>; photos: string[]; sellerRating: number | null; sellerFeedbackCount: number | null; unavailable: boolean; uploadedText: string | null }`
  - `type CatalogPage = { kind: "ok"; cards: CardListing[] } | { kind: "empty" } | { kind: "unrecognised" }`
  - `interface MatchableSearch { keywords; maxPricePence; minPricePence: number | null; conditions: ConditionCode[]; excludeWords: string[]; matchMode: "strict" | "loose" }`
  - `effectivePricePence(card): number | null`, `cardStageMatch(search, card): boolean`, `detailStageMatch(search, detail): boolean`
  - test helper `makeCard(overrides?: Partial<CardListing>): CardListing`

- [ ] **Step 1: Create the types, conditions and test helper**

`src/matching/conditions.ts`:

```ts
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
```

`src/vinted/types.ts`:

```ts
import type { ConditionCode } from "../matching/conditions.js";

export interface CardListing {
  vintedId: string;
  title: string;
  brand: string | null;
  model: string | null;
  condition: ConditionCode;
  /** Fee-inclusive total shown on the card, or null when the card has none. */
  pricePence: number | null;
  itemPricePence: number | null;
  photoUrl: string | null;
  url: string;
}

export interface ItemDetail {
  description: string;
  attributes: Record<string, string>;
  photos: string[];
  /** 0..1 */
  sellerRating: number | null;
  sellerFeedbackCount: number | null;
  /** Sold or reserved. */
  unavailable: boolean;
  /** e.g. "2 min ago" */
  uploadedText: string | null;
}

export type CatalogPage = { kind: "ok"; cards: CardListing[] } | { kind: "empty" } | { kind: "unrecognised" };
```

`test/helpers/cards.ts`:

```ts
import type { CardListing, ItemDetail } from "../../src/vinted/types.js";

export function makeCard(overrides: Partial<CardListing> = {}): CardListing {
  return {
    vintedId: "1001",
    title: "iPhone 15 128GB",
    brand: "Apple",
    model: "iPhone 15",
    condition: "very_good",
    pricePence: 26320,
    itemPricePence: 24999,
    photoUrl: "https://images1.vinted.net/t/1001/310x430/a.webp",
    url: "https://www.vinted.co.uk/items/1001-iphone-15",
    ...overrides,
  };
}

export function makeDetail(overrides: Partial<ItemDetail> = {}): ItemDetail {
  return {
    description: "Battery 89%, always in a case",
    attributes: { internal_memory_capacity: "128 GB", sim_lock: "Unlocked", status: "Very good", upload_date: "2 min ago" },
    photos: ["https://images1.vinted.net/t/1001/f800/a.webp"],
    sellerRating: 0.98,
    sellerFeedbackCount: 122,
    unavailable: false,
    uploadedText: "2 min ago",
    ...overrides,
  };
}
```

- [ ] **Step 2: Write the failing test**

`test/match.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { conditionBand, conditionFromLabel } from "../src/matching/conditions.js";
import { cardStageMatch, detailStageMatch, effectivePricePence, type MatchableSearch } from "../src/matching/match.js";
import { makeCard, makeDetail } from "./helpers/cards.js";

const search = (overrides: Partial<MatchableSearch> = {}): MatchableSearch => ({
  keywords: "iphone 15",
  maxPricePence: 30000,
  minPricePence: null,
  conditions: [],
  excludeWords: [],
  matchMode: "strict",
  ...overrides,
});

describe("conditions", () => {
  it("maps UK labels to codes and bands", () => {
    expect(conditionFromLabel("Very good")).toBe("very_good");
    expect(conditionFromLabel(" new WITH tags ")).toBe("new_with_tags");
    expect(conditionFromLabel("M")).toBe("unknown");
    expect(conditionFromLabel(null)).toBe("unknown");
    expect(conditionBand("good")).toBe("good");
    expect(conditionBand("satisfactory")).toBe("worn");
    expect(conditionBand("not_fully_functional")).toBe("faulty");
  });
});

describe("cardStageMatch", () => {
  it("passes a matching card", () => {
    expect(cardStageMatch(search(), makeCard())).toBe(true);
  });

  it("enforces fee-inclusive price bounds", () => {
    expect(cardStageMatch(search({ maxPricePence: 26319 }), makeCard())).toBe(false);
    expect(cardStageMatch(search({ maxPricePence: 26320 }), makeCard())).toBe(true);
    expect(cardStageMatch(search({ minPricePence: 26321 }), makeCard())).toBe(false);
  });

  it("falls back to the item price when the card has no total", () => {
    const card = makeCard({ pricePence: null, itemPricePence: 20000 });
    expect(effectivePricePence(card)).toBe(20000);
    expect(cardStageMatch(search({ maxPricePence: 20000 }), card)).toBe(true);
  });

  it("never matches a card with no price at all (Review Focus 3)", () => {
    expect(cardStageMatch(search(), makeCard({ pricePence: null, itemPricePence: null }))).toBe(false);
  });

  it("filters conditions; unknown passes only when no condition is chosen (Review Focus 3)", () => {
    expect(cardStageMatch(search({ conditions: ["good"] }), makeCard())).toBe(false);
    expect(cardStageMatch(search({ conditions: ["very_good", "good"] }), makeCard())).toBe(true);
    expect(cardStageMatch(search({ conditions: ["good"] }), makeCard({ condition: "unknown" }))).toBe(false);
    expect(cardStageMatch(search(), makeCard({ condition: "unknown" }))).toBe(true);
  });

  it("applies strict matching only in strict mode", () => {
    const handbag = makeCard({ title: "Juicy Couture pink handbag", brand: "Juicy Couture", model: null });
    expect(cardStageMatch(search(), handbag)).toBe(false);
    expect(cardStageMatch(search({ matchMode: "loose" }), handbag)).toBe(true);
  });

  it("uses brand and model in strict matching", () => {
    expect(cardStageMatch(search({ keywords: "apple iphone 15" }), makeCard({ title: "Phone 15 128GB", model: "iPhone 15" }))).toBe(true);
  });

  it("rejects exclude words found in the title", () => {
    expect(cardStageMatch(search({ excludeWords: ["box only"] }), makeCard({ title: "iPhone 15 box only" }))).toBe(false);
  });
});

describe("detailStageMatch", () => {
  it("passes a normal detail", () => {
    expect(detailStageMatch(search({ excludeWords: ["locked"] }), makeDetail())).toBe(true);
  });
  it("drops sold or reserved items", () => {
    expect(detailStageMatch(search(), makeDetail({ unavailable: true }))).toBe(false);
  });
  it("checks exclude words in description and attributes", () => {
    expect(detailStageMatch(search({ excludeWords: ["icloud"] }), makeDetail({ description: "iCloud locked" }))).toBe(false);
    expect(detailStageMatch(search({ excludeWords: ["network locked"] }), makeDetail({ attributes: { sim_lock: "Network locked" } }))).toBe(false);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run test/match.test.ts`
Expected: FAIL — cannot resolve `../src/matching/match.js`.

- [ ] **Step 4: Write the implementation**

`src/matching/match.ts`:

```ts
import type { CardListing, ItemDetail } from "../vinted/types.js";
import type { ConditionCode } from "./conditions.js";
import { containsPhrase, strictKeywordMatch } from "./normalize.js";

export interface MatchableSearch {
  keywords: string;
  maxPricePence: number;
  minPricePence: number | null;
  conditions: ConditionCode[];
  excludeWords: string[];
  matchMode: "strict" | "loose";
}

export function effectivePricePence(card: Pick<CardListing, "pricePence" | "itemPricePence">): number | null {
  return card.pricePence ?? card.itemPricePence;
}

/** Spec §6 card stage: price, condition, strict keywords, title exclusions. */
export function cardStageMatch(search: MatchableSearch, card: CardListing): boolean {
  const price = effectivePricePence(card);
  if (price === null) return false;
  if (price > search.maxPricePence) return false;
  if (search.minPricePence !== null && price < search.minPricePence) return false;
  if (search.conditions.length > 0 && !search.conditions.includes(card.condition)) return false;
  if (search.matchMode === "strict") {
    const text = [card.title, card.brand ?? "", card.model ?? ""].join(" ");
    if (!strictKeywordMatch(search.keywords, text)) return false;
  }
  return !search.excludeWords.some((word) => containsPhrase(card.title, word));
}

/** Spec §6 detail stage: availability and exclusions in description/attributes. */
export function detailStageMatch(search: MatchableSearch, detail: ItemDetail): boolean {
  if (detail.unavailable) return false;
  const text = [detail.description, ...Object.values(detail.attributes)].join("\n");
  return !search.excludeWords.some((word) => containsPhrase(text, word));
}
```

- [ ] **Step 5: Run tests and type-check**

Run: `npx vitest run test/match.test.ts && npm run typecheck`
Expected: PASS; no type errors.

- [ ] **Step 6: Commit**

```bash
git add src/matching/conditions.ts src/matching/match.ts src/vinted/types.ts test/helpers/cards.ts test/match.test.ts
git commit -m "feat: condition codes, Vinted listing types and two-stage matcher"
```

---

### Task 4: Vinted page parser and URLs

**Files:**
- Create: `src/vinted/parse.ts`, `src/vinted/url.ts`
- Test: `test/parse.test.ts`

**Interfaces:**
- Consumes: `CardListing`, `ItemDetail`, `CatalogPage` (Task 3), `conditionFromLabel` (Task 3).
- Produces:
  - `parseMoneyToPence(text?: string | null): number | null`
  - `decodeHtml(value: string): string`
  - `parseCatalogHtml(html: string, host: string): CatalogPage`
  - `parseItemHtml(html: string): ItemDetail | null`
  - `isChallengePage(html: string): boolean`
  - `catalogUrl(host: string, termKey: string, page?: number): string`

This ports `parseVintedCatalogHtml` / `parseVintedItemHtml` / `parseVintedMoney` from `~/fbm-sniper-community/lib/vinted-scraper.js`, with these changes: prices in pence, condition codes, `model` extracted, trailing price segments removed from the card title before reading labels, no seller names, and the empty-state/unrecognised distinction.

- [ ] **Step 1: Write the failing test**

`test/parse.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { catalogUrl } from "../src/vinted/url.js";
import { isChallengePage, parseCatalogHtml, parseItemHtml, parseMoneyToPence } from "../src/vinted/parse.js";

const HOST = "www.vinted.co.uk";

// Trimmed from a real www.vinted.co.uk catalog card (October 2026).
const card = (id: string, title: string, price: string, total: string) => `
<div class="ItemBox__container" data-testid="product-item-id-${id}">
  <div data-testid="product-item-id-${id}--image"><img src="https://images1.vinted.net/t/${id}/310x430/a.webp?s=1" alt="${title}" class="c" data-testid="product-item-id-${id}--image--img"/></div>
  <a href="/items/${id}-slug?referrer=catalog" class="overlay" data-testid="product-item-id-${id}--overlay-link" title="${title}" target="_self"><div></div></a>
  <button aria-pressed="false" aria-label="Add to favourites, favourited by 6 users" data-testid="product-item-id-${id}--favourite" type="button"></button>
  <p class="t" data-testid="product-item-id-${id}--description-title">Apple iPhone 15</p>
  <p class="t" data-testid="product-item-id-${id}--description-subtitle">Very good</p>
  <p class="t" data-testid="product-item-id-${id}--price-text">${price}</p>
  <div data-testid="product-item-id-${id}--breakdown"><button class="p" tabindex="0" aria-label="${total} includes Vinted fee" type="button"></button></div>
</div>`;

describe("parseMoneyToPence", () => {
  it("handles UK, EU and thousands formats", () => {
    expect(parseMoneyToPence("£1,234.50")).toBe(123450);
    expect(parseMoneyToPence("£5.00")).toBe(500);
    expect(parseMoneyToPence("5,00 €")).toBe(500);
    expect(parseMoneyToPence("1.234 Kč")).toBe(123400);
    expect(parseMoneyToPence("")).toBeNull();
    expect(parseMoneyToPence(undefined)).toBeNull();
  });
});

describe("parseCatalogHtml", () => {
  it("extracts cards with fee-inclusive price, model and condition code", () => {
    const html =
      card("111", "iPhone 15 256GB, with box, Brand: Apple, Model: iPhone 15, Condition: Very good, 350.00 £, 368.20 £", "£350.00", "£368.20") +
      card("222", "Phone case, Condition: New with tags, 1.50 £, 2.28 £", "£1.50", "£2.28");
    const page = parseCatalogHtml(html, HOST);
    expect(page.kind).toBe("ok");
    if (page.kind !== "ok") return;
    expect(page.cards).toHaveLength(2);
    expect(page.cards[0]).toEqual({
      vintedId: "111",
      title: "iPhone 15 256GB, with box",
      brand: "Apple",
      model: "iPhone 15",
      condition: "very_good",
      pricePence: 36820,
      itemPricePence: 35000,
      photoUrl: "https://images1.vinted.net/t/111/310x430/a.webp?s=1",
      url: "https://www.vinted.co.uk/items/111-slug",
    });
    expect(page.cards[1]?.title).toBe("Phone case");
    expect(page.cards[1]?.condition).toBe("new_with_tags");
    expect(page.cards[1]?.model).toBeNull();
  });

  it("keeps numeric titles and decodes entities", () => {
    const html = card("333", "Levi&#39;s 501 &amp; belt, Brand: Levi&#39;s, Condition: Good, 25.00 £, 26.95 £", "£25.00", "£26.95");
    const page = parseCatalogHtml(html, HOST);
    if (page.kind !== "ok") throw new Error("expected ok");
    expect(page.cards[0]?.title).toBe("Levi's 501 & belt");
    expect(page.cards[0]?.brand).toBe("Levi's");
  });

  it("does not mistake a storage size for a price", () => {
    const page = parseCatalogHtml(card("555", "iPhone 15, 128GB", "£250.00", "£263.20"), HOST);
    if (page.kind !== "ok") throw new Error("expected ok");
    expect(page.cards[0]?.title).toBe("iPhone 15, 128GB");
  });

  it("returns null total when the breakdown is missing", () => {
    const html = card("444", "Thing, Condition: Good, 10.00 £", "£10.00", "").replace(/<div data-testid="product-item-id-444--breakdown">.*?<\/div>/s, "");
    const page = parseCatalogHtml(html, HOST);
    if (page.kind !== "ok") throw new Error("expected ok");
    expect(page.cards[0]?.pricePence).toBeNull();
    expect(page.cards[0]?.itemPricePence).toBe(1000);
  });

  it("distinguishes the empty state from an unrecognised page", () => {
    expect(parseCatalogHtml('<div data-testid="search-empty-state"><h2>No results</h2></div>', HOST)).toEqual({ kind: "empty" });
    expect(parseCatalogHtml("<html><body>new layout</body></html>", HOST)).toEqual({ kind: "unrecognised" });
  });
});

describe("parseItemHtml", () => {
  it("reads description, attributes, seller rating, upload time and sold status", () => {
    const payload = JSON.stringify(
      `32:["$","$Ld8",null,{"plugins":[` +
        `{"data":{"item_id":"1","title":"Sold"},"name":"buyer_item_status"},` +
        `{"data":{"attributes":[{"code":"internal_memory_capacity","data":{"title":"Storage","value":"256 GB"}},{"code":"upload_date","data":{"title":"Uploaded","value":"2 min ago"}}]},"name":"attributes"},` +
        `{"data":{"description":"Battery 85%, no scratches"},"name":"description"},` +
        `{"data":{"feedback_count":122,"feedback_reputation":0.98,"name":"jade"},"name":"seller_info"}` +
        `]}]\n"photos":[{"url":"https://img/full.webp","thumbnails":[]}]`,
    );
    const detail = parseItemHtml(`<script>self.__next_f.push([1,${payload}])</script>`);
    expect(detail).toEqual({
      description: "Battery 85%, no scratches",
      attributes: { internal_memory_capacity: "256 GB", upload_date: "2 min ago" },
      photos: ["https://img/full.webp"],
      sellerRating: 0.98,
      sellerFeedbackCount: 122,
      unavailable: true,
      uploadedText: "2 min ago",
    });
    expect(JSON.stringify(detail)).not.toContain("jade");
  });

  it("returns null for an unrecognised page", () => {
    expect(parseItemHtml("<html></html>")).toBeNull();
  });
});

describe("isChallengePage (Review Focus 4)", () => {
  it("does not flag a normal page that mentions 'Just a moment'", () => {
    const normal =
      '<html><head><title>Items | Vinted</title><script src="/cdn-cgi/challenge-platform/scripts/jsd/main.js"></script></head>' +
      '<body>{"explanation":"Just a moment while we process your payment."}' +
      card("1", "Thing, Condition: Good, 1.00 £, 1.75 £", "£1.00", "£1.75") +
      "</body></html>";
    expect(isChallengePage(normal)).toBe(false);
  });
  it("flags a Cloudflare interstitial", () => {
    expect(isChallengePage("<html><head><title>Just a moment...</title></head><body></body></html>")).toBe(true);
    expect(isChallengePage('<script>window._cf_chl_opt={cvId:"3"}</script>')).toBe(true);
  });
});

describe("catalogUrl", () => {
  it("builds newest-first search URLs", () => {
    expect(catalogUrl(HOST, "iphone 15")).toBe("https://www.vinted.co.uk/catalog?search_text=iphone+15&order=newest_first");
    expect(catalogUrl(HOST, "iphone 15", 3)).toBe("https://www.vinted.co.uk/catalog?search_text=iphone+15&order=newest_first&page=3");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/parse.test.ts`
Expected: FAIL — cannot resolve `../src/vinted/url.js`.

- [ ] **Step 3: Write the implementation**

`src/vinted/url.ts`:

```ts
export function catalogUrl(host: string, termKey: string, page = 1): string {
  const params = new URLSearchParams({ search_text: termKey, order: "newest_first" });
  if (page > 1) params.set("page", String(page));
  return `https://${host}/catalog?${params.toString()}`;
}
```

`src/vinted/parse.ts`:

```ts
import { conditionFromLabel } from "../matching/conditions.js";
import type { CardListing, CatalogPage, ItemDetail } from "./types.js";

/** "£1,234.50", "1 234,50 €", "5,00 €", "1.234 Kč" → pence. */
export function parseMoneyToPence(text: string | null | undefined): number | null {
  const raw = String(text ?? "").replace(/[^\d.,]/g, "");
  if (!raw) return null;
  let normalised = raw;
  const lastComma = raw.lastIndexOf(",");
  const lastDot = raw.lastIndexOf(".");
  if (lastComma > -1 && lastDot > -1) {
    normalised = lastComma > lastDot ? raw.replace(/\./g, "").replace(",", ".") : raw.replace(/,/g, "");
  } else if (lastComma > -1) {
    normalised = /,\d{1,2}$/.test(raw) ? raw.replace(/\./g, "").replace(",", ".") : raw.replace(/,/g, "");
  } else if (lastDot > -1 && !/\.\d{1,2}$/.test(raw)) {
    normalised = raw.replace(/\./g, "");
  }
  const value = Number.parseFloat(normalised);
  return Number.isFinite(value) ? Math.round(value * 100) : null;
}

export function decodeHtml(value: string): string {
  return value
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec: string) => String.fromCodePoint(Number.parseInt(dec, 10)))
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

export function isChallengePage(html: string): boolean {
  return /<title>\s*just a moment/i.test(html) || /cf_chl_opt|cf-chl-/i.test(html);
}

/** "350.00 \u00a3", "\u00a35.00", "315,70 \u20ac" \u2014 needs a currency marker so "128GB" is not mistaken for a price. */
function isPriceLike(part: string): boolean {
  const trimmed = part.trim();
  return (
    /\d/.test(trimmed) &&
    /[\u00a3\u20ac$]|k\u010d|z\u0142|kr|lei|ft/i.test(trimmed) &&
    /^[^\d\s]{0,3}\s?[\d.,\s\u00a0\u202f]+\s?[^\d\s]{0,3}$/.test(trimmed)
  );
}

/**
 * The card link title reads "iPhone 15, Brand: Apple, Model: iPhone 15, Condition: Very good, 350.00 £, 368.20 £".
 * Trailing prices are removed first; the title is everything before the first "Label: value" part.
 */
function splitCardTitle(raw: string): { title: string; labelled: Record<string, string> } {
  const parts = raw.split(", ");
  let popped = 0;
  while (parts.length > 1 && popped < 2 && isPriceLike(parts[parts.length - 1] ?? "")) {
    parts.pop();
    popped += 1;
  }
  const titleParts: string[] = [];
  const labelled: Record<string, string> = {};
  for (const part of parts) {
    const label = /^([^:]{1,30}):\s*(.+)$/.exec(part);
    if (label?.[1] && label[2]) {
      labelled[label[1].trim().toLowerCase()] = label[2].trim();
      continue;
    }
    if (Object.keys(labelled).length === 0) titleParts.push(part);
  }
  return { title: titleParts.join(", ").trim(), labelled };
}

function tagWithTestId(segment: string, tag: string, testId: string): string | null {
  return new RegExp(`<${tag}\\b[^>]*data-testid="${testId}"[^>]*>`).exec(segment)?.[0] ?? null;
}

function attr(tag: string | null, name: string): string | null {
  if (!tag) return null;
  const value = new RegExp(`\\s${name}="([^"]*)"`).exec(tag)?.[1];
  return value === undefined ? null : decodeHtml(value);
}

function textOfTestId(segment: string, testId: string): string | null {
  const value = new RegExp(`data-testid="${testId}"[^>]*>([^<]*)<`).exec(segment)?.[1];
  const text = value === undefined ? "" : decodeHtml(value).trim();
  return text || null;
}

function parseCard(segment: string, id: string, host: string): CardListing {
  const linkTag = tagWithTestId(segment, "a", `product-item-id-${id}--overlay-link`);
  const href = attr(linkTag, "href") ?? `/items/${id}`;
  const { title, labelled } = splitCardTitle(attr(linkTag, "title") ?? "");
  const imgTag = tagWithTestId(segment, "img", `product-item-id-${id}--image--img`);
  const itemPricePence = parseMoneyToPence(textOfTestId(segment, `product-item-id-${id}--price-text`));

  // "£368.20 includes Vinted fee" — scoped to the breakdown block, because the
  // favourite button earlier in the card also carries an aria-label.
  const breakdownAt = segment.indexOf(`product-item-id-${id}--breakdown`);
  const totalLabel = breakdownAt > -1 ? /aria-label="([^"]*)"/.exec(segment.slice(breakdownAt))?.[1] : undefined;
  const totalAmount = totalLabel ? /\d[\d.,\s\u00a0\u202f]*\d|\d/.exec(decodeHtml(totalLabel))?.[0] : undefined;

  const brandText = textOfTestId(segment, `product-item-id-${id}--description-title`);
  const subtitle = textOfTestId(segment, `product-item-id-${id}--description-subtitle`);
  const url = new URL(href, `https://${host}`);
  url.search = "";
  url.hash = "";

  return {
    vintedId: id,
    title: title || brandText || "",
    brand: labelled["brand"] ?? brandText,
    model: labelled["model"] ?? null,
    condition: conditionFromLabel(labelled["condition"] ?? subtitle),
    pricePence: parseMoneyToPence(totalAmount),
    itemPricePence,
    photoUrl: attr(imgTag, "src"),
    url: url.toString(),
  };
}

export function parseCatalogHtml(html: string, host: string): CatalogPage {
  const starts = [...html.matchAll(/data-testid="product-item-id-(\d+)"/g)];
  if (starts.length === 0) {
    return html.includes('data-testid="search-empty-state"') ? { kind: "empty" } : { kind: "unrecognised" };
  }
  const cards: CardListing[] = [];
  const seen = new Set<string>();
  starts.forEach((match, index) => {
    const id = match[1];
    if (!id || seen.has(id)) return;
    seen.add(id);
    const start = match.index ?? 0;
    const end = starts[index + 1]?.index ?? html.length;
    cards.push(parseCard(html.slice(start, end), id, host));
  });
  return { kind: "ok", cards };
}

/** Concatenate Next.js RSC chunks: self.__next_f.push([1,"..."]). */
function extractRscText(html: string): string {
  let text = "";
  for (const match of html.matchAll(/self\.__next_f\.push\(\[1,"((?:[^"\\]|\\.)*)"\]\)/g)) {
    try {
      text += JSON.parse(`"${match[1] ?? ""}"`) as string;
    } catch {
      // skip a malformed chunk
    }
  }
  return text;
}

/** The JSON array/object starting at text[start], string-aware. */
function sliceBalancedJson(text: string, start: number): string | null {
  const open = text[start];
  const close = open === "[" ? "]" : "}";
  let depth = 0;
  let inString = false;
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i];
    if (inString) {
      if (ch === "\\") i += 1;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === open) depth += 1;
    else if (ch === close) {
      depth -= 1;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

function parseJsonAfter(text: string, key: string): unknown {
  const index = text.indexOf(key);
  if (index === -1) return null;
  const raw = sliceBalancedJson(text, index + key.length - 1);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
}

interface Plugin {
  name?: string;
  data?: Record<string, unknown>;
}

interface RawPhoto {
  full_size_url?: string;
  url?: string;
  thumbnails?: Array<{ url?: string; width?: number }>;
}

export function parseItemHtml(html: string): ItemDetail | null {
  const text = extractRscText(html);
  const plugins = parseJsonAfter(text, '"plugins":[');
  if (!Array.isArray(plugins)) return null;
  const list = plugins as Plugin[];
  const byName = new Map(list.map((plugin) => [plugin?.name ?? "", plugin?.data ?? {}]));

  const attributes: Record<string, string> = {};
  const rawAttributes = (byName.get("attributes")?.["attributes"] ?? []) as Array<{ code?: string; data?: { value?: unknown } }>;
  for (const attribute of rawAttributes) {
    if (attribute?.code && attribute.data?.value != null) attributes[attribute.code] = String(attribute.data.value);
  }

  const seller = list.find((plugin) => plugin?.data && "feedback_reputation" in plugin.data)?.data ?? {};
  const statusTitle = String(byName.get("buyer_item_status")?.["title"] ?? "");

  const photos: string[] = [];
  const rawPhotos = parseJsonAfter(text, '"photos":[');
  for (const photo of (Array.isArray(rawPhotos) ? rawPhotos : []) as RawPhoto[]) {
    const largestThumb = [...(photo?.thumbnails ?? [])].sort((a, b) => (b.width ?? 0) - (a.width ?? 0))[0]?.url;
    const best = photo?.full_size_url ?? photo?.url ?? largestThumb;
    if (best && !photos.includes(best)) photos.push(best);
  }

  const rating = seller["feedback_reputation"];
  const count = seller["feedback_count"];
  return {
    description: String(byName.get("description")?.["description"] ?? ""),
    attributes,
    photos,
    sellerRating: typeof rating === "number" ? rating : null,
    sellerFeedbackCount: typeof count === "number" ? count : null,
    unavailable: statusTitle !== "",
    uploadedText: attributes["upload_date"] ?? null,
  };
}
```

- [ ] **Step 4: Run tests and type-check**

Run: `npx vitest run test/parse.test.ts && npm run typecheck`
Expected: PASS; no type errors.

- [ ] **Step 5: Commit**

```bash
git add src/vinted/parse.ts src/vinted/url.ts test/parse.test.ts
git commit -m "feat: Vinted catalog/item parser with challenge and empty-state detection"
```

---

### Task 5: Real-page fixtures

**Files:**
- Create: `scripts/capture-fixtures.ts`, `test/fixtures/catalog-uk.html`, `test/fixtures/item-uk.html`, `test/fixtures/empty-uk.html` (generated)
- Test: `test/fixtures.test.ts`

**Interfaces:**
- Consumes: `catalogUrl`, `parseCatalogHtml`, `parseItemHtml`, `isChallengePage` (Task 4); `DEFAULT_USER_AGENT` (Task 1).
- Produces: committed fixture files used only by tests.

- [ ] **Step 1: Write the capture script**

`scripts/capture-fixtures.ts`:

```ts
import { mkdirSync, writeFileSync } from "node:fs";
import { DEFAULT_USER_AGENT } from "../src/config.js";
import { isChallengePage, parseCatalogHtml, parseItemHtml } from "../src/vinted/parse.js";
import { catalogUrl } from "../src/vinted/url.js";

const HOST = "www.vinted.co.uk";
const OUT = new URL("../test/fixtures/", import.meta.url);

async function get(url: string): Promise<string> {
  const res = await fetch(url, {
    headers: { "user-agent": DEFAULT_USER_AGENT, accept: "text/html", "accept-language": "en-GB,en;q=0.9" },
  });
  if (res.status !== 200) throw new Error(`${url} → HTTP ${res.status}`);
  return res.text();
}

/** Replace every seller login/username value found in the page with "redacted". */
function scrub(html: string): string {
  const names = new Set<string>();
  for (const match of html.matchAll(/\\?"(?:login|username)\\?"\s*:\s*\\?"([^"\\]+)/g)) {
    if (match[1]) names.add(match[1]);
  }
  let out = html;
  for (const name of names) out = out.split(name).join("redacted");
  return out;
}

function trimCatalog(html: string): string {
  const first = html.indexOf('data-testid="product-item-id-');
  const last = html.lastIndexOf('data-testid="product-item-id-');
  return `<html><head><title>Items | Vinted</title></head><body>${html.slice(Math.max(0, first - 500), last + 20000)}</body></html>`;
}

function trimItem(html: string): string {
  const chunks = [...html.matchAll(/self\.__next_f\.push\(\[1,"(?:[^"\\]|\\.)*"\]\)/g)]
    .map((match) => match[0])
    .filter((chunk) => chunk.includes("plugins") || chunk.includes("photos"));
  return `<html><head><title>Item | Vinted</title></head><body>${chunks.map((chunk) => `<script>${chunk}</script>`).join("\n")}</body></html>`;
}

function trimEmpty(html: string): string {
  const at = html.indexOf('data-testid="search-empty-state"');
  return `<html><head><title>Items | Vinted</title></head><body><div ${html.slice(at, at + 2000)}</body></html>`;
}

async function main(): Promise<void> {
  mkdirSync(OUT, { recursive: true });

  const catalog = await get(catalogUrl(HOST, "iphone 15"));
  if (isChallengePage(catalog)) throw new Error("live catalog page was detected as a challenge — fix isChallengePage first");
  const page = parseCatalogHtml(catalog, HOST);
  if (page.kind !== "ok" || page.cards.length < 90) throw new Error(`unexpected catalog parse: ${page.kind}`);
  writeFileSync(new URL("catalog-uk.html", OUT), scrub(trimCatalog(catalog)));

  const firstUrl = page.cards[0]?.url;
  if (!firstUrl) throw new Error("no card url");
  const item = await get(firstUrl);
  if (!parseItemHtml(item)) throw new Error("live item page did not parse");
  writeFileSync(new URL("item-uk.html", OUT), scrub(trimItem(item)));

  const empty = await get(catalogUrl(HOST, "zzqxjv nonexistent thing 9431"));
  if (parseCatalogHtml(empty, HOST).kind !== "empty") throw new Error("empty search not recognised");
  writeFileSync(new URL("empty-uk.html", OUT), trimEmpty(empty));

  console.log(`Saved fixtures: ${page.cards.length} cards; item ${firstUrl}`);
}

await main();
```

- [ ] **Step 2: Capture the fixtures**

Run: `npm run capture-fixtures`
Expected: prints `Saved fixtures: 96 cards; item https://www.vinted.co.uk/items/…`. Then check sizes and the scrub:

Run: `ls -lh test/fixtures && grep -c redacted test/fixtures/item-uk.html`
Expected: three files; catalog under ~1 MB; item file contains at least 1 `redacted`.

- [ ] **Step 3: Write the fixture test**

`test/fixtures.test.ts`:

```ts
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { isChallengePage, parseCatalogHtml, parseItemHtml } from "../src/vinted/parse.js";

const HOST = "www.vinted.co.uk";
const read = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");

describe("real Vinted UK pages", () => {
  it("parses a real catalog page", () => {
    const html = read("catalog-uk.html");
    expect(isChallengePage(html)).toBe(false);
    const page = parseCatalogHtml(html, HOST);
    expect(page.kind).toBe("ok");
    if (page.kind !== "ok") return;
    expect(page.cards.length).toBeGreaterThanOrEqual(90);
    for (const card of page.cards) {
      expect(card.vintedId).toMatch(/^\d+$/);
      expect(card.url.startsWith(`https://${HOST}/items/`)).toBe(true);
      expect(card.title.length).toBeGreaterThan(0);
    }
    const priced = page.cards.filter((card) => card.pricePence !== null && card.itemPricePence !== null);
    expect(priced.length / page.cards.length).toBeGreaterThanOrEqual(0.9);
    expect(priced.every((card) => (card.pricePence ?? 0) >= (card.itemPricePence ?? 0))).toBe(true);
    expect(page.cards.some((card) => card.model !== null)).toBe(true);
    expect(page.cards.some((card) => card.condition !== "unknown")).toBe(true);
  });

  it("parses a real item page", () => {
    const detail = parseItemHtml(read("item-uk.html"));
    expect(detail).not.toBeNull();
    expect(typeof detail?.description).toBe("string");
    expect(detail?.photos.length).toBeGreaterThanOrEqual(1);
    expect(Object.keys(detail?.attributes ?? {}).length).toBeGreaterThanOrEqual(1);
  });

  it("recognises a real empty search", () => {
    expect(parseCatalogHtml(read("empty-uk.html"), HOST)).toEqual({ kind: "empty" });
  });
});
```

- [ ] **Step 4: Run the test**

Run: `npx vitest run test/fixtures.test.ts`
Expected: 3 tests PASS. If the catalog assertions fail, Vinted's markup has drifted from Task 4's synthetic card — update `parseCard` against the fixture, keep Task 4's tests green, and re-run.

- [ ] **Step 5: Commit**

```bash
git add scripts/capture-fixtures.ts test/fixtures test/fixtures.test.ts
git commit -m "test: scrubbed real Vinted UK fixtures and parser regression tests"
```

---

### Task 6: Deal insight — comparison groups and statistics

**Files:**
- Create: `src/insight/groups.ts`, `src/insight/stats.ts`
- Test: `test/insight.test.ts`

**Interfaces:**
- Consumes: `normalizeText` (Task 2), `conditionBand`, `ConditionCode` (Task 3).
- Produces:
  - `storageFromText(text?: string | null): string | null`
  - `interface Group { groupKey: string; modelKnown: boolean }`
  - `groupFor(termKey: string, card: { title: string; model: string | null; condition: ConditionCode }, detailStorage?: string | null): Group`
  - `type Insight = { kind: "median"; n; medianPence; diffPence; percentile } | { kind: "rough"; n; percentile } | { kind: "insufficient"; n }`
  - `MIN_SAMPLE = 10`, `median(values: number[]): number`, `computeInsight(pricePence: number, comparable: number[], modelKnown: boolean): Insight`

- [ ] **Step 1: Write the failing test**

`test/insight.test.ts`:

```ts
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/insight.test.ts`
Expected: FAIL — cannot resolve `../src/insight/groups.js`.

- [ ] **Step 3: Write the implementation**

`src/insight/groups.ts`:

```ts
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
```

`src/insight/stats.ts`:

```ts
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
```

- [ ] **Step 4: Run tests and type-check**

Run: `npx vitest run test/insight.test.ts && npm run typecheck`
Expected: PASS; no type errors.

- [ ] **Step 5: Commit**

```bash
git add src/insight test/insight.test.ts
git commit -m "feat: comparison groups and price insight statistics"
```

---
### Task 7: Database core — schema, users, invites, meta, wizard state

**Files:**
- Create: `src/db/schema.ts`, `src/db/database.ts`, `src/db/users.ts`, `src/db/meta.ts`, `test/helpers/db.ts`
- Test: `test/db-users.test.ts`

**Interfaces:**
- Produces:
  - `type Db` (better-sqlite3 `Database`), `openDatabase(path: string): Db`, `migrate(db: Db): void`
  - `type UserStatus = "waitlist" | "beta" | "admin"`, `interface User { telegramId; username: string | null; firstName: string | null; status; searchLimit; botBlocked: boolean; createdAt }`, `interface UserProfile { telegramId; username: string | null; firstName: string | null }`
  - `getUser(db, telegramId): User | undefined`, `createUser(db, profile, status, searchLimit, now): User`, `touchUserProfile(db, profile): void`, `setUserStatus(db, telegramId, status): void`, `setBotBlocked(db, telegramId, blocked: boolean): void`, `waitlistPosition(db, telegramId): number`, `listWaitlist(db, limit): User[]`, `countUsersByStatus(db): Record<UserStatus, number>`, `deleteUserData(db, telegramId): void`, `createInvites(db, createdBy, count, now): string[]`, `redeemInvite(db, code, telegramId, now): boolean`
  - `getMeta(db, key): string | undefined`, `setMeta(db, key, value): void`, `getWizardState<T>(db, telegramId, now, ttlMs): T | undefined`, `saveWizardState(db, telegramId, state: unknown, now): void`, `clearWizardState(db, telegramId): void`
  - test helpers `memoryDb(): Db`, `seedUser(db, telegramId?, status?, now?): User`

- [ ] **Step 1: Write the schema and database module**

`src/db/schema.ts`:

```ts
export const SCHEMA_V1 = `
CREATE TABLE users (
  telegram_id   INTEGER PRIMARY KEY,
  username      TEXT,
  first_name    TEXT,
  status        TEXT NOT NULL CHECK (status IN ('waitlist','beta','admin')),
  search_limit  INTEGER NOT NULL DEFAULT 5,
  bot_blocked   INTEGER NOT NULL DEFAULT 0,
  created_at    INTEGER NOT NULL
);

CREATE TABLE invites (
  code        TEXT PRIMARY KEY,
  created_by  INTEGER NOT NULL,
  created_at  INTEGER NOT NULL,
  used_by     INTEGER,
  used_at     INTEGER
);

CREATE TABLE searches (
  id            INTEGER PRIMARY KEY,
  user_id       INTEGER NOT NULL REFERENCES users(telegram_id),
  keywords      TEXT NOT NULL,
  term_key      TEXT NOT NULL,
  max_price_p   INTEGER NOT NULL,
  min_price_p   INTEGER,
  conditions    TEXT NOT NULL,
  exclude_words TEXT NOT NULL,
  match_mode    TEXT NOT NULL CHECK (match_mode IN ('strict','loose')),
  status        TEXT NOT NULL CHECK (status IN ('active','paused')),
  active_since  INTEGER NOT NULL,
  created_at    INTEGER NOT NULL
);
CREATE INDEX searches_term ON searches(term_key, status);
CREATE INDEX searches_user ON searches(user_id);

CREATE TABLE terms (
  term_key        TEXT PRIMARY KEY,
  baseline_at     INTEGER,
  warmed_up_at    INTEGER,
  last_polled_at  INTEGER,
  last_success_at INTEGER,
  had_results     INTEGER NOT NULL DEFAULT 0,
  empty_streak    INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE term_items (
  term_key      TEXT NOT NULL,
  vinted_id     TEXT NOT NULL,
  first_seen_at INTEGER NOT NULL,
  last_seen_at  INTEGER NOT NULL,
  PRIMARY KEY (term_key, vinted_id)
);
CREATE INDEX term_items_last_seen ON term_items(last_seen_at);

CREATE TABLE items (
  vinted_id         TEXT PRIMARY KEY,
  title             TEXT NOT NULL,
  brand             TEXT,
  model             TEXT,
  condition         TEXT NOT NULL,
  price_p           INTEGER,
  item_price_p      INTEGER,
  photo_url         TEXT,
  url               TEXT NOT NULL,
  card_seen_at      INTEGER NOT NULL,
  detail_json       TEXT,
  detail_fetched_at INTEGER
);
CREATE INDEX items_card_seen ON items(card_seen_at);

CREATE TABLE price_observations (
  vinted_id         TEXT PRIMARY KEY,
  group_key         TEXT NOT NULL,
  model_known       INTEGER NOT NULL,
  price_p           INTEGER NOT NULL,
  first_observed_at INTEGER NOT NULL,
  observed_at       INTEGER NOT NULL
);
CREATE INDEX price_obs_group ON price_observations(group_key, observed_at);

CREATE TABLE alerts (
  id                  INTEGER PRIMARY KEY,
  search_id           INTEGER NOT NULL REFERENCES searches(id),
  vinted_id           TEXT NOT NULL,
  status              TEXT NOT NULL CHECK (status IN ('pending','sent','digested','digest_sent','dropped','failed')),
  insight_json        TEXT,
  details_unavailable INTEGER NOT NULL DEFAULT 0,
  created_at          INTEGER NOT NULL,
  sent_at             INTEGER,
  UNIQUE (search_id, vinted_id)
);
CREATE INDEX alerts_status ON alerts(status, created_at);
CREATE INDEX alerts_search_sent ON alerts(search_id, sent_at);

CREATE TABLE wizard_state (
  telegram_id INTEGER PRIMARY KEY,
  state_json  TEXT NOT NULL,
  updated_at  INTEGER NOT NULL
);

CREATE TABLE meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;
```

`src/db/database.ts`:

```ts
import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { SCHEMA_V1 } from "./schema.js";

export type Db = Database.Database;

export function migrate(db: Db): void {
  const version = db.pragma("user_version", { simple: true }) as number;
  if (version < 1) {
    db.exec(SCHEMA_V1);
    db.pragma("user_version = 1");
  }
}

export function openDatabase(path: string): Db {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  migrate(db);
  return db;
}
```

- [ ] **Step 2: Write the failing test**

`test/helpers/db.ts`:

```ts
import { openDatabase, type Db } from "../../src/db/database.js";
import { createUser, type User, type UserStatus } from "../../src/db/users.js";

export function memoryDb(): Db {
  return openDatabase(":memory:");
}

export function seedUser(db: Db, telegramId = 111, status: UserStatus = "beta", now = 0): User {
  return createUser(db, { telegramId, username: `user${telegramId}`, firstName: "Test" }, status, 5, now);
}
```

`test/db-users.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { migrate } from "../src/db/database.js";
import { clearWizardState, getMeta, getWizardState, saveWizardState, setMeta } from "../src/db/meta.js";
import {
  countUsersByStatus,
  createInvites,
  deleteUserData,
  getUser,
  listWaitlist,
  redeemInvite,
  setBotBlocked,
  setUserStatus,
  touchUserProfile,
  waitlistPosition,
} from "../src/db/users.js";
import { memoryDb, seedUser } from "./helpers/db.js";

describe("database", () => {
  it("migrates idempotently", () => {
    const db = memoryDb();
    expect(() => migrate(db)).not.toThrow();
    expect(db.pragma("user_version", { simple: true })).toBe(1);
  });
});

describe("users", () => {
  it("creates, reads and updates users", () => {
    const db = memoryDb();
    seedUser(db, 7, "waitlist", 100);
    expect(getUser(db, 7)).toEqual({ telegramId: 7, username: "user7", firstName: "Test", status: "waitlist", searchLimit: 5, botBlocked: false, createdAt: 100 });
    setBotBlocked(db, 7, true);
    expect(getUser(db, 7)?.botBlocked).toBe(true);
    touchUserProfile(db, { telegramId: 7, username: "renamed", firstName: "New" });
    expect(getUser(db, 7)).toMatchObject({ username: "renamed", firstName: "New", botBlocked: false });
    setUserStatus(db, 7, "beta");
    expect(getUser(db, 7)?.status).toBe("beta");
    expect(getUser(db, 999)).toBeUndefined();
  });

  it("numbers the waitlist in join order and lists newest first", () => {
    const db = memoryDb();
    seedUser(db, 1, "waitlist", 10);
    seedUser(db, 2, "beta", 15);
    seedUser(db, 3, "waitlist", 20);
    seedUser(db, 4, "waitlist", 30);
    expect([1, 3, 4].map((id) => waitlistPosition(db, id))).toEqual([1, 2, 3]);
    expect(listWaitlist(db, 2).map((u) => u.telegramId)).toEqual([4, 3]);
    expect(countUsersByStatus(db)).toEqual({ waitlist: 3, beta: 1, admin: 0 });
  });
});

describe("invites", () => {
  it("creates unique codes that redeem exactly once", () => {
    const db = memoryDb();
    const codes = createInvites(db, 42, 3, 0);
    expect(codes).toHaveLength(3);
    expect(new Set(codes).size).toBe(3);
    for (const code of codes) expect(code).toMatch(/^[A-Za-z0-9_-]{8}$/);
    expect(redeemInvite(db, codes[0]!, 7, 1)).toBe(true);
    expect(redeemInvite(db, codes[0]!, 8, 2)).toBe(false);
    expect(redeemInvite(db, "nope", 8, 2)).toBe(false);
  });
});

describe("deleteUserData", () => {
  it("removes searches, alerts, wizard state and the user, and anonymises invites", () => {
    const db = memoryDb();
    seedUser(db, 111);
    const [code] = createInvites(db, 42, 1, 0);
    redeemInvite(db, code!, 111, 1);
    db.prepare(
      "INSERT INTO searches (id,user_id,keywords,term_key,max_price_p,min_price_p,conditions,exclude_words,match_mode,status,active_since,created_at) VALUES (1,111,'x','x',100,NULL,'[]','[]','strict','active',0,0)",
    ).run();
    db.prepare("INSERT INTO alerts (search_id,vinted_id,status,created_at) VALUES (1,'9','pending',0)").run();
    saveWizardState(db, 111, { step: "keywords" }, 0);

    deleteUserData(db, 111);

    expect(getUser(db, 111)).toBeUndefined();
    expect(db.prepare("SELECT COUNT(*) AS n FROM searches").get()).toEqual({ n: 0 });
    expect(db.prepare("SELECT COUNT(*) AS n FROM alerts").get()).toEqual({ n: 0 });
    expect(db.prepare("SELECT COUNT(*) AS n FROM wizard_state").get()).toEqual({ n: 0 });
    expect(db.prepare("SELECT used_by FROM invites").get()).toEqual({ used_by: null });
    expect(redeemInvite(db, code!, 222, 2)).toBe(false);
  });
});

describe("meta and wizard state", () => {
  it("stores key/values", () => {
    const db = memoryDb();
    expect(getMeta(db, "started_at")).toBeUndefined();
    setMeta(db, "started_at", "5");
    setMeta(db, "started_at", "6");
    expect(getMeta(db, "started_at")).toBe("6");
  });

  it("expires wizard state after the TTL", () => {
    const db = memoryDb();
    saveWizardState(db, 1, { step: "maxPrice" }, 1_000);
    expect(getWizardState(db, 1, 2_000, 3_600_000)).toEqual({ step: "maxPrice" });
    expect(getWizardState(db, 1, 1_000 + 3_600_001, 3_600_000)).toBeUndefined();
    saveWizardState(db, 1, { step: "keywords" }, 0);
    clearWizardState(db, 1);
    expect(getWizardState(db, 1, 0, 3_600_000)).toBeUndefined();
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run test/db-users.test.ts`
Expected: FAIL — cannot resolve `../src/db/users.js`.

- [ ] **Step 4: Write the implementation**

`src/db/users.ts`:

```ts
import { randomBytes } from "node:crypto";
import type { Db } from "./database.js";

export type UserStatus = "waitlist" | "beta" | "admin";

export interface User {
  telegramId: number;
  username: string | null;
  firstName: string | null;
  status: UserStatus;
  searchLimit: number;
  botBlocked: boolean;
  createdAt: number;
}

export interface UserProfile {
  telegramId: number;
  username: string | null;
  firstName: string | null;
}

interface UserRow {
  telegram_id: number;
  username: string | null;
  first_name: string | null;
  status: UserStatus;
  search_limit: number;
  bot_blocked: number;
  created_at: number;
}

const toUser = (row: UserRow): User => ({
  telegramId: row.telegram_id,
  username: row.username,
  firstName: row.first_name,
  status: row.status,
  searchLimit: row.search_limit,
  botBlocked: row.bot_blocked === 1,
  createdAt: row.created_at,
});

export function getUser(db: Db, telegramId: number): User | undefined {
  const row = db.prepare("SELECT * FROM users WHERE telegram_id = ?").get(telegramId) as UserRow | undefined;
  return row ? toUser(row) : undefined;
}

export function createUser(db: Db, profile: UserProfile, status: UserStatus, searchLimit: number, now: number): User {
  db.prepare(
    "INSERT INTO users (telegram_id, username, first_name, status, search_limit, bot_blocked, created_at) VALUES (?, ?, ?, ?, ?, 0, ?)",
  ).run(profile.telegramId, profile.username, profile.firstName, status, searchLimit, now);
  return getUser(db, profile.telegramId)!;
}

/** Called whenever a user messages the bot: refresh their name and clear the blocked flag. */
export function touchUserProfile(db: Db, profile: UserProfile): void {
  db.prepare("UPDATE users SET username = ?, first_name = ?, bot_blocked = 0 WHERE telegram_id = ?").run(
    profile.username,
    profile.firstName,
    profile.telegramId,
  );
}

export function setUserStatus(db: Db, telegramId: number, status: UserStatus): void {
  db.prepare("UPDATE users SET status = ? WHERE telegram_id = ?").run(status, telegramId);
}

export function setBotBlocked(db: Db, telegramId: number, blocked: boolean): void {
  db.prepare("UPDATE users SET bot_blocked = ? WHERE telegram_id = ?").run(blocked ? 1 : 0, telegramId);
}

export function waitlistPosition(db: Db, telegramId: number): number {
  const row = db
    .prepare(
      "SELECT COUNT(*) AS n FROM users WHERE status = 'waitlist' AND created_at <= (SELECT created_at FROM users WHERE telegram_id = ?)",
    )
    .get(telegramId) as { n: number };
  return row.n;
}

export function listWaitlist(db: Db, limit: number): User[] {
  const rows = db.prepare("SELECT * FROM users WHERE status = 'waitlist' ORDER BY created_at DESC LIMIT ?").all(limit) as UserRow[];
  return rows.map(toUser);
}

export function countUsersByStatus(db: Db): Record<UserStatus, number> {
  const counts: Record<UserStatus, number> = { waitlist: 0, beta: 0, admin: 0 };
  const rows = db.prepare("SELECT status, COUNT(*) AS n FROM users GROUP BY status").all() as Array<{ status: UserStatus; n: number }>;
  for (const row of rows) counts[row.status] = row.n;
  return counts;
}

/** /deleteme: remove everything about a user; invites they used stay consumed but anonymous. */
export function deleteUserData(db: Db, telegramId: number): void {
  db.transaction((id: number) => {
    db.prepare("DELETE FROM alerts WHERE search_id IN (SELECT id FROM searches WHERE user_id = ?)").run(id);
    db.prepare("DELETE FROM searches WHERE user_id = ?").run(id);
    db.prepare("DELETE FROM wizard_state WHERE telegram_id = ?").run(id);
    db.prepare("UPDATE invites SET used_by = NULL WHERE used_by = ?").run(id);
    db.prepare("DELETE FROM users WHERE telegram_id = ?").run(id);
  })(telegramId);
}

export function createInvites(db: Db, createdBy: number, count: number, now: number): string[] {
  const insert = db.prepare("INSERT INTO invites (code, created_by, created_at) VALUES (?, ?, ?)");
  const codes: string[] = [];
  db.transaction(() => {
    while (codes.length < count) {
      const code = randomBytes(6).toString("base64url");
      if (insert.run(code, createdBy, now).changes === 1) codes.push(code);
    }
  })();
  return codes;
}

/** Atomically consume an unused invite. */
export function redeemInvite(db: Db, code: string, telegramId: number, now: number): boolean {
  const result = db.prepare("UPDATE invites SET used_by = ?, used_at = ? WHERE code = ? AND used_at IS NULL").run(telegramId, now, code);
  return result.changes === 1;
}
```

`src/db/meta.ts`:

```ts
import type { Db } from "./database.js";

export function getMeta(db: Db, key: string): string | undefined {
  const row = db.prepare("SELECT value FROM meta WHERE key = ?").get(key) as { value: string } | undefined;
  return row?.value;
}

export function setMeta(db: Db, key: string, value: string): void {
  db.prepare("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, value);
}

export function getWizardState<T>(db: Db, telegramId: number, now: number, ttlMs: number): T | undefined {
  const row = db.prepare("SELECT state_json, updated_at FROM wizard_state WHERE telegram_id = ?").get(telegramId) as
    | { state_json: string; updated_at: number }
    | undefined;
  if (!row) return undefined;
  if (now - row.updated_at > ttlMs) {
    clearWizardState(db, telegramId);
    return undefined;
  }
  return JSON.parse(row.state_json) as T;
}

export function saveWizardState(db: Db, telegramId: number, state: unknown, now: number): void {
  db.prepare(
    "INSERT INTO wizard_state (telegram_id, state_json, updated_at) VALUES (?, ?, ?) ON CONFLICT(telegram_id) DO UPDATE SET state_json = excluded.state_json, updated_at = excluded.updated_at",
  ).run(telegramId, JSON.stringify(state), now);
}

export function clearWizardState(db: Db, telegramId: number): void {
  db.prepare("DELETE FROM wizard_state WHERE telegram_id = ?").run(telegramId);
}
```

- [ ] **Step 5: Run tests and type-check**

Run: `npx vitest run test/db-users.test.ts && npm run typecheck`
Expected: PASS; no type errors.

- [ ] **Step 6: Commit**

```bash
git add src/db/schema.ts src/db/database.ts src/db/users.ts src/db/meta.ts test/helpers/db.ts test/db-users.test.ts
git commit -m "feat: SQLite schema, users, invites, meta and wizard state"
```

---

### Task 8: Database — searches and terms

**Files:**
- Create: `src/db/searches.ts`, `src/db/terms.ts`
- Modify: `test/helpers/db.ts` (add `seedSearch`)
- Test: `test/db-searches.test.ts`

**Interfaces:**
- Consumes: `Db`, `createUser` (Task 7); `toTermKey` (Task 2); `MatchableSearch` (Task 3); `ConditionCode` (Task 3).
- Produces:
  - `type MatchMode = "strict" | "loose"`, `type SearchStatus = "active" | "paused"`
  - `interface Search extends MatchableSearch { id; userId; termKey; status: SearchStatus; activeSince; createdAt }`
  - `interface NewSearch { userId; keywords; maxPricePence; minPricePence: number | null; conditions: ConditionCode[]; excludeWords: string[]; matchMode: MatchMode }`
  - `createSearch(db, input: NewSearch, now): Search`, `getSearch(db, id): Search | undefined`, `listSearchesByUser(db, userId): Search[]`, `countSearchesByUser(db, userId): number`, `setSearchStatus(db, id, status, now): void`, `deleteSearch(db, id): void`, `activeSearchesForTerm(db, termKey): Search[]`, `pauseAllSearchesForUser(db, userId): void`, `countActiveSearches(db): number`
  - `interface Term { termKey; baselineAt: number | null; warmedUpAt: number | null; lastPolledAt: number | null; lastSuccessAt: number | null; hadResults: boolean; emptyStreak: number }`
  - `ensureTerm(db, termKey): void`, `getTerm(db, termKey): Term | undefined`, `listActiveTerms(db): Term[]`, `markPolled(db, termKey, now): void`, `markSuccess(db, termKey, now, hadCards: boolean): void`, `bumpEmptyStreak(db, termKey): number`, `setBaseline(db, termKey, now): void`, `setWarmedUp(db, termKey, now): void`, `deleteIdleTerms(db): number`
  - test helper `seedSearch(db, overrides?: Partial<NewSearch>, now?): Search`

- [ ] **Step 1: Extend the test helper**

Replace `test/helpers/db.ts` with:

```ts
import { openDatabase, type Db } from "../../src/db/database.js";
import { createSearch, type NewSearch, type Search } from "../../src/db/searches.js";
import { createUser, type User, type UserStatus } from "../../src/db/users.js";

export function memoryDb(): Db {
  return openDatabase(":memory:");
}

export function seedUser(db: Db, telegramId = 111, status: UserStatus = "beta", now = 0): User {
  return createUser(db, { telegramId, username: `user${telegramId}`, firstName: "Test" }, status, 5, now);
}

export function seedSearch(db: Db, overrides: Partial<NewSearch> = {}, now = 1_000): Search {
  return createSearch(
    db,
    {
      userId: 111,
      keywords: "iphone 15",
      maxPricePence: 30000,
      minPricePence: null,
      conditions: [],
      excludeWords: [],
      matchMode: "strict",
      ...overrides,
    },
    now,
  );
}
```

- [ ] **Step 2: Write the failing test**

`test/db-searches.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  activeSearchesForTerm,
  countActiveSearches,
  countSearchesByUser,
  deleteSearch,
  getSearch,
  listSearchesByUser,
  pauseAllSearchesForUser,
  setSearchStatus,
} from "../src/db/searches.js";
import {
  bumpEmptyStreak,
  deleteIdleTerms,
  getTerm,
  listActiveTerms,
  markPolled,
  markSuccess,
  setBaseline,
  setWarmedUp,
} from "../src/db/terms.js";
import { memoryDb, seedSearch, seedUser } from "./helpers/db.js";

describe("searches", () => {
  it("creates a search with a normalised term key and a term row", () => {
    const db = memoryDb();
    seedUser(db);
    const search = seedSearch(db, { keywords: "  iPhone 15 🔥 ", conditions: ["very_good"], excludeWords: ["icloud"] }, 500);
    expect(search).toEqual({
      id: search.id,
      userId: 111,
      keywords: "  iPhone 15 🔥 ",
      termKey: "iphone 15",
      maxPricePence: 30000,
      minPricePence: null,
      conditions: ["very_good"],
      excludeWords: ["icloud"],
      matchMode: "strict",
      status: "active",
      activeSince: 500,
      createdAt: 500,
    });
    expect(getTerm(db, "iphone 15")?.baselineAt).toBeNull();
  });

  it("lists, counts, pauses, resumes and deletes", () => {
    const db = memoryDb();
    seedUser(db);
    const a = seedSearch(db, { keywords: "iphone 15" }, 1);
    const b = seedSearch(db, { keywords: "ps5" }, 2);
    expect(listSearchesByUser(db, 111).map((s) => s.id)).toEqual([a.id, b.id]);
    expect(countSearchesByUser(db, 111)).toBe(2);

    setSearchStatus(db, a.id, "paused", 10);
    expect(getSearch(db, a.id)?.status).toBe("paused");
    expect(countActiveSearches(db)).toBe(1);
    setSearchStatus(db, a.id, "active", 20);
    expect(getSearch(db, a.id)).toMatchObject({ status: "active", activeSince: 20 });

    db.prepare("INSERT INTO alerts (search_id, vinted_id, status, created_at) VALUES (?, '1', 'pending', 0)").run(b.id);
    deleteSearch(db, b.id);
    expect(getSearch(db, b.id)).toBeUndefined();
    expect(db.prepare("SELECT COUNT(*) AS n FROM alerts").get()).toEqual({ n: 0 });
  });

  it("finds active searches for a term and pauses all of a user's searches", () => {
    const db = memoryDb();
    seedUser(db, 111);
    seedUser(db, 222);
    seedSearch(db, { userId: 111 });
    seedSearch(db, { userId: 222 });
    seedSearch(db, { userId: 222, keywords: "ps5" });
    expect(activeSearchesForTerm(db, "iphone 15")).toHaveLength(2);
    pauseAllSearchesForUser(db, 222);
    expect(activeSearchesForTerm(db, "iphone 15").map((s) => s.userId)).toEqual([111]);
  });
});

describe("terms", () => {
  it("lists only terms with active searches", () => {
    const db = memoryDb();
    seedUser(db);
    const a = seedSearch(db, { keywords: "iphone 15" });
    seedSearch(db, { keywords: "ps5" });
    setSearchStatus(db, a.id, "paused", 5);
    expect(listActiveTerms(db).map((t) => t.termKey)).toEqual(["ps5"]);
    expect(deleteIdleTerms(db)).toBe(1);
    expect(getTerm(db, "iphone 15")).toBeUndefined();
    setSearchStatus(db, a.id, "active", 6);
    expect(getTerm(db, "iphone 15")).toBeDefined();
  });

  it("tracks polling state", () => {
    const db = memoryDb();
    seedUser(db);
    seedSearch(db);
    markPolled(db, "iphone 15", 100);
    expect(bumpEmptyStreak(db, "iphone 15")).toBe(1);
    expect(bumpEmptyStreak(db, "iphone 15")).toBe(2);
    markSuccess(db, "iphone 15", 200, false);
    expect(getTerm(db, "iphone 15")).toMatchObject({ lastPolledAt: 100, lastSuccessAt: 200, hadResults: false, emptyStreak: 0 });
    markSuccess(db, "iphone 15", 300, true);
    markSuccess(db, "iphone 15", 400, false);
    expect(getTerm(db, "iphone 15")?.hadResults).toBe(true);
    setBaseline(db, "iphone 15", 500);
    setWarmedUp(db, "iphone 15", 600);
    expect(getTerm(db, "iphone 15")).toMatchObject({ baselineAt: 500, warmedUpAt: 600 });
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run test/db-searches.test.ts`
Expected: FAIL — cannot resolve `../src/db/searches.js`.

- [ ] **Step 4: Write the implementation**

`src/db/terms.ts`:

```ts
import type { Db } from "./database.js";

export interface Term {
  termKey: string;
  baselineAt: number | null;
  warmedUpAt: number | null;
  lastPolledAt: number | null;
  lastSuccessAt: number | null;
  hadResults: boolean;
  emptyStreak: number;
}

interface TermRow {
  term_key: string;
  baseline_at: number | null;
  warmed_up_at: number | null;
  last_polled_at: number | null;
  last_success_at: number | null;
  had_results: number;
  empty_streak: number;
}

const toTerm = (row: TermRow): Term => ({
  termKey: row.term_key,
  baselineAt: row.baseline_at,
  warmedUpAt: row.warmed_up_at,
  lastPolledAt: row.last_polled_at,
  lastSuccessAt: row.last_success_at,
  hadResults: row.had_results === 1,
  emptyStreak: row.empty_streak,
});

export function ensureTerm(db: Db, termKey: string): void {
  db.prepare("INSERT OR IGNORE INTO terms (term_key) VALUES (?)").run(termKey);
}

export function getTerm(db: Db, termKey: string): Term | undefined {
  const row = db.prepare("SELECT * FROM terms WHERE term_key = ?").get(termKey) as TermRow | undefined;
  return row ? toTerm(row) : undefined;
}

export function listActiveTerms(db: Db): Term[] {
  const rows = db
    .prepare(
      "SELECT t.* FROM terms t WHERE EXISTS (SELECT 1 FROM searches s WHERE s.term_key = t.term_key AND s.status = 'active') ORDER BY t.term_key",
    )
    .all() as TermRow[];
  return rows.map(toTerm);
}

export function markPolled(db: Db, termKey: string, now: number): void {
  db.prepare("UPDATE terms SET last_polled_at = ? WHERE term_key = ?").run(now, termKey);
}

/** A recognised result (cards or the empty state): reset the layout-alarm streak. */
export function markSuccess(db: Db, termKey: string, now: number, hadCards: boolean): void {
  db.prepare("UPDATE terms SET last_success_at = ?, empty_streak = 0, had_results = MAX(had_results, ?) WHERE term_key = ?").run(
    now,
    hadCards ? 1 : 0,
    termKey,
  );
}

export function bumpEmptyStreak(db: Db, termKey: string): number {
  db.prepare("UPDATE terms SET empty_streak = empty_streak + 1 WHERE term_key = ?").run(termKey);
  return getTerm(db, termKey)?.emptyStreak ?? 0;
}

export function setBaseline(db: Db, termKey: string, now: number): void {
  db.prepare("UPDATE terms SET baseline_at = ? WHERE term_key = ?").run(now, termKey);
}

export function setWarmedUp(db: Db, termKey: string, now: number): void {
  db.prepare("UPDATE terms SET warmed_up_at = ? WHERE term_key = ?").run(now, termKey);
}

export function deleteIdleTerms(db: Db): number {
  return db
    .prepare("DELETE FROM terms WHERE NOT EXISTS (SELECT 1 FROM searches s WHERE s.term_key = terms.term_key AND s.status = 'active')")
    .run().changes;
}
```

`src/db/searches.ts`:

```ts
import type { ConditionCode } from "../matching/conditions.js";
import type { MatchableSearch } from "../matching/match.js";
import { toTermKey } from "../matching/normalize.js";
import type { Db } from "./database.js";
import { ensureTerm } from "./terms.js";

export type MatchMode = "strict" | "loose";
export type SearchStatus = "active" | "paused";

export interface Search extends MatchableSearch {
  id: number;
  userId: number;
  termKey: string;
  status: SearchStatus;
  activeSince: number;
  createdAt: number;
}

export interface NewSearch {
  userId: number;
  keywords: string;
  maxPricePence: number;
  minPricePence: number | null;
  conditions: ConditionCode[];
  excludeWords: string[];
  matchMode: MatchMode;
}

interface SearchRow {
  id: number;
  user_id: number;
  keywords: string;
  term_key: string;
  max_price_p: number;
  min_price_p: number | null;
  conditions: string;
  exclude_words: string;
  match_mode: MatchMode;
  status: SearchStatus;
  active_since: number;
  created_at: number;
}

const toSearch = (row: SearchRow): Search => ({
  id: row.id,
  userId: row.user_id,
  keywords: row.keywords,
  termKey: row.term_key,
  maxPricePence: row.max_price_p,
  minPricePence: row.min_price_p,
  conditions: JSON.parse(row.conditions) as ConditionCode[],
  excludeWords: JSON.parse(row.exclude_words) as string[],
  matchMode: row.match_mode,
  status: row.status,
  activeSince: row.active_since,
  createdAt: row.created_at,
});

export function getSearch(db: Db, id: number): Search | undefined {
  const row = db.prepare("SELECT * FROM searches WHERE id = ?").get(id) as SearchRow | undefined;
  return row ? toSearch(row) : undefined;
}

export function createSearch(db: Db, input: NewSearch, now: number): Search {
  const termKey = toTermKey(input.keywords);
  ensureTerm(db, termKey);
  const info = db
    .prepare(
      `INSERT INTO searches (user_id, keywords, term_key, max_price_p, min_price_p, conditions, exclude_words, match_mode, status, active_since, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)`,
    )
    .run(
      input.userId,
      input.keywords,
      termKey,
      input.maxPricePence,
      input.minPricePence,
      JSON.stringify(input.conditions),
      JSON.stringify(input.excludeWords),
      input.matchMode,
      now,
      now,
    );
  return getSearch(db, Number(info.lastInsertRowid))!;
}

export function listSearchesByUser(db: Db, userId: number): Search[] {
  return (db.prepare("SELECT * FROM searches WHERE user_id = ? ORDER BY id").all(userId) as SearchRow[]).map(toSearch);
}

export function countSearchesByUser(db: Db, userId: number): number {
  return (db.prepare("SELECT COUNT(*) AS n FROM searches WHERE user_id = ?").get(userId) as { n: number }).n;
}

/** Resuming resets active_since so items seen while paused never alert. */
export function setSearchStatus(db: Db, id: number, status: SearchStatus, now: number): void {
  if (status === "active") {
    db.prepare("UPDATE searches SET status = 'active', active_since = ? WHERE id = ?").run(now, id);
    const search = getSearch(db, id);
    if (search) ensureTerm(db, search.termKey);
  } else {
    db.prepare("UPDATE searches SET status = 'paused' WHERE id = ?").run(id);
  }
}

export function deleteSearch(db: Db, id: number): void {
  db.transaction((searchId: number) => {
    db.prepare("DELETE FROM alerts WHERE search_id = ?").run(searchId);
    db.prepare("DELETE FROM searches WHERE id = ?").run(searchId);
  })(id);
}

export function activeSearchesForTerm(db: Db, termKey: string): Search[] {
  return (db.prepare("SELECT * FROM searches WHERE term_key = ? AND status = 'active' ORDER BY id").all(termKey) as SearchRow[]).map(toSearch);
}

export function pauseAllSearchesForUser(db: Db, userId: number): void {
  db.prepare("UPDATE searches SET status = 'paused' WHERE user_id = ?").run(userId);
}

export function countActiveSearches(db: Db): number {
  return (db.prepare("SELECT COUNT(*) AS n FROM searches WHERE status = 'active'").get() as { n: number }).n;
}
```

- [ ] **Step 5: Run tests and type-check**

Run: `npx vitest run test/db-searches.test.ts test/db-users.test.ts && npm run typecheck`
Expected: PASS; no type errors.

- [ ] **Step 6: Commit**

```bash
git add src/db/searches.ts src/db/terms.ts test/helpers/db.ts test/db-searches.test.ts
git commit -m "feat: search and term repositories"
```

---

### Task 9: Database — items, price observations, alerts and retention

**Files:**
- Create: `src/db/items.ts`, `src/db/prices.ts`, `src/db/alerts.ts`, `src/db/retention.ts`
- Test: `test/db-items.test.ts`

**Interfaces:**
- Consumes: `Db` (Task 7); `deleteIdleTerms` (Task 8); `CardListing`, `ItemDetail` (Task 3); `ConditionCode` (Task 3); `Insight` (Task 6).
- Produces:
  - `interface StoredItem extends CardListing { cardSeenAt; detail: ItemDetail | null; detailFetchedAt: number | null }`
  - `upsertItemCard(db, card, now): void`, `getItem(db, vintedId): StoredItem | undefined`, `saveItemDetail(db, vintedId, detail, now): void`, `knownTermItemIds(db, termKey, ids: string[]): Set<string>`, `insertTermItems(db, termKey, ids, now): void`, `touchTermItems(db, termKey, ids, now): void`, `recentItemsForTerm(db, termKey, limit): StoredItem[]`
  - `interface PriceObservation { vintedId; groupKey; modelKnown: boolean; pricePence }`, `upsertPriceObservation(db, obs, now): void`, `groupPrices(db, groupKey, since, excludeVintedId?): number[]`, `termModelPrices(db, termKey, since): number[]`
  - `type AlertStatus = "pending" | "sent" | "digested" | "digest_sent" | "dropped" | "failed"`, `interface Alert { id; searchId; vintedId; status; insight: Insight | null; detailsUnavailable: boolean; createdAt; sentAt: number | null }`, `interface PendingAlert extends Alert { chatId: number }`
  - `createAlert(db, { searchId, vintedId, insight, detailsUnavailable, createdAt }): Alert | null`, `getAlert(db, id)`, `listPendingAlerts(db, limit): PendingAlert[]`, `setAlertStatus(db, id, status, sentAt?: number | null): void`, `sentTimesForSearch(db, searchId, since): number[]`, `heldAlertsForSearch(db, searchId): Alert[]`, `searchesWithHeldAlerts(db): number[]`, `dropStalePending(db, olderThan): number`, `sentLatencies(db, since): number[]`
  - `DAY_MS`, `runRetention(db, now): void`

- [ ] **Step 1: Write the failing test**

`test/db-items.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  createAlert,
  dropStalePending,
  heldAlertsForSearch,
  listPendingAlerts,
  searchesWithHeldAlerts,
  sentLatencies,
  sentTimesForSearch,
  setAlertStatus,
} from "../src/db/alerts.js";
import { getItem, insertTermItems, knownTermItemIds, recentItemsForTerm, saveItemDetail, touchTermItems, upsertItemCard } from "../src/db/items.js";
import { groupPrices, termModelPrices, upsertPriceObservation } from "../src/db/prices.js";
import { DAY_MS, runRetention } from "../src/db/retention.js";
import { getTerm } from "../src/db/terms.js";
import { makeCard, makeDetail } from "./helpers/cards.js";
import { memoryDb, seedSearch, seedUser } from "./helpers/db.js";

describe("items", () => {
  it("upserts cards and stores details", () => {
    const db = memoryDb();
    upsertItemCard(db, makeCard(), 10);
    upsertItemCard(db, makeCard({ pricePence: 25000 }), 20);
    expect(getItem(db, "1001")).toEqual({ ...makeCard({ pricePence: 25000 }), cardSeenAt: 20, detail: null, detailFetchedAt: null });
    saveItemDetail(db, "1001", makeDetail(), 30);
    expect(getItem(db, "1001")).toMatchObject({ detail: makeDetail(), detailFetchedAt: 30 });
  });

  it("tracks which items each term has seen", () => {
    const db = memoryDb();
    insertTermItems(db, "iphone 15", ["1", "2"], 100);
    expect(knownTermItemIds(db, "iphone 15", ["1", "2", "3"])).toEqual(new Set(["1", "2"]));
    expect(knownTermItemIds(db, "ps5", ["1"])).toEqual(new Set());
    insertTermItems(db, "iphone 15", ["2"], 999);
    touchTermItems(db, "iphone 15", ["1"], 200);
    const rows = db.prepare("SELECT vinted_id, first_seen_at, last_seen_at FROM term_items ORDER BY vinted_id").all();
    expect(rows).toEqual([
      { vinted_id: "1", first_seen_at: 100, last_seen_at: 200 },
      { vinted_id: "2", first_seen_at: 100, last_seen_at: 100 },
    ]);
  });

  it("lists a term's items newest first", () => {
    const db = memoryDb();
    for (const id of ["9", "100", "55"]) upsertItemCard(db, makeCard({ vintedId: id }), 1);
    insertTermItems(db, "iphone 15", ["9", "100", "55"], 1);
    expect(recentItemsForTerm(db, "iphone 15", 2).map((item) => item.vintedId)).toEqual(["100", "55"]);
  });
});

describe("price observations", () => {
  it("queries a group within a window, excluding one item", () => {
    const db = memoryDb();
    upsertPriceObservation(db, { vintedId: "1", groupKey: "iphone 15|iphone 15|128gb|good", modelKnown: true, pricePence: 30000 }, 100);
    upsertPriceObservation(db, { vintedId: "2", groupKey: "iphone 15|iphone 15|128gb|good", modelKnown: true, pricePence: 32000 }, 200);
    upsertPriceObservation(db, { vintedId: "3", groupKey: "iphone 15|-|-|new", modelKnown: false, pricePence: 500 }, 200);
    upsertPriceObservation(db, { vintedId: "1", groupKey: "iphone 15|iphone 15|128gb|good", modelKnown: true, pricePence: 29000 }, 300);
    expect(groupPrices(db, "iphone 15|iphone 15|128gb|good", 0).sort()).toEqual([29000, 32000]);
    expect(groupPrices(db, "iphone 15|iphone 15|128gb|good", 250)).toEqual([29000]);
    expect(groupPrices(db, "iphone 15|iphone 15|128gb|good", 0, "1")).toEqual([32000]);
    expect(termModelPrices(db, "iphone 15", 0).sort()).toEqual([29000, 32000]);
    expect(termModelPrices(db, "iphone", 0)).toEqual([]);
  });
});

describe("alerts", () => {
  it("creates each (search, item) alert once and lists pending with the chat id", () => {
    const db = memoryDb();
    seedUser(db, 111);
    const search = seedSearch(db);
    const insight = { kind: "insufficient" as const, n: 3 };
    const alert = createAlert(db, { searchId: search.id, vintedId: "1001", insight, detailsUnavailable: true, createdAt: 50 });
    expect(alert).toMatchObject({ searchId: search.id, vintedId: "1001", status: "pending", insight, detailsUnavailable: true, createdAt: 50, sentAt: null });
    expect(createAlert(db, { searchId: search.id, vintedId: "1001", insight: null, detailsUnavailable: false, createdAt: 60 })).toBeNull();
    expect(listPendingAlerts(db, 10)).toEqual([{ ...alert, chatId: 111 }]);
  });

  it("supports flood bookkeeping, stale drops and latency stats", () => {
    const db = memoryDb();
    seedUser(db);
    const search = seedSearch(db);
    const make = (id: string, createdAt: number) =>
      createAlert(db, { searchId: search.id, vintedId: id, insight: null, detailsUnavailable: false, createdAt })!;
    const a = make("1", 1_000);
    const b = make("2", 2_000);
    const c = make("3", 3_000);
    setAlertStatus(db, a.id, "sent", 1_500);
    setAlertStatus(db, b.id, "digested");
    expect(sentTimesForSearch(db, search.id, 1_000)).toEqual([1_500]);
    expect(sentTimesForSearch(db, search.id, 1_600)).toEqual([]);
    expect(heldAlertsForSearch(db, search.id).map((x) => x.id)).toEqual([b.id]);
    expect(searchesWithHeldAlerts(db)).toEqual([search.id]);
    expect(dropStalePending(db, 3_001)).toBe(1);
    expect(listPendingAlerts(db, 10)).toEqual([]);
    expect(sentLatencies(db, 0)).toEqual([500]);
    expect(c.id).toBeGreaterThan(0);
  });
});

describe("retention", () => {
  it("prunes by age but keeps items still visible or awaiting an alert", () => {
    const db = memoryDb();
    seedUser(db);
    const search = seedSearch(db);
    const now = 40 * DAY_MS;
    const old = now - 8 * DAY_MS;
    upsertItemCard(db, makeCard({ vintedId: "old" }), old);
    upsertItemCard(db, makeCard({ vintedId: "pending-old" }), old);
    upsertItemCard(db, makeCard({ vintedId: "fresh" }), now);
    insertTermItems(db, "iphone 15", ["old"], old);
    insertTermItems(db, "iphone 15", ["fresh"], old);
    touchTermItems(db, "iphone 15", ["fresh"], now);
    createAlert(db, { searchId: search.id, vintedId: "pending-old", insight: null, detailsUnavailable: false, createdAt: now });
    upsertPriceObservation(db, { vintedId: "old", groupKey: "g", modelKnown: true, pricePence: 1 }, now - 31 * DAY_MS);
    upsertPriceObservation(db, { vintedId: "fresh", groupKey: "g", modelKnown: true, pricePence: 1 }, now);

    runRetention(db, now);

    expect(getItem(db, "old")).toBeUndefined();
    expect(getItem(db, "pending-old")).toBeDefined();
    expect(getItem(db, "fresh")).toBeDefined();
    expect(knownTermItemIds(db, "iphone 15", ["old", "fresh"])).toEqual(new Set(["fresh"]));
    expect(groupPrices(db, "g", 0)).toEqual([1]);
    expect(getTerm(db, "iphone 15")).toBeDefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/db-items.test.ts`
Expected: FAIL — cannot resolve `../src/db/alerts.js`.

- [ ] **Step 3: Write the implementation**

`src/db/items.ts`:

```ts
import type { ConditionCode } from "../matching/conditions.js";
import type { CardListing, ItemDetail } from "../vinted/types.js";
import type { Db } from "./database.js";

export interface StoredItem extends CardListing {
  cardSeenAt: number;
  detail: ItemDetail | null;
  detailFetchedAt: number | null;
}

interface ItemRow {
  vinted_id: string;
  title: string;
  brand: string | null;
  model: string | null;
  condition: string;
  price_p: number | null;
  item_price_p: number | null;
  photo_url: string | null;
  url: string;
  card_seen_at: number;
  detail_json: string | null;
  detail_fetched_at: number | null;
}

const toItem = (row: ItemRow): StoredItem => ({
  vintedId: row.vinted_id,
  title: row.title,
  brand: row.brand,
  model: row.model,
  condition: row.condition as ConditionCode,
  pricePence: row.price_p,
  itemPricePence: row.item_price_p,
  photoUrl: row.photo_url,
  url: row.url,
  cardSeenAt: row.card_seen_at,
  detail: row.detail_json ? (JSON.parse(row.detail_json) as ItemDetail) : null,
  detailFetchedAt: row.detail_fetched_at,
});

export function upsertItemCard(db: Db, card: CardListing, now: number): void {
  db.prepare(
    `INSERT INTO items (vinted_id, title, brand, model, condition, price_p, item_price_p, photo_url, url, card_seen_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(vinted_id) DO UPDATE SET
       title = excluded.title, brand = excluded.brand, model = excluded.model, condition = excluded.condition,
       price_p = excluded.price_p, item_price_p = excluded.item_price_p, photo_url = excluded.photo_url,
       url = excluded.url, card_seen_at = excluded.card_seen_at`,
  ).run(card.vintedId, card.title, card.brand, card.model, card.condition, card.pricePence, card.itemPricePence, card.photoUrl, card.url, now);
}

export function getItem(db: Db, vintedId: string): StoredItem | undefined {
  const row = db.prepare("SELECT * FROM items WHERE vinted_id = ?").get(vintedId) as ItemRow | undefined;
  return row ? toItem(row) : undefined;
}

export function saveItemDetail(db: Db, vintedId: string, detail: ItemDetail, now: number): void {
  db.prepare("UPDATE items SET detail_json = ?, detail_fetched_at = ? WHERE vinted_id = ?").run(JSON.stringify(detail), now, vintedId);
}

export function knownTermItemIds(db: Db, termKey: string, ids: string[]): Set<string> {
  if (ids.length === 0) return new Set();
  const rows = db
    .prepare("SELECT vinted_id FROM term_items WHERE term_key = ? AND vinted_id IN (SELECT value FROM json_each(?))")
    .all(termKey, JSON.stringify(ids)) as Array<{ vinted_id: string }>;
  return new Set(rows.map((row) => row.vinted_id));
}

export function insertTermItems(db: Db, termKey: string, ids: string[], now: number): void {
  const insert = db.prepare("INSERT OR IGNORE INTO term_items (term_key, vinted_id, first_seen_at, last_seen_at) VALUES (?, ?, ?, ?)");
  db.transaction(() => {
    for (const id of ids) insert.run(termKey, id, now, now);
  })();
}

export function touchTermItems(db: Db, termKey: string, ids: string[], now: number): void {
  const update = db.prepare("UPDATE term_items SET last_seen_at = ? WHERE term_key = ? AND vinted_id = ?");
  db.transaction(() => {
    for (const id of ids) update.run(now, termKey, id);
  })();
}

export function recentItemsForTerm(db: Db, termKey: string, limit: number): StoredItem[] {
  const rows = db
    .prepare(
      "SELECT i.* FROM items i JOIN term_items t ON t.vinted_id = i.vinted_id WHERE t.term_key = ? ORDER BY CAST(i.vinted_id AS INTEGER) DESC LIMIT ?",
    )
    .all(termKey, limit) as ItemRow[];
  return rows.map(toItem);
}
```

`src/db/prices.ts`:

```ts
import type { Db } from "./database.js";

export interface PriceObservation {
  vintedId: string;
  groupKey: string;
  modelKnown: boolean;
  pricePence: number;
}

export function upsertPriceObservation(db: Db, obs: PriceObservation, now: number): void {
  db.prepare(
    `INSERT INTO price_observations (vinted_id, group_key, model_known, price_p, first_observed_at, observed_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(vinted_id) DO UPDATE SET
       group_key = excluded.group_key, model_known = excluded.model_known,
       price_p = excluded.price_p, observed_at = excluded.observed_at`,
  ).run(obs.vintedId, obs.groupKey, obs.modelKnown ? 1 : 0, obs.pricePence, now, now);
}

export function groupPrices(db: Db, groupKey: string, since: number, excludeVintedId?: string): number[] {
  const rows = db
    .prepare("SELECT price_p FROM price_observations WHERE group_key = ? AND observed_at >= ? AND vinted_id != ?")
    .all(groupKey, since, excludeVintedId ?? "") as Array<{ price_p: number }>;
  return rows.map((row) => row.price_p);
}

/** Prices of listings with a known model for any group of this term (used for the min-price suggestion). */
export function termModelPrices(db: Db, termKey: string, since: number): number[] {
  const prefix = `${termKey}|`;
  const rows = db
    .prepare("SELECT price_p FROM price_observations WHERE substr(group_key, 1, ?) = ? AND model_known = 1 AND observed_at >= ?")
    .all(prefix.length, prefix, since) as Array<{ price_p: number }>;
  return rows.map((row) => row.price_p);
}
```

`src/db/alerts.ts`:

```ts
import type { Insight } from "../insight/stats.js";
import type { Db } from "./database.js";

export type AlertStatus = "pending" | "sent" | "digested" | "digest_sent" | "dropped" | "failed";

export interface Alert {
  id: number;
  searchId: number;
  vintedId: string;
  status: AlertStatus;
  insight: Insight | null;
  detailsUnavailable: boolean;
  createdAt: number;
  sentAt: number | null;
}

export interface PendingAlert extends Alert {
  chatId: number;
}

interface AlertRow {
  id: number;
  search_id: number;
  vinted_id: string;
  status: AlertStatus;
  insight_json: string | null;
  details_unavailable: number;
  created_at: number;
  sent_at: number | null;
}

const toAlert = (row: AlertRow): Alert => ({
  id: row.id,
  searchId: row.search_id,
  vintedId: row.vinted_id,
  status: row.status,
  insight: row.insight_json ? (JSON.parse(row.insight_json) as Insight) : null,
  detailsUnavailable: row.details_unavailable === 1,
  createdAt: row.created_at,
  sentAt: row.sent_at,
});

export function getAlert(db: Db, id: number): Alert | undefined {
  const row = db.prepare("SELECT * FROM alerts WHERE id = ?").get(id) as AlertRow | undefined;
  return row ? toAlert(row) : undefined;
}

/** Returns null when this (search, item) pair already has an alert. */
export function createAlert(
  db: Db,
  input: { searchId: number; vintedId: string; insight: Insight | null; detailsUnavailable: boolean; createdAt: number },
): Alert | null {
  const info = db
    .prepare(
      "INSERT OR IGNORE INTO alerts (search_id, vinted_id, status, insight_json, details_unavailable, created_at) VALUES (?, ?, 'pending', ?, ?, ?)",
    )
    .run(input.searchId, input.vintedId, input.insight ? JSON.stringify(input.insight) : null, input.detailsUnavailable ? 1 : 0, input.createdAt);
  return info.changes === 0 ? null : getAlert(db, Number(info.lastInsertRowid))!;
}

export function listPendingAlerts(db: Db, limit: number): PendingAlert[] {
  const rows = db
    .prepare(
      "SELECT a.*, s.user_id AS chat_id FROM alerts a JOIN searches s ON s.id = a.search_id WHERE a.status = 'pending' ORDER BY a.created_at, a.id LIMIT ?",
    )
    .all(limit) as Array<AlertRow & { chat_id: number }>;
  return rows.map((row) => ({ ...toAlert(row), chatId: row.chat_id }));
}

export function setAlertStatus(db: Db, id: number, status: AlertStatus, sentAt: number | null = null): void {
  db.prepare("UPDATE alerts SET status = ?, sent_at = COALESCE(?, sent_at) WHERE id = ?").run(status, sentAt, id);
}

export function sentTimesForSearch(db: Db, searchId: number, since: number): number[] {
  const rows = db
    .prepare("SELECT sent_at FROM alerts WHERE search_id = ? AND status = 'sent' AND sent_at >= ? ORDER BY sent_at")
    .all(searchId, since) as Array<{ sent_at: number }>;
  return rows.map((row) => row.sent_at);
}

export function heldAlertsForSearch(db: Db, searchId: number): Alert[] {
  const rows = db.prepare("SELECT * FROM alerts WHERE search_id = ? AND status = 'digested' ORDER BY created_at, id").all(searchId) as AlertRow[];
  return rows.map(toAlert);
}

export function searchesWithHeldAlerts(db: Db): number[] {
  const rows = db.prepare("SELECT DISTINCT search_id FROM alerts WHERE status = 'digested' ORDER BY search_id").all() as Array<{ search_id: number }>;
  return rows.map((row) => row.search_id);
}

export function dropStalePending(db: Db, olderThan: number): number {
  return db.prepare("UPDATE alerts SET status = 'dropped' WHERE status = 'pending' AND created_at < ?").run(olderThan).changes;
}

export function sentLatencies(db: Db, since: number): number[] {
  const rows = db
    .prepare("SELECT sent_at - created_at AS latency FROM alerts WHERE status = 'sent' AND sent_at >= ?")
    .all(since) as Array<{ latency: number }>;
  return rows.map((row) => row.latency);
}
```

`src/db/retention.ts`:

```ts
import type { Db } from "./database.js";
import { deleteIdleTerms } from "./terms.js";

export const DAY_MS = 86_400_000;
export const ITEM_RETENTION_MS = 7 * DAY_MS;
export const PRICE_RETENTION_MS = 30 * DAY_MS;
export const ALERT_RETENTION_MS = 30 * DAY_MS;
export const WIZARD_TTL_MS = 60 * 60_000;

/** Spec §5 retention; run hourly. */
export function runRetention(db: Db, now: number): void {
  db.transaction(() => {
    db.prepare("DELETE FROM term_items WHERE last_seen_at < ?").run(now - ITEM_RETENTION_MS);
    db.prepare(
      "DELETE FROM items WHERE card_seen_at < ? AND vinted_id NOT IN (SELECT vinted_id FROM alerts WHERE status IN ('pending','digested'))",
    ).run(now - ITEM_RETENTION_MS);
    db.prepare("DELETE FROM price_observations WHERE observed_at < ?").run(now - PRICE_RETENTION_MS);
    db.prepare("DELETE FROM alerts WHERE created_at < ?").run(now - ALERT_RETENTION_MS);
    db.prepare("DELETE FROM wizard_state WHERE updated_at < ?").run(now - WIZARD_TTL_MS);
    deleteIdleTerms(db);
  })();
}
```

- [ ] **Step 4: Run tests and type-check**

Run: `npx vitest run test/db-items.test.ts && npm run typecheck`
Expected: PASS; no type errors.

- [ ] **Step 5: Commit**

```bash
git add src/db/items.ts src/db/prices.ts src/db/alerts.ts src/db/retention.ts test/db-items.test.ts
git commit -m "feat: item cache, price observations, alert ledger and retention"
```

---

### Task 10: Request queue with spacing, priority and backoff

**Files:**
- Create: `src/poller/requestQueue.ts`
- Test: `test/requestQueue.test.ts`

**Interfaces:**
- Produces:
  - `type Priority = "detail" | "poll" | "warmup"`
  - `interface BackoffState { active: boolean; level: number; until: number }`
  - `BACKOFF_BASE_MS = 60_000`, `BACKOFF_MAX_MS = 1_800_000`, `backoffDelayMs(level: number): number`
  - `interface QueueOptions { spacingMs: number; jitterMs: number; random?: () => number; onBackoffChange?: (state: BackoffState) => void }`
  - `class RequestQueue { constructor(opts); enqueue<T>(priority, run: () => Promise<T>): Promise<T>; reportBlocked(): void; reportSuccess(): void; get backoff(): BackoffState; get size(): number; stop(): void }`

- [ ] **Step 1: Write the failing test**

`test/requestQueue.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { backoffDelayMs, RequestQueue, type BackoffState } from "../src/poller/requestQueue.js";

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
});
afterEach(() => {
  vi.useRealTimers();
});

describe("RequestQueue", () => {
  it("spaces request starts", async () => {
    const queue = new RequestQueue({ spacingMs: 1000, jitterMs: 0 });
    const starts: number[] = [];
    const jobs = [1, 2, 3].map(() => queue.enqueue("poll", async () => void starts.push(Date.now())));
    await vi.advanceTimersByTimeAsync(5000);
    await Promise.all(jobs);
    expect(starts).toEqual([0, 1000, 2000]);
  });

  it("adds jitter to the gap", async () => {
    const queue = new RequestQueue({ spacingMs: 1000, jitterMs: 500, random: () => 0.5 });
    const starts: number[] = [];
    const jobs = [1, 2].map(() => queue.enqueue("poll", async () => void starts.push(Date.now())));
    await vi.advanceTimersByTimeAsync(5000);
    await Promise.all(jobs);
    expect(starts).toEqual([0, 1250]);
  });

  it("runs higher priorities first", async () => {
    const queue = new RequestQueue({ spacingMs: 100, jitterMs: 0 });
    const order: string[] = [];
    let release!: () => void;
    const first = queue.enqueue("poll", () => new Promise<void>((resolve) => (release = resolve)));
    const rest = [
      queue.enqueue("warmup", async () => void order.push("warmup")),
      queue.enqueue("poll", async () => void order.push("poll")),
      queue.enqueue("detail", async () => void order.push("detail")),
    ];
    release();
    await vi.advanceTimersByTimeAsync(1000);
    await Promise.all([first, ...rest]);
    expect(order).toEqual(["detail", "poll", "warmup"]);
  });

  it("backs off exponentially while blocked and recovers on success", async () => {
    const changes: BackoffState[] = [];
    const queue = new RequestQueue({ spacingMs: 100, jitterMs: 0, onBackoffChange: (state) => changes.push(state) });
    const starts: number[] = [];
    await queue.enqueue("poll", async () => {
      starts.push(Date.now());
      queue.reportBlocked();
    });
    const second = queue.enqueue("poll", async () => {
      starts.push(Date.now());
      queue.reportBlocked();
    });
    const third = queue.enqueue("poll", async () => {
      starts.push(Date.now());
      queue.reportSuccess();
    });
    await vi.advanceTimersByTimeAsync(200_000);
    await Promise.all([second, third]);
    expect(starts).toEqual([0, 60_000, 180_000]);
    expect(changes.map((state) => [state.active, state.level])).toEqual([
      [true, 1],
      [true, 2],
      [false, 0],
    ]);
    expect(queue.backoff.active).toBe(false);
  });

  it("caps the backoff at 30 minutes", () => {
    expect([1, 2, 3, 6, 10].map(backoffDelayMs)).toEqual([60_000, 120_000, 240_000, 1_800_000, 1_800_000]);
  });

  it("propagates job errors without stopping", async () => {
    const queue = new RequestQueue({ spacingMs: 10, jitterMs: 0 });
    // Attach the handler immediately: the job rejects before the timers advance.
    const failing = queue
      .enqueue("poll", async () => {
        throw new Error("boom");
      })
      .catch((error: unknown) => error);
    const next = queue.enqueue("poll", async () => "ok");
    await vi.advanceTimersByTimeAsync(100);
    expect(await failing).toEqual(new Error("boom"));
    await expect(next).resolves.toBe("ok");
  });

  it("rejects queued and new jobs after stop", async () => {
    const queue = new RequestQueue({ spacingMs: 1000, jitterMs: 0 });
    const first = queue.enqueue("poll", async () => "first");
    const second = queue.enqueue("poll", async () => "second");
    await expect(first).resolves.toBe("first");
    queue.stop();
    await expect(second).rejects.toThrow("queue stopped");
    await expect(queue.enqueue("poll", async () => "late")).rejects.toThrow("queue stopped");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/requestQueue.test.ts`
Expected: FAIL — cannot resolve `../src/poller/requestQueue.js`.

- [ ] **Step 3: Write the implementation**

`src/poller/requestQueue.ts`:

```ts
export type Priority = "detail" | "poll" | "warmup";

const RANK: Record<Priority, number> = { detail: 0, poll: 1, warmup: 2 };

export interface BackoffState {
  active: boolean;
  level: number;
  until: number;
}

export const BACKOFF_BASE_MS = 60_000;
export const BACKOFF_MAX_MS = 30 * 60_000;

export function backoffDelayMs(level: number): number {
  return Math.min(BACKOFF_BASE_MS * 2 ** (level - 1), BACKOFF_MAX_MS);
}

export interface QueueOptions {
  spacingMs: number;
  jitterMs: number;
  random?: () => number;
  onBackoffChange?: (state: BackoffState) => void;
}

interface Job {
  priority: Priority;
  seq: number;
  run: () => Promise<unknown>;
  resolve: (value: unknown) => void;
  reject: (error: unknown) => void;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Every Vinted request goes through here: one at a time, spaced, prioritised, paused while blocked. */
export class RequestQueue {
  private readonly jobs: Job[] = [];
  private seq = 0;
  private lastStart = Number.NEGATIVE_INFINITY;
  private nextGap: number;
  private level = 0;
  private until = 0;
  private wake: (() => void) | null = null;
  private running = false;
  private stopped = false;

  constructor(private readonly opts: QueueOptions) {
    this.nextGap = opts.spacingMs;
  }

  enqueue<T>(priority: Priority, run: () => Promise<T>): Promise<T> {
    if (this.stopped) return Promise.reject(new Error("queue stopped"));
    return new Promise<T>((resolve, reject) => {
      this.jobs.push({ priority, seq: this.seq++, run, resolve: resolve as (value: unknown) => void, reject });
      this.ensureRunning();
      this.wake?.();
    });
  }

  get backoff(): BackoffState {
    return { active: this.level > 0, level: this.level, until: this.until };
  }

  get size(): number {
    return this.jobs.length;
  }

  reportBlocked(): void {
    this.level += 1;
    this.until = Date.now() + backoffDelayMs(this.level);
    this.opts.onBackoffChange?.(this.backoff);
  }

  reportSuccess(): void {
    if (this.level === 0) return;
    this.level = 0;
    this.until = 0;
    this.opts.onBackoffChange?.(this.backoff);
  }

  stop(): void {
    this.stopped = true;
    for (const job of this.jobs.splice(0)) job.reject(new Error("queue stopped"));
    this.wake?.();
  }

  private ensureRunning(): void {
    if (this.running) return;
    this.running = true;
    void this.loop();
  }

  private async loop(): Promise<void> {
    while (!this.stopped) {
      if (this.jobs.length === 0) {
        await new Promise<void>((resolve) => (this.wake = resolve));
        this.wake = null;
        continue;
      }
      const readyAt = Math.max(this.lastStart + this.nextGap, this.until);
      const wait = readyAt - Date.now();
      if (wait > 0) {
        await sleep(wait);
        continue; // re-check: a higher-priority job or a backoff change may have arrived
      }
      const job = this.takeNext();
      this.lastStart = Date.now();
      this.nextGap = this.opts.spacingMs + Math.floor((this.opts.random ?? Math.random)() * this.opts.jitterMs);
      try {
        job.resolve(await job.run());
      } catch (error) {
        job.reject(error);
      }
    }
    this.running = false;
  }

  private takeNext(): Job {
    let best = 0;
    for (let i = 1; i < this.jobs.length; i += 1) {
      const candidate = this.jobs[i]!;
      const current = this.jobs[best]!;
      const rankDiff = RANK[candidate.priority] - RANK[current.priority];
      if (rankDiff < 0 || (rankDiff === 0 && candidate.seq < current.seq)) best = i;
    }
    return this.jobs.splice(best, 1)[0]!;
  }
}
```

- [ ] **Step 4: Run tests and type-check**

Run: `npx vitest run test/requestQueue.test.ts && npm run typecheck`
Expected: PASS; no type errors.

- [ ] **Step 5: Commit**

```bash
git add src/poller/requestQueue.ts test/requestQueue.test.ts
git commit -m "feat: prioritised, spaced request queue with exponential backoff"
```

---

### Task 11: Vinted HTTP client

**Files:**
- Create: `src/vinted/client.ts`
- Test: `test/client.test.ts`

**Interfaces:**
- Consumes: `catalogUrl` (Task 4), `parseCatalogHtml`, `parseItemHtml`, `isChallengePage` (Task 4), `Priority`, `RequestQueue` (Task 10).
- Produces:
  - `interface HttpResponse { status: number; text(): Promise<string> }`
  - `type FetchLike = (url: string, init: { headers: Record<string, string>; signal: AbortSignal }) => Promise<HttpResponse>`
  - `type CatalogResult = { kind: "ok"; cards: CardListing[] } | { kind: "empty" } | { kind: "unrecognised" } | { kind: "blocked"; status: number } | { kind: "error"; message: string }`
  - `type ItemResult = { kind: "ok"; detail: ItemDetail } | { kind: "blocked"; status: number } | { kind: "error"; message: string }`
  - `interface VintedClientOptions { queue: Pick<RequestQueue, "enqueue" | "reportBlocked" | "reportSuccess">; fetch: FetchLike; host: string; userAgent: string; timeoutMs?: number; retryDelayMs?: number }`
  - `class VintedClient { fetchCatalog(termKey, page, priority): Promise<CatalogResult>; fetchItem(url): Promise<ItemResult> }`

- [ ] **Step 1: Write the failing test**

`test/client.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import { VintedClient, type FetchLike, type HttpResponse } from "../src/vinted/client.js";

const CARD = `<div data-testid="product-item-id-77"><a href="/items/77-x" data-testid="product-item-id-77--overlay-link" title="iPhone 15, Brand: Apple, Condition: Good, 200.00 £, 210.70 £"></a><p data-testid="product-item-id-77--price-text">£200.00</p></div>`;

function setup(responses: Array<HttpResponse | Error>) {
  const queue = {
    enqueue: <T>(_priority: unknown, run: () => Promise<T>) => run(),
    reportBlocked: vi.fn(),
    reportSuccess: vi.fn(),
  };
  const calls: Array<{ url: string; headers: Record<string, string> }> = [];
  const fetch: FetchLike = async (url, init) => {
    calls.push({ url, headers: init.headers });
    const next = responses.shift();
    if (!next) throw new Error("no more responses");
    if (next instanceof Error) throw next;
    return next;
  };
  const client = new VintedClient({ queue, fetch, host: "www.vinted.co.uk", userAgent: "UA", retryDelayMs: 0 });
  return { client, queue, calls };
}

const page = (status: number, body: string): HttpResponse => ({ status, text: async () => body });

describe("VintedClient", () => {
  it("fetches and parses a catalog page", async () => {
    const { client, queue, calls } = setup([page(200, `<title>Items | Vinted</title>${CARD}`)]);
    const result = await client.fetchCatalog("iphone 15", 2, "poll");
    expect(result.kind).toBe("ok");
    expect(calls[0]?.url).toBe("https://www.vinted.co.uk/catalog?search_text=iphone+15&order=newest_first&page=2");
    expect(calls[0]?.headers["user-agent"]).toBe("UA");
    expect(queue.reportSuccess).toHaveBeenCalledTimes(1);
    expect(queue.reportBlocked).not.toHaveBeenCalled();
  });

  it("treats 403/429/503 as blocked", async () => {
    for (const status of [403, 429, 503]) {
      const { client, queue } = setup([page(status, "")]);
      expect(await client.fetchCatalog("x", 1, "poll")).toEqual({ kind: "blocked", status });
      expect(queue.reportBlocked).toHaveBeenCalledTimes(1);
    }
  });

  it("treats a Cloudflare interstitial as blocked", async () => {
    const { client, queue } = setup([page(200, "<html><head><title>Just a moment...</title></head></html>")]);
    expect(await client.fetchCatalog("x", 1, "poll")).toEqual({ kind: "blocked", status: 200 });
    expect(queue.reportBlocked).toHaveBeenCalledTimes(1);
  });

  it("does not treat a normal page mentioning 'Just a moment' as blocked (Review Focus 4)", async () => {
    const body = `<title>Items | Vinted</title><script src="/cdn-cgi/challenge-platform/x.js"></script>{"t":"Just a moment while we process your payment."}${CARD}`;
    const { client, queue } = setup([page(200, body)]);
    expect((await client.fetchCatalog("x", 1, "poll")).kind).toBe("ok");
    expect(queue.reportBlocked).not.toHaveBeenCalled();
  });

  it("retries once after a network error", async () => {
    const { client, calls } = setup([new Error("ECONNRESET"), page(200, CARD)]);
    expect((await client.fetchCatalog("x", 1, "poll")).kind).toBe("ok");
    expect(calls).toHaveLength(2);
  });

  it("reports an error after the retry also fails", async () => {
    const { client } = setup([page(404, "nope"), page(404, "nope")]);
    expect(await client.fetchCatalog("x", 1, "poll")).toEqual({ kind: "error", message: "HTTP 404" });
  });

  it("parses item pages and reports unrecognised ones as errors", async () => {
    const payload = JSON.stringify(`{"plugins":[{"data":{"description":"Mint"},"name":"description"}]}`);
    const { client } = setup([page(200, `<script>self.__next_f.push([1,${payload}])</script>`), page(200, "<html></html>"), page(200, "<html></html>")]);
    const ok = await client.fetchItem("https://www.vinted.co.uk/items/77-x");
    expect(ok.kind === "ok" && ok.detail.description).toBe("Mint");
    expect(await client.fetchItem("https://www.vinted.co.uk/items/78-y")).toEqual({ kind: "error", message: "item page not recognised" });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/client.test.ts`
Expected: FAIL — cannot resolve `../src/vinted/client.js`.

- [ ] **Step 3: Write the implementation**

`src/vinted/client.ts`:

```ts
import type { Priority, RequestQueue } from "../poller/requestQueue.js";
import { isChallengePage, parseCatalogHtml, parseItemHtml } from "./parse.js";
import type { CardListing, ItemDetail } from "./types.js";
import { catalogUrl } from "./url.js";

export interface HttpResponse {
  status: number;
  text(): Promise<string>;
}

export type FetchLike = (url: string, init: { headers: Record<string, string>; signal: AbortSignal }) => Promise<HttpResponse>;

export type CatalogResult =
  | { kind: "ok"; cards: CardListing[] }
  | { kind: "empty" }
  | { kind: "unrecognised" }
  | { kind: "blocked"; status: number }
  | { kind: "error"; message: string };

export type ItemResult = { kind: "ok"; detail: ItemDetail } | { kind: "blocked"; status: number } | { kind: "error"; message: string };

export interface VintedClientOptions {
  queue: Pick<RequestQueue, "enqueue" | "reportBlocked" | "reportSuccess">;
  fetch: FetchLike;
  host: string;
  userAgent: string;
  timeoutMs?: number;
  retryDelayMs?: number;
}

type Raw = { kind: "html"; html: string } | { kind: "blocked"; status: number } | { kind: "error"; message: string };

const BLOCK_STATUSES = new Set([403, 429, 503]);
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export class VintedClient {
  constructor(private readonly opts: VintedClientOptions) {}

  async fetchCatalog(termKey: string, page: number, priority: Priority): Promise<CatalogResult> {
    const raw = await this.get(catalogUrl(this.opts.host, termKey, page), priority);
    if (raw.kind !== "html") return raw;
    return parseCatalogHtml(raw.html, this.opts.host);
  }

  async fetchItem(url: string): Promise<ItemResult> {
    const raw = await this.get(url, "detail");
    if (raw.kind !== "html") return raw;
    const detail = parseItemHtml(raw.html);
    return detail ? { kind: "ok", detail } : { kind: "error", message: "item page not recognised" };
  }

  /** One attempt, then one retry after retryDelayMs on errors (not on blocks). */
  private async get(url: string, priority: Priority): Promise<Raw> {
    const first = await this.opts.queue.enqueue(priority, () => this.attempt(url));
    if (first.kind !== "error") return first;
    await sleep(this.opts.retryDelayMs ?? 5000);
    return this.opts.queue.enqueue(priority, () => this.attempt(url));
  }

  private async attempt(url: string): Promise<Raw> {
    let status: number;
    let html: string;
    try {
      const res = await this.opts.fetch(url, {
        headers: {
          "user-agent": this.opts.userAgent,
          accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          "accept-language": "en-GB,en;q=0.9",
        },
        signal: AbortSignal.timeout(this.opts.timeoutMs ?? 15_000),
      });
      status = res.status;
      html = await res.text();
    } catch (error) {
      return { kind: "error", message: error instanceof Error ? error.message : String(error) };
    }
    if (BLOCK_STATUSES.has(status) || (status === 200 && isChallengePage(html))) {
      this.opts.queue.reportBlocked();
      return { kind: "blocked", status };
    }
    if (status !== 200) return { kind: "error", message: `HTTP ${status}` };
    this.opts.queue.reportSuccess();
    return { kind: "html", html };
  }
}
```

- [ ] **Step 4: Run tests and type-check**

Run: `npx vitest run test/client.test.ts && npm run typecheck`
Expected: PASS; no type errors.

- [ ] **Step 5: Commit**

```bash
git add src/vinted/client.ts test/client.test.ts
git commit -m "feat: Vinted HTTP client with block detection and one retry"
```

---

### Task 12: Health monitor

**Files:**
- Create: `src/health/health.ts`
- Test: `test/health.test.ts`

**Interfaces:**
- Consumes: `BackoffState` (Task 10).
- Produces:
  - `interface HealthOptions { notifyOwner: (text: string) => Promise<void>; now?: () => number; silenceMs?: number; staleMs?: number; overflowSilenceMs?: number }`
  - `interface HealthSnapshot { startedAt; lastSuccessAt: number | null; backoff: BackoffState; failureCount; overflowCounts: Record<string, number>; layoutSuspects: string[]; medianPollIntervalMs: number | null }`
  - `class Health { onBackoffChange(state): Promise<void>; recordSuccess(): void; recordFailure(termKey, message): void; layoutSuspect(termKey): Promise<void>; clearLayoutSuspect(termKey): void; overflow(termKey): Promise<void>; recordPollInterval(ms): void; checkStale(): Promise<void>; restartNotice(): Promise<void>; snapshot(): HealthSnapshot }`

- [ ] **Step 1: Write the failing test**

`test/health.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import { Health } from "../src/health/health.js";

function setup() {
  let now = 0;
  const notifyOwner = vi.fn<(text: string) => Promise<void>>(async () => {});
  const health = new Health({ notifyOwner, now: () => now });
  return { health, notifyOwner, advance: (ms: number) => (now += ms) };
}

describe("Health", () => {
  it("messages the owner when backoff starts and ends", async () => {
    const { health, notifyOwner } = setup();
    await health.onBackoffChange({ active: true, level: 1, until: 60_000 });
    await health.onBackoffChange({ active: true, level: 2, until: 180_000 });
    await health.onBackoffChange({ active: false, level: 0, until: 0 });
    expect(notifyOwner.mock.calls.map(([text]) => text)).toEqual([
      "⚠️ Vinted is blocking requests. Pausing for 1 min, then retrying with longer waits.",
      "✅ Vinted requests are working again.",
    ]);
  });

  it("rate-limits repeated layout alarms per term to one per 15 minutes", async () => {
    const { health, notifyOwner, advance } = setup();
    await health.layoutSuspect("iphone 15");
    await health.layoutSuspect("iphone 15");
    await health.layoutSuspect("ps5");
    advance(15 * 60_000);
    await health.layoutSuspect("iphone 15");
    expect(notifyOwner).toHaveBeenCalledTimes(3);
    expect(health.snapshot().layoutSuspects).toEqual(["iphone 15", "ps5"]);
    health.clearLayoutSuspect("ps5");
    expect(health.snapshot().layoutSuspects).toEqual(["iphone 15"]);
  });

  it("counts overflow and notifies at most hourly per term", async () => {
    const { health, notifyOwner, advance } = setup();
    await health.overflow("iphone");
    advance(30 * 60_000);
    await health.overflow("iphone");
    advance(31 * 60_000);
    await health.overflow("iphone");
    expect(notifyOwner).toHaveBeenCalledTimes(2);
    expect(health.snapshot().overflowCounts).toEqual({ iphone: 3 });
  });

  it("warns when nothing has succeeded for 5 minutes, except during backoff", async () => {
    const { health, notifyOwner, advance } = setup();
    advance(4 * 60_000);
    await health.checkStale();
    expect(notifyOwner).not.toHaveBeenCalled();
    advance(60_000);
    await health.onBackoffChange({ active: true, level: 1, until: 999_999 });
    notifyOwner.mockClear();
    await health.checkStale();
    expect(notifyOwner).not.toHaveBeenCalled();
    await health.onBackoffChange({ active: false, level: 0, until: 0 });
    notifyOwner.mockClear();
    await health.checkStale();
    expect(notifyOwner).toHaveBeenCalledWith("⏳ No successful Vinted request for 5 minutes.");
    health.recordSuccess();
    notifyOwner.mockClear();
    advance(16 * 60_000);
    await health.checkStale();
    expect(notifyOwner).toHaveBeenCalledTimes(1);
  });

  it("summarises poll intervals and failures", () => {
    const { health } = setup();
    for (const ms of [30_000, 40_000, 50_000]) health.recordPollInterval(ms);
    health.recordFailure("x", "HTTP 500");
    health.recordSuccess();
    expect(health.snapshot()).toMatchObject({ medianPollIntervalMs: 40_000, failureCount: 1, lastSuccessAt: 0 });
  });

  it("never throws when messaging the owner fails", async () => {
    const health = new Health({ notifyOwner: async () => Promise.reject(new Error("telegram down")), now: () => 0 });
    await expect(health.restartNotice()).resolves.toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/health.test.ts`
Expected: FAIL — cannot resolve `../src/health/health.js`.

- [ ] **Step 3: Write the implementation**

`src/health/health.ts`:

```ts
import type { BackoffState } from "../poller/requestQueue.js";

export interface HealthOptions {
  notifyOwner: (text: string) => Promise<void>;
  now?: () => number;
  silenceMs?: number;
  staleMs?: number;
  overflowSilenceMs?: number;
}

export interface HealthSnapshot {
  startedAt: number;
  lastSuccessAt: number | null;
  backoff: BackoffState;
  failureCount: number;
  overflowCounts: Record<string, number>;
  layoutSuspects: string[];
  medianPollIntervalMs: number | null;
}

const MINUTE = 60_000;

export class Health {
  private readonly startedAt: number;
  private lastSuccessAt: number | null = null;
  private backoff: BackoffState = { active: false, level: 0, until: 0 };
  private failureCount = 0;
  private readonly overflowCounts = new Map<string, number>();
  private readonly layoutSuspects = new Set<string>();
  private readonly intervals: number[] = [];
  private readonly lastNotified = new Map<string, number>();

  constructor(private readonly opts: HealthOptions) {
    this.startedAt = this.now();
  }

  private now(): number {
    return (this.opts.now ?? Date.now)();
  }

  /** Message the owner unless the same condition was reported within silenceMs. Never throws. */
  private async notify(key: string, text: string, silenceMs = this.opts.silenceMs ?? 15 * MINUTE): Promise<void> {
    const now = this.now();
    const last = this.lastNotified.get(key);
    if (last !== undefined && now - last < silenceMs) return;
    this.lastNotified.set(key, now);
    try {
      await this.opts.notifyOwner(text);
    } catch {
      // owner messaging must never take the engine down
    }
  }

  async onBackoffChange(state: BackoffState): Promise<void> {
    const wasActive = this.backoff.active;
    this.backoff = state;
    if (state.active && !wasActive) {
      const minutes = Math.max(1, Math.round((state.until - this.now()) / MINUTE));
      await this.notify("backoff-start", `⚠️ Vinted is blocking requests. Pausing for ${minutes} min, then retrying with longer waits.`);
    } else if (!state.active && wasActive) {
      await this.notify("backoff-end", "✅ Vinted requests are working again.", 0);
    }
  }

  recordSuccess(): void {
    this.lastSuccessAt = this.now();
  }

  recordFailure(_termKey: string, _message: string): void {
    this.failureCount += 1;
  }

  async layoutSuspect(termKey: string): Promise<void> {
    this.layoutSuspects.add(termKey);
    await this.notify(`layout:${termKey}`, `🧩 Vinted layout may have changed: no items recognised for "${termKey}" 3 times in a row.`);
  }

  clearLayoutSuspect(termKey: string): void {
    this.layoutSuspects.delete(termKey);
  }

  async overflow(termKey: string): Promise<void> {
    this.overflowCounts.set(termKey, (this.overflowCounts.get(termKey) ?? 0) + 1);
    await this.notify(
      `overflow:${termKey}`,
      `🌊 "${termKey}" had a full page of new listings in one check, so some may have been missed.`,
      this.opts.overflowSilenceMs ?? 60 * MINUTE,
    );
  }

  recordPollInterval(ms: number): void {
    this.intervals.push(ms);
    if (this.intervals.length > 100) this.intervals.shift();
  }

  async checkStale(): Promise<void> {
    if (this.backoff.active) return;
    const reference = this.lastSuccessAt ?? this.startedAt;
    if (this.now() - reference >= (this.opts.staleMs ?? 5 * MINUTE)) {
      await this.notify("stale", "⏳ No successful Vinted request for 5 minutes.");
    }
  }

  async restartNotice(): Promise<void> {
    await this.notify("restart", "🔄 flipradar restarted after an unexpected stop.", 0);
  }

  snapshot(): HealthSnapshot {
    const sorted = [...this.intervals].sort((a, b) => a - b);
    return {
      startedAt: this.startedAt,
      lastSuccessAt: this.lastSuccessAt,
      backoff: this.backoff,
      failureCount: this.failureCount,
      overflowCounts: Object.fromEntries(this.overflowCounts),
      layoutSuspects: [...this.layoutSuspects],
      medianPollIntervalMs: sorted.length ? sorted[Math.floor(sorted.length / 2)]! : null,
    };
  }
}
```

- [ ] **Step 4: Run tests and type-check**

Run: `npx vitest run test/health.test.ts && npm run typecheck`
Expected: PASS; no type errors.

- [ ] **Step 5: Commit**

```bash
git add src/health/health.ts test/health.test.ts
git commit -m "feat: health monitor with rate-limited owner alerts"
```

---
### Task 13: Alert pipeline

**Files:**
- Create: `src/alerts/pipeline.ts`
- Test: `test/pipeline.test.ts`

**Interfaces:**
- Consumes: `activeSearchesForTerm` (Task 8); `getItem`, `saveItemDetail` (Task 9); `upsertPriceObservation`, `groupPrices` (Task 9); `createAlert` (Task 9); `cardStageMatch`, `detailStageMatch`, `effectivePricePence` (Task 3); `groupFor` (Task 6); `computeInsight` (Task 6); `ItemResult` (Task 11).
- Produces:
  - `interface NewCard { card: CardListing; firstSeenAt: number }`
  - `interface PipelineDeps { db: Db; fetchItem: (url: string) => Promise<ItemResult>; now: () => number }`
  - `INSIGHT_WINDOW_MS = 30 days`
  - `processNewItems(deps, termKey: string, newCards: NewCard[]): Promise<number>` — returns the number of alerts created. Item cards must already be in `items` (the poller upserts them first).

- [ ] **Step 1: Write the failing test**

`test/pipeline.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import { processNewItems } from "../src/alerts/pipeline.js";
import { listPendingAlerts } from "../src/db/alerts.js";
import { upsertItemCard } from "../src/db/items.js";
import { upsertPriceObservation } from "../src/db/prices.js";
import type { ItemResult } from "../src/vinted/client.js";
import type { CardListing } from "../src/vinted/types.js";
import { makeCard, makeDetail } from "./helpers/cards.js";
import { memoryDb, seedSearch, seedUser } from "./helpers/db.js";

function setup(itemResult: ItemResult = { kind: "ok", detail: makeDetail() }) {
  const db = memoryDb();
  seedUser(db, 111);
  const fetchItem = vi.fn(async (_url: string) => itemResult);
  const deps = { db, fetchItem, now: () => 5_000 };
  const seen = (card: CardListing) => {
    upsertItemCard(db, card, 2_000);
    return { card, firstSeenAt: 2_000 };
  };
  return { db, fetchItem, deps, seen };
}

describe("processNewItems", () => {
  it("creates one pending alert per matching search, once", async () => {
    const { db, fetchItem, deps, seen } = setup();
    const search = seedSearch(db, {}, 1_000);
    const item = seen(makeCard());
    expect(await processNewItems(deps, "iphone 15", [item])).toBe(1);
    expect(await processNewItems(deps, "iphone 15", [item])).toBe(0);
    expect(fetchItem).toHaveBeenCalledTimes(1);
    const [alert] = listPendingAlerts(db, 10);
    expect(alert).toMatchObject({ searchId: search.id, vintedId: "1001", detailsUnavailable: false, createdAt: 2_000, insight: { kind: "insufficient", n: 0 } });
  });

  it("ignores items first seen before the search became active", async () => {
    const { db, deps, seen } = setup();
    seedSearch(db, {}, 3_000);
    expect(await processNewItems(deps, "iphone 15", [seen(makeCard())])).toBe(0);
  });

  it("does not fetch details when no search passes the card stage", async () => {
    const { db, fetchItem, deps, seen } = setup();
    seedSearch(db, { maxPricePence: 100 }, 1_000);
    expect(await processNewItems(deps, "iphone 15", [seen(makeCard())])).toBe(0);
    expect(fetchItem).not.toHaveBeenCalled();
  });

  it("still alerts, flagged, when the item page cannot be read", async () => {
    const { db, deps, seen } = setup({ kind: "error", message: "HTTP 500" });
    seedSearch(db, {}, 1_000);
    expect(await processNewItems(deps, "iphone 15", [seen(makeCard())])).toBe(1);
    expect(listPendingAlerts(db, 10)[0]?.detailsUnavailable).toBe(true);
  });

  it("skips sold items", async () => {
    const { db, deps, seen } = setup({ kind: "ok", detail: makeDetail({ unavailable: true }) });
    seedSearch(db, {}, 1_000);
    expect(await processNewItems(deps, "iphone 15", [seen(makeCard())])).toBe(0);
  });

  it("applies description exclusions per search but fetches the page once", async () => {
    const { db, fetchItem, deps, seen } = setup({ kind: "ok", detail: makeDetail({ description: "iCloud locked, parts" }) });
    seedUser(db, 222);
    seedSearch(db, { userId: 111, excludeWords: ["icloud"] }, 1_000);
    const open = seedSearch(db, { userId: 222 }, 1_000);
    expect(await processNewItems(deps, "iphone 15", [seen(makeCard())])).toBe(1);
    expect(fetchItem).toHaveBeenCalledTimes(1);
    expect(listPendingAlerts(db, 10).map((alert) => alert.searchId)).toEqual([open.id]);
  });

  it("attaches median insight when 10+ comparable prices exist", async () => {
    const { db, deps, seen } = setup();
    seedSearch(db, {}, 1_000);
    for (let i = 0; i < 10; i += 1) {
      upsertPriceObservation(db, { vintedId: `c${i}`, groupKey: "iphone 15|iphone 15|128gb|good", modelKnown: true, pricePence: 30_000 + i * 1_000 }, 4_000);
    }
    await processNewItems(deps, "iphone 15", [seen(makeCard())]);
    expect(listPendingAlerts(db, 10)[0]?.insight).toEqual({ kind: "median", n: 10, medianPence: 34_500, diffPence: 8_180, percentile: 100 });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/pipeline.test.ts`
Expected: FAIL — cannot resolve `../src/alerts/pipeline.js`.

- [ ] **Step 3: Write the implementation**

`src/alerts/pipeline.ts`:

```ts
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
```

- [ ] **Step 4: Run tests and type-check**

Run: `npx vitest run test/pipeline.test.ts && npm run typecheck`
Expected: PASS; no type errors.

- [ ] **Step 5: Commit**

```bash
git add src/alerts/pipeline.ts test/pipeline.test.ts
git commit -m "feat: alert pipeline with single detail fetch and deal insight"
```

---

### Task 14: Poller — baseline, warm-up, new-item detection

**Files:**
- Create: `src/poller/poller.ts`
- Test: `test/poller.test.ts`

**Interfaces:**
- Consumes: `listActiveTerms`, `getTerm`, `markPolled`, `markSuccess`, `bumpEmptyStreak`, `setBaseline`, `setWarmedUp` (Task 8); `upsertItemCard`, `insertTermItems`, `touchTermItems`, `knownTermItemIds` (Task 9); `upsertPriceObservation` (Task 9); `groupFor` (Task 6); `effectivePricePence` (Task 3); `CatalogResult` (Task 11); `Priority` (Task 10); `NewCard` (Task 13); `Health` (Task 12).
- Produces:
  - `WARMUP_PAGES = [2, 3, 4, 5]`, `LAYOUT_ALARM_STREAK = 3`, `OVERFLOW_MIN_CARDS = 90`
  - `interface PollerDeps { db; fetchCatalog(termKey, page, priority): Promise<CatalogResult>; pipeline(termKey, cards: NewCard[]): Promise<number>; health: Pick<Health, "recordSuccess" | "recordFailure" | "layoutSuspect" | "clearLayoutSuspect" | "overflow" | "recordPollInterval">; minTermIntervalMs: number; now?: () => number; log?: { error(obj: object, msg: string): void } }`
  - `class Poller { dueTerm(): Term | undefined; pollTerm(termKey): Promise<void>; ensureFresh(termKey): Promise<void>; whenIdle(): Promise<void>; start(): void; stop(): void }`

- [ ] **Step 1: Write the failing test**

`test/poller.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import type { NewCard } from "../src/alerts/pipeline.js";
import { knownTermItemIds } from "../src/db/items.js";
import { getTerm, markPolled } from "../src/db/terms.js";
import { Poller } from "../src/poller/poller.js";
import type { Priority } from "../src/poller/requestQueue.js";
import type { CatalogResult } from "../src/vinted/client.js";
import { makeCard } from "./helpers/cards.js";
import { memoryDb, seedSearch, seedUser } from "./helpers/db.js";

const ok = (ids: string[]): CatalogResult => ({ kind: "ok", cards: ids.map((id) => makeCard({ vintedId: id, url: `https://www.vinted.co.uk/items/${id}` })) });

function setup() {
  const db = memoryDb();
  seedUser(db);
  seedSearch(db, {}, 0);
  const state = { now: 10_000, page1: ok(["1", "2"]) as CatalogResult, warm: new Map<number, CatalogResult>() };
  const fetchCatalog = vi.fn(async (_termKey: string, page: number, _priority: Priority): Promise<CatalogResult> =>
    page === 1 ? state.page1 : (state.warm.get(page) ?? { kind: "empty" }),
  );
  const pipeline = vi.fn(async (_termKey: string, _cards: NewCard[]) => 0);
  const health = {
    recordSuccess: vi.fn(),
    recordFailure: vi.fn(),
    layoutSuspect: vi.fn(async (_termKey: string) => {}),
    clearLayoutSuspect: vi.fn(),
    overflow: vi.fn(async (_termKey: string) => {}),
    recordPollInterval: vi.fn(),
  };
  const poller = new Poller({ db, fetchCatalog, pipeline, health, minTermIntervalMs: 30_000, now: () => state.now });
  return { db, state, fetchCatalog, pipeline, health, poller };
}

describe("Poller", () => {
  it("records a baseline without alerting, then warms up pages 2–5", async () => {
    const { db, state, fetchCatalog, pipeline, poller } = setup();
    state.warm.set(2, ok(["3"]));
    await poller.pollTerm("iphone 15");
    await poller.whenIdle();
    expect(pipeline).not.toHaveBeenCalled();
    expect(getTerm(db, "iphone 15")).toMatchObject({ baselineAt: 10_000, warmedUpAt: 10_000, lastSuccessAt: 10_000, hadResults: true });
    expect(knownTermItemIds(db, "iphone 15", ["1", "2", "3"])).toEqual(new Set(["1", "2"]));
    expect(db.prepare("SELECT COUNT(*) AS n FROM price_observations").get()).toEqual({ n: 3 });
    expect(fetchCatalog.mock.calls.map((call) => [call[1], call[2]])).toEqual([
      [1, "poll"],
      [2, "warmup"],
      [3, "warmup"],
    ]);
  });

  it("sends only new cards to the pipeline, stamped with the poll time", async () => {
    const { state, pipeline, health, poller } = setup();
    await poller.pollTerm("iphone 15");
    await poller.whenIdle();
    state.now = 50_000;
    state.page1 = ok(["4", "1", "2"]);
    await poller.pollTerm("iphone 15");
    expect(pipeline).toHaveBeenCalledTimes(1);
    const [termKey, cards] = pipeline.mock.calls[0]!;
    expect(termKey).toBe("iphone 15");
    expect(cards.map((c) => [c.card.vintedId, c.firstSeenAt])).toEqual([["4", 50_000]]);
    expect(health.recordPollInterval).toHaveBeenCalledWith(40_000);
  });

  it("picks the never-polled term first, then the least recently polled", () => {
    const { db, state, poller } = setup();
    seedSearch(db, { keywords: "ps5" }, 0);
    seedSearch(db, { keywords: "switch" }, 0);
    markPolled(db, "iphone 15", 10_000);
    markPolled(db, "ps5", 5_000);
    expect(poller.dueTerm()?.termKey).toBe("switch");
    markPolled(db, "switch", 39_000);
    state.now = 20_000;
    expect(poller.dueTerm()).toBeUndefined();
    state.now = 40_000;
    expect(poller.dueTerm()?.termKey).toBe("ps5");
  });

  it("reports overflow when a full page is entirely new", async () => {
    const { state, health, poller } = setup();
    await poller.pollTerm("iphone 15");
    await poller.whenIdle();
    state.page1 = ok(Array.from({ length: 96 }, (_, i) => String(1000 + i)));
    await poller.pollTerm("iphone 15");
    expect(health.overflow).toHaveBeenCalledWith("iphone 15");
  });

  it("raises the layout alarm after 3 unrecognised pages for a term that had results", async () => {
    const { state, health, poller } = setup();
    await poller.pollTerm("iphone 15");
    await poller.whenIdle();
    state.page1 = { kind: "unrecognised" };
    await poller.pollTerm("iphone 15");
    await poller.pollTerm("iphone 15");
    expect(health.layoutSuspect).not.toHaveBeenCalled();
    await poller.pollTerm("iphone 15");
    expect(health.layoutSuspect).toHaveBeenCalledWith("iphone 15");
  });

  it("records failures and leaves state alone when blocked", async () => {
    const { db, state, health, pipeline, poller } = setup();
    state.page1 = { kind: "error", message: "HTTP 500" };
    await poller.pollTerm("iphone 15");
    expect(health.recordFailure).toHaveBeenCalledWith("iphone 15", "HTTP 500");
    state.page1 = { kind: "blocked", status: 429 };
    await poller.pollTerm("iphone 15");
    expect(getTerm(db, "iphone 15")).toMatchObject({ baselineAt: null, lastPolledAt: 10_000, lastSuccessAt: null });
    expect(pipeline).not.toHaveBeenCalled();
  });

  it("treats an empty search as a successful baseline", async () => {
    const { db, state, poller } = setup();
    state.page1 = { kind: "empty" };
    await poller.pollTerm("iphone 15");
    expect(getTerm(db, "iphone 15")).toMatchObject({ baselineAt: 10_000, lastSuccessAt: 10_000, hadResults: false });
  });

  it("ensureFresh polls only before the baseline, and concurrent polls share one fetch", async () => {
    const { fetchCatalog, poller } = setup();
    await Promise.all([poller.ensureFresh("iphone 15"), poller.pollTerm("iphone 15")]);
    await poller.whenIdle();
    const page1Calls = () => fetchCatalog.mock.calls.filter((call) => call[1] === 1).length;
    expect(page1Calls()).toBe(1);
    await poller.ensureFresh("iphone 15");
    expect(page1Calls()).toBe(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/poller.test.ts`
Expected: FAIL — cannot resolve `../src/poller/poller.js`.

- [ ] **Step 3: Write the implementation**

`src/poller/poller.ts`:

```ts
import type { NewCard } from "../alerts/pipeline.js";
import type { Db } from "../db/database.js";
import { insertTermItems, knownTermItemIds, touchTermItems, upsertItemCard } from "../db/items.js";
import { upsertPriceObservation } from "../db/prices.js";
import { bumpEmptyStreak, getTerm, listActiveTerms, markPolled, markSuccess, setBaseline, setWarmedUp, type Term } from "../db/terms.js";
import type { Health } from "../health/health.js";
import { groupFor } from "../insight/groups.js";
import { effectivePricePence } from "../matching/match.js";
import type { CatalogResult } from "../vinted/client.js";
import type { CardListing } from "../vinted/types.js";
import type { Priority } from "./requestQueue.js";

export const WARMUP_PAGES = [2, 3, 4, 5];
export const LAYOUT_ALARM_STREAK = 3;
export const OVERFLOW_MIN_CARDS = 90;

export interface PollerDeps {
  db: Db;
  fetchCatalog: (termKey: string, page: number, priority: Priority) => Promise<CatalogResult>;
  pipeline: (termKey: string, cards: NewCard[]) => Promise<number>;
  health: Pick<Health, "recordSuccess" | "recordFailure" | "layoutSuspect" | "clearLayoutSuspect" | "overflow" | "recordPollInterval">;
  minTermIntervalMs: number;
  now?: () => number;
  log?: { error(obj: object, msg: string): void };
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export class Poller {
  private running = false;
  private readonly inFlight = new Map<string, Promise<void>>();
  private readonly warmups = new Map<string, Promise<void>>();

  constructor(private readonly deps: PollerDeps) {}

  private now(): number {
    return (this.deps.now ?? Date.now)();
  }

  /** The due term polled longest ago (never-polled terms first). */
  dueTerm(): Term | undefined {
    const now = this.now();
    return listActiveTerms(this.deps.db)
      .filter((term) => term.lastPolledAt === null || now - term.lastPolledAt >= this.deps.minTermIntervalMs)
      .sort((a, b) => (a.lastPolledAt ?? -1) - (b.lastPolledAt ?? -1))[0];
  }

  /** Concurrent calls for the same term share one poll. */
  pollTerm(termKey: string): Promise<void> {
    const existing = this.inFlight.get(termKey);
    if (existing) return existing;
    const poll = this.doPoll(termKey).finally(() => this.inFlight.delete(termKey));
    this.inFlight.set(termKey, poll);
    return poll;
  }

  /** Used by the search preview: make sure a brand-new term has a baseline. */
  async ensureFresh(termKey: string): Promise<void> {
    const inFlight = this.inFlight.get(termKey);
    if (inFlight) return inFlight;
    if (!getTerm(this.deps.db, termKey)?.baselineAt) await this.pollTerm(termKey);
  }

  async whenIdle(): Promise<void> {
    await Promise.all([...this.inFlight.values(), ...this.warmups.values()]);
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    void this.loop();
  }

  stop(): void {
    this.running = false;
  }

  private async loop(): Promise<void> {
    while (this.running) {
      const term = this.dueTerm();
      if (!term) {
        await sleep(500);
        continue;
      }
      try {
        await this.pollTerm(term.termKey);
      } catch (error) {
        this.deps.log?.error({ err: error, termKey: term.termKey }, "poll failed");
      }
    }
  }

  private recordCards(termKey: string, cards: CardListing[], now: number): void {
    for (const card of cards) {
      upsertItemCard(this.deps.db, card, now);
      const price = effectivePricePence(card);
      if (price === null) continue;
      const group = groupFor(termKey, card);
      upsertPriceObservation(this.deps.db, { vintedId: card.vintedId, groupKey: group.groupKey, modelKnown: group.modelKnown, pricePence: price }, now);
    }
  }

  private async doPoll(termKey: string): Promise<void> {
    const before = getTerm(this.deps.db, termKey);
    const startedAt = this.now();
    if (before?.lastPolledAt != null) this.deps.health.recordPollInterval(startedAt - before.lastPolledAt);
    markPolled(this.deps.db, termKey, startedAt);

    const result = await this.deps.fetchCatalog(termKey, 1, "poll");
    const now = this.now();

    switch (result.kind) {
      case "blocked":
        return; // the request queue is already backing off
      case "error":
        this.deps.health.recordFailure(termKey, result.message);
        return;
      case "unrecognised": {
        const streak = bumpEmptyStreak(this.deps.db, termKey);
        if (before?.hadResults && streak >= LAYOUT_ALARM_STREAK) await this.deps.health.layoutSuspect(termKey);
        return;
      }
      case "empty":
        markSuccess(this.deps.db, termKey, now, false);
        this.deps.health.recordSuccess();
        this.deps.health.clearLayoutSuspect(termKey);
        if (!before?.baselineAt) setBaseline(this.deps.db, termKey, now);
        return;
      case "ok":
        break;
    }

    const cards = result.cards;
    this.recordCards(termKey, cards, now);
    markSuccess(this.deps.db, termKey, now, cards.length > 0);
    this.deps.health.recordSuccess();
    this.deps.health.clearLayoutSuspect(termKey);
    const ids = cards.map((card) => card.vintedId);

    if (!before?.baselineAt) {
      insertTermItems(this.deps.db, termKey, ids, now);
      setBaseline(this.deps.db, termKey, now);
      this.startWarmUp(termKey);
      return;
    }

    const known = knownTermItemIds(this.deps.db, termKey, ids);
    const fresh = cards.filter((card) => !known.has(card.vintedId));
    touchTermItems(this.deps.db, termKey, [...known], now);
    insertTermItems(this.deps.db, termKey, fresh.map((card) => card.vintedId), now);
    if (!before.warmedUpAt) this.startWarmUp(termKey);
    if (cards.length >= OVERFLOW_MIN_CARDS && fresh.length === cards.length) await this.deps.health.overflow(termKey);
    if (fresh.length > 0) await this.deps.pipeline(termKey, fresh.map((card) => ({ card, firstSeenAt: now })));
  }

  private startWarmUp(termKey: string): void {
    if (this.warmups.has(termKey)) return;
    const warmup = this.warmUp(termKey)
      .catch((error: unknown) => this.deps.log?.error({ err: error, termKey }, "warm-up failed"))
      .finally(() => this.warmups.delete(termKey));
    this.warmups.set(termKey, warmup);
  }

  /** Pages 2–5 feed price data only; on a block or error, the next poll retries. */
  private async warmUp(termKey: string): Promise<void> {
    for (const page of WARMUP_PAGES) {
      const result = await this.deps.fetchCatalog(termKey, page, "warmup");
      if (result.kind === "empty") break;
      if (result.kind !== "ok") return;
      this.recordCards(termKey, result.cards, this.now());
    }
    setWarmedUp(this.deps.db, termKey, this.now());
  }
}
```

- [ ] **Step 4: Run tests and type-check**

Run: `npx vitest run test/poller.test.ts && npm run typecheck`
Expected: PASS; no type errors.

- [ ] **Step 5: Commit**

```bash
git add src/poller/poller.ts test/poller.test.ts
git commit -m "feat: poller with baseline, warm-up, new-item detection and alarms"
```

---

### Task 15: Message formatting and flood control

**Files:**
- Create: `src/alerts/format.ts`, `src/alerts/flood.ts`
- Test: `test/format.test.ts`

**Interfaces:**
- Consumes: `CONDITION_LABELS`, `ConditionCode` (Task 3); `Insight` (Task 6); `StoredItem` (Task 9).
- Produces:
  - `interface InlineButton { text: string; url?: string; callback_data?: string }`, `interface InlineMarkup { inline_keyboard: InlineButton[][] }`
  - `CAPTION_LIMIT = 1024`, `escapeHtml(text): string`, `formatPence(pence): string`, `formatPounds(pence): string`, `conditionLabel(code): string | null`, `insightLine(insight: Insight | null): string | null`, `alertCaption(item: StoredItem, insight: Insight | null, detailsUnavailable: boolean): string`, `alertMarkup(searchId: number, url: string): InlineMarkup`, `digestText(keywords: string, items: StoredItem[], heldCount: number): string`
  - `FLOOD_LIMIT = 10`, `FLOOD_WINDOW_MS = 600_000`, `shouldHold(recentSentAt: number[], now: number): boolean`, `digestDue(recentSentAt: number[], heldCreatedAt: number[], now: number): boolean`

- [ ] **Step 1: Write the failing test**

`test/format.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { digestDue, FLOOD_WINDOW_MS, shouldHold } from "../src/alerts/flood.js";
import { alertCaption, alertMarkup, CAPTION_LIMIT, digestText, formatPence, formatPounds, insightLine } from "../src/alerts/format.js";
import type { StoredItem } from "../src/db/items.js";
import { makeCard, makeDetail } from "./helpers/cards.js";

const stored = (overrides: Partial<StoredItem> = {}): StoredItem => ({
  ...makeCard(),
  cardSeenAt: 0,
  detail: makeDetail(),
  detailFetchedAt: 0,
  ...overrides,
});

describe("money", () => {
  it("formats pence", () => {
    expect(formatPence(26320)).toBe("£263.20");
    expect(formatPence(123456)).toBe("£1,234.56");
    expect(formatPounds(5849)).toBe("£58");
  });
});

describe("insightLine", () => {
  it("renders each kind", () => {
    expect(insightLine(null)).toBeNull();
    expect(insightLine({ kind: "insufficient", n: 3 })).toBe("📊 Not enough price data yet");
    expect(insightLine({ kind: "rough", n: 40, percentile: 75 })).toBe("💰 Cheaper than 75% of 40 similar (rough)");
    expect(insightLine({ kind: "median", n: 47, medianPence: 32100, diffPence: 5800, percentile: 91 })).toBe(
      "💰 <b>£58 below typical</b> · cheaper than 91% of 47 similar",
    );
    expect(insightLine({ kind: "median", n: 12, medianPence: 30000, diffPence: -2500, percentile: 20 })).toBe(
      "💰 £25 above typical · cheaper than 20% of 12 similar",
    );
    expect(insightLine({ kind: "median", n: 12, medianPence: 30000, diffPence: 40, percentile: 50 })).toBe(
      "💰 About the typical price · cheaper than 50% of 12 similar",
    );
  });
});

describe("alertCaption", () => {
  it("shows title, condition, brand, fee breakdown, insight and seller", () => {
    const caption = alertCaption(stored(), { kind: "median", n: 47, medianPence: 32100, diffPence: 5780, percentile: 91 }, false);
    expect(caption).toBe(
      [
        "🔔 <b>iPhone 15 128GB</b> · Very good · Apple",
        "£263.20 (£249.99 + £13.21 fee) + postage",
        "💰 <b>£58 below typical</b> · cheaper than 91% of 47 similar",
        "⭐ Seller 98% (122 reviews) · Uploaded 2 min ago",
      ].join("\n"),
    );
  });

  it("omits missing parts and flags unavailable details", () => {
    const caption = alertCaption(stored({ brand: null, condition: "unknown", pricePence: null, detail: null }), null, true);
    expect(caption).toBe(["🔔 <b>iPhone 15 128GB</b>", "£249.99 + postage", "ℹ️ Details unavailable, check the listing"].join("\n"));
  });

  it("escapes HTML and stays within Telegram's caption limit (Review Focus 5)", () => {
    const title = "<b>&amp;</b> ".repeat(60);
    const caption = alertCaption(stored({ title, brand: "R&D <Labs>" }), null, false);
    expect(caption.length).toBeLessThanOrEqual(CAPTION_LIMIT);
    expect(caption).toContain("&lt;b&gt;&amp;amp;");
    expect(caption).toContain("R&amp;D &lt;Labs&gt;");
    expect(caption).not.toContain("<b>&amp;</b>");
  });
});

describe("markup and digest", () => {
  it("links to the listing and offers pause", () => {
    expect(alertMarkup(7, "https://www.vinted.co.uk/items/1")).toEqual({
      inline_keyboard: [[{ text: "Open on Vinted", url: "https://www.vinted.co.uk/items/1" }, { text: "⏸ Pause search", callback_data: "pause:7" }]],
    });
  });

  it("lists up to 5 held items", () => {
    const items = Array.from({ length: 6 }, (_, i) => stored({ vintedId: String(i), title: `Item ${i} <x>`, url: `https://v/${i}` }));
    const text = digestText("iphone 15", items, 8);
    expect(text.split("\n")[0]).toBe('📦 <b>8 more matches</b> for "iphone 15" in the last few minutes:');
    expect(text).toContain('• <a href="https://v/0">Item 0 &lt;x&gt;</a> · £263.20');
    expect(text).not.toContain("Item 5");
    expect(text).toContain("…and 3 more.");
  });
});

describe("flood control", () => {
  const now = 10 * FLOOD_WINDOW_MS;
  const recent = (count: number) => Array.from({ length: count }, (_, i) => now - 1000 * (i + 1));

  it("holds after 10 sends in the window", () => {
    expect(shouldHold(recent(9), now)).toBe(false);
    expect(shouldHold(recent(10), now)).toBe(true);
    expect(shouldHold([...recent(9), now - FLOOD_WINDOW_MS - 1], now)).toBe(false);
  });

  it("sends a digest when the flood ends or the oldest held alert is 10 minutes old", () => {
    expect(digestDue(recent(10), [], now)).toBe(false);
    expect(digestDue(recent(10), [now - 1000], now)).toBe(false);
    expect(digestDue(recent(5), [now - 1000], now)).toBe(true);
    expect(digestDue(recent(10), [now - FLOOD_WINDOW_MS], now)).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/format.test.ts`
Expected: FAIL — cannot resolve `../src/alerts/flood.js`.

- [ ] **Step 3: Write the implementation**

`src/alerts/flood.ts`:

```ts
export const FLOOD_LIMIT = 10;
export const FLOOD_WINDOW_MS = 10 * 60_000;

/** True when this search already had FLOOD_LIMIT alerts sent inside the window. */
export function shouldHold(recentSentAt: number[], now: number): boolean {
  return recentSentAt.filter((sentAt) => sentAt > now - FLOOD_WINDOW_MS).length >= FLOOD_LIMIT;
}

/** Send held alerts as one digest once the flood has passed, or after one window at most. */
export function digestDue(recentSentAt: number[], heldCreatedAt: number[], now: number): boolean {
  if (heldCreatedAt.length === 0) return false;
  return !shouldHold(recentSentAt, now) || Math.min(...heldCreatedAt) <= now - FLOOD_WINDOW_MS;
}
```

`src/alerts/format.ts`:

```ts
import type { StoredItem } from "../db/items.js";
import type { Insight } from "../insight/stats.js";
import { CONDITION_LABELS, type ConditionCode } from "../matching/conditions.js";

export interface InlineButton {
  text: string;
  url?: string;
  callback_data?: string;
}

export interface InlineMarkup {
  inline_keyboard: InlineButton[][];
}

export const CAPTION_LIMIT = 1024;
const TITLE_LIMIT = 120;

export function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function truncate(text: string, limit: number): string {
  return text.length <= limit ? text : `${text.slice(0, limit - 1).trimEnd()}…`;
}

export function formatPence(pence: number): string {
  return `£${(pence / 100).toLocaleString("en-GB", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export function formatPounds(pence: number): string {
  return `£${Math.round(pence / 100).toLocaleString("en-GB")}`;
}

export function conditionLabel(code: ConditionCode): string | null {
  return code === "unknown" ? null : CONDITION_LABELS[code];
}

export function insightLine(insight: Insight | null): string | null {
  if (!insight) return null;
  switch (insight.kind) {
    case "insufficient":
      return "📊 Not enough price data yet";
    case "rough":
      return `💰 Cheaper than ${insight.percentile}% of ${insight.n} similar (rough)`;
    case "median": {
      const tail = `cheaper than ${insight.percentile}% of ${insight.n} similar`;
      if (Math.abs(insight.diffPence) < 100) return `💰 About the typical price · ${tail}`;
      if (insight.diffPence > 0) return `💰 <b>${formatPounds(insight.diffPence)} below typical</b> · ${tail}`;
      return `💰 ${formatPounds(-insight.diffPence)} above typical · ${tail}`;
    }
  }
}

function priceLine(item: StoredItem): string | null {
  const total = item.pricePence;
  const base = item.itemPricePence;
  if (total !== null && base !== null && total > base) {
    return `${formatPence(total)} (${formatPence(base)} + ${formatPence(total - base)} fee) + postage`;
  }
  const only = total ?? base;
  return only === null ? null : `${formatPence(only)} + postage`;
}

function sellerLine(item: StoredItem): string | null {
  const detail = item.detail;
  if (!detail) return null;
  const parts: string[] = [];
  if (detail.sellerRating !== null) {
    const reviews = detail.sellerFeedbackCount !== null ? ` (${detail.sellerFeedbackCount} reviews)` : "";
    parts.push(`Seller ${Math.round(detail.sellerRating * 100)}%${reviews}`);
  }
  if (detail.uploadedText) parts.push(`Uploaded ${escapeHtml(detail.uploadedText)}`);
  return parts.length ? `⭐ ${parts.join(" · ")}` : null;
}

export function alertCaption(item: StoredItem, insight: Insight | null, detailsUnavailable: boolean): string {
  const header = [
    `🔔 <b>${escapeHtml(truncate(item.title || "Untitled listing", TITLE_LIMIT))}</b>`,
    conditionLabel(item.condition),
    item.brand ? escapeHtml(truncate(item.brand, 40)) : null,
  ]
    .filter(Boolean)
    .join(" · ");
  const lines = [header, priceLine(item), insightLine(insight), sellerLine(item)];
  if (detailsUnavailable) lines.push("ℹ️ Details unavailable, check the listing");
  return lines.filter((line): line is string => Boolean(line)).join("\n");
}

export function alertMarkup(searchId: number, url: string): InlineMarkup {
  return {
    inline_keyboard: [[{ text: "Open on Vinted", url }, { text: "⏸ Pause search", callback_data: `pause:${searchId}` }]],
  };
}

export function digestText(keywords: string, items: StoredItem[], heldCount: number): string {
  const shown = items.slice(0, 5);
  const lines = [`📦 <b>${heldCount} more matches</b> for "${escapeHtml(keywords)}" in the last few minutes:`];
  for (const item of shown) {
    const price = item.pricePence ?? item.itemPricePence;
    lines.push(`• <a href="${escapeHtml(item.url)}">${escapeHtml(truncate(item.title, 80))}</a>${price === null ? "" : ` · ${formatPence(price)}`}`);
  }
  if (heldCount > shown.length) lines.push(`…and ${heldCount - shown.length} more.`);
  lines.push("Too many? Pause this search in /searches and create a narrower one.");
  return lines.join("\n");
}
```

- [ ] **Step 4: Run tests and type-check**

Run: `npx vitest run test/format.test.ts && npm run typecheck`
Expected: PASS; no type errors.

- [ ] **Step 5: Commit**

```bash
git add src/alerts/format.ts src/alerts/flood.ts test/format.test.ts
git commit -m "feat: alert/digest formatting and flood control rules"
```

---

### Task 16: Notifier

**Files:**
- Create: `src/alerts/notifier.ts`
- Test: `test/notifier.test.ts`

**Interfaces:**
- Consumes: `listPendingAlerts`, `setAlertStatus`, `sentTimesForSearch`, `heldAlertsForSearch`, `searchesWithHeldAlerts`, `dropStalePending`, `PendingAlert` (Task 9); `getItem` (Task 9); `getSearch`, `pauseAllSearchesForUser` (Task 8); `setBotBlocked` (Task 7); `alertCaption`, `alertMarkup`, `digestText`, `InlineMarkup` (Task 15); `shouldHold`, `digestDue`, `FLOOD_WINDOW_MS` (Task 15).
- Produces:
  - `interface TelegramSender { sendMessage(chatId: number, text: string, other?: { parse_mode?: "HTML"; reply_markup?: InlineMarkup; link_preview_options?: { is_disabled: boolean } }): Promise<unknown>; sendPhoto(chatId: number, photo: string, other?: { caption?: string; parse_mode?: "HTML"; reply_markup?: InlineMarkup }): Promise<unknown> }`
  - `type TelegramFailure`, `classifyTelegramError(error: unknown): TelegramFailure`
  - `STALE_PENDING_MS = 600_000`
  - `interface NotifierOptions { db; api: TelegramSender; now?; sleep?; perChatGapMs?; globalGapMs?; retryDelaysMs?; log? }`
  - `class Notifier { dropStale(): number; tick(): Promise<void>; start(intervalMs?): void; stop(flushMs?): Promise<void> }`

- [ ] **Step 1: Write the failing test**

`test/notifier.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import { FLOOD_WINDOW_MS } from "../src/alerts/flood.js";
import { classifyTelegramError, Notifier, type TelegramSender } from "../src/alerts/notifier.js";
import { createAlert, getAlert, setAlertStatus } from "../src/db/alerts.js";
import { saveItemDetail, upsertItemCard } from "../src/db/items.js";
import { getSearch, setSearchStatus } from "../src/db/searches.js";
import { getUser } from "../src/db/users.js";
import { makeCard, makeDetail } from "./helpers/cards.js";
import { memoryDb, seedSearch, seedUser } from "./helpers/db.js";

function telegramError(error_code: number, description: string, retry_after?: number) {
  return Object.assign(new Error(description), { error_code, description, parameters: retry_after ? { retry_after } : {} });
}

function setup() {
  const db = memoryDb();
  seedUser(db, 111);
  const search = seedSearch(db, {}, 0);
  let now = 1_000_000;
  const api = {
    sendMessage: vi.fn<TelegramSender["sendMessage"]>(async () => ({})),
    sendPhoto: vi.fn<TelegramSender["sendPhoto"]>(async () => ({})),
  };
  const sleep = vi.fn(async (ms: number) => {
    now += ms;
  });
  const notifier = new Notifier({ db, api, now: () => now, sleep, retryDelaysMs: [2000, 4000, 8000] });
  const addAlert = (vintedId: string, createdAt = now) => {
    upsertItemCard(db, makeCard({ vintedId, url: `https://www.vinted.co.uk/items/${vintedId}` }), createdAt);
    saveItemDetail(db, vintedId, makeDetail(), createdAt);
    return createAlert(db, { searchId: search.id, vintedId, insight: null, detailsUnavailable: false, createdAt })!;
  };
  return { db, search, api, sleep, notifier, addAlert, advance: (ms: number) => (now += ms), nowValue: () => now };
}

describe("classifyTelegramError", () => {
  it("recognises Telegram failure kinds", () => {
    expect(classifyTelegramError(telegramError(429, "Too Many Requests", 7))).toEqual({ kind: "retry_after", seconds: 7 });
    expect(classifyTelegramError(telegramError(403, "Forbidden: bot was blocked by the user"))).toEqual({ kind: "blocked" });
    expect(classifyTelegramError(telegramError(400, "Bad Request: wrong file"))).toEqual({ kind: "bad_request", description: "Bad Request: wrong file" });
    expect(classifyTelegramError(new Error("socket hang up"))).toEqual({ kind: "other", description: "socket hang up" });
  });
});

describe("Notifier", () => {
  it("sends a pending alert as a photo with caption and buttons", async () => {
    const { db, api, notifier, addAlert, search } = setup();
    const alert = addAlert("1");
    await notifier.tick();
    expect(api.sendPhoto).toHaveBeenCalledTimes(1);
    const [chatId, photo, other] = api.sendPhoto.mock.calls[0]!;
    expect(chatId).toBe(111);
    expect(photo).toBe(makeCard().photoUrl);
    expect(other?.caption).toContain("iPhone 15 128GB");
    expect(other?.reply_markup?.inline_keyboard[0]?.[1]?.callback_data).toBe(`pause:${search.id}`);
    expect(getAlert(db, alert.id)?.status).toBe("sent");
  });

  it("falls back to a text message when Telegram rejects the photo", async () => {
    const { db, api, notifier, addAlert } = setup();
    api.sendPhoto.mockRejectedValueOnce(telegramError(400, "Bad Request: wrong file identifier"));
    const alert = addAlert("1");
    await notifier.tick();
    expect(api.sendMessage).toHaveBeenCalledTimes(1);
    expect(getAlert(db, alert.id)?.status).toBe("sent");
  });

  it("waits retry_after on 429 then succeeds", async () => {
    const { db, api, sleep, notifier, addAlert } = setup();
    api.sendPhoto.mockRejectedValueOnce(telegramError(429, "Too Many Requests", 3));
    const alert = addAlert("1");
    await notifier.tick();
    expect(sleep).toHaveBeenCalledWith(3000);
    expect(getAlert(db, alert.id)?.status).toBe("sent");
  });

  it("marks the alert failed after retries are exhausted", async () => {
    const { db, api, sleep, notifier, addAlert } = setup();
    api.sendPhoto.mockRejectedValue(new Error("network down"));
    const alert = addAlert("1");
    await notifier.tick();
    expect(api.sendPhoto).toHaveBeenCalledTimes(4);
    expect(sleep.mock.calls.map(([ms]) => ms).filter((ms) => ms >= 2000)).toEqual([2000, 4000, 8000]);
    expect(getAlert(db, alert.id)?.status).toBe("failed");
  });

  it("pauses everything for a user who blocked the bot", async () => {
    const { db, api, notifier, addAlert, search } = setup();
    api.sendPhoto.mockRejectedValue(telegramError(403, "Forbidden: bot was blocked by the user"));
    const alert = addAlert("1");
    await notifier.tick();
    expect(getAlert(db, alert.id)?.status).toBe("failed");
    expect(getUser(db, 111)?.botBlocked).toBe(true);
    expect(getSearch(db, search.id)?.status).toBe("paused");
  });

  it("drops alerts for paused searches", async () => {
    const { db, api, notifier, addAlert, search } = setup();
    const alert = addAlert("1");
    setSearchStatus(db, search.id, "paused", 0);
    await notifier.tick();
    expect(api.sendPhoto).not.toHaveBeenCalled();
    expect(getAlert(db, alert.id)?.status).toBe("dropped");
  });

  it("keeps at least 1.1 s between messages to the same chat", async () => {
    const { api, sleep, notifier, addAlert } = setup();
    addAlert("1");
    addAlert("2");
    await notifier.tick();
    expect(api.sendPhoto).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(1100);
  });

  it("holds alerts during a flood and later sends one digest", async () => {
    const { db, api, notifier, addAlert, advance, nowValue } = setup();
    for (let i = 0; i < 10; i += 1) setAlertStatus(db, addAlert(`s${i}`).id, "sent", nowValue());
    const held = [addAlert("h1"), addAlert("h2")];
    await notifier.tick();
    expect(held.map((alert) => getAlert(db, alert.id)?.status)).toEqual(["digested", "digested"]);
    expect(api.sendMessage).not.toHaveBeenCalled();
    advance(FLOOD_WINDOW_MS + 1);
    await notifier.tick();
    expect(api.sendMessage).toHaveBeenCalledTimes(1);
    expect(api.sendMessage.mock.calls[0]?.[1]).toContain("2 more matches");
    expect(held.map((alert) => getAlert(db, alert.id)?.status)).toEqual(["digest_sent", "digest_sent"]);
  });

  it("drops pending alerts older than 10 minutes at startup", () => {
    const { db, notifier, addAlert, nowValue } = setup();
    const stale = addAlert("old", nowValue() - 11 * 60_000);
    const fresh = addAlert("new");
    expect(notifier.dropStale()).toBe(1);
    expect(getAlert(db, stale.id)?.status).toBe("dropped");
    expect(getAlert(db, fresh.id)?.status).toBe("pending");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/notifier.test.ts`
Expected: FAIL — cannot resolve `../src/alerts/notifier.js`.

- [ ] **Step 3: Write the implementation**

`src/alerts/notifier.ts`:

```ts
import {
  dropStalePending,
  heldAlertsForSearch,
  listPendingAlerts,
  searchesWithHeldAlerts,
  sentTimesForSearch,
  setAlertStatus,
  type PendingAlert,
} from "../db/alerts.js";
import type { Db } from "../db/database.js";
import { getItem, type StoredItem } from "../db/items.js";
import { getSearch, pauseAllSearchesForUser } from "../db/searches.js";
import { setBotBlocked } from "../db/users.js";
import { digestDue, FLOOD_WINDOW_MS, shouldHold } from "./flood.js";
import { alertCaption, alertMarkup, digestText, type InlineMarkup } from "./format.js";

export interface TelegramSender {
  sendMessage(
    chatId: number,
    text: string,
    other?: { parse_mode?: "HTML"; reply_markup?: InlineMarkup; link_preview_options?: { is_disabled: boolean } },
  ): Promise<unknown>;
  sendPhoto(chatId: number, photo: string, other?: { caption?: string; parse_mode?: "HTML"; reply_markup?: InlineMarkup }): Promise<unknown>;
}

export type TelegramFailure =
  | { kind: "retry_after"; seconds: number }
  | { kind: "blocked" }
  | { kind: "bad_request"; description: string }
  | { kind: "other"; description: string };

/** grammY's GrammyError carries error_code, description and parameters.retry_after. */
export function classifyTelegramError(error: unknown): TelegramFailure {
  const e = error as { error_code?: number; description?: string; parameters?: { retry_after?: number } } | null;
  const description = e?.description ?? (error instanceof Error ? error.message : String(error));
  if (e?.error_code === 429) return { kind: "retry_after", seconds: e.parameters?.retry_after ?? 5 };
  if (e?.error_code === 403) return { kind: "blocked" };
  if (e?.error_code === 400) return { kind: "bad_request", description };
  return { kind: "other", description };
}

export const STALE_PENDING_MS = 10 * 60_000;

export interface NotifierOptions {
  db: Db;
  api: TelegramSender;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  perChatGapMs?: number;
  globalGapMs?: number;
  retryDelaysMs?: number[];
  log?: { error(obj: object, msg: string): void };
}

interface Outgoing {
  photo?: string | null;
  caption?: string;
  text?: string;
  markup?: InlineMarkup;
}

const realSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export class Notifier {
  private readonly lastSendByChat = new Map<number, number>();
  private lastSendAny = Number.NEGATIVE_INFINITY;
  private running = false;
  private timer: NodeJS.Timeout | null = null;
  private current: Promise<void> | null = null;

  constructor(private readonly opts: NotifierOptions) {}

  private now(): number {
    return (this.opts.now ?? Date.now)();
  }

  private sleep(ms: number): Promise<void> {
    return (this.opts.sleep ?? realSleep)(ms);
  }

  /** Startup: an alert that waited more than 10 minutes is no longer worth sending. */
  dropStale(): number {
    return dropStalePending(this.opts.db, this.now() - STALE_PENDING_MS);
  }

  async tick(): Promise<void> {
    for (const alert of listPendingAlerts(this.opts.db, 50)) await this.handle(alert);
    for (const searchId of searchesWithHeldAlerts(this.opts.db)) await this.maybeDigest(searchId);
  }

  start(intervalMs = 500): void {
    if (this.running) return;
    this.running = true;
    const loop = () => {
      this.current = this.tick()
        .catch((error: unknown) => this.opts.log?.error({ err: error }, "notifier tick failed"))
        .finally(() => {
          this.current = null;
          if (this.running) this.timer = setTimeout(loop, intervalMs);
        });
    };
    loop();
  }

  async stop(flushMs = 5000): Promise<void> {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    if (this.current) await Promise.race([this.current, realSleep(flushMs)]);
  }

  private async handle(alert: PendingAlert): Promise<void> {
    const { db } = this.opts;
    const search = getSearch(db, alert.searchId);
    const item = getItem(db, alert.vintedId);
    if (!search || search.status !== "active" || !item) {
      setAlertStatus(db, alert.id, "dropped");
      return;
    }
    const now = this.now();
    if (shouldHold(sentTimesForSearch(db, search.id, now - FLOOD_WINDOW_MS), now)) {
      setAlertStatus(db, alert.id, "digested");
      return;
    }
    const delivered = await this.deliver(alert.chatId, {
      photo: item.photoUrl,
      caption: alertCaption(item, alert.insight, alert.detailsUnavailable),
      markup: alertMarkup(search.id, item.url),
    });
    if (delivered) setAlertStatus(db, alert.id, "sent", this.now());
    else setAlertStatus(db, alert.id, "failed");
  }

  private async maybeDigest(searchId: number): Promise<void> {
    const { db } = this.opts;
    const held = heldAlertsForSearch(db, searchId);
    const now = this.now();
    if (!digestDue(sentTimesForSearch(db, searchId, now - FLOOD_WINDOW_MS), held.map((alert) => alert.createdAt), now)) return;
    const search = getSearch(db, searchId);
    if (!search || search.status !== "active") {
      for (const alert of held) setAlertStatus(db, alert.id, "dropped");
      return;
    }
    const items = held.map((alert) => getItem(db, alert.vintedId)).filter((item): item is StoredItem => item !== undefined);
    const delivered = await this.deliver(search.userId, { text: digestText(search.keywords, items, held.length) });
    for (const alert of held) setAlertStatus(db, alert.id, delivered ? "digest_sent" : "failed", delivered ? this.now() : null);
  }

  /** Telegram send with pacing, 429 handling, photo→text fallback and 2/4/8 s retries. */
  private async deliver(chatId: number, message: Outgoing): Promise<boolean> {
    const delays = this.opts.retryDelaysMs ?? [2000, 4000, 8000];
    let usePhoto = Boolean(message.photo);
    for (let attempt = 0; attempt <= delays.length; attempt += 1) {
      await this.pace(chatId);
      try {
        if (usePhoto && message.photo) {
          await this.opts.api.sendPhoto(chatId, message.photo, { caption: message.caption, parse_mode: "HTML", reply_markup: message.markup });
        } else {
          await this.opts.api.sendMessage(chatId, message.text ?? message.caption ?? "", {
            parse_mode: "HTML",
            reply_markup: message.markup,
            link_preview_options: { is_disabled: true },
          });
        }
        return true;
      } catch (error) {
        const failure = classifyTelegramError(error);
        if (failure.kind === "blocked") {
          setBotBlocked(this.opts.db, chatId, true);
          pauseAllSearchesForUser(this.opts.db, chatId);
          return false;
        }
        if (failure.kind === "retry_after") {
          await this.sleep(failure.seconds * 1000);
          continue;
        }
        if (failure.kind === "bad_request" && usePhoto) {
          usePhoto = false; // e.g. Telegram could not fetch the photo URL
          continue;
        }
        this.opts.log?.error({ err: error, chatId }, "telegram send failed");
        const delay = delays[attempt];
        if (delay !== undefined) await this.sleep(delay);
      }
    }
    return false;
  }

  private async pace(chatId: number): Promise<void> {
    const perChat = this.opts.perChatGapMs ?? 1100;
    const global = this.opts.globalGapMs ?? 40;
    const last = this.lastSendByChat.get(chatId);
    const wait = Math.max(last === undefined ? 0 : last + perChat - this.now(), this.lastSendAny + global - this.now());
    if (wait > 0) await this.sleep(wait);
    this.lastSendByChat.set(chatId, this.now());
    this.lastSendAny = this.now();
  }
}
```

- [ ] **Step 4: Run tests and type-check**

Run: `npx vitest run test/notifier.test.ts && npm run typecheck`
Expected: PASS; no type errors.

- [ ] **Step 5: Commit**

```bash
git add src/alerts/notifier.ts test/notifier.test.ts
git commit -m "feat: Telegram notifier with pacing, retries, flood digests"
```

---
### Task 17: `/new` wizard state machine

**Files:**
- Create: `src/bot/wizard.ts`
- Test: `test/wizard.test.ts`

**Interfaces:**
- Consumes: `CONDITION_CODES`, `CONDITION_LABELS`, `isConditionCode`, `KnownCondition` (Task 3); `escapeHtml`, `formatPence` (Task 15); `MatchMode` (Task 8).
- Produces:
  - `type WizardStep = "keywords" | "maxPrice" | "minPrice" | "conditions" | "exclude" | "confirm"`
  - `interface WizardState { step; keywords?: string; maxPricePence?: number; minPricePence?: number | null; conditions: KnownCondition[]; excludeWords: string[]; matchMode: MatchMode }`
  - `interface WizardDraft { keywords; maxPricePence; minPricePence: number | null; conditions: KnownCondition[]; excludeWords: string[]; matchMode: MatchMode }`
  - `type WizardInput = { kind: "text"; text: string } | { kind: "button"; data: string }`
  - `interface WizardButton { text: string; data: string }`, `interface WizardReply { text: string; buttons: WizardButton[][] }`
  - `type WizardOutcome = { kind: "continue"; state; reply } | { kind: "cancelled"; reply } | { kind: "create"; draft }`
  - `interface WizardContext { minPriceSuggestionPence: number | null }`
  - `WIZARD_BUTTONS`, `parsePriceInput(text): number | null`, `startWizard(ctx): { state; reply }`, `advanceWizard(state, input, ctx): WizardOutcome`

- [ ] **Step 1: Write the failing test**

`test/wizard.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { advanceWizard, parsePriceInput, startWizard, WIZARD_BUTTONS, type WizardOutcome, type WizardState } from "../src/bot/wizard.js";

const ctx = { minPriceSuggestionPence: null };
const text = (value: string) => ({ kind: "text" as const, text: value });
const button = (data: string) => ({ kind: "button" as const, data });

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
    state = continueState(advanceWizard(state, button("wz:cond:good"), ctx));
    state = continueState(advanceWizard(state, button("wz:cond:very_good"), ctx));
    expect(state.conditions).toEqual(["very_good", "good"]);
    state = continueState(advanceWizard(state, button("wz:cond:good"), ctx));
    expect(state.conditions).toEqual(["very_good"]);
    state = continueState(advanceWizard(state, button(WIZARD_BUTTONS.done), ctx));
    state = continueState(advanceWizard(state, text("iCloud, cracked , box only,,"), ctx));
    expect(state).toMatchObject({ step: "confirm", excludeWords: ["icloud", "cracked", "box only"] });
    state = continueState(advanceWizard(state, button(WIZARD_BUTTONS.mode), ctx));
    expect(state.matchMode).toBe("loose");
    state = continueState(advanceWizard(state, button(WIZARD_BUTTONS.mode), ctx));
    expect(advanceWizard(state, button(WIZARD_BUTTONS.create), ctx)).toEqual({
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
    const atConditions = continueState(advanceWizard(atMin, button(WIZARD_BUTTONS.skip), ctx));
    expect(atConditions.minPricePence).toBeNull();
    expect(continueState(advanceWizard(atConditions, text("good"), ctx)).step).toBe("conditions");
    expect(continueState(advanceWizard(atConditions, button("wz:cond:bogus"), ctx)).step).toBe("conditions");
    const atExclude = continueState(advanceWizard(atConditions, button(WIZARD_BUTTONS.done), ctx));
    const tooMany = Array.from({ length: 21 }, (_, i) => `w${i}`).join(",");
    expect(continueState(advanceWizard(atExclude, text(tooMany), ctx)).step).toBe("exclude");
  });

  it("offers the suggested min price as a button", () => {
    const suggest = { minPriceSuggestionPence: 15000 };
    let state = continueState(advanceWizard(startWizard(suggest).state, text("iphone 15"), suggest));
    const toMin = advanceWizard(state, text("300"), suggest);
    if (toMin.kind !== "continue") throw new Error("expected continue");
    expect(toMin.reply.text).toContain("£150.00");
    expect(toMin.reply.buttons[0]).toEqual([{ text: "Use £150.00", data: "wz:min:15000" }]);
    state = continueState(advanceWizard(toMin.state, button("wz:min:15000"), suggest));
    expect(state).toMatchObject({ step: "conditions", minPricePence: 15000 });
  });

  it("'Any condition' clears the selection", () => {
    let state = continueState(advanceWizard(continueState(advanceWizard(continueState(advanceWizard(startWizard(ctx).state, text("ps5"), ctx)), text("300"), ctx)), button(WIZARD_BUTTONS.skip), ctx));
    state = continueState(advanceWizard(state, button("wz:cond:good"), ctx));
    state = continueState(advanceWizard(state, button(WIZARD_BUTTONS.any), ctx));
    expect(state.conditions).toEqual([]);
  });

  it("cancels from any step", () => {
    const outcome = advanceWizard(startWizard(ctx).state, button(WIZARD_BUTTONS.cancel), ctx);
    expect(outcome).toEqual({ kind: "cancelled", reply: { text: "Cancelled. Nothing was saved.", buttons: [] } });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/wizard.test.ts`
Expected: FAIL — cannot resolve `../src/bot/wizard.js`.

- [ ] **Step 3: Write the implementation**

`src/bot/wizard.ts`:

```ts
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
```

- [ ] **Step 4: Run tests and type-check**

Run: `npx vitest run test/wizard.test.ts && npm run typecheck`
Expected: PASS; no type errors.

- [ ] **Step 5: Commit**

```bash
git add src/bot/wizard.ts test/wizard.test.ts
git commit -m "feat: /new search wizard as a pure state machine"
```

---

### Task 18: Bot service — access, commands, preview and admin

**Files:**
- Create: `src/bot/types.ts`, `src/bot/preview.ts`, `src/bot/admin.ts`, `src/bot/service.ts`
- Test: `test/service.test.ts`

**Interfaces:**
- Consumes: users/invites/meta (Task 7); searches/terms (Task 8); items/prices/alerts/retention (Task 9); `Health`, `HealthSnapshot` (Task 12); `INSIGHT_WINDOW_MS` (Task 13); format helpers (Task 15); wizard (Task 17); `groupFor` (Task 6); `median`, `MIN_SAMPLE` (Task 6); `cardStageMatch`, `effectivePricePence` (Task 3); `toTermKey` (Task 2).
- Produces:
  - `interface BotButton { text; data?: string; url?: string }`, `interface BotReply { text; buttons?: BotButton[][] }`, `interface Actor { telegramId; username: string | null; firstName: string | null }`, `interface ServiceResult { replies: BotReply[]; followUp?: Promise<BotReply[]>; toast?: string }`
  - `suggestMinPrice(db, termKey, now): number | null`, `buildPreview(db, search, now): BotReply`
  - `inviteReply(db, adminId, arg, now, botUsername): BotReply`, `statsReply(db, snapshot, now): BotReply`, `healthReply(db, snapshot, now): BotReply`, `waitlistReply(db): BotReply`
  - `interface BotServiceDeps { db; adminTelegramId; defaultSearchLimit; botUsername: () => string; now: () => number; ensureFresh: (termKey) => Promise<void>; notifyOwner: (text) => Promise<void>; healthSnapshot: () => HealthSnapshot }`
  - `class BotService { start(actor, payload); help(actor); newSearch(actor); text(actor, text); button(actor, data); searches(actor); cancel(actor); feedback(actor, text); deleteMe(actor); invite(actor, arg); stats(actor); health(actor); waitlist(actor) }` — every method returns `Promise<ServiceResult>`.

- [ ] **Step 1: Write the failing test**

`test/service.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import { buildPreview, suggestMinPrice } from "../src/bot/preview.js";
import { BotService } from "../src/bot/service.js";
import type { Actor, ServiceResult } from "../src/bot/types.js";
import { insertTermItems, upsertItemCard } from "../src/db/items.js";
import { upsertPriceObservation } from "../src/db/prices.js";
import { createSearch, getSearch, listSearchesByUser } from "../src/db/searches.js";
import { createUser, getUser } from "../src/db/users.js";
import { Health } from "../src/health/health.js";
import { makeCard } from "./helpers/cards.js";
import { memoryDb, seedSearch, seedUser } from "./helpers/db.js";

function setup() {
  const db = memoryDb();
  const now = 1_000_000;
  const ensureFresh = vi.fn(async (_termKey: string) => {});
  const notifyOwner = vi.fn(async (_text: string) => {});
  const health = new Health({ notifyOwner: async () => {}, now: () => now });
  const service = new BotService({
    db,
    adminTelegramId: 42,
    defaultSearchLimit: 2,
    botUsername: () => "flipradar_bot",
    now: () => now,
    ensureFresh,
    notifyOwner,
    healthSnapshot: () => health.snapshot(),
  });
  const actor = (telegramId: number): Actor => ({ telegramId, username: `u${telegramId}`, firstName: "T" });
  const text = (result: ServiceResult) => result.replies.map((reply) => reply.text).join("\n---\n");
  const member = (telegramId: number) => createUser(db, actor(telegramId), "beta", 2, 0);
  return { db, service, ensureFresh, notifyOwner, actor, text, member, now };
}

const priceObs = (db: ReturnType<typeof memoryDb>, now: number) => {
  for (let i = 0; i < 10; i += 1) {
    upsertPriceObservation(db, { vintedId: `p${i}`, groupKey: "iphone 15|iphone 15|128gb|good", modelKnown: true, pricePence: 30_000 + i * 1_000 }, now);
  }
};

describe("access", () => {
  it("makes the owner an admin on /start", async () => {
    const { db, service, actor, text } = setup();
    expect(text(await service.start(actor(42), ""))).toContain("Welcome to flipradar");
    expect(getUser(db, 42)?.status).toBe("admin");
  });

  it("puts strangers on a numbered waitlist", async () => {
    const { service, actor, text } = setup();
    expect(text(await service.start(actor(7), ""))).toContain("#1");
    expect(text(await service.start(actor(8), ""))).toContain("#2");
    expect(text(await service.start(actor(7), ""))).toContain("#1");
    expect(text(await service.newSearch(actor(7)))).toContain("waitlist");
  });

  it("redeems an invite exactly once", async () => {
    const { db, service, actor, text, notifyOwner } = setup();
    await service.start(actor(42), "");
    const links = text(await service.invite(actor(42), "2"));
    const codes = [...links.matchAll(/t\.me\/flipradar_bot\?start=([\w-]+)/g)].map((match) => match[1]!);
    expect(codes).toHaveLength(2);
    expect(text(await service.start(actor(7), codes[0]!))).toContain("Welcome to flipradar");
    expect(getUser(db, 7)?.status).toBe("beta");
    expect(notifyOwner).toHaveBeenCalledWith(expect.stringContaining("@u7 joined the beta"));
    const reused = text(await service.start(actor(8), codes[0]!));
    expect(reused).toContain("isn't valid");
    expect(getUser(db, 8)?.status).toBe("waitlist");
  });

  it("keeps admin commands to the admin", async () => {
    const { service, actor, member, text } = setup();
    member(7);
    expect(text(await service.stats(actor(7)))).toBe("Admins only.");
    await service.start(actor(42), "");
    expect(text(await service.stats(actor(42)))).toContain("Searches: 0 active");
    expect(text(await service.health(actor(42)))).toContain("Backoff: off");
    expect(text(await service.waitlist(actor(42)))).toContain("Waitlist: 0");
  });
});

describe("creating searches", () => {
  it("runs the wizard and replies with a preview follow-up", async () => {
    const { db, service, actor, member, text, ensureFresh } = setup();
    member(7);
    expect(text(await service.newSearch(actor(7)))).toContain("What are you looking for?");
    expect(text(await service.text(actor(7), "iphone 15"))).toContain("Max price?");
    expect(text(await service.text(actor(7), "300"))).toContain("Min price?");
    expect(text(await service.button(actor(7), "wz:skip"))).toContain("Which conditions?");
    expect(text(await service.button(actor(7), "wz:cond:done"))).toContain("Words to exclude?");
    expect(text(await service.button(actor(7), "wz:skip"))).toContain("Check your search");
    const created = await service.button(actor(7), "wz:create");
    expect(text(created)).toContain("Search saved");
    const preview = await created.followUp!;
    expect(preview[0]?.text).toContain("Watching <b>iphone 15</b>");
    expect(ensureFresh).toHaveBeenCalledWith("iphone 15");
    expect(listSearchesByUser(db, 7)).toHaveLength(1);
  });

  it("refuses beyond the search limit", async () => {
    const { db, service, actor, member, text } = setup();
    member(7);
    for (const keywords of ["a1", "b2"]) {
      createSearch(db, { userId: 7, keywords, maxPricePence: 100, minPricePence: null, conditions: [], excludeWords: [], matchMode: "strict" }, 0);
    }
    expect(text(await service.newSearch(actor(7)))).toContain("used all 2 searches");
  });

  it("answers stray text and unknown commands", async () => {
    const { service, actor, member, text } = setup();
    member(7);
    expect(text(await service.text(actor(7), "hello"))).toContain("/new");
    expect(text(await service.text(actor(7), "/foo"))).toContain("don't know that command");
  });
});

describe("managing searches", () => {
  it("lists, pauses, resumes and deletes only your own searches", async () => {
    const { db, service, actor, member, text } = setup();
    member(7);
    member(8);
    const search = createSearch(db, { userId: 7, keywords: "ps5", maxPricePence: 30_000, minPricePence: 20_000, conditions: ["good"], excludeWords: ["box only"], matchMode: "strict" }, 0);
    const listing = await service.searches(actor(7));
    expect(text(listing)).toContain("max £300.00 · min £200.00 · Good · excluding box only");
    expect(listing.replies[1]?.buttons?.[0]?.[0]).toEqual({ text: "⏸ Pause", data: `pause:${search.id}` });
    expect((await service.button(actor(8), `pause:${search.id}`)).toast).toBe("Search not found.");
    expect((await service.button(actor(7), `pause:${search.id}`)).toast).toBe("Paused");
    expect(getSearch(db, search.id)?.status).toBe("paused");
    expect((await service.button(actor(7), `resume:${search.id}`)).toast).toBe("Resumed");
    const confirm = await service.button(actor(7), `del:${search.id}`);
    expect(confirm.replies[0]?.buttons?.[0]?.[0]?.data).toBe(`delok:${search.id}`);
    await service.button(actor(7), `delok:${search.id}`);
    expect(getSearch(db, search.id)).toBeUndefined();
  });

  it("forwards feedback and deletes user data on confirmation", async () => {
    const { db, service, actor, member, text, notifyOwner } = setup();
    member(7);
    expect(text(await service.feedback(actor(7), "  "))).toContain("Usage");
    await service.feedback(actor(7), "love it <3");
    expect(notifyOwner).toHaveBeenCalledWith(expect.stringContaining("love it &lt;3"));
    const confirm = await service.deleteMe(actor(7));
    expect(confirm.replies[0]?.buttons?.[0]?.[0]?.data).toBe("deleteme:ok");
    await service.button(actor(7), "deleteme:ok");
    expect(getUser(db, 7)).toBeUndefined();
  });
});

describe("preview helpers", () => {
  it("suggests 40% of the model-known median, rounded down to £10", () => {
    const { db, now } = setup();
    expect(suggestMinPrice(db, "iphone 15", now)).toBeNull();
    priceObs(db, now);
    expect(suggestMinPrice(db, "iphone 15", now)).toBe(13_000);
  });

  it("shows the typical price and latest matches", () => {
    const { db, now } = setup();
    seedUser(db, 111);
    const search = seedSearch(db, {}, 0);
    for (const id of ["11", "12", "13", "14"]) upsertItemCard(db, makeCard({ vintedId: id, url: `https://www.vinted.co.uk/items/${id}` }), now);
    insertTermItems(db, "iphone 15", ["11", "12", "13", "14"], now);
    priceObs(db, now);
    const preview = buildPreview(db, search, now).text;
    expect(preview).toContain("Typical listing price (used, good): <b>£345.00</b>, from 10 listings");
    expect(preview).toContain('<a href="https://www.vinted.co.uk/items/14">');
    expect(preview).not.toContain("items/11");
  });

  it("says when nothing currently matches", () => {
    const { db, now } = setup();
    seedUser(db, 111);
    const search = seedSearch(db, { maxPricePence: 100 }, 0);
    expect(buildPreview(db, search, now).text).toContain("No current listings match");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/service.test.ts`
Expected: FAIL — cannot resolve `../src/bot/preview.js`.

- [ ] **Step 3: Write the implementation**

`src/bot/types.ts`:

```ts
export interface BotButton {
  text: string;
  data?: string;
  url?: string;
}

export interface BotReply {
  text: string;
  buttons?: BotButton[][];
}

export interface Actor {
  telegramId: number;
  username: string | null;
  firstName: string | null;
}

/** followUp is sent after the replies, without blocking the bot's update loop. */
export interface ServiceResult {
  replies: BotReply[];
  followUp?: Promise<BotReply[]>;
  toast?: string;
}
```

`src/bot/preview.ts`:

```ts
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
```

`src/bot/admin.ts`:

```ts
import { escapeHtml } from "../alerts/format.js";
import { sentLatencies } from "../db/alerts.js";
import type { Db } from "../db/database.js";
import { DAY_MS } from "../db/retention.js";
import { countActiveSearches } from "../db/searches.js";
import { listActiveTerms } from "../db/terms.js";
import { countUsersByStatus, createInvites, listWaitlist } from "../db/users.js";
import type { HealthSnapshot } from "../health/health.js";
import type { BotReply } from "./types.js";

export function inviteReply(db: Db, adminId: number, arg: string, now: number, botUsername: string): BotReply {
  const count = Math.min(10, Math.max(1, Number.parseInt(arg, 10) || 1));
  const codes = createInvites(db, adminId, count, now);
  return {
    text: [`🎟 ${count} invite link${count === 1 ? "" : "s"} (each works once):`, ...codes.map((code) => `https://t.me/${botUsername}?start=${code}`)].join("\n"),
  };
}

export function statsReply(db: Db, snapshot: HealthSnapshot, now: number): BotReply {
  const users = countUsersByStatus(db);
  const latencies = sentLatencies(db, now - DAY_MS).sort((a, b) => a - b);
  const medianLatency = latencies.length ? latencies[Math.floor(latencies.length / 2)]! : null;
  const seconds = (ms: number | null) => (ms === null ? "n/a" : `${Math.round(ms / 1000)} s`);
  return {
    text: [
      "📈 <b>Stats</b>",
      `Testers: ${users.beta} beta · ${users.admin} admin · ${users.waitlist} waitlist`,
      `Searches: ${countActiveSearches(db)} active across ${listActiveTerms(db).length} terms`,
      `Alerts sent (24 h): ${latencies.length}`,
      `Median alert time (24 h): ${seconds(medianLatency)}`,
      `Typical gap between checks of a term: ${seconds(snapshot.medianPollIntervalMs)}`,
    ].join("\n"),
  };
}

export function healthReply(db: Db, snapshot: HealthSnapshot, now: number): BotReply {
  const ago = (time: number | null) => (time === null ? "never" : `${Math.round((now - time) / 1000)} s ago`);
  const lines = [
    "🩺 <b>Health</b>",
    snapshot.backoff.active
      ? `Backoff: ON until ${new Date(snapshot.backoff.until).toISOString().slice(11, 16)} UTC (level ${snapshot.backoff.level})`
      : "Backoff: off",
    `Last successful Vinted request: ${ago(snapshot.lastSuccessAt)}`,
    `Failed requests since start: ${snapshot.failureCount}`,
  ];
  if (snapshot.layoutSuspects.length) lines.push(`⚠️ Layout suspects: ${snapshot.layoutSuspects.map(escapeHtml).join(", ")}`);
  for (const term of listActiveTerms(db)) {
    lines.push(
      `• ${escapeHtml(term.termKey)}: polled ${ago(term.lastPolledAt)}, empty streak ${term.emptyStreak}, overflow ${snapshot.overflowCounts[term.termKey] ?? 0}`,
    );
  }
  return { text: lines.join("\n") };
}

export function waitlistReply(db: Db): BotReply {
  const total = countUsersByStatus(db).waitlist;
  const newest = listWaitlist(db, 10).map((user) =>
    user.username ? `@${escapeHtml(user.username)}` : `${escapeHtml(user.firstName ?? "unknown")} (${user.telegramId})`,
  );
  return { text: [`⏳ <b>Waitlist: ${total}</b>`, ...newest.map((name) => `• ${name}`)].join("\n") };
}
```

`src/bot/service.ts`:

```ts
import { escapeHtml, formatPence } from "../alerts/format.js";
import type { Db } from "../db/database.js";
import { clearWizardState, getWizardState, saveWizardState } from "../db/meta.js";
import { WIZARD_TTL_MS } from "../db/retention.js";
import { countSearchesByUser, createSearch, deleteSearch, getSearch, listSearchesByUser, setSearchStatus, type Search } from "../db/searches.js";
import {
  createUser,
  deleteUserData,
  getUser,
  redeemInvite,
  setUserStatus,
  touchUserProfile,
  waitlistPosition,
  type User,
} from "../db/users.js";
import type { HealthSnapshot } from "../health/health.js";
import { CONDITION_LABELS, type KnownCondition } from "../matching/conditions.js";
import { toTermKey } from "../matching/normalize.js";
import { healthReply, inviteReply, statsReply, waitlistReply } from "./admin.js";
import { buildPreview, suggestMinPrice } from "./preview.js";
import type { Actor, BotReply, ServiceResult } from "./types.js";
import { advanceWizard, startWizard, type WizardInput, type WizardReply, type WizardState } from "./wizard.js";

export interface BotServiceDeps {
  db: Db;
  adminTelegramId: number;
  defaultSearchLimit: number;
  botUsername: () => string;
  now: () => number;
  ensureFresh: (termKey: string) => Promise<void>;
  notifyOwner: (text: string) => Promise<void>;
  healthSnapshot: () => HealthSnapshot;
}

const ADMIN_SEARCH_LIMIT = 100;
const PRIVACY = "🔒 I store your Telegram ID, username and searches, nothing else. /deleteme erases them.";

const say = (...texts: string[]): ServiceResult => ({ replies: texts.map((text) => ({ text })) });
const toBotReply = (reply: WizardReply): BotReply => ({ text: reply.text, buttons: reply.buttons });
const displayName = (actor: Actor) => (actor.username ? `@${actor.username}` : actor.firstName ?? String(actor.telegramId));

export class BotService {
  constructor(private readonly deps: BotServiceDeps) {}

  /** Look up the user, promote the owner to admin, refresh profile details. */
  private resolve(actor: Actor): User | undefined {
    const { db } = this.deps;
    const existing = getUser(db, actor.telegramId);
    if (actor.telegramId === this.deps.adminTelegramId) {
      if (!existing) createUser(db, actor, "admin", ADMIN_SEARCH_LIMIT, this.deps.now());
      else if (existing.status !== "admin") setUserStatus(db, actor.telegramId, "admin");
    } else if (!existing) {
      return undefined;
    }
    touchUserProfile(db, actor);
    return getUser(db, actor.telegramId);
  }

  private isMember(user: User | undefined): user is User {
    return user?.status === "beta" || user?.status === "admin";
  }

  private notMember(user: User | undefined): ServiceResult {
    if (!user) return say("Send /start to join the waitlist.");
    return say(`You're on the waitlist (#${waitlistPosition(this.deps.db, user.telegramId)}). I'll message you here when a spot opens.`);
  }

  private welcome(): string {
    return [
      "👋 <b>Welcome to flipradar!</b>",
      "I watch Vinted UK and message you the moment a listing matches your search, with how its price compares to similar listings.",
      "",
      "/new: create a search",
      "/searches: pause or delete searches",
      "/help: all commands",
      "",
      PRIVACY,
    ].join("\n");
  }

  async start(actor: Actor, payload: string): Promise<ServiceResult> {
    const { db } = this.deps;
    const now = this.deps.now();
    const user = this.resolve(actor);
    if (this.isMember(user)) return say(this.welcome());

    const code = payload.trim();
    if (code && redeemInvite(db, code, actor.telegramId, now)) {
      if (user) setUserStatus(db, actor.telegramId, "beta");
      else createUser(db, actor, "beta", this.deps.defaultSearchLimit, now);
      void this.deps.notifyOwner(`🎟 ${escapeHtml(displayName(actor))} joined the beta.`).catch(() => {});
      return say(this.welcome());
    }

    if (!user) createUser(db, actor, "waitlist", this.deps.defaultSearchLimit, now);
    const position = waitlistPosition(db, actor.telegramId);
    const invalid = code ? "That invite link isn't valid or has already been used.\n\n" : "";
    return say(`${invalid}👋 flipradar is in private beta. You're <b>#${position}</b> on the waitlist, and I'll message you here when a spot opens.\n\n${PRIVACY}`);
  }

  async help(actor: Actor): Promise<ServiceResult> {
    const user = this.resolve(actor);
    if (!this.isMember(user)) return this.notMember(user);
    const lines = [
      "<b>Commands</b>",
      `/new: create a search (up to ${user.searchLimit})`,
      "/searches: pause, resume or delete your searches",
      "/cancel: stop creating a search",
      "/feedback &lt;message&gt;: send feedback to the team",
      "/deleteme: erase your data",
    ];
    if (user.status === "admin") lines.push("", "<b>Admin</b>", "/invite [n], /stats, /health, /waitlist");
    return say(lines.join("\n"));
  }

  async newSearch(actor: Actor): Promise<ServiceResult> {
    const user = this.resolve(actor);
    if (!this.isMember(user)) return this.notMember(user);
    if (countSearchesByUser(this.deps.db, user.telegramId) >= user.searchLimit) {
      return say(`You've used all ${user.searchLimit} searches. Delete one in /searches first.`);
    }
    const { state, reply } = startWizard({ minPriceSuggestionPence: null });
    saveWizardState(this.deps.db, user.telegramId, state, this.deps.now());
    return { replies: [toBotReply(reply)] };
  }

  async text(actor: Actor, text: string): Promise<ServiceResult> {
    const user = this.resolve(actor);
    if (!this.isMember(user)) return this.notMember(user);
    if (text.startsWith("/")) return say("I don't know that command. Try /help.");
    return this.wizardInput(user, { kind: "text", text });
  }

  async button(actor: Actor, data: string): Promise<ServiceResult> {
    const { db } = this.deps;
    const now = this.deps.now();
    const user = this.resolve(actor);

    if (data === "deleteme:ok") {
      if (user) deleteUserData(db, user.telegramId);
      return { replies: [{ text: "🗑 All your data has been deleted. Send /start any time to come back." }], toast: "Deleted" };
    }
    if (!this.isMember(user)) return { ...this.notMember(user), toast: "Not available" };
    if (data.startsWith("wz:")) return this.wizardInput(user, { kind: "button", data });

    const match = /^(pause|resume|del|delok):(\d+)$/.exec(data);
    if (!match) return { replies: [], toast: "That button has expired." };
    const search = getSearch(db, Number(match[2]));
    if (!search || search.userId !== user.telegramId) return { replies: [], toast: "Search not found." };
    const name = `<b>${escapeHtml(search.keywords)}</b>`;

    switch (match[1]) {
      case "pause":
        setSearchStatus(db, search.id, "paused", now);
        return { replies: [{ text: `⏸ Paused ${name}. Resume it in /searches.` }], toast: "Paused" };
      case "resume":
        setSearchStatus(db, search.id, "active", now);
        return { replies: [{ text: `▶️ Resumed ${name}. Alerts start from now.` }], toast: "Resumed" };
      case "del":
        return { replies: [{ text: `Delete ${name}? This can't be undone.`, buttons: [[{ text: "🗑 Yes, delete", data: `delok:${search.id}` }]] }] };
      default:
        deleteSearch(db, search.id);
        return { replies: [{ text: `🗑 Deleted ${name}.` }], toast: "Deleted" };
    }
  }

  async searches(actor: Actor): Promise<ServiceResult> {
    const user = this.resolve(actor);
    if (!this.isMember(user)) return this.notMember(user);
    const list = listSearchesByUser(this.deps.db, user.telegramId);
    if (list.length === 0) return say("You have no searches yet. Send /new to create one.");
    return { replies: [{ text: `<b>Your searches</b> (${list.length}/${user.searchLimit})` }, ...list.map((search) => this.searchCard(search))] };
  }

  async cancel(actor: Actor): Promise<ServiceResult> {
    clearWizardState(this.deps.db, actor.telegramId);
    return say("Cancelled.");
  }

  async feedback(actor: Actor, text: string): Promise<ServiceResult> {
    const user = this.resolve(actor);
    if (!user) return say("Send /start first.");
    const message = text.trim();
    if (!message) return say("Usage: /feedback your message");
    await this.deps
      .notifyOwner(`💬 Feedback from ${escapeHtml(displayName(actor))} (${actor.telegramId}):\n${escapeHtml(message.slice(0, 1000))}`)
      .catch(() => {});
    return say("Thanks! Sent to the team.");
  }

  async deleteMe(actor: Actor): Promise<ServiceResult> {
    const user = this.resolve(actor);
    if (!user) return say("I don't have any data about you.");
    return {
      replies: [{ text: "This deletes your searches and everything I store about you. Continue?", buttons: [[{ text: "🗑 Yes, delete my data", data: "deleteme:ok" }]] }],
    };
  }

  async invite(actor: Actor, arg: string): Promise<ServiceResult> {
    if (this.resolve(actor)?.status !== "admin") return say("Admins only.");
    return { replies: [inviteReply(this.deps.db, actor.telegramId, arg, this.deps.now(), this.deps.botUsername())] };
  }

  async stats(actor: Actor): Promise<ServiceResult> {
    if (this.resolve(actor)?.status !== "admin") return say("Admins only.");
    return { replies: [statsReply(this.deps.db, this.deps.healthSnapshot(), this.deps.now())] };
  }

  async health(actor: Actor): Promise<ServiceResult> {
    if (this.resolve(actor)?.status !== "admin") return say("Admins only.");
    return { replies: [healthReply(this.deps.db, this.deps.healthSnapshot(), this.deps.now())] };
  }

  async waitlist(actor: Actor): Promise<ServiceResult> {
    if (this.resolve(actor)?.status !== "admin") return say("Admins only.");
    return { replies: [waitlistReply(this.deps.db)] };
  }

  private async wizardInput(user: User, input: WizardInput): Promise<ServiceResult> {
    const { db } = this.deps;
    const now = this.deps.now();
    const state = getWizardState<WizardState>(db, user.telegramId, now, WIZARD_TTL_MS);
    if (!state) {
      return say(input.kind === "text" ? "Send /new to create a search, or /help for commands." : "That menu has expired. Send /new to start again.");
    }
    const ctx = { minPriceSuggestionPence: state.keywords ? suggestMinPrice(db, toTermKey(state.keywords), now) : null };
    const outcome = advanceWizard(state, input, ctx);
    if (outcome.kind === "continue") {
      saveWizardState(db, user.telegramId, outcome.state, now);
      return { replies: [toBotReply(outcome.reply)] };
    }
    clearWizardState(db, user.telegramId);
    if (outcome.kind === "cancelled") return { replies: [toBotReply(outcome.reply)] };

    if (countSearchesByUser(db, user.telegramId) >= user.searchLimit) {
      return say(`You've used all ${user.searchLimit} searches. Delete one in /searches first.`);
    }
    const search = createSearch(db, { userId: user.telegramId, ...outcome.draft }, now);
    const followUp = this.deps
      .ensureFresh(search.termKey)
      .catch(() => undefined)
      .then(() => [buildPreview(db, getSearch(db, search.id) ?? search, this.deps.now())]);
    return { replies: [{ text: "✅ Search saved. Checking current listings…" }], followUp };
  }

  private searchCard(search: Search): BotReply {
    const parts = [`max ${formatPence(search.maxPricePence)}`];
    if (search.minPricePence !== null) parts.push(`min ${formatPence(search.minPricePence)}`);
    const known = search.conditions.filter((code): code is KnownCondition => code !== "unknown");
    parts.push(known.length ? known.map((code) => CONDITION_LABELS[code]).join(", ") : "any condition");
    if (search.excludeWords.length) parts.push(`excluding ${search.excludeWords.join(", ")}`);
    const status = search.status === "active" ? "🟢 Active" : "⏸ Paused";
    return {
      text: `<b>${escapeHtml(search.keywords)}</b>\n${escapeHtml(parts.join(" · "))}\n${status} · ${search.matchMode} matching`,
      buttons: [
        [
          search.status === "active" ? { text: "⏸ Pause", data: `pause:${search.id}` } : { text: "▶️ Resume", data: `resume:${search.id}` },
          { text: "🗑 Delete", data: `del:${search.id}` },
        ],
      ],
    };
  }
}
```

- [ ] **Step 4: Run tests and type-check**

Run: `npx vitest run test/service.test.ts && npm run typecheck`
Expected: PASS; no type errors.

- [ ] **Step 5: Commit**

```bash
git add src/bot/types.ts src/bot/preview.ts src/bot/admin.ts src/bot/service.ts test/service.test.ts
git commit -m "feat: bot service with invites, waitlist, wizard, preview and admin commands"
```

---

### Task 19: grammY wiring, main entry point and live probe

**Files:**
- Create: `src/bot/bot.ts`, `src/main.ts`, `scripts/probe.ts`
- Test: `test/bot.test.ts`

**Interfaces:**
- Consumes: everything above.
- Produces:
  - `toInlineMarkup(buttons?: BotButton[][]): InlineKeyboardMarkup | undefined`
  - `BOT_COMMANDS`
  - `attachHandlers(bot: Bot, service: BotService, log: { error(obj: object, msg: string): void }): void`
  - `src/main.ts` — the runnable app (`npm start`)
  - `scripts/probe.ts` — live canary (`npm run probe`)

- [ ] **Step 1: Write the failing test**

`test/bot.test.ts`:

```ts
import { Bot } from "grammy";
import { describe, expect, it, vi } from "vitest";
import { attachHandlers, toInlineMarkup } from "../src/bot/bot.js";
import { BotService } from "../src/bot/service.js";
import { Health } from "../src/health/health.js";
import { memoryDb } from "./helpers/db.js";

const botInfo = {
  id: 1,
  is_bot: true,
  first_name: "flipradar",
  username: "flipradar_bot",
  can_join_groups: false,
  can_read_all_group_messages: false,
  supports_inline_queries: false,
  can_connect_to_business: false,
  has_main_web_app: false,
};

function setup() {
  const db = memoryDb();
  const service = new BotService({
    db,
    adminTelegramId: 42,
    defaultSearchLimit: 5,
    botUsername: () => "flipradar_bot",
    now: () => 1_000,
    ensureFresh: async () => {},
    notifyOwner: async () => {},
    healthSnapshot: () => new Health({ notifyOwner: async () => {} }).snapshot(),
  });
  const bot = new Bot("123:test", { botInfo: botInfo as never });
  const calls: Array<{ method: string; payload: Record<string, unknown> }> = [];
  bot.api.config.use(async (_prev, method, payload) => {
    calls.push({ method, payload: payload as Record<string, unknown> });
    const result = method === "sendMessage" ? { message_id: 1, date: 0, chat: { id: 7, type: "private" }, text: "" } : true;
    return { ok: true, result } as never;
  });
  const log = { error: vi.fn() };
  attachHandlers(bot, service, log);
  return { bot, calls, log };
}

const from = { id: 7, is_bot: false, first_name: "T", username: "tester" };
const chat = { id: 7, type: "private", first_name: "T" };

describe("toInlineMarkup", () => {
  it("converts buttons and omits empty keyboards", () => {
    expect(toInlineMarkup(undefined)).toBeUndefined();
    expect(toInlineMarkup([])).toBeUndefined();
    expect(toInlineMarkup([[{ text: "Open", url: "https://x" }, { text: "Pause", data: "pause:1" }]])).toEqual({
      inline_keyboard: [[{ text: "Open", url: "https://x" }, { text: "Pause", callback_data: "pause:1" }]],
    });
  });
});

describe("attachHandlers", () => {
  it("routes /start to the service and replies in HTML", async () => {
    const { bot, calls } = setup();
    await bot.handleUpdate({
      update_id: 1,
      message: { message_id: 1, date: 0, chat, from, text: "/start", entities: [{ type: "bot_command", offset: 0, length: 6 }] },
    } as never);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.method).toBe("sendMessage");
    expect(calls[0]?.payload["parse_mode"]).toBe("HTML");
    expect(String(calls[0]?.payload["text"])).toContain("waitlist");
  });

  it("answers callback queries with a toast", async () => {
    const { bot, calls } = setup();
    await bot.handleUpdate({
      update_id: 2,
      callback_query: { id: "cb1", from, chat_instance: "x", data: "pause:1", message: { message_id: 5, date: 0, chat, text: "x" } },
    } as never);
    expect(calls[0]?.method).toBe("answerCallbackQuery");
    expect(calls[0]?.payload["text"]).toBe("Not available");
  });

  it("ignores group chats", async () => {
    const { bot, calls } = setup();
    await bot.handleUpdate({
      update_id: 3,
      message: { message_id: 1, date: 0, chat: { id: -5, type: "group", title: "g" }, from, text: "/start", entities: [{ type: "bot_command", offset: 0, length: 6 }] },
    } as never);
    expect(calls).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/bot.test.ts`
Expected: FAIL — cannot resolve `../src/bot/bot.js`.

- [ ] **Step 3: Write the bot wiring**

`src/bot/bot.ts`:

```ts
import type { Bot, Context } from "grammy";
import type { InlineKeyboardMarkup } from "grammy/types";
import type { BotService } from "./service.js";
import type { Actor, BotButton, BotReply, ServiceResult } from "./types.js";

export const BOT_COMMANDS = [
  { command: "new", description: "Create a search" },
  { command: "searches", description: "Pause, resume or delete searches" },
  { command: "help", description: "All commands" },
  { command: "feedback", description: "Send feedback" },
  { command: "deleteme", description: "Erase your data" },
];

export function toInlineMarkup(buttons?: BotButton[][]): InlineKeyboardMarkup | undefined {
  if (!buttons || buttons.length === 0) return undefined;
  return {
    inline_keyboard: buttons.map((row) =>
      row.map((button) => (button.url ? { text: button.text, url: button.url } : { text: button.text, callback_data: button.data ?? "noop" })),
    ),
  };
}

/** Thin adapter: Telegram updates → BotService → replies. Private chats only. */
export function attachHandlers(bot: Bot, service: BotService, log: { error(obj: object, msg: string): void }): void {
  const actorOf = (ctx: Context): Actor | null =>
    ctx.from && ctx.chat?.type === "private"
      ? { telegramId: ctx.from.id, username: ctx.from.username ?? null, firstName: ctx.from.first_name ?? null }
      : null;

  const send = async (ctx: Context, replies: BotReply[]) => {
    for (const reply of replies) {
      await ctx.reply(reply.text, { parse_mode: "HTML", reply_markup: toInlineMarkup(reply.buttons), link_preview_options: { is_disabled: true } });
    }
  };

  const deliver = async (ctx: Context, result: ServiceResult) => {
    await send(ctx, result.replies);
    if (result.followUp) {
      void result.followUp.then((replies) => send(ctx, replies)).catch((error: unknown) => log.error({ err: error }, "follow-up failed"));
    }
  };

  const handle = (fn: (actor: Actor, ctx: Context) => Promise<ServiceResult>) => async (ctx: Context) => {
    const actor = actorOf(ctx);
    if (!actor) return;
    await deliver(ctx, await fn(actor, ctx));
  };

  const arg = (ctx: Context) => (typeof ctx.match === "string" ? ctx.match : "");

  bot.command("start", handle((actor, ctx) => service.start(actor, arg(ctx))));
  bot.command("help", handle((actor) => service.help(actor)));
  bot.command("new", handle((actor) => service.newSearch(actor)));
  bot.command("searches", handle((actor) => service.searches(actor)));
  bot.command("cancel", handle((actor) => service.cancel(actor)));
  bot.command("feedback", handle((actor, ctx) => service.feedback(actor, arg(ctx))));
  bot.command("deleteme", handle((actor) => service.deleteMe(actor)));
  bot.command("invite", handle((actor, ctx) => service.invite(actor, arg(ctx))));
  bot.command("stats", handle((actor) => service.stats(actor)));
  bot.command("health", handle((actor) => service.health(actor)));
  bot.command("waitlist", handle((actor) => service.waitlist(actor)));

  bot.on("callback_query:data", async (ctx) => {
    const actor = actorOf(ctx);
    if (!actor) {
      await ctx.answerCallbackQuery();
      return;
    }
    const result = await service.button(actor, ctx.callbackQuery.data);
    await ctx.answerCallbackQuery(result.toast ? { text: result.toast } : undefined);
    await deliver(ctx, result);
  });

  bot.on("message:text", handle((actor, ctx) => service.text(actor, ctx.message?.text ?? "")));

  bot.catch((error) => log.error({ err: error.error }, "bot handler failed"));
}
```

- [ ] **Step 4: Run the wiring test**

Run: `npx vitest run test/bot.test.ts`
Expected: 4 tests PASS.

- [ ] **Step 5: Write the entry point and probe**

`src/main.ts`:

```ts
import { Bot } from "grammy";
import { existsSync } from "node:fs";
import pino from "pino";
import { Notifier, type TelegramSender } from "./alerts/notifier.js";
import { processNewItems } from "./alerts/pipeline.js";
import { attachHandlers, BOT_COMMANDS } from "./bot/bot.js";
import { BotService } from "./bot/service.js";
import { loadConfig } from "./config.js";
import { openDatabase } from "./db/database.js";
import { getMeta, setMeta } from "./db/meta.js";
import { runRetention } from "./db/retention.js";
import { Health } from "./health/health.js";
import { Poller } from "./poller/poller.js";
import { RequestQueue } from "./poller/requestQueue.js";
import { VintedClient } from "./vinted/client.js";

if (existsSync(".env")) process.loadEnvFile(".env");
const config = loadConfig();
const log = pino({ level: config.logLevel });
const db = openDatabase(config.databasePath);
const bot = new Bot(config.telegramBotToken);

const notifyOwner = async (text: string): Promise<void> => {
  await bot.api.sendMessage(config.adminTelegramId, text, { parse_mode: "HTML" });
};

const health = new Health({ notifyOwner });
const queue = new RequestQueue({
  spacingMs: config.requestSpacingMs,
  jitterMs: 500,
  onBackoffChange: (state) => void health.onBackoffChange(state),
});
const client = new VintedClient({ queue, fetch: (url, init) => fetch(url, init), host: config.vintedHost, userAgent: config.userAgent });
const poller = new Poller({
  db,
  fetchCatalog: (termKey, page, priority) => client.fetchCatalog(termKey, page, priority),
  pipeline: (termKey, cards) => processNewItems({ db, fetchItem: (url) => client.fetchItem(url), now: Date.now }, termKey, cards),
  health,
  minTermIntervalMs: config.minTermIntervalMs,
  log,
});
const api: TelegramSender = {
  sendMessage: (chatId, text, other) => bot.api.sendMessage(chatId, text, other as Parameters<typeof bot.api.sendMessage>[2]),
  sendPhoto: (chatId, photo, other) => bot.api.sendPhoto(chatId, photo, other as Parameters<typeof bot.api.sendPhoto>[2]),
};
const notifier = new Notifier({ db, api, log });
const service = new BotService({
  db,
  adminTelegramId: config.adminTelegramId,
  defaultSearchLimit: config.defaultSearchLimit,
  botUsername: () => bot.botInfo.username,
  now: Date.now,
  ensureFresh: (termKey) => poller.ensureFresh(termKey),
  notifyOwner,
  healthSnapshot: () => health.snapshot(),
});
attachHandlers(bot, service, log);

async function main(): Promise<void> {
  const previousStart = getMeta(db, "started_at");
  const cleanShutdown = getMeta(db, "clean_shutdown_at");
  setMeta(db, "started_at", String(Date.now()));

  const dropped = notifier.dropStale();
  if (dropped > 0) log.warn({ dropped }, "dropped stale pending alerts");

  await bot.init();
  await bot.api.setMyCommands(BOT_COMMANDS);
  if (previousStart && (!cleanShutdown || Number(cleanShutdown) < Number(previousStart))) await health.restartNotice();

  poller.start();
  notifier.start();
  const timers = [
    setInterval(() => {
      try {
        runRetention(db, Date.now());
      } catch (error) {
        log.error({ err: error }, "retention failed");
      }
    }, 60 * 60_000),
    setInterval(() => void health.checkStale(), 60_000),
  ];

  let stopping = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (stopping) return;
    stopping = true;
    log.info({ signal }, "shutting down");
    for (const timer of timers) clearInterval(timer);
    poller.stop();
    queue.stop();
    await notifier.stop(5000);
    await bot.stop();
    setMeta(db, "clean_shutdown_at", String(Date.now()));
    db.close();
    process.exit(0);
  };
  process.once("SIGINT", () => void shutdown("SIGINT"));
  process.once("SIGTERM", () => void shutdown("SIGTERM"));

  log.info({ bot: bot.botInfo.username }, "flipradar started");
  await bot.start();
}

main().catch((error: unknown) => {
  log.fatal({ err: error }, "fatal error");
  process.exit(1);
});
```

`scripts/probe.ts`:

```ts
import { DEFAULT_USER_AGENT } from "../src/config.js";
import { RequestQueue } from "../src/poller/requestQueue.js";
import { VintedClient } from "../src/vinted/client.js";

const host = process.env.VINTED_HOST || "www.vinted.co.uk";
const queue = new RequestQueue({ spacingMs: 1000, jitterMs: 0 });
const client = new VintedClient({
  queue,
  fetch: (url, init) => fetch(url, init),
  host,
  userAgent: process.env.USER_AGENT || DEFAULT_USER_AGENT,
  retryDelayMs: 2000,
});

function fail(message: string): never {
  console.error(`PROBE FAILED: ${message}`);
  queue.stop();
  process.exit(1);
}

const catalog = await client.fetchCatalog("iphone", 1, "poll");
if (catalog.kind !== "ok") {
  const detail = "status" in catalog ? ` (HTTP ${catalog.status})` : "message" in catalog ? ` (${catalog.message})` : "";
  fail(`catalog → ${catalog.kind}${detail}`);
}
const first = catalog.cards[0];
if (!first) fail("catalog had no cards");
const item = await client.fetchItem(first.url);
if (item.kind !== "ok") fail(`item → ${item.kind}`);

const priced = catalog.cards.filter((card) => card.pricePence !== null).length;
const withModel = catalog.cards.filter((card) => card.model !== null).length;
console.log(
  `PROBE OK (${host}): ${catalog.cards.length} cards, ${priced} priced, ${withModel} with model; ` +
    `item ${first.vintedId}: ${item.detail.photos.length} photos, seller rating ${item.detail.sellerRating ?? "n/a"}`,
);
queue.stop();
```

- [ ] **Step 6: Verify everything**

Run: `npm run typecheck && npm test`
Expected: no type errors; every test file passes.

Run: `npm run probe`
Expected: `PROBE OK (www.vinted.co.uk): 96 cards, … priced, … with model; item …: N photos, seller rating …`

- [ ] **Step 7: Commit**

```bash
git add src/bot/bot.ts src/main.ts scripts/probe.ts test/bot.test.ts
git commit -m "feat: grammY wiring, app entry point and live Vinted probe"
```

---

### Task 20: Running it — Docker, CI probe and README

**Files:**
- Create: `Dockerfile`, `.dockerignore`, `docker-compose.yml`, `.github/workflows/probe.yml`, `README.md`

**Interfaces:**
- Consumes: `npm start`, `npm run probe` (Task 19).
- Produces: deployment and documentation files only.

- [ ] **Step 1: Write the container files**

`Dockerfile`:

```dockerfile
FROM node:22-bookworm-slim
WORKDIR /app
# Build tools in case better-sqlite3 has no prebuilt binary for this platform.
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY tsconfig.json ./
COPY src ./src
ENV NODE_ENV=production
ENV DATABASE_PATH=/data/flipradar.db
VOLUME ["/data"]
CMD ["npx", "tsx", "src/main.ts"]
```

`.dockerignore`:

```
node_modules
data
.env
.git
test
docs
coverage
```

`docker-compose.yml`:

```yaml
services:
  flipradar:
    build: .
    env_file: .env
    environment:
      DATABASE_PATH: /data/flipradar.db
    volumes:
      - flipradar-data:/data
    restart: unless-stopped

volumes:
  flipradar-data:
```

`.github/workflows/probe.yml`:

```yaml
name: Vinted probe (data-centre IP)

on:
  workflow_dispatch:

jobs:
  probe:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: npm
      - run: npm ci
      - run: npm run probe
```

- [ ] **Step 2: Write the README**

`README.md`:

````markdown
# flipradar

Telegram alerts for new Vinted UK listings, with how each price compares to similar listings.
Private beta. Design: `docs/superpowers/specs/2026-10-07-flipradar-beta-design.md`.

## Setup

1. Create a bot: message [@BotFather](https://t.me/BotFather) → `/newbot` → copy the token.
2. Find your Telegram user ID: message [@userinfobot](https://t.me/userinfobot).
3. Configure:
   ```bash
   cp .env.example .env
   # set TELEGRAM_BOT_TOKEN and ADMIN_TELEGRAM_ID
   ```
4. Install and check:
   ```bash
   npm install
   npm test
   npm run probe     # live check that Vinted pages still parse
   ```

## Run

```bash
npm start          # foreground
npm run start:mac  # same, but keeps the Mac from idle-sleeping (caffeinate)
```

Message your bot `/start`. You become the admin automatically.

### Inviting testers

- `/invite 3` creates three one-time invite links. Send one to each tester.
- Anyone who messages the bot without an invite joins the waitlist; see it with `/waitlist`.
- `/stats` and `/health` show how the engine is doing.

### Keep it running on a Mac

The Mac must stay plugged in; closing the lid still sleeps it. To start at login and restart after crashes, save this as `~/Library/LaunchAgents/com.flipradar.bot.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.flipradar.bot</string>
  <key>ProgramArguments</key>
  <array><string>/bin/zsh</string><string>-lc</string><string>cd ~/flipradar &amp;&amp; npm run start:mac</string></array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>/tmp/flipradar.log</string>
  <key>StandardErrorPath</key><string>/tmp/flipradar.err.log</string>
</dict>
</plist>
```

Then: `launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.flipradar.bot.plist`
(stop with `launchctl bootout gui/$(id -u)/com.flipradar.bot`).

## Moving to a server

```bash
docker compose up -d --build
```

The database lives on the `flipradar-data` volume; `.env` is passed in by compose.

Before paying for a server, check whether Vinted serves data-centre IPs: GitHub → Actions →
"Vinted probe (data-centre IP)" → Run workflow. A green run means a cloud server should work.

## Privacy

Stored: testers' Telegram IDs, usernames and searches; anonymous listing prices. Never stored:
Vinted seller usernames or IDs. `/deleteme` erases a tester's data.
````

- [ ] **Step 3: Verify**

Run: `npm run typecheck && npm test && npm run probe`
Expected: all pass, `PROBE OK …`.

If Docker is installed (`docker --version` succeeds), also run: `docker build -t flipradar .`
Expected: image builds. If Docker is not installed, skip this and note it in the hand-off.

- [ ] **Step 4: Commit**

```bash
git add Dockerfile .dockerignore docker-compose.yml .github/workflows/probe.yml README.md
git commit -m "docs: README, Docker setup and data-centre probe workflow"
```

---

## Manual end-to-end check (needs the owner's bot token)

Not automatable here; the owner does this once after Task 20:

1. Create the bot with @BotFather, fill in `.env`, run `npm start`.
2. In Telegram: `/start` → welcome as admin. `/new` → `iphone 15` → `350` → Skip → Done → Skip → Create.
3. Expect "Search saved" then a preview with current matches within ~10 s.
4. Within a few minutes, expect a 🔔 alert for a newly listed iPhone 15 under £350.
5. `/invite 1`, open the link from a second Telegram account → welcome; `/searches` there is empty.
6. `/health` shows the term polled seconds ago; stop with Ctrl+C and restart: no restart warning (clean shutdown). Kill with `kill -9` and restart: "restarted after an unexpected stop".
