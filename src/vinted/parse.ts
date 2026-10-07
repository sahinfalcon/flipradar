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
