# flipradar — Beta Alert Engine Design

- **Date:** 2026-10-07
- **Status:** Draft for review
- **Scope:** Milestone 1 of the flipradar micro-SaaS — the alert engine plus a private Telegram beta. Web sign-up, billing and other marketplaces are later milestones with their own specs.

## 1. Summary

flipradar watches Vinted UK for new listings that match resellers' saved searches and sends a Telegram alert within seconds. Unlike existing Vinted alert tools, every alert says **whether the price is good**: how far it sits below the typical listing price for comparable items, based on price data flipradar collects itself.

The beta runs as one Node.js/TypeScript process on the owner's Mac, serves the owner plus about five invited testers (≈25 searches), and doubles as the source of real alerts for TikTok marketing.

## 2. Goals, success criteria, non-goals

### Goals
1. Reliable, fast alerts for new Vinted UK listings matching a tester's search.
2. Deal insight on alerts: "£X below typical · cheaper than N% of M similar listings".
3. A Telegram-only experience: invite, create a search, receive alerts, manage searches.
4. Early warning to the owner when Vinted blocks requests or changes its page layout.
5. Price data collection from day one, so deal insight improves over time.

### Success criteria (measured during a 2-week beta)
- Median alert latency ≤ 60 s, measured from the item first appearing in our poll of its search term to the Telegram message being sent.
- Zero duplicate alerts (same item, same search).
- Deal insight (median-based, ≥ 10 comparable listings) shown on ≥ 70 % of alerts for searches whose results carry a Vinted model (phones, consoles…).
- Vinted blocking or a layout change is reported to the owner within 10 minutes.
- At least 5 testers each keep ≥ 1 search active for the 2 weeks.

### Non-goals for this milestone
- Web app, accounts outside Telegram, payments/Stripe, plan tiers.
- Vinted countries other than the UK; Facebook Marketplace or other sources.
- Category, brand and size filters; editing a saved search (delete and recreate instead).
- Sold-price tracking; a "deals only" alert mode; price-drop alerts.
- Email, mobile-app or Discord delivery.
- Proxies (designed for, not built).

## 3. Context

### Product position
Vinted alert tools are a crowded category (Vinotify, Telvin Bot, Clothing Alerts, CollectAlert, Apify actors). They tell users *that* something was listed. A review of Vinotify on 2026-10-07 (free account) found:

- Search form: country (27 sites), keywords, min/max price, category, brand, size, condition, per-search check frequency, email/app notifications.
- Pricing: Free (1 search, daily checks), Plus £2.99/mo (10 searches), Premium £4.99/mo (25 + price-drop alerts), Pro £19.99/mo (100 + multi-market, webhooks, AI/MCP).
- Its search preview took ~40 s and, for "iphone 15", included a £2 phone case, an "iPhone box only" listing and a handbag. Prices excluded Vinted's buyer fee. No indication of whether a price is good.
- Affiliate scheme: £1 per sign-up.

flipradar's differentiators for the beta: deal insight, strict relevance matching, fee-inclusive prices, an instant preview when a search is created, and alerts that carry seller trust and listing age.

### Technical starting point
Vinted retired its `/api/v2/catalog/items` endpoint (404). Its catalog and item pages are server-rendered and readable without login, cookie or browser. A working parser and tests exist in `~/fbm-sniper-community`:

- `lib/vinted-scraper.js` — `parseVintedCatalogHtml`, `parseVintedItemHtml`, `parseVintedMoney`, `buildVintedSearchUrl`, `VINTED_COUNTRIES`.
- `test/vinted-scraper.test.js` — fixtures and tests for the above.

Observed page facts the design relies on:
- `https://www.vinted.co.uk/catalog?search_text=…&order=newest_first[&page=N]` returns 96 item cards per page, newest first.
- Each card carries `data-testid="product-item-id-<id>…"` hooks; its link `title` reads like `iPhone 15, Brand: Apple, Model: iPhone 15, Condition: Very good, 350.00 £, 368.20 £`, giving title, brand, model (electronics), condition, item price and fee-inclusive price.
- Item pages embed a Next.js RSC payload with a `plugins` array: description, attributes (`internal_memory_capacity`, `sim_lock`, `status`, `upload_date` such as "2 min ago"), seller `feedback_reputation`/`feedback_count`, and a `buyer_item_status` banner once sold or reserved.

