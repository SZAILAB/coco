import { Bot } from "grammy";
import { createCocoCommandHandlers } from "./coco-commands.js";
import { buildDirectSessionEntryText, buildNoActiveTargetText } from "./coco-commands.js";
import { directSessions } from "./direct-session.js";
import { createTelegramCommandHandlers } from "./telegram-commands.js";

const token = process.env.COCO_TELEGRAM_TOKEN;
if (!token) {
  console.error("[telegram] COCO_TELEGRAM_TOKEN is required");
  process.exit(1);
}

// Allowlist by numeric user ID (stable, unlike usernames which can change)
const allowedUserIds = (process.env.COCO_TELEGRAM_USERS ?? "")
  .split(",")
  .map((s) => Number.parseInt(s.trim(), 10))
  .filter((n) => Number.isFinite(n) && n > 0);

const bot = new Bot(token);
const handlers = createTelegramCommandHandlers({
  allowedUserIds,
});
const cocoHandlers = createCocoCommandHandlers({
  deps: {
    bind: (chatKey, agent, sessionId, cwd) => directSessions.bind(chatKey, agent, sessionId, cwd),
    use: (chatKey, agent) => directSessions.use(chatKey, agent),
    ask: (chatKey, agent, text) => directSessions.ask(chatKey, agent, text),
    sendToActive: (chatKey, text, options) => directSessions.sendToActive(chatKey, text, options),
    current: (chatKey) => directSessions.current(chatKey),
    detach: (chatKey, agent) => directSessions.detach(chatKey, agent),
    xcheckOn: (chatKey, rounds) => directSessions.xcheckOn(chatKey, rounds),
    xcheckOff: (chatKey) => directSessions.xcheckOff(chatKey),
    xcheckStop: (chatKey) => directSessions.xcheckStop(chatKey),
  },
});

// Auth guard — checks from.id against allowlist
bot.use((ctx, next) => handlers.authGuard(ctx, next));

// /start
bot.command("start", handlers.help);
// /help
bot.command("help", handlers.help);

// /coco ...
bot.command("coco", async (ctx) => {
  await cocoHandlers.handleCocoCommand({
    chatKey: buildTelegramChatKey(ctx.chat?.id),
    text: ctx.msg.text,
    reply: (text) => ctx.reply(text),
  });
});

// Bound direct sessions receive any non-/coco message, including agent slash commands like /compact.
bot.on("message:text", async (ctx, next) => {
  const text = ctx.msg.text.trim();
  if (isReservedTelegramCommand(text)) {
    await next();
    return;
  }

  const handled = await cocoHandlers.handlePlainText({
    chatKey: buildTelegramChatKey(ctx.chat?.id),
    text,
    reply: (replyText) => ctx.reply(replyText),
  });
  if (!handled) {
    await ctx.reply(text.startsWith("/") ? buildDirectSessionEntryText() : buildNoActiveTargetText());
  }
});

// Start
console.log("[telegram] Starting bot...");
bot.start({
  onStart: () => console.log("[telegram] Bot is running"),
});

function buildTelegramChatKey(chatId: number | undefined): string {
  return `telegram:${chatId ?? "unknown"}`;
}

function isReservedTelegramCommand(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed.startsWith("/")) return false;

  const raw = trimmed.slice(1).split(/\s+/, 1)[0] ?? "";
  const command = raw.split("@", 1)[0]?.toLowerCase() ?? "";
  return command === "start" || command === "help" || command === "coco";
}
