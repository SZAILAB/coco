import { describe, expect, it, vi } from "vitest";
import { createTelegramCommandHandlers, type TelegramCommandContext } from "./telegram-commands.js";
import type { ControlConfig } from "./control.js";
import type { RunStatus } from "./run-status.js";
import type { TelegramSubscription } from "./telegram-state.js";

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

function makeContext(overrides: Partial<TelegramCommandContext> = {}) {
  const reply = vi.fn(async (_text: string) => {});
  return {
    match: "",
    chat: { id: 1001 },
    from: { id: 2001 },
    reply,
    ...overrides,
  };
}

function createHarness(options?: {
  allowedUserIds?: number[];
  subscriptions?: TelegramSubscription[];
  readStatusResult?: RunStatus | null;
}) {
  const subscriptions = new Map<number, TelegramSubscription>(
    (options?.subscriptions ?? []).map((entry) => [entry.chatId, entry]),
  );
  const readStatusResult =
    options && "readStatusResult" in options ? options.readStatusResult : makeStatus();
  const deps = {
    startBroker: vi.fn(),
    readStatus: vi.fn().mockResolvedValue(readStatusResult),
    stopBroker: vi.fn(),
    lastTurn: vi.fn(),
    persistSubscriptions: vi.fn().mockResolvedValue(undefined),
  };

  const handlers = createTelegramCommandHandlers({
    allowedUserIds: options?.allowedUserIds ?? [2001],
    subscriptions,
    cfg,
    deps,
  });

  return { subscriptions, deps, handlers };
}

describe("telegram command handlers", () => {
  it("blocks unauthorized users in the auth guard", async () => {
    const { handlers } = createHarness();
    const ctx = makeContext({ from: { id: 9999 } });
    const next = vi.fn();

    await handlers.authGuard(ctx, next);

    expect(ctx.reply).toHaveBeenCalledWith("Not authorized.");
    expect(next).not.toHaveBeenCalled();
  });

  it("persists a new subscription", async () => {
    const { handlers, subscriptions, deps } = createHarness();
    const ctx = makeContext();

    await handlers.subscribe(ctx);

    expect(subscriptions.get(1001)).toEqual({ chatId: 1001, userId: 2001 });
    expect(deps.persistSubscriptions).toHaveBeenCalledOnce();
    expect(ctx.reply).toHaveBeenCalledWith("Notifications enabled for chat 1001.");
  });

  it("removes a subscription", async () => {
    const { handlers, subscriptions, deps } = createHarness({
      subscriptions: [{ chatId: 1001, userId: 2001 }],
    });
    const ctx = makeContext();

    await handlers.unsubscribe(ctx);

    expect(subscriptions.has(1001)).toBe(false);
    expect(deps.persistSubscriptions).toHaveBeenCalledOnce();
    expect(ctx.reply).toHaveBeenCalledWith("Notifications disabled for chat 1001.");
  });

  it("lists subscribers with active and blocked states", async () => {
    const { handlers } = createHarness({
      allowedUserIds: [2001],
      subscriptions: [
        { chatId: 1001, userId: 2001 },
        { chatId: 1002, userId: 9999 },
      ],
    });
    const ctx = makeContext();

    await handlers.subscribers(ctx);

    expect(ctx.reply).toHaveBeenCalledWith(
      [
        "Subscribers: 2",
        "- chat 1001 (user 2001, active)",
        "- chat 1002 (user 9999, blocked)",
      ].join("\n"),
    );
  });

  it("reports when no run status exists", async () => {
    const { handlers, deps } = createHarness({ readStatusResult: null });
    const ctx = makeContext();

    await handlers.status(ctx);

    expect(deps.readStatus).toHaveBeenCalledWith(undefined, cfg);
    expect(ctx.reply).toHaveBeenCalledWith("No broker run found.");
  });
});