## 4. Architecture

One Node.js process. All state in one SQLite file.

```
 Telegram ──► bot ──────────────► db (SQLite) ◄──────────────┐
 (testers)    wizard, commands,    users, invites, searches,  │
              invites, admin       terms, items, prices,      │
                                   alerts                     │
                                      │                       │
                                      ▼                       │
              poller ──► request queue ──► vinted client ──► Vinted UK
              (picks due    (spacing,        (fetch + parse)  │
               terms)        priority,                        │
                   │         backoff)                         │
                   ▼                                          │
              pipeline ──► matcher (pure) ──► insight (pure)  │
                   │                                          │
                   ▼                                          │
              alerts ──► notifier ──► Telegram ───────────────┘
                   │
              health ◄── counters/events ──► admin (owner)
```

### Units

| Unit | Purpose | Depends on |
|---|---|---|
| `config` | Reads and validates `.env` into a typed object. | — |
| `db` | Schema migrations and small repository functions per table. Only unit that touches SQLite. | `better-sqlite3` |
| `vinted/parse` | Pure: catalog HTML → `CardListing[]`; item HTML → `ItemDetail \| null`; money parsing. Ported from `fbm-sniper-community`. | — |
| `vinted/url` | Pure: builds catalog URLs (`search_text`, `order=newest_first`, `page`). | — |
| `vinted/client` | Fetches a catalog page or item page through the request queue; classifies responses (ok / blocked / error). | `fetch`, `requestQueue` |
| `poller/requestQueue` | Single queue for every Vinted request: spacing + jitter, priority, global backoff. | clock |
| `poller/poller` | Chooses which search term is due, runs baseline/warm-up, detects new items per term, hands them to the pipeline. | `db`, `vinted/client`, `pipeline`, `health` |
| `matching/match` | Pure: does an item satisfy a search (card stage, detail stage)? | `matching/normalize` |
| `insight/groups` | Pure: comparison-group key for a listing. | — |
| `insight/stats` | Pure: median, percentile and labels from a list of prices. | — |
| `alerts/pipeline` | For new items: card match → detail fetch (once per item) → detail match → insight → create alert rows. | `db`, `match`, `insight`, `vinted/client` |
| `alerts/flood` | Pure: decides send vs. digest for a search given its recent alert times. | — |
| `alerts/format` | Pure: alert, digest and preview message text + buttons. | — |
| `alerts/notifier` | Sends pending alerts with per-chat and global pacing, retries, photo fallback. | `grammY` API, `db` |
| `bot/wizard` | Pure state machine for `/new`: (state, input) → (state, reply). | — |
| `bot/bot` | grammY wiring: commands, callback buttons, access control; thin adapters over pure units. | `grammY`, `db`, `wizard`, `format` |
| `health` | Tracks counters/events, decides when to message the owner, renders `/health`. | `db`, notifier |
| `main` | Composition root: builds everything, starts bot + poller + notifier, handles shutdown. | all |

## 5. Data model (SQLite)

Money is stored as integer pence. Times are Unix milliseconds.

