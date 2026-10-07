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
