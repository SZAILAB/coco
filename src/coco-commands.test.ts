import { describe, expect, it, vi } from "vitest";
import { createCocoCommandHandlers, parseCocoCommand } from "./coco-commands.js";
import type { DirectChatState } from "./direct-session.js";

function makeState(overrides?: Partial<DirectChatState>): DirectChatState {
  return {
    activeTarget: "codex",
    bindings: {
      codex: {
        agent: "codex",
        sessionId: "thread-1",
        cwd: "/tmp/project",
        status: "ready",
        error: null,
      },
    },
    xcheck: {
      enabled: false,
      rounds: 1,
      owner: "codex",
      reviewer: null,
      runState: "idle",
      step: null,
      round: null,
      startedAt: null,
      stopRequested: false,
      lastError: null,
    },
    ...overrides,
  };
}

describe("coco direct commands", () => {
  it("parses bind, ask, and xcheck commands", () => {
    expect(parseCocoCommand("/coco bind codex thread-1 /tmp/project")).toEqual({
      name: "bind",
      agent: "codex",
      sessionId: "thread-1",
      cwd: "/tmp/project",
    });
    expect(parseCocoCommand("/coco bind claude session-1 /tmp/project with spaces")).toEqual({
      name: "bind",
      agent: "claude",
      sessionId: "session-1",
      cwd: "/tmp/project with spaces",
    });
    expect(parseCocoCommand("/coco ask claude review this")).toEqual({
      name: "ask",
      agent: "claude",
      text: "review this",
    });
    expect(parseCocoCommand("/coco xcheck status")).toEqual({
      name: "xcheck",
      action: "status",
    });
    expect(parseCocoCommand("/coco xcheck on 10")).toEqual({
      name: "xcheck",
      action: "on",
      rounds: 10,
    });
  });

  it("binds a session and reports current state", async () => {
    const reply = vi.fn(async (_text: string) => {});
    const handlers = createCocoCommandHandlers({
      deps: {
        bind: vi.fn(async () => makeState()),
        use: vi.fn(() => makeState()),
        ask: vi.fn(),
        sendToActive: vi.fn(),
        current: vi.fn(() => makeState()),
        detach: vi.fn(async () => makeState({ activeTarget: null, bindings: {} })),
        xcheckOn: vi.fn(() => makeState()),
        xcheckOff: vi.fn(() => makeState({ xcheck: { ...makeState().xcheck, enabled: false } })),
        xcheckStop: vi.fn(() => makeState()),
      },
    });

    const handled = await handlers.handleCocoCommand({
      chatKey: "telegram:1001",
      text: "/coco bind codex thread-1 /tmp/project",
      reply,
    });

    expect(handled).toBe(true);
    expect(reply).toHaveBeenCalledWith(
      expect.stringContaining("Bound codex session thread-1 in /tmp/project."),
    );
  });

  it("enables xcheck mode", async () => {
    const reply = vi.fn(async (_text: string) => {});
    const handlers = createCocoCommandHandlers({
      deps: {
        bind: vi.fn(),
        use: vi.fn(),
        ask: vi.fn(),
        sendToActive: vi.fn(),
        current: vi.fn(() =>
          makeState({
            bindings: {
              codex: makeState().bindings.codex,
              claude: {
                agent: "claude",
                sessionId: "session-1",
                cwd: "/tmp/project",
                status: "ready",
                error: null,
              },
            },
            xcheck: {
              enabled: true,
              rounds: 10,
              owner: "codex",
              reviewer: "claude",
              runState: "idle",
              step: null,
              round: null,
              startedAt: null,
              stopRequested: false,
              lastError: null,
            },
          }),
        ),
        detach: vi.fn(),
        xcheckOn: vi.fn((_chatKey, rounds) =>
          makeState({
            bindings: {
              codex: makeState().bindings.codex,
              claude: {
                agent: "claude",
                sessionId: "session-1",
                cwd: "/tmp/project",
                status: "ready",
                error: null,
              },
            },
            xcheck: {
              enabled: true,
              rounds: rounds ?? 1,
              owner: "codex",
              reviewer: "claude",
              runState: "idle",
              step: null,
              round: null,
              startedAt: null,
              stopRequested: false,
              lastError: null,
            },
          }),
        ),
        xcheckOff: vi.fn(),
        xcheckStop: vi.fn(),
      },
    });

    const handled = await handlers.handleCocoCommand({
      chatKey: "feishu:oc_1",
      text: "/coco xcheck on 10",
      reply,
    });

    expect(handled).toBe(true);
    expect(reply).toHaveBeenCalledWith(expect.stringContaining("Xcheck mode enabled for 10 rounds."));
    expect(reply).toHaveBeenCalledWith(expect.stringContaining("Reviewer: claude"));
    expect(reply).toHaveBeenCalledWith(expect.stringContaining("Rounds: 10"));
  });

  it("forwards slash commands to the active session without xcheck", async () => {
    const reply = vi.fn(async (_text: string) => {});
    const sendToActive = vi.fn(async () => [
      {
        type: "agent" as const,
        phase: "default" as const,
        result: {
          agent: "claude" as const,
          sessionId: "sess-1",
          text: "looks good",
        },
      },
    ]);
    const handlers = createCocoCommandHandlers({
      deps: {
        bind: vi.fn(),
        use: vi.fn(),
        ask: vi.fn(),
        sendToActive,
        current: vi.fn(() => makeState()),
        detach: vi.fn(),
        xcheckOn: vi.fn(),
        xcheckOff: vi.fn(),
        xcheckStop: vi.fn(),
      },
    });

    const handled = await handlers.handlePlainText({
      chatKey: "feishu:oc_1",
      text: "/compact",
      reply,
    });

    expect(handled).toBe(true);
    expect(reply).toHaveBeenCalledWith("[claude sess-1]\nlooks good");
    expect(sendToActive).toHaveBeenCalledWith(
      "feishu:oc_1",
      "/compact",
      expect.objectContaining({
        bypassXcheck: true,
        onOutput: expect.any(Function),
      }),
    );
  });

  it("renders all xcheck phases in order without duplicating callback-driven replies", async () => {
    const reply = vi.fn(async (_text: string) => {});
    const outputs = [
      {
        type: "agent" as const,
        phase: "draft" as const,
        result: {
          agent: "codex" as const,
          sessionId: "thread-1",
          text: "draft answer",
        },
      },
      {
        type: "agent" as const,
        phase: "review" as const,
        result: {
          agent: "claude" as const,
          sessionId: "session-1",
          text: "review notes",
        },
      },
      {
        type: "agent" as const,
        phase: "final" as const,
        result: {
          agent: "codex" as const,
          sessionId: "thread-1",
          text: "final answer",
        },
      },
    ];
    const handlers = createCocoCommandHandlers({
      deps: {
        bind: vi.fn(),
        use: vi.fn(),
        ask: vi.fn(),
        sendToActive: vi.fn(async (_chatKey, _text, options) => {
          for (const output of outputs) {
            await options?.onOutput?.(output);
          }
          return outputs;
        }),
        current: vi.fn(() => makeState()),
        detach: vi.fn(),
        xcheckOn: vi.fn(),
        xcheckOff: vi.fn(),
        xcheckStop: vi.fn(),
      },
    });

    const handled = await handlers.handlePlainText({
      chatKey: "feishu:oc_1",
      text: "please review this",
      reply,
    });

    expect(handled).toBe(true);
    expect(reply.mock.calls).toEqual([
      ["[codex draft thread-1]\ndraft answer"],
      ["[claude review session-1]\nreview notes"],
      ["[codex final thread-1]\nfinal answer"],
    ]);
  });
});
