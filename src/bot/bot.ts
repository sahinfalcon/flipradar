import type { Bot, Context } from "grammy";
import type { InlineKeyboardMarkup } from "grammy/types";
import type { BotService } from "./service.js";
import type { Actor, BotButton, BotReply, ServiceResult } from "./types.js";

export const BOT_COMMANDS = [
  { command: "new", description: "Create a search" },
  { command: "searches", description: "Pause, resume or delete searches" },
  { command: "help", description: "All commands" },
  { command: "feedback", description: "Send feedback" },
  { command: "deleteme", description: "Erase your data" },
];

export function toInlineMarkup(buttons?: BotButton[][]): InlineKeyboardMarkup | undefined {
  if (!buttons || buttons.length === 0) return undefined;
  return {
    inline_keyboard: buttons.map((row) =>
      row.map((button) => (button.url ? { text: button.text, url: button.url } : { text: button.text, callback_data: button.data ?? "noop" })),
    ),
  };
}

/** Thin adapter: Telegram updates → BotService → replies. Private chats only. */
export function attachHandlers(bot: Bot, service: BotService, log: { error(obj: object, msg: string): void }): void {
  const actorOf = (ctx: Context): Actor | null =>
    ctx.from && ctx.chat?.type === "private"
      ? { telegramId: ctx.from.id, username: ctx.from.username ?? null, firstName: ctx.from.first_name ?? null }
      : null;

  const send = async (ctx: Context, replies: BotReply[]) => {
    for (const reply of replies) {
      await ctx.reply(reply.text, { parse_mode: "HTML", reply_markup: toInlineMarkup(reply.buttons), link_preview_options: { is_disabled: true } });
    }
  };

  const deliver = async (ctx: Context, result: ServiceResult) => {
    await send(ctx, result.replies);
    if (result.followUp) {
      void result.followUp.then((replies) => send(ctx, replies)).catch((error: unknown) => log.error({ err: error }, "follow-up failed"));
    }
  };

  const handle = (fn: (actor: Actor, ctx: Context) => Promise<ServiceResult>) => async (ctx: Context) => {
    const actor = actorOf(ctx);
    if (!actor) return;
    await deliver(ctx, await fn(actor, ctx));
  };

  const arg = (ctx: Context) => (typeof ctx.match === "string" ? ctx.match : "");

  bot.command("start", handle((actor, ctx) => service.start(actor, arg(ctx))));
  bot.command("help", handle((actor) => service.help(actor)));
  bot.command("new", handle((actor) => service.newSearch(actor)));
  bot.command("searches", handle((actor) => service.searches(actor)));
  bot.command("cancel", handle((actor) => service.cancel(actor)));
  bot.command("feedback", handle((actor, ctx) => service.feedback(actor, arg(ctx))));
  bot.command("deleteme", handle((actor) => service.deleteMe(actor)));
  bot.command("invite", handle((actor, ctx) => service.invite(actor, arg(ctx))));
  bot.command("stats", handle((actor) => service.stats(actor)));
  bot.command("health", handle((actor) => service.health(actor)));
  bot.command("waitlist", handle((actor) => service.waitlist(actor)));

  bot.on("callback_query:data", async (ctx) => {
    const actor = actorOf(ctx);
    if (!actor) {
      await ctx.answerCallbackQuery();
      return;
    }
    const result = await service.button(actor, ctx.callbackQuery.data);
    await ctx.answerCallbackQuery(result.toast ? { text: result.toast } : undefined);
    await deliver(ctx, result);
  });

  bot.on("message:text", handle((actor, ctx) => service.text(actor, ctx.message?.text ?? "")));

  bot.catch((error) => log.error({ err: error.error }, "bot handler failed"));
}
