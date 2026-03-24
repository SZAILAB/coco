import { Bot } from "grammy";
import path from "node:path";
import { defaultControlConfig, lastTurn, readStatus, startBroker, stopBroker } from "./control.js";
import { collectStatusNotifications, createNotificationCursor } from "./telegram-notify.js";
import { createTelegramCommandHandlers } from "./telegram-commands.js";
import {
  createTelegramStatePaths,
  loadTelegramNotifierState,
  loadTelegramSubscribers,
  saveTelegramNotifierState,
  saveTelegramSubscribers,
  type TelegramNotifierState,
  type TelegramSubscription,
} from "./telegram-state.js";

// ---------------------------------------------------------------------------
// Telegram bot — thin shell over control.ts
// ---------------------------------------------------------------------------

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

const cfg = defaultControlConfig();
const telegramState = createTelegramStatePaths(
  path.resolve(cfg.cwd, process.env.COCO_TELEGRAM_STATE_DIR ?? "state/telegram"),
);
const bot = new Bot(token);
const subscriptions = new Map<number, TelegramSubscription>();
const notifyPollMs = Math.max(
  0,
  Number.parseInt(process.env.COCO_TELEGRAM_NOTIFY_POLL_MS ?? "5000", 10) || 5_000,
);
const handlers = createTelegramCommandHandlers({
  allowedUserIds,
  subscriptions,
  cfg,
  deps: {
    startBroker,
    readStatus,
    stopBroker,
    lastTurn,
    persistSubscriptions,
  },
});

// Auth guard — checks from.id against allowlist
bot.use((ctx, next) => handlers.authGuard(ctx, next));

// /subscribe
bot.command("subscribe", handlers.subscribe);

// /unsubscribe
bot.command("unsubscribe", handlers.unsubscribe);

// /subscribers
bot.command("subscribers", handlers.subscribers);

// /run <task>
bot.command("run", handlers.run);

// /status [runId]
bot.command("status", handlers.status);

// /stop [runId]
bot.command("stop", handlers.stop);

// /last [runId]
bot.command("last", handlers.last);

// /help
bot.command("help", handlers.help);

// Start
const notifierState = await loadPersistedState();
console.log("[telegram] Starting bot...");
startNotifier(notifierState);
bot.start({
  onStart: () => console.log("[telegram] Bot is running"),
});

function startNotifier(initialState: TelegramNotifierState): void {
  if (notifyPollMs <= 0) return;

  let seeded = initialState.seeded;
  let cursor = initialState.cursor ?? createNotificationCursor();
  let polling = false;

  const poll = async () => {
    if (polling || subscriptions.size === 0) return;
    polling = true;
    try {
      const previousCursor = JSON.stringify(cursor);
      const status = await readStatus(undefined, cfg);
      const result = collectStatusNotifications(cursor, status);
      cursor = result.cursor;

      if (!seeded) {
        seeded = true;
        await saveTelegramNotifierState(telegramState, { seeded, cursor });
        return;
      }

      if (previousCursor !== JSON.stringify(cursor)) {
        await saveTelegramNotifierState(telegramState, { seeded, cursor });
      }

      for (const notification of result.notifications) {
        await broadcast(notification.text);
      }
    } catch (err) {
      console.error("[telegram] Notification poll failed:", err);
    } finally {
      polling = false;
    }
  };

  const timer = setInterval(() => {
    void poll();
  }, notifyPollMs);
  timer.unref?.();
}

async function broadcast(text: string): Promise<void> {
  for (const subscription of subscriptions.values()) {
    if (!isAllowedBroadcastUserId(subscription.userId)) continue;
    try {
      await bot.api.sendMessage(subscription.chatId, text);
    } catch (err) {
      console.error(`[telegram] Failed to notify chat ${subscription.chatId}:`, err);
    }
  }
}

async function loadPersistedState(): Promise<TelegramNotifierState> {
  const [storedSubscriptions, storedNotifier] = await Promise.all([
    loadTelegramSubscribers(telegramState),
    loadTelegramNotifierState(telegramState),
  ]);

  subscriptions.clear();
  for (const subscription of storedSubscriptions) {
    subscriptions.set(subscription.chatId, subscription);
  }

  return storedNotifier;
}

async function persistSubscriptions(): Promise<void> {
  await saveTelegramSubscribers(telegramState, [...subscriptions.values()]);
}

function isAllowedBroadcastUserId(userId: number | undefined): boolean {
  return allowedUserIds.length === 0 || (!!userId && allowedUserIds.includes(userId));
}
