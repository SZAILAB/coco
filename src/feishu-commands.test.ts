import { describe, expect, it, vi } from "vitest";
import { createFeishuCommandHandlers, parseCommand } from "./feishu-commands.js";
import type { ControlConfig } from "./control.js";
import type { RunStatus } from "./run-status.js";

const cfg: ControlConfig = {
  cwd: "/tmp/coco",
  brokerRoot: "/tmp/coco/state/broker",
};

function makeStatus(): RunStatus {
  return {
    runId: "run-123",
    task: "test",
    cwd: "/tmp/coco",
    pid: 123,
    pidFile: "/tmp/coco/state/broker/run-123/broker.pid",
    turnDir: "/tmp/coco/state/broker/run-123",
    statusFile: "/tmp/coco/state/broker/run-123/status.json",
    phase: "waiting-turn",
    round: 1,
    startedAt: "2026-03-24T00:00:00.000Z",
    updatedAt: "2026-03-24T00:00:10.000Z",
    stoppedAt: null,
    stopReason: null,
    stopBy: null,
    stopTextPreview: null,
    waitingFor: null,
    lastForward: null,
    recentTurns: [],
    progressSummary: null,
    heartbeat: {
      intervalMs: 60_000,
      count: 0,
      lastAt: null,
      lastText: null,
    },
    sessions: {
      left: { name: "codex", pid: 201, status: "running" },
      right: { name: "claude", pid: 202, status: "running" },
    },
  };
}

function createHarness(options?: {
  allowedUserIds?: string[];
  allowedChatIds?: string[];
  readStatusResult?: RunStatus | null;
}) {
  const readStatusResult =
    options && "readStatusResult" in options ? options.readStatusResult : makeStatus();
  const deps = {
    startBroker: vi.fn(),
    readStatus: vi.fn().mockResolvedValue(readStatusResult),
    stopBroker: vi.fn(),
    lastTurn: vi.fn(),
  };

  const handlers = createFeishuCommandHandlers({
    allowedUserIds: options?.allowedUserIds ?? ["ou_123"],
    allowedChatIds: options?.allowedChatIds ?? ["oc_123"],
    cfg,
    deps,
  });

  return { deps, handlers };
}

function makeMessage(overrides?: Partial<Parameters<typeof createHarness>[0]> & {
  chatId?: string;
  userId?: string;
  text?: string;
}) {
  const reply = vi.fn(async (_text: string) => {});
  return {
    chatId: overrides?.chatId ?? "oc_123",
    userId: overrides?.userId ?? "ou_123",
    text: overrides?.text ?? "/help",
    reply,
  };
}

describe("feishu command handlers", () => {
  it("parses slash commands with args", () => {
    expect(parseCommand("/run hello world")).toEqual({
      name: "run",
      args: "hello world",
    });
    expect(parseCommand("hello")).toBeNull();
  });

  it("blocks unauthorized users", async () => {
    const { handlers } = createHarness();
    const message = makeMessage({ userId: "ou_blocked" });

    await handlers.handleMessage(message);

    expect(message.reply).toHaveBeenCalledWith("Not authorized.");
  });

  it("starts a broker run", async () => {
    const { handlers, deps } = createHarness();
    deps.startBroker.mockResolvedValue({ pid: 999, runId: "run-999" });
    const message = makeMessage({ text: "/run discuss task" });

    await handlers.handleMessage(message);

    expect(deps.startBroker).toHaveBeenCalledWith("discuss task", cfg);
    expect(message.reply).toHaveBeenCalledWith("Broker started.\nPID: 999\nRun: run-999");
  });

  it("reports when no run exists", async () => {
    const { handlers, deps } = createHarness({ readStatusResult: null });
    const message = makeMessage({ text: "/status" });

    await handlers.handleMessage(message);

    expect(deps.readStatus).toHaveBeenCalledWith(undefined, cfg);
    expect(message.reply).toHaveBeenCalledWith("No broker run found.");
  });

  it("falls back to help text for plain text input", async () => {
    const { handlers } = createHarness();
    const message = makeMessage({ text: "hello" });

    await handlers.handleMessage(message);

    expect(message.reply).toHaveBeenCalledWith(expect.stringContaining("coco Feishu commands:"));
  });
});
