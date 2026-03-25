import type { DirectAgent, DirectSendResult } from "./direct-backend.js";
import type { DirectChatState } from "./direct-session.js";

export type CocoCommandDeps = {
  bind(chatKey: string, agent: DirectAgent, sessionId: string, cwd: string): Promise<DirectChatState>;
  use(chatKey: string, agent: DirectAgent): DirectChatState;
  ask(chatKey: string, agent: DirectAgent, text: string): Promise<DirectSendResult>;
  sendToActive(chatKey: string, text: string): Promise<DirectSendResult | null>;
  current(chatKey: string): DirectChatState;
  detach(chatKey: string, agent?: DirectAgent): Promise<DirectChatState>;
};

export type CocoCommandRuntime = {
  deps: CocoCommandDeps;
};

export type CocoCommandMessage = {
  chatKey: string;
  text: string;
  reply(text: string): Promise<unknown> | unknown;
};

type ParsedCocoCommand =
  | { name: "help" }
  | { name: "current" }
  | { name: "bind"; agent: DirectAgent; sessionId: string; cwd: string }
  | { name: "use"; agent: DirectAgent }
  | { name: "ask"; agent: DirectAgent; text: string }
  | { name: "detach"; agent?: DirectAgent };

export function createCocoCommandHandlers(runtime: CocoCommandRuntime) {
  return {
    handleCocoCommand: async (message: CocoCommandMessage): Promise<boolean> => {
      const parsed = parseCocoCommand(message.text);
      if (!parsed) return false;

      switch (parsed.name) {
        case "help":
          await message.reply(buildCocoHelpText());
          return true;

        case "current":
          await message.reply(formatCurrentState(runtime.deps.current(message.chatKey)));
          return true;

        case "bind": {
          try {
            const state = await runtime.deps.bind(
              message.chatKey,
              parsed.agent,
              parsed.sessionId,
              parsed.cwd,
            );
            await message.reply(
              [
                `Bound ${parsed.agent} session ${parsed.sessionId} in ${parsed.cwd}.`,
                formatCurrentState(state),
              ].join("\n\n"),
            );
          } catch (err) {
            await message.reply(`Failed to bind ${parsed.agent}: ${err}`);
          }
          return true;
        }

        case "use":
          try {
            const state = runtime.deps.use(message.chatKey, parsed.agent);
            await message.reply(
              [
                `Active target set to ${parsed.agent}.`,
                formatCurrentState(state),
              ].join("\n\n"),
            );
          } catch (err) {
            await message.reply(`Failed to switch target: ${err}`);
          }
          return true;

        case "ask":
          try {
            const result = await runtime.deps.ask(message.chatKey, parsed.agent, parsed.text);
            await message.reply(formatAgentReply(result));
          } catch (err) {
            await message.reply(`Failed to send to ${parsed.agent}: ${err}`);
          }
          return true;

        case "detach":
          try {
            const state = await runtime.deps.detach(message.chatKey, parsed.agent);
            const suffix = parsed.agent ? ` ${parsed.agent}` : "";
            await message.reply([`Detached${suffix}.`, formatCurrentState(state)].join("\n\n"));
          } catch (err) {
            await message.reply(`Failed to detach: ${err}`);
          }
          return true;
      }
    },

    handlePlainText: async (message: CocoCommandMessage): Promise<boolean> => {
      const result = await runtime.deps.sendToActive(message.chatKey, message.text);
      if (!result) return false;
      await message.reply(formatAgentReply(result));
      return true;
    },
  };
}

export function parseCocoCommand(text: string): ParsedCocoCommand | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith("/coco")) return null;

  const remainder = trimmed.slice("/coco".length).trim();
  if (!remainder) {
    return { name: "help" };
  }

  const [name, ...restParts] = remainder.split(/\s+/);
  const rest = restParts.join(" ").trim();

  switch (name.toLowerCase()) {
    case "help":
      return { name: "help" };
    case "current":
      return { name: "current" };
    case "bind": {
      const match = rest.match(/^(\S+)\s+(\S+)\s+(.+)$/);
      if (!match) return { name: "help" };
      const [, agent, sessionId, cwd] = match;
      if (!isDirectAgent(agent) || !cwd.trim()) return { name: "help" };
      return { name: "bind", agent, sessionId, cwd: cwd.trim() };
    }
    case "use": {
      if (!isDirectAgent(rest)) return { name: "help" };
      return { name: "use", agent: rest };
    }
    case "ask": {
      const [agent, ...textParts] = rest.split(/\s+/);
      const prompt = textParts.join(" ").trim();
      if (!isDirectAgent(agent) || !prompt) return { name: "help" };
      return { name: "ask", agent, text: prompt };
    }
    case "detach": {
      if (!rest) return { name: "detach" };
      if (!isDirectAgent(rest)) return { name: "help" };
      return { name: "detach", agent: rest };
    }
    default:
      return { name: "help" };
  }
}

export function buildCocoHelpText(): string {
  return [
    "coco session commands:",
    "/coco bind codex <thread_id> <cwd> - Bind a Codex session in a specific workdir",
    "/coco bind claude <session_id> <cwd> - Bind a Claude session in a specific workdir",
    "/coco use <codex|claude> - Set the default direct-chat target",
    "/coco ask <codex|claude> <text> - Send one message without switching target",
    "/coco current - Show current bindings and active target",
    "/coco detach [codex|claude] - Detach the active or named binding",
    "/coco help - This message",
    "",
    "After you bind and /coco use a target, any non-/coco message is forwarded to that session.",
  ].join("\n");
}

export function formatCurrentState(state: DirectChatState): string {
  const lines = ["Direct session state:"];
  lines.push(`Active: ${state.activeTarget ?? "none"}`);

  const agents: DirectAgent[] = ["codex", "claude"];
  let hasBindings = false;
  for (const agent of agents) {
    const binding = state.bindings[agent];
    if (!binding) continue;
    hasBindings = true;
    const parts = [`- ${agent}: ${binding.sessionId}`, `cwd=${binding.cwd}`, `[${binding.status}]`];
    if (binding.error) {
      parts.push(`error=${binding.error}`);
    }
    lines.push(parts.join(" "));
  }

  if (!hasBindings) {
    lines.push("No direct session bindings.");
  }

  return lines.join("\n");
}

export function formatAgentReply(result: DirectSendResult): string {
  const header = `[${result.agent} ${result.sessionId}]`;
  const body = result.text.trim() || "(empty reply)";
  return `${header}\n${body}`;
}

function isDirectAgent(value: string | undefined): value is DirectAgent {
  return value === "codex" || value === "claude";
}
