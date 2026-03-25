import type { ControlConfig, LastTurnSummary, StartResult, StopResult } from "./control.js";
import type { RunStatus } from "./run-status.js";
import type { TelegramSubscription } from "./telegram-state.js";

export type TelegramCommandContext = {
  match?: string | RegExpMatchArray;
  chat?: { id?: number };
  from?: { id?: number };
  reply(text: string): Promise<unknown> | unknown;
};

export type TelegramNext = () => Promise<unknown> | unknown;

export type TelegramCommandDeps = {
  startBroker(task: string, cfg: ControlConfig): Promise<StartResult>;
  readStatus(runId: string | undefined, cfg: ControlConfig): Promise<RunStatus | null>;
  stopBroker(runId: string | undefined, cfg: ControlConfig): Promise<StopResult>;
  lastTurn(runId: string | undefined, cfg: ControlConfig): Promise<LastTurnSummary | null>;
  persistSubscriptions(): Promise<void>;
};

export type TelegramCommandRuntime = {
  allowedUserIds: number[];
  subscriptions: Map<number, TelegramSubscription>;
  cfg: ControlConfig;
  deps: TelegramCommandDeps;
};

export function createTelegramCommandHandlers(runtime: TelegramCommandRuntime) {
  return {
    authGuard: async (ctx: TelegramCommandContext, next: TelegramNext) => {
      const userId = ctx.from?.id;
      if (!isAllowedUserId(runtime.allowedUserIds, userId)) {
        await ctx.reply("Not authorized.");
        return;
      }
      await next();
    },

    subscribe: async (ctx: TelegramCommandContext) => {
      const subscription = getContextSubscription(ctx.chat?.id, ctx.from?.id);
      if (!subscription) {
        await ctx.reply("This chat cannot subscribe to notifications.");
        return;
      }

      const existed = runtime.subscriptions.has(subscription.chatId);
      runtime.subscriptions.set(subscription.chatId, subscription);
      await runtime.deps.persistSubscriptions();

      await ctx.reply(
        existed
          ? `Notifications were already enabled for chat ${subscription.chatId}.`
          : `Notifications enabled for chat ${subscription.chatId}.`,
      );
    },

    unsubscribe: async (ctx: TelegramCommandContext) => {
      const chatId = ctx.chat?.id;
      if (!chatId) {
        await ctx.reply("This chat cannot unsubscribe.");
        return;
      }

      const removed = runtime.subscriptions.delete(chatId);
      if (removed) {
        await runtime.deps.persistSubscriptions();
      }

      await ctx.reply(
        removed
          ? `Notifications disabled for chat ${chatId}.`
          : `Chat ${chatId} was not subscribed.`,
      );
    },

    subscribers: async (ctx: TelegramCommandContext) => {
      const lines = [`Subscribers: ${runtime.subscriptions.size}`];

      if (runtime.subscriptions.size === 0) {
        lines.push("No chats are subscribed.");
      } else {
        for (const subscription of [...runtime.subscriptions.values()].sort((a, b) => a.chatId - b.chatId)) {
          const state = isAllowedUserId(runtime.allowedUserIds, subscription.userId)
            ? "active"
            : "blocked";
          lines.push(
            `- chat ${subscription.chatId} (user ${subscription.userId}, ${state})`,
          );
        }
      }

      await ctx.reply(lines.join("\n"));
    },

    run: async (ctx: TelegramCommandContext) => {
      const task = readMatchText(ctx.match);
      if (!task) {
        await ctx.reply("Usage: /run <task description>");
        return;
      }

      try {
        const result = await runtime.deps.startBroker(task, runtime.cfg);
        await ctx.reply(
          `Broker started.\nPID: ${result.pid}\nRun: ${result.runId ?? "pending..."}`,
        );
      } catch (err) {
        await ctx.reply(`Failed to start: ${err}`);
      }
    },

    status: async (ctx: TelegramCommandContext) => {
      const runId = readMatchText(ctx.match) || undefined;
      const status = await runtime.deps.readStatus(runId, runtime.cfg);
      if (!status) {
        await ctx.reply("No broker run found.");
        return;
      }

      await ctx.reply(formatStatusMessage(status));
    },

    stop: async (ctx: TelegramCommandContext) => {
      const runId = readMatchText(ctx.match) || undefined;

      try {
        const result = await runtime.deps.stopBroker(runId, runtime.cfg);
        if (!result.wasAlive) {
          await ctx.reply(`Broker (pid=${result.pid}) was not running.`);
        } else {
          await ctx.reply(`Broker stopped (pid=${result.pid}, signal=${result.signal}).`);
        }
      } catch (err) {
        await ctx.reply(`Failed to stop: ${err}`);
      }
    },

    last: async (ctx: TelegramCommandContext) => {
      const runId = readMatchText(ctx.match) || undefined;
      const summary = await runtime.deps.lastTurn(runId, runtime.cfg);
      if (!summary) {
        await ctx.reply("No broker run found.");
        return;
      }

      await ctx.reply(formatLastTurnMessage(summary));
    },

    help: async (ctx: TelegramCommandContext) => {
      await ctx.reply(buildHelpText());
    },
  };
}

export function buildHelpText(): string {
  return [
    "coco commands:",
    "/run <task> - Start a broker discussion",
    "/status - Show current run status",
    "/stop - Stop the running broker",
    "/last - Show last forwarded turn",
    "/subscribe - Enable proactive notifications for this chat",
    "/unsubscribe - Disable proactive notifications for this chat",
    "/subscribers - List subscribed chats",
    "/coco help - Direct session commands",
    "/help - This message",
  ].join("\n");
}

export function formatStatusMessage(status: RunStatus): string {
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
    lines.push(`Heartbeat: #${status.heartbeat.count} at ${status.heartbeat.lastAt}`);
  }
  if (status.progressSummary) {
    lines.push("Summary:");
    lines.push(status.progressSummary.text);
  }
  if (status.stopReason) {
    lines.push(`Stop: ${status.stopReason} by ${status.stopBy}`);
  }

  lines.push(`Sessions: L=${status.sessions.left.status} R=${status.sessions.right.status}`);
  return lines.join("\n");
}

export function formatLastTurnMessage(summary: LastTurnSummary): string {
  const lines = [`Run: ${summary.runId} (${summary.phase})`, `Round: ${summary.round}`];

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

  return lines.join("\n");
}

function getContextSubscription(
  chatId: number | undefined,
  userId: number | undefined,
): TelegramSubscription | null {
  if (!chatId || !userId) return null;
  return { chatId, userId };
}

function isAllowedUserId(allowedUserIds: number[], userId: number | undefined): boolean {
  return allowedUserIds.length === 0 || (!!userId && allowedUserIds.includes(userId));
}

function readMatchText(match: string | RegExpMatchArray | undefined): string {
  if (typeof match === "string") return match.trim();
  if (Array.isArray(match)) return match.join(" ").trim();
  return "";
}
