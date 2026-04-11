import type { DirectAgent, DirectSendResult } from "./direct-backend.js";
import type { DirectChatState, DirectDispatchOptions, DirectDispatchOutput } from "./direct-session.js";

export type CocoCommandDeps = {
  bind(chatKey: string, agent: DirectAgent, sessionId: string, cwd: string): Promise<DirectChatState>;
  use(chatKey: string, agent: DirectAgent): DirectChatState;
  ask(chatKey: string, agent: DirectAgent, text: string): Promise<DirectSendResult>;
  sendToActive(
    chatKey: string,
    text: string,
    options?: DirectDispatchOptions,
  ): Promise<DirectDispatchOutput[] | null>;
  current(chatKey: string): DirectChatState;
  detach(chatKey: string, agent?: DirectAgent): Promise<DirectChatState>;
  xcheckOn(chatKey: string, rounds?: number): DirectChatState;
  xcheckOff(chatKey: string): DirectChatState;
  xcheckStop(chatKey: string): DirectChatState;
  collabOn(chatKey: string, rounds?: number): DirectChatState;
  collabOff(chatKey: string): DirectChatState;
  collabStop(chatKey: string): DirectChatState;
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
  | { name: "detach"; agent?: DirectAgent }
  | { name: "xcheck"; action: "on"; rounds: number }
  | { name: "xcheck"; action: "off" | "status" | "stop" }
  | { name: "collab"; action: "on"; rounds: number }
  | { name: "collab"; action: "off" | "status" | "stop" };

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

        case "xcheck":
          await handleXcheckCommand(runtime, message, parsed);
          return true;

        case "collab":
          await handleCollabCommand(runtime, message, parsed);
          return true;
      }
    },

    handlePlainText: async (message: CocoCommandMessage): Promise<boolean> => {
      try {
        let emitted = false;
        const result = await runtime.deps.sendToActive(message.chatKey, message.text, {
          bypassSessionMode: shouldBypassSessionMode(message.text),
          onOutput: async (output) => {
            emitted = true;
            await message.reply(formatDispatchOutput(output));
          },
        });
        if (!result) return false;
        if (!emitted) {
          for (const output of result) {
            await message.reply(formatDispatchOutput(output));
          }
        }
        return true;
      } catch (err) {
        await message.reply(`Failed to send to the active target: ${err}`);
        return true;
      }
    },
  };
}

async function handleCollabCommand(
  runtime: CocoCommandRuntime,
  message: CocoCommandMessage,
  command: Extract<ParsedCocoCommand, { name: "collab" }>,
): Promise<void> {
  switch (command.action) {
    case "status":
      await message.reply(formatCollabState(runtime.deps.current(message.chatKey)));
      return;

    case "on":
      try {
        const state = runtime.deps.collabOn(message.chatKey, command.rounds);
        await message.reply(
          [
            `Collab mode enabled for ${command.rounds} turn${command.rounds === 1 ? "" : "s"}.`,
            formatCollabState(state),
          ].join("\n\n"),
        );
      } catch (err) {
        await message.reply(`Failed to enable collab: ${err}`);
      }
      return;

    case "off":
      try {
        const state = runtime.deps.collabOff(message.chatKey);
        await message.reply(["Collab mode disabled.", formatCollabState(state)].join("\n\n"));
      } catch (err) {
        await message.reply(`Failed to disable collab: ${err}`);
      }
      return;

    case "stop":
      try {
        const state = runtime.deps.collabStop(message.chatKey);
        await message.reply(
          [
            "Stopping the current collab run after the current step finishes.",
            formatCollabState(state),
          ].join("\n\n"),
        );
      } catch (err) {
        await message.reply(`Failed to stop collab: ${err}`);
      }
      return;
  }
}

