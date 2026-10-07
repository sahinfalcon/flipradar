import { z } from "zod";

export const DEFAULT_USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36";

const Schema = z.object({
  TELEGRAM_BOT_TOKEN: z.string().min(1),
  ADMIN_TELEGRAM_ID: z.coerce.number().int().positive(),
  DATABASE_PATH: z.string().min(1).default("./data/flipradar.db"),
  VINTED_HOST: z.string().min(1).default("www.vinted.co.uk"),
  REQUEST_SPACING_MS: z.coerce.number().int().min(250).default(1500),
  MIN_TERM_INTERVAL_MS: z.coerce.number().int().min(5000).default(30000),
  DEFAULT_SEARCH_LIMIT: z.coerce.number().int().min(1).max(100).default(5),
  USER_AGENT: z.string().min(1).default(DEFAULT_USER_AGENT),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),
});

export interface Config {
  telegramBotToken: string;
  adminTelegramId: number;
  databasePath: string;
  vintedHost: string;
  requestSpacingMs: number;
  minTermIntervalMs: number;
  defaultSearchLimit: number;
  userAgent: string;
  logLevel: "fatal" | "error" | "warn" | "info" | "debug" | "trace" | "silent";
}

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const present = Object.fromEntries(Object.entries(env).filter(([, value]) => value !== undefined && value !== ""));
  const result = Schema.safeParse(present);
  if (!result.success) {
    const problems = result.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ");
    throw new Error(`Invalid configuration — ${problems}`);
  }
  const e = result.data;
  return {
    telegramBotToken: e.TELEGRAM_BOT_TOKEN,
    adminTelegramId: e.ADMIN_TELEGRAM_ID,
    databasePath: e.DATABASE_PATH,
    vintedHost: e.VINTED_HOST,
    requestSpacingMs: e.REQUEST_SPACING_MS,
    minTermIntervalMs: e.MIN_TERM_INTERVAL_MS,
    defaultSearchLimit: e.DEFAULT_SEARCH_LIMIT,
    userAgent: e.USER_AGENT,
    logLevel: e.LOG_LEVEL,
  };
}
