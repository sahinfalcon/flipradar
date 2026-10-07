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