async function handleXcheckCommand(
  runtime: CocoCommandRuntime,
  message: CocoCommandMessage,
  command: Extract<ParsedCocoCommand, { name: "xcheck" }>,
): Promise<void> {
  switch (command.action) {
    case "status":
      await message.reply(formatXcheckState(runtime.deps.current(message.chatKey)));
      return;

    case "on":
      try {
        const state = runtime.deps.xcheckOn(message.chatKey, command.rounds);
        await message.reply(
          [
            `Xcheck mode enabled for ${command.rounds} round${command.rounds === 1 ? "" : "s"}.`,
            formatXcheckState(state),
          ].join("\n\n"),
        );
      } catch (err) {
        await message.reply(`Failed to enable xcheck: ${err}`);
      }
      return;

    case "off":
      try {
        const state = runtime.deps.xcheckOff(message.chatKey);
        await message.reply(["Xcheck mode disabled.", formatXcheckState(state)].join("\n\n"));
      } catch (err) {
        await message.reply(`Failed to disable xcheck: ${err}`);
      }
      return;

    case "stop":
      try {
        const state = runtime.deps.xcheckStop(message.chatKey);
        await message.reply(
          [
            "Stopping the current xcheck run after the current step finishes.",
            formatXcheckState(state),
          ].join("\n\n"),
        );
      } catch (err) {
        await message.reply(`Failed to stop xcheck: ${err}`);
      }
      return;
  }
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
    case "xcheck": {
      if (rest === "on") {
        return { name: "xcheck", action: "on", rounds: 1 };
      }
      const onMatch = rest.match(/^on\s+(\d+)$/);
      if (onMatch) {
        const rounds = Number.parseInt(onMatch[1] ?? "", 10);
        if (Number.isInteger(rounds) && rounds > 0) {
          return { name: "xcheck", action: "on", rounds };
        }
        return { name: "help" };
      }
      if (rest === "off" || rest === "status" || rest === "stop") {
        return { name: "xcheck", action: rest };
      }
      return { name: "help" };
    }
    case "collab": {
      if (rest === "on") {
        return { name: "collab", action: "on", rounds: 1 };
      }
      const onMatch = rest.match(/^on\s+(\d+)$/);
      if (onMatch) {
        const rounds = Number.parseInt(onMatch[1] ?? "", 10);
        if (Number.isInteger(rounds) && rounds > 0) {
          return { name: "collab", action: "on", rounds };
        }
        return { name: "help" };
      }
      if (rest === "off" || rest === "status" || rest === "stop") {
        return { name: "collab", action: rest };
      }
      return { name: "help" };
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
    "/coco xcheck on [rounds] - Enable xcheck mode; default is 1 round",
    "/coco xcheck off - Disable xcheck mode",
    "/coco xcheck status - Show xcheck mode state",
    "/coco xcheck stop - Stop the current xcheck run after the current step",
    "/coco collab on [turns] - Enable collab mode; default is 1 turn",
    "/coco collab off - Disable collab mode",
    "/coco collab status - Show collab mode state",
    "/coco collab stop - Stop the current collab run after the current step",
    "/coco help - This message",
    "",
    "After you bind and /coco use a target, any non-/coco message is forwarded to that session.",
    "When xcheck is on, normal messages run configurable draft/review rounds, then owner final.",
    "When collab is on, normal messages relay raw replies between both bound sessions for a configurable number of turns.",
  ].join("\n");
}

export function buildNoActiveTargetText(): string {
  return [
    "No active direct session target is bound for this chat.",
    "Use /coco help to see commands, then bind a session with /coco bind ...",
  ].join("\n");
}

