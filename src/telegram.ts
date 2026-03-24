import { Bot } from "grammy";
import path from "node:path";
import { defaultControlConfig, lastTurn, readStatus, startBroker, stopBroker } from "./control.js";
import { collectStatusNotifications, createNotificationCursor } from "./telegram-notify.js";
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

// Auth guard — checks from.id against allowlist
bot.use(async (ctx, next) => {
  const userId = ctx.from?.id;
  if (!isAllowedUserId(userId)) {
    await ctx.reply("Not authorized.");
    return;
  }
  await next();
});

// /subscribe
bot.command("subscribe", async (ctx) => {
  const subscription = getContextSubscription(ctx.chat?.id, ctx.from?.id);
  if (!subscription) {
    await ctx.reply("This chat cannot subscribe to notifications.");
    return;
  }

  const existed = subscriptions.has(subscription.chatId);
  subscriptions.set(subscription.chatId, subscription);
  await persistSubscriptions();

  await ctx.reply(
    existed
      ? `Notifications were already enabled for chat ${subscription.chatId}.`
      : `Notifications enabled for chat ${subscription.chatId}.`,
  );
});

// /unsubscribe
bot.command("unsubscribe", async (ctx) => {
  const chatId = ctx.chat?.id;
  if (!chatId) {
    await ctx.reply("This chat cannot unsubscribe.");
    return;
  }

  const removed = subscriptions.delete(chatId);
  if (removed) {
    await persistSubscriptions();
  }

  await ctx.reply(
    removed
      ? `Notifications disabled for chat ${chatId}.`
      : `Chat ${chatId} was not subscribed.`,
  );
});

// /subscribers
bot.command("subscribers", async (ctx) => {
  const lines = [
    `Subscribers: ${subscriptions.size}`,
  ];

  if (subscriptions.size === 0) {
    lines.push("No chats are subscribed.");
  } else {
    for (const subscription of [...subscriptions.values()].sort((a, b) => a.chatId - b.chatId)) {
      const state = isAllowedUserId(subscription.userId) ? "active" : "blocked";
      lines.push(`- chat ${subscription.chatId} (user ${subscription.userId}, ${state})`);
    }
  }

  await ctx.reply(lines.join("\n"));
});

// /run <task>
bot.command("run", async (ctx) => {
  const task = ctx.match?.trim();
  if (!task) {
    await ctx.reply("Usage: /run <task description>");
    return;
  }

  try {
    const result = await startBroker(task, cfg);
    await ctx.reply(
      `Broker started.\nPID: ${result.pid}\nRun: ${result.runId ?? "pending..."}`,
    );
  } catch (err) {
    await ctx.reply(`Failed to start: ${err}`);
  }
});

// /status [runId]
bot.command("status", async (ctx) => {
  const runId = ctx.match?.trim() || undefined;
  const status = await readStatus(runId, cfg);
  if (!status) {
    await ctx.reply("No broker run found.");
    return;
  }

  const lines = [
    `Run: ${status.runId}`,
    `Phase: ${status.phase}`,
    `Round: ${status.round}`,
    `PID: ${status.pid}`,
    `Started: ${status.startedAt}`,
  ];

  if (status.waitingFor) {
    lines.push(`Waiting: ${status.waitingFor.agent} turn ${status.waitingFor.turn}`);
  }
  if (status.lastForward) {
    lines.push(`Last: ${status.lastForward.from} -> ${status.lastForward.to}`);
    lines.push(`Preview: ${status.lastForward.preview}`);
  }
  if (status.heartbeat.count > 0 && status.heartbeat.lastAt) {
    lines.push(
      `Heartbeat: #${status.heartbeat.count} at ${status.heartbeat.lastAt}`,
    );
  }
  if (status.progressSummary) {
    lines.push("Summary:");
    lines.push(status.progressSummary.text);
  }
  if (status.stopReason) {
    lines.push(`Stop: ${status.stopReason} by ${status.stopBy}`);
  }

  lines.push(
    `Sessions: L=${status.sessions.left.status} R=${status.sessions.right.status}`,
  );

  await ctx.reply(lines.join("\n"));
});

// /stop [runId]
bot.command("stop", async (ctx) => {
  const runId = ctx.match?.trim() || undefined;

  try {
    const result = await stopBroker(runId, cfg);
    if (!result.wasAlive) {
      await ctx.reply(`Broker (pid=${result.pid}) was not running.`);
    } else {
      await ctx.reply(`Broker stopped (pid=${result.pid}, signal=${result.signal}).`);
    }
  } catch (err) {
    await ctx.reply(`Failed to stop: ${err}`);
  }
});

// /last [runId]
bot.command("last", async (ctx) => {
  const runId = ctx.match?.trim() || undefined;
  const summary = await lastTurn(runId, cfg);
  if (!summary) {
    await ctx.reply("No broker run found.");
    return;
  }

  const lines = [
    `Run: ${summary.runId} (${summary.phase})`,
    `Round: ${summary.round}`,
  ];

  if (summary.progressSummary) {
    lines.push("Summary:");
    lines.push(summary.progressSummary.text);
  }

  if (summary.heartbeat.count > 0 && summary.heartbeat.lastAt) {
    lines.push(`Heartbeat: #${summary.heartbeat.count} at ${summary.heartbeat.lastAt}`);
  }

  if (summary.lastForward) {
    lines.push(`${summary.lastForward.from} -> ${summary.lastForward.to}:`);
    lines.push(summary.lastForward.preview);
  } else {
    lines.push("No turns forwarded yet.");
  }

  if (summary.stopReason) {
    lines.push(`Stopped: ${summary.stopReason} by ${summary.stopBy}`);
  }

  await ctx.reply(lines.join("\n"));
});

// /help
bot.command("help", async (ctx) => {
  await ctx.reply(
    [
      "coco commands:",
      "/run <task> - Start a broker discussion",
      "/status - Show current run status",
      "/stop - Stop the running broker",
      "/last - Show last forwarded turn",
      "/subscribe - Enable proactive notifications for this chat",
      "/unsubscribe - Disable proactive notifications for this chat",
      "/subscribers - List subscribed chats",
      "/help - This message",
    ].join("\n"),
  );
});

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
    if (!isAllowedUserId(subscription.userId)) continue;
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

function getContextSubscription(
  chatId: number | undefined,
  userId: number | undefined,
): TelegramSubscription | null {
  if (!chatId || !userId) return null;
  return { chatId, userId };
}

function isAllowedUserId(userId: number | undefined): boolean {
  return allowedUserIds.length === 0 || (!!userId && allowedUserIds.includes(userId));
}
