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
