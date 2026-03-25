import type { ControlConfig, LastTurnSummary, StartResult, StopResult } from "./control.js";
import type { RunStatus } from "./run-status.js";
import { formatLastTurnMessage, formatStatusMessage } from "./telegram-commands.js";

export type FeishuCommandDeps = {
  startBroker(task: string, cfg: ControlConfig): Promise<StartResult>;
  readStatus(runId: string | undefined, cfg: ControlConfig): Promise<RunStatus | null>;
  stopBroker(runId: string | undefined, cfg: ControlConfig): Promise<StopResult>;
  lastTurn(runId: string | undefined, cfg: ControlConfig): Promise<LastTurnSummary | null>;
};

export type FeishuCommandMessage = {
  chatId: string;
  userId: string;
  text: string;
  reply(text: string): Promise<unknown> | unknown;
};

export type FeishuCommandRuntime = {
  allowedUserIds: string[];
  allowedChatIds: string[];
  cfg: ControlConfig;
  deps: FeishuCommandDeps;
};

type ParsedCommand = {
  name: string;
  args: string;
};

export function createFeishuCommandHandlers(runtime: FeishuCommandRuntime) {
  return {
    handleMessage: async (message: FeishuCommandMessage) => {
      if (!isAllowedMessage(runtime, message)) {
        await message.reply("Not authorized.");
        return;
      }

      const parsed = parseCommand(message.text);
      if (!parsed) {
        await message.reply(buildFeishuHelpText());
        return;
      }

      switch (parsed.name) {
        case "run":
          if (!parsed.args) {
            await message.reply("Usage: /run <task description>");
            return;
          }

          try {
            const result = await runtime.deps.startBroker(parsed.args, runtime.cfg);
            await message.reply(
              `Broker started.\nPID: ${result.pid}\nRun: ${result.runId ?? "pending..."}`,
            );
          } catch (err) {
            await message.reply(`Failed to start: ${err}`);
          }
          return;

        case "status": {
          const status = await runtime.deps.readStatus(parsed.args || undefined, runtime.cfg);
          if (!status) {
            await message.reply("No broker run found.");
            return;
          }
          await message.reply(formatStatusMessage(status));
          return;
        }

        case "stop":
          try {
            const result = await runtime.deps.stopBroker(parsed.args || undefined, runtime.cfg);
            if (!result.wasAlive) {
              await message.reply(`Broker (pid=${result.pid}) was not running.`);
            } else {
              await message.reply(`Broker stopped (pid=${result.pid}, signal=${result.signal}).`);
            }
          } catch (err) {
            await message.reply(`Failed to stop: ${err}`);
          }
          return;

        case "last": {
          const summary = await runtime.deps.lastTurn(parsed.args || undefined, runtime.cfg);
          if (!summary) {
            await message.reply("No broker run found.");
            return;
          }
          await message.reply(formatLastTurnMessage(summary));
          return;
        }

        case "help":
          await message.reply(buildFeishuHelpText());
          return;

        default:
          await message.reply(buildFeishuHelpText());
      }
    },
  };
}

export function buildFeishuHelpText(): string {
  return [
    "coco Feishu commands:",
    "/run <task> - Start a broker discussion",
    "/status [runId] - Show current run status",
    "/stop [runId] - Stop the running broker",
    "/last [runId] - Show last forwarded turn",
    "/help - This message",
  ].join("\n");
}

export function parseCommand(text: string): ParsedCommand | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith("/")) return null;

  const spaceIndex = trimmed.indexOf(" ");
  if (spaceIndex === -1) {
    return { name: trimmed.slice(1).toLowerCase(), args: "" };
  }

  return {
    name: trimmed.slice(1, spaceIndex).toLowerCase(),
    args: trimmed.slice(spaceIndex + 1).trim(),
  };
}

function isAllowedMessage(runtime: FeishuCommandRuntime, message: FeishuCommandMessage): boolean {
  const userAllowed =
    runtime.allowedUserIds.length === 0 || runtime.allowedUserIds.includes(message.userId);
  const chatAllowed =
    runtime.allowedChatIds.length === 0 || runtime.allowedChatIds.includes(message.chatId);
  return userAllowed && chatAllowed;
}