```sql
users(
  telegram_id     INTEGER PRIMARY KEY,
  username        TEXT,
  first_name      TEXT,
  status          TEXT NOT NULL CHECK (status IN ('waitlist','beta','admin')),
  search_limit    INTEGER NOT NULL DEFAULT 5,
  bot_blocked     INTEGER NOT NULL DEFAULT 0,
  created_at      INTEGER NOT NULL
)

invites(
  code            TEXT PRIMARY KEY,
  created_by      INTEGER NOT NULL,
  created_at      INTEGER NOT NULL,
  used_by         INTEGER,
  used_at         INTEGER
)

searches(
  id              INTEGER PRIMARY KEY,
  user_id         INTEGER NOT NULL REFERENCES users(telegram_id),
  keywords        TEXT NOT NULL,          -- as typed
  term_key        TEXT NOT NULL,          -- normalised keywords; shared fetch key
  max_price_p     INTEGER NOT NULL,       -- fee-inclusive
  min_price_p     INTEGER,
  conditions      TEXT NOT NULL,          -- JSON array of condition codes; [] = any
  exclude_words   TEXT NOT NULL,          -- JSON array
  match_mode      TEXT NOT NULL CHECK (match_mode IN ('strict','loose')),
  status          TEXT NOT NULL CHECK (status IN ('active','paused')),
  active_since    INTEGER NOT NULL,       -- set on create and on resume
  created_at      INTEGER NOT NULL
)

terms(                                    -- one row per distinct term_key with ≥1 active search
  term_key        TEXT PRIMARY KEY,
  baseline_at     INTEGER,                -- null until first successful poll
  warmed_up_at    INTEGER,                -- null until pages 2–5 fetched
  last_polled_at  INTEGER,
  last_success_at INTEGER,
  had_results     INTEGER NOT NULL DEFAULT 0,
  empty_streak    INTEGER NOT NULL DEFAULT 0
)

term_items(                               -- "seen" set per term
  term_key        TEXT NOT NULL,
  vinted_id       TEXT NOT NULL,
  first_seen_at   INTEGER NOT NULL,
  last_seen_at    INTEGER NOT NULL,       -- refreshed every poll the card is on page 1
  PRIMARY KEY (term_key, vinted_id)
)

items(                                    -- latest card data + cached detail
  vinted_id       TEXT PRIMARY KEY,
  title           TEXT NOT NULL,
  brand           TEXT,
  model           TEXT,
  condition       TEXT,                   -- condition code
  price_p         INTEGER,                -- fee-inclusive
  item_price_p    INTEGER,
  photo_url       TEXT,
  url             TEXT NOT NULL,
  card_seen_at    INTEGER NOT NULL,
  detail_json     TEXT,                   -- ItemDetail, null until fetched
  detail_fetched_at INTEGER
)

price_observations(                       -- anonymous; no seller data
  vinted_id       TEXT PRIMARY KEY,
  group_key       TEXT NOT NULL,
  model_known     INTEGER NOT NULL,
  price_p         INTEGER NOT NULL,
  first_observed_at INTEGER NOT NULL,
  observed_at     INTEGER NOT NULL        -- last time seen/updated
)
CREATE INDEX price_obs_group ON price_observations(group_key, observed_at);

alerts(
  id              INTEGER PRIMARY KEY,
  search_id       INTEGER NOT NULL REFERENCES searches(id),
  vinted_id       TEXT NOT NULL,
  status          TEXT NOT NULL CHECK (status IN ('pending','sent','digested','dropped','failed')),
  insight_json    TEXT,
  created_at      INTEGER NOT NULL,       -- = term_items.first_seen_at of the triggering item
  sent_at         INTEGER,
  UNIQUE (search_id, vinted_id)
)

wizard_state(                             -- in-progress /new per chat
  telegram_id     INTEGER PRIMARY KEY,
  state_json      TEXT NOT NULL,
  updated_at      INTEGER NOT NULL
)

meta(                                     -- small key/value store
  key             TEXT PRIMARY KEY,       -- e.g. 'clean_shutdown_at', 'started_at'
  value           TEXT NOT NULL
)
```

Retention, run hourly: `term_items` with `last_seen_at` and `items` with `card_seen_at` older than 7 days (pruning by *last* sighting means a listing still visible on page 1 is never forgotten and re-alerted); `price_observations` with `observed_at` older than 30 days; `alerts` older than 30 days; `wizard_state` older than 1 hour; `terms` rows with no active searches.

## 6. Searches and matching

### Search definition
- **keywords** (required, 2–60 chars).
- **max price** (required), fee-inclusive, £1–£10,000.
- **min price** (optional), fee-inclusive, below max.
- **conditions**: any subset of `new_with_tags`, `new_without_tags`, `very_good`, `good`, `satisfactory`, `not_fully_functional`; empty = any.
- **exclude words** (optional): up to 20 words or phrases.
- **match mode**: `strict` (default) or `loose`.

