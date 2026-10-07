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

  it("keeps titles that contain a colon (Final review I1)", () => {
    const html =
      card("601", "The Legend of Zelda: Tears of the Kingdom, Brand: Nintendo, Condition: Very good, 40.00 £, 42.70 £", "£40.00", "£42.70") +
      card("602", "Size: M Nike hoodie, Brand: Nike, Size: M, Condition: Good, 15.00 £, 16.45 £", "£15.00", "£16.45") +
      card("603", "Pokemon: Scarlet, with case, Brand: Nintendo, Condition: Good, 30.00 £, 32.20 £", "£30.00", "£32.20");
    const page = parseCatalogHtml(html, HOST);
    if (page.kind !== "ok") throw new Error("expected ok");
    expect(page.cards.map((c) => [c.title, c.brand, c.condition])).toEqual([
      ["The Legend of Zelda: Tears of the Kingdom", "Nintendo", "very_good"],
      ["Size: M Nike hoodie", "Nike", "good"],
      ["Pokemon: Scarlet, with case", "Nintendo", "good"],
    ]);
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