export function buildDirectSessionEntryText(): string {
  return [buildNoActiveTargetText(), "", buildCocoHelpText()].join("\n\n");
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

  lines.push(`Xcheck: ${state.xcheck.enabled ? "on" : "off"}`);
  lines.push(`Xcheck rounds: ${state.xcheck.rounds}`);
  lines.push(
    `Xcheck target: owner=${state.xcheck.owner ?? "none"} reviewer=${state.xcheck.reviewer ?? "none"}`,
  );
  if (state.xcheck.runState === "running") {
    const extra = state.xcheck.stopRequested ? " stop-requested" : "";
    lines.push(
      `Xcheck run: [running] round=${state.xcheck.round ?? "unknown"}/${state.xcheck.rounds} step=${state.xcheck.step ?? "unknown"} started=${state.xcheck.startedAt ?? "unknown"}${extra}`,
    );
  } else {
    lines.push("Xcheck run: [idle]");
  }
  if (state.xcheck.lastError) {
    lines.push(`Xcheck last error: ${state.xcheck.lastError}`);
  }

  lines.push(`Collab: ${state.collab.enabled ? "on" : "off"}`);
  lines.push(`Collab turns: ${state.collab.rounds}`);
  lines.push(
    `Collab target: lead=${state.collab.lead ?? "none"} partner=${state.collab.partner ?? "none"}`,
  );
  if (state.collab.runState === "running") {
    const extra = state.collab.stopRequested ? " stop-requested" : "";
    lines.push(
      `Collab run: [running] turn=${state.collab.round ?? "unknown"}/${state.collab.rounds} step=${state.collab.step ?? "unknown"} started=${state.collab.startedAt ?? "unknown"}${extra}`,
    );
  } else {
    lines.push("Collab run: [idle]");
  }
  if (state.collab.lastError) {
    lines.push(`Collab last error: ${state.collab.lastError}`);
  }

  return lines.join("\n");
}

export function formatXcheckState(state: DirectChatState): string {
  const lines = ["Xcheck state:"];
  lines.push(`Enabled: ${state.xcheck.enabled ? "on" : "off"}`);
  lines.push(`Rounds: ${state.xcheck.rounds}`);
  lines.push(`Owner: ${state.xcheck.owner ?? "none"}`);
  lines.push(`Reviewer: ${state.xcheck.reviewer ?? "none"}`);
  lines.push(`Run: ${state.xcheck.runState}`);
  if (state.xcheck.round) {
    lines.push(`Round: ${state.xcheck.round}/${state.xcheck.rounds}`);
  }
  if (state.xcheck.step) {
    lines.push(`Step: ${state.xcheck.step}`);
  }
  if (state.xcheck.startedAt) {
    lines.push(`Started: ${state.xcheck.startedAt}`);
  }
  if (state.xcheck.stopRequested) {
    lines.push("Stop Requested: yes");
  }
  if (state.xcheck.lastError) {
    lines.push(`Last Error: ${state.xcheck.lastError}`);
  }
  return lines.join("\n");
}

export function formatCollabState(state: DirectChatState): string {
  const lines = ["Collab state:"];
  lines.push(`Enabled: ${state.collab.enabled ? "on" : "off"}`);
  lines.push(`Turns: ${state.collab.rounds}`);
  lines.push(`Lead: ${state.collab.lead ?? "none"}`);
  lines.push(`Partner: ${state.collab.partner ?? "none"}`);
  lines.push(`Run: ${state.collab.runState}`);
  if (state.collab.round) {
    lines.push(`Turn: ${state.collab.round}/${state.collab.rounds}`);
  }
  if (state.collab.step) {
    lines.push(`Step: ${state.collab.step}`);
  }
  if (state.collab.startedAt) {
    lines.push(`Started: ${state.collab.startedAt}`);
  }
  if (state.collab.stopRequested) {
    lines.push("Stop Requested: yes");
  }
  if (state.collab.lastError) {
    lines.push(`Last Error: ${state.collab.lastError}`);
  }
  return lines.join("\n");
}

export function formatDispatchOutput(output: DirectDispatchOutput): string {
  if (output.type === "system") {
    return output.text;
  }
  if (output.phase === "default") {
    return formatAgentReply(output.result);
  }

  const header = `[${output.result.agent} ${output.phase} ${output.result.sessionId}]`;
  const body = output.result.text.trim() || "(empty reply)";
  return `${header}\n${body}`;
}

export function formatAgentReply(result: DirectSendResult): string {
  const header = `[${result.agent} ${result.sessionId}]`;
  const body = result.text.trim() || "(empty reply)";
  return `${header}\n${body}`;
}

function isDirectAgent(value: string | undefined): value is DirectAgent {
  return value === "codex" || value === "claude";
}

function shouldBypassSessionMode(text: string): boolean {
  return text.trim().startsWith("/");
}