### Term key and shared fetching
`term_key` = keywords lowercased, punctuation except `+`/`-` replaced by spaces, whitespace collapsed, trimmed. All searches with the same `term_key` share one Vinted fetch. The catalog request carries only `search_text` and `order=newest_first` (plus `page` during warm-up); price, condition and words are filtered locally so differently-priced searches still share.

### Text normalisation (shared helper)
Lowercase, Unicode NFKD with diacritics removed, punctuation → space, whitespace collapsed, then split into **words** on spaces.

### Strict keyword matching
Matching is by **whole words**, never by substring, so `pro` does not match `protector` and `cap` does not match `capri`.

- **Listing words** `L`: the words of `title + brand + model`.
- **Listing phrases** `P`: every word in `L`, plus every run of 2 or 3 adjacent words in `L` joined without spaces (`"i phone"` → `iphone`, `"128 gb"` → `128gb`, `"ralph lauren"` → `ralphlauren`).
- **Same word** (`a ≈ b`): `a = b`, or one equals the other plus `s` or `es` (`polo` ≈ `polos`, `dress` ≈ `dresses`).
- **Search words** `S`: the words of the keywords, in order.

Walk `S` from the start. At each position try joining the next 3, then 2, then 1 search words without spaces; take the longest join that is `≈` some phrase in `P` and move past those words. If none matches, a one-character word (e.g. the `i` in `i phone`) is skipped; any longer word means **no match**. The listing matches when every search word has been consumed. Word order in the listing does not matter.

| Search | Listing title (+ brand/model) | Strict match |
|---|---|---|
| ralph lauren polo | Ralph Lauren Polo Shirt Navy M | ✅ |
| ralph lauren polo | Polo Ralph Lauren cap | ✅ any order |
| ralph lauren polo | RalphLauren polo tee | ✅ `ralph`+`lauren` = `ralphlauren` |
| ralph lauren polo | Lauren Ralph Lauren dress | ❌ no `polo` |
| polo | Ralph Lauren polos bundle | ✅ plural |
| iphone 15 | I Phone 15 . Good Condition | ✅ `i`+`phone` joined in listing |
| i phone 15 | iPhone 15 128GB | ✅ `i`+`phone` joined in search |
| iphone 15 pro | iPhone 15 screen protector | ❌ `pro` ≠ `protector` |
| 128gb | iPhone 15 128 GB | ✅ `128`+`gb` |
| cap | Capri trousers | ❌ `cap` ≠ `capri` |

These rows are required test cases.

