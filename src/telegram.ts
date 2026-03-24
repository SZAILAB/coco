import { Bot } from "grammy";
import { defaultControlConfig, lastTurn, readStatus, startBroker, stopBroker } from "./control.js";

// ---------------------------------------------------------------------------
// Telegram bot — thin shell over control.ts
// ---------------------------------------------------------------------------

const token = process.env.COCO_TELEGRAM_TOKEN;
if (!token) {
  console.error("[telegram] COCO_TELEGRAM_TOKEN is required");
  process.exit(1);
}

const allowedUsers = (process.env.COCO_TELEGRAM_USERS ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

const cfg = defaultControlConfig();
const bot = new Bot(token);

// Auth guard
bot.use(async (ctx, next) => {
  const username = ctx.from?.username;
  if (allowedUsers.length > 0 && (!username || !allowedUsers.includes(username))) {
    await ctx.reply("Not authorized.");
    return;
  }
  await next();
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
      "/help - This message",
    ].join("\n"),
  );
});

// Start
console.log("[telegram] Starting bot...");
bot.start({
  onStart: () => console.log("[telegram] Bot is running"),
});
