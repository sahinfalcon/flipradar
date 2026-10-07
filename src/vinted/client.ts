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