### Card-stage match (from card data only)
An item passes for a search when all hold:
1. `price_p` (fee-inclusive; falls back to `item_price_p` when the card has no total) ≤ `max_price_p` and ≥ `min_price_p` if set.
2. `conditions` empty, or the item's condition code is in it. Unknown condition passes only when `conditions` is empty.
3. **Strict mode:** the listing passes *Strict keyword matching* (above). **Loose mode:** skipped (Vinted's own matching is trusted).
4. No exclude word appears as a whole word/phrase in the normalised title.

### Detail stage
Items that pass the card stage for at least one search have their item page fetched **once** (cached in `items.detail_json`). Then, per search:
1. Drop if the detail says the item is unavailable (sold/reserved banner).
2. No exclude word appears as a whole word/phrase in description + attribute values.
3. If the item page cannot be fetched or parsed after one retry, alert on card data alone and mark the alert "details unavailable".

Exclude-word matching uses whole-word boundaries on normalised text (`locked` does not match `unlocked`).

### Condition mapping (UK)
Card/attribute labels → codes: "New with tags" → `new_with_tags`, "New without tags" → `new_without_tags`, "Very good" → `very_good`, "Good" → `good`, "Satisfactory" → `satisfactory`, "Not fully functional" → `not_fully_functional`. Anything else → `unknown`.

## 7. Polling, new-item detection and request budget

### Request queue
- Every Vinted request goes through one queue.
- Spacing: `REQUEST_SPACING_MS` (default 1500) + uniform jitter 0–500 ms between request starts.
- Priority: item-page fetches > catalog polls > warm-up pages.
- One request in flight at a time.

### Choosing what to poll
A term is due when `now − last_polled_at ≥ MIN_TERM_INTERVAL_MS` (default 30 000). The poller always enqueues the due term with the oldest `last_polled_at`, so terms are served round-robin. With ~25 terms each is polled about every 40 s; `/health` shows the measured cycle time.

### First poll of a term (baseline + warm-up)
1. Fetch page 1. Insert every card into `term_items` (`first_seen_at = last_seen_at = now`) and `items`, record price observations, set `baseline_at`. **No searches are evaluated.**
2. Enqueue pages 2–5 at warm-up priority. Their cards only feed `items` and `price_observations` (not `term_items`); then set `warmed_up_at`.

### Subsequent polls
1. Fetch page 1 and parse cards. Upsert `items` and price observations for every card.
2. **New for term** = card IDs not in `term_items` for this term. Insert them with `first_seen_at = last_seen_at = now`; refresh `last_seen_at` for the cards already known.
3. For each new item, evaluate every active search on the term with `active_since < first_seen_at`, running the pipeline (§6).
4. **Overflow:** if page 1 has ≥ 90 cards and every card is new for the term, record an overflow event (possible missed listings); notify the owner at most once per hour per term.

### Bumped listings
A listing a seller pushes back to the top is already in `term_items` and does not re-alert. A bumped listing we never saw before is new for the term and does alert; its "Uploaded … ago" line (from the item page) shows its age.

## 8. Deal insight

### Comparison group
`group_key = term_key | model | storage | condition_band`
- `model`: from the card's "Model:" label, normalised; `-` if absent.
- `storage`: first match of `(\d{2,4})\s?(gb|tb)` in the normalised title (e.g. `128gb`), else from the detail attribute `internal_memory_capacity` when available; `-` if absent.
- `condition_band`: `new` (new with/without tags), `good` (very good, good), `worn` (satisfactory), `faulty` (not fully functional), `unknown`.

Every card seen (baseline, warm-up, routine polls) upserts one `price_observations` row keyed by Vinted ID, updating `price_p` and `observed_at`.

### Statistics for an alert
Using observations in the same group with `observed_at` within 30 days, excluding the alerted item:
- `n` = count. If `n < 10` → "Not enough price data yet".
- `median` of `price_p`.
- `percentile` = share of observations with `price_p` greater than the item's price, rounded to a whole percent.
- Line when the model is known: `💰 £{median − price} below typical · cheaper than {percentile}% of {n} similar` (or `£X above typical` when negative).
- Line when no model (most fashion): `💰 Cheaper than {percentile}% of {n} similar (rough)`.
- Wording always says "typical listing price" in help text and previews. These are asking prices, not sold prices.

### Preview on search creation
After a search is created: if the term has a baseline, reply immediately; otherwise poll the term at catalog priority (ahead of the normal round-robin) and reply when page 1 is in. The preview shows the group's typical price for the most common model/condition among matching cards (if `n ≥ 10`) and the 3 newest cards that pass the card stage.

## 9. Telegram experience

### Access
- `/start <code>` with a valid unused invite → status `beta`, code consumed, welcome + privacy note + `/help`.
- `/start` without a valid code from an unknown user → status `waitlist`, reply "Private beta — you're #N on the waitlist."
- The owner (`ADMIN_TELEGRAM_ID`) is `admin` on first contact.
- Waitlisted users can only use `/start`, `/help`, `/deleteme`.

### `/new` wizard
Steps, each with **Cancel** and, where optional, **Skip**:
1. Keywords.
2. Max price (fee-inclusive), accepting `300`, `£300`, `300.50`.
3. Min price (optional). If the term already has ≥ 10 price observations with a known model, the prompt suggests 40 % of their median, rounded down to the nearest £10 (cases and boxes carry no model, so this median reflects the device itself). Otherwise no suggestion.
4. Conditions: six toggle buttons + **Any** + **Done**.
5. Exclude words (optional), comma-separated.
6. Summary with toggle **Strict ✓ / Loose** and **Create**.

Validation errors re-ask the same step. The wizard state lives in `wizard_state`, expires after 1 hour, and `/cancel` ends it. Exceeding `search_limit` is refused at step 1.

### Alert message
`sendPhoto` with HTML caption; falls back to `sendMessage` if the photo fails.
```
📱 {title} · {condition label} · {brand}
£{total} (£{item} + £{fee} fee) + postage
{insight line}
⭐ Seller {rating}% ({reviews} reviews) · Uploaded {upload_date}
[ Open on Vinted ]  [ Pause this search ]
```
Lines with missing data are omitted. "Pause this search" sets `status = 'paused'`.

### Flood control
Per search: if 10 alerts were sent in the last 10 minutes, further matches become `digested`; at the end of the window one digest message lists up to 5 of them (title, price, link) plus "N more — tighten your max price?".

### Commands
- Testers: `/new`, `/searches` (one message per search with ⏸/▶/🗑 buttons; 🗑 asks for confirmation via an inline button, not a dialog), `/help`, `/feedback <text>` (forwarded to the owner), `/cancel`, `/deleteme` (confirm button; deletes the user's searches, alerts, wizard state and user row).
- Owner: `/invite [n]` (1–10 codes, returns `t.me/<bot>?start=<code>` links), `/stats` (testers, active searches, distinct terms, alerts 24 h, median alert latency 24 h, cycle time), `/health` (backoff state, last success, per-term last poll / empty streak / overflow count), `/waitlist` (count + newest 10 usernames).

### Sending
- Per chat: ≥ 1.1 s between messages. Global: ≤ 25 messages/s.
- Pending alerts are sent oldest first. On startup, pending alerts older than 10 minutes become `dropped`.
- Telegram 429: wait `retry_after`, then retry. Other errors: retry 3 times with 2/4/8 s waits, then `failed`.
- Telegram 403 "bot was blocked by the user": set `users.bot_blocked = 1`, pause the user's searches.

## 10. Health and error handling

| Condition | Action |
|---|---|
| HTTP 403/429/503, or a body containing a Cloudflare challenge (`cf-chl`, "Just a moment") | Global backoff: pause the queue 1 min, doubling up to 30 min while it persists. Message the owner when backoff starts and when a request next succeeds. |
| Network error / timeout (15 s) | Retry the request once after 5 s; then count a failure for that term and move on. |
| HTTP 200 with zero cards on page 1 for a term with `had_results = 1` | `empty_streak += 1`; at 3, message the owner "Vinted layout may have changed (term: …)". Reset on any non-empty result. |
| No successful Vinted request for 5 minutes while not in backoff | Message the owner. |
| Overflow (§7) | Message the owner at most once per hour per term. |
| Process start | If `meta.clean_shutdown_at` is older than `meta.started_at` (the previous run did not shut down cleanly), message the owner "Restarted after an unexpected stop". On SIGINT/SIGTERM, stop polling, flush sends for up to 5 s, then write `clean_shutdown_at`. |
| Unhandled exception in a poll or send | Log, count, continue; the loop never dies on one bad item. |

Owner messages are rate-limited to one per condition per 15 minutes.

## 11. Privacy

- Stored about people: Telegram ID, username, first name, searches, alerts sent to them.
- Not stored: Vinted seller usernames or IDs. Alerts show seller rating and review count only.
- Price observations hold no personal data.
- `/start` includes a short privacy note; `/deleteme` erases a user's data.
- Retention as in §5.

## 12. Configuration

`.env` (git-ignored); `.env.example` committed.

| Variable | Default | Meaning |
|---|---|---|
| `TELEGRAM_BOT_TOKEN` | — (required) | From @BotFather. |
| `ADMIN_TELEGRAM_ID` | — (required) | Owner's numeric Telegram ID. |
| `DATABASE_PATH` | `./data/flipradar.db` | SQLite file. |
| `VINTED_HOST` | `www.vinted.co.uk` | Beta is UK only. |
| `REQUEST_SPACING_MS` | `1500` | Minimum gap between Vinted requests. |
| `MIN_TERM_INTERVAL_MS` | `30000` | Minimum gap between polls of one term. |
| `DEFAULT_SEARCH_LIMIT` | `5` | Searches per beta tester. |
| `USER_AGENT` | current desktop Chrome UA | Sent to Vinted. |
| `LOG_LEVEL` | `info` | pino level. |

## 13. Technology

- Node.js ≥ 22, TypeScript (strict), ES modules; `tsx` to run, `tsc` to type-check.
- `grammY` for Telegram (long polling; no public URL needed on the Mac).
- `better-sqlite3` for SQLite (synchronous, mature, prebuilt binaries for macOS arm64 and Linux).
- Native `fetch` for HTTP.
- `pino` for JSON logs.
- `vitest` for tests.
- `zod` for config validation.

## 14. Repository layout

```
flipradar/
  src/
    main.ts
    config.ts
    db/            schema.sql, migrate.ts, users.ts, searches.ts, terms.ts, items.ts, prices.ts, alerts.ts
    vinted/        parse.ts, url.ts, client.ts, types.ts
    poller/        requestQueue.ts, poller.ts
    matching/      normalize.ts, match.ts, conditions.ts
    insight/       groups.ts, stats.ts
    alerts/        pipeline.ts, flood.ts, format.ts, notifier.ts
    bot/           bot.ts, wizard.ts, commands.ts, admin.ts
    health/        health.ts
  test/
    fixtures/      catalog-uk.html, item-uk.html (seller names scrubbed)
    *.test.ts
  scripts/probe.ts
  Dockerfile
  docker-compose.yml
  .env.example
  .github/workflows/probe.yml
  docs/superpowers/specs/
```

## 15. Testing

- **Parser:** real saved Vinted UK catalog and item pages (seller names and photos URLs scrubbed) plus the existing synthetic cases from `fbm-sniper-community`.
- **Matcher:** table-driven cases for price bounds (fee-inclusive and fallback), conditions, strict/loose, every row of the strict-matching table in §6, whole-word excludes (`unlocked` vs `locked`), detail-stage drops.
- **Insight:** groups (model/storage/band extraction), median/percentile, `n < 10`, excluding the item itself, the no-model "rough" label.
- **Poller:** fake clock + fake client: baseline without alerts, warm-up pages, `active_since` cut-off, resume, overflow, round-robin order, empty-streak alarm.
- **Request queue:** spacing, priority order, backoff doubling and reset.
- **Wizard:** every step, validation re-asks, Skip/Cancel, search-limit refusal.
- **Flood + format:** digest thresholds; message text for full and partial data.
- **Notifier:** pacing, 429 `retry_after`, blocked-user handling, startup drop of stale alerts (fake Telegram API).
- **Live canary:** `npm run probe` fetches one real catalog page and one item page and exits non-zero if parsing yields no cards or no detail. Run manually and from GitHub Actions.

## 16. Running

- **Mac (beta):** `npm start`; `npm run start:mac` wraps it in `caffeinate -is` so the Mac doesn't idle-sleep. The Mac must stay powered; closing the lid still sleeps it. An optional `launchd` agent (documented in the README) starts it at login and restarts it on crash.
- **Server (later):** `docker compose up -d` with the database on a named volume and the same `.env`.
- **Data-centre spike:** `.github/workflows/probe.yml` runs `npm run probe` on demand from a GitHub-hosted runner to learn whether Vinted serves data-centre IPs before paying for a server.

## 17. Risks

| Risk | Mitigation |
|---|---|
| Vinted/Meta terms of service prohibit scraping; commercial use raises exposure; UK GDPR applies. | Beta is private and free. Minimal personal data, deletion on request. Legal advice before charging. |
| Vinted blocks or rate-limits the home IP. | Conservative request budget, global backoff, owner alerts; proxies designed in later. |
| Vinted changes page markup. | Parser on stable `data-testid` hooks, fixtures, live canary, empty-streak alarm. |
| Asking prices overstate value. | Wording says "typical listing price"; sold-price tracking is the planned next step. |
| Mac sleeps or goes offline. | `caffeinate`, launchd, restart notice; server move prepared. |
| Telegram sending limits during bursts. | Pacing, flood control, digests. |

## 18. Later milestones (not in this spec)

1. Web landing page + waitlist, sign-up, search management UI.
2. Stripe billing and plan limits.
3. Category / brand / size filters; more Vinted countries.
4. Sold-price tracking and a "deals only" mode.
5. Proxy support and server hosting.
6. Additional sources (Facebook Marketplace).
