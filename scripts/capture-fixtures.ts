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

/**
 * Redact seller identity: login/username values and the "name" inside the seller block
 * (the object carrying feedback_reputation) are replaced everywhere; seller/user IDs become 0.
 */
function scrub(html: string): string {
  const names = new Set<string>();
  for (const match of html.matchAll(/\\?"(?:login|username)\\?"\s*:\s*\\?"([^"\\]+)/g)) {
    if (match[1]) names.add(match[1]);
  }
  for (const match of html.matchAll(/\\?"feedback_reputation\\?"[^{}]*?\\?"name\\?"\s*:\s*\\?"([^"\\]+)/g)) {
    if (match[1]) names.add(match[1]);
  }
  let out = html;
  for (const name of names) out = out.split(name).join("redacted");
  return out.replace(/(\\?"(?:seller_id|user_id)\\?"\s*:\s*\\?"?)\d+/g, "$10");
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

  const empty = await get(catalogUrl(HOST, "zzqxjv nonexistentthing"));
  if (parseCatalogHtml(empty, HOST).kind !== "empty") throw new Error("empty search not recognised");
  writeFileSync(new URL("empty-uk.html", OUT), trimEmpty(empty));

  console.log(`Saved fixtures: ${page.cards.length} cards; item ${firstUrl}`);
}

await main();
