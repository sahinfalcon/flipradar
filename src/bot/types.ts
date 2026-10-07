export interface BotButton {
  text: string;
  data?: string;
  url?: string;
}

export interface BotReply {
  text: string;
  buttons?: BotButton[][];
}

export interface Actor {
  telegramId: number;
  username: string | null;
  firstName: string | null;
}

/** followUp is sent after the replies, without blocking the bot's update loop. */
export interface ServiceResult {
  replies: BotReply[];
  followUp?: Promise<BotReply[]>;
  toast?: string;
}
