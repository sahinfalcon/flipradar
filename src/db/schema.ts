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
