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
