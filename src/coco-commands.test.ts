import { describe, expect, it, vi } from "vitest";
import {
  buildNoActiveTargetText,
  createCocoCommandHandlers,
  parseCocoCommand,
} from "./coco-commands.js";
import type { DirectChatState } from "./direct-session.js";

function makeState(overrides?: Partial<DirectChatState>): DirectChatState {
  return {
    activeTarget: "lead",
    bindings: {
      lead: {
        role: "lead",
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
      lead: "codex",
      partner: null,
      runState: "idle",
      step: null,
      round: null,
      startedAt: null,
      stopRequested: false,
      lastError: null,
    },
    collab: {
      enabled: false,
      rounds: 1,
      lead: "codex",
      partner: null,
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
  it("parses role-based bind, ask, xcheck, and collab commands", () => {
    expect(parseCocoCommand("/coco bind lead codex thread-1 /tmp/project")).toEqual({
      name: "bind",
      role: "lead",
      agent: "codex",
      sessionId: "thread-1",
      cwd: "/tmp/project",
    });
    expect(parseCocoCommand("/coco bind partner claude session-1 /tmp/project with spaces")).toEqual({
      name: "bind",
      role: "partner",
      agent: "claude",
      sessionId: "session-1",
      cwd: "/tmp/project with spaces",
    });
    expect(parseCocoCommand("/coco ask partner review this")).toEqual({
      name: "ask",
      role: "partner",
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
    expect(parseCocoCommand("/coco collab status")).toEqual({
      name: "collab",
      action: "status",
    });
    expect(parseCocoCommand("/coco collab on 3")).toEqual({
      name: "collab",
      action: "on",
      rounds: 3,
    });
  });

  it("guides users to bind lead first and partner for pair modes", () => {
    expect(buildNoActiveTargetText()).toContain("bind lead first");
    expect(buildNoActiveTargetText()).toContain("xcheck / collab");
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
        collabOn: vi.fn(() => makeState()),
        collabOff: vi.fn(() => makeState({ collab: { ...makeState().collab, enabled: false } })),
        collabStop: vi.fn(() => makeState()),
      },
    });

    const handled = await handlers.handleCocoCommand({
      chatKey: "telegram:1001",
      text: "/coco bind lead codex thread-1 /tmp/project",
      reply,
    });

    expect(handled).toBe(true);
    expect(reply).toHaveBeenCalledWith(
      expect.stringContaining("Bound lead to codex session thread-1 in /tmp/project."),
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
              lead: makeState().bindings.lead,
              partner: {
                role: "partner",
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
              lead: "codex",
              partner: "claude",
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
              lead: makeState().bindings.lead,
              partner: {
                role: "partner",
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
              lead: "codex",
              partner: "claude",
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
        collabOn: vi.fn(),
        collabOff: vi.fn(),
        collabStop: vi.fn(),
      },
    });

    const handled = await handlers.handleCocoCommand({
      chatKey: "feishu:oc_1",
      text: "/coco xcheck on 10",
      reply,
    });

    expect(handled).toBe(true);
    expect(reply).toHaveBeenCalledWith(expect.stringContaining("Xcheck mode enabled for 10 rounds."));
    expect(reply).toHaveBeenCalledWith(expect.stringContaining("Partner: claude"));
    expect(reply).toHaveBeenCalledWith(expect.stringContaining("Rounds: 10"));
  });

  it("enables collab mode", async () => {
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
              lead: makeState().bindings.lead,
              partner: {
                role: "partner",
                agent: "claude",
                sessionId: "session-1",
                cwd: "/tmp/project",
                status: "ready",
                error: null,
              },
            },
            collab: {
              enabled: true,
              rounds: 3,
              lead: "codex",
              partner: "claude",
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
        xcheckOn: vi.fn(),
        xcheckOff: vi.fn(),
        xcheckStop: vi.fn(),
        collabOn: vi.fn((_chatKey, rounds) =>
          makeState({
            bindings: {
              lead: makeState().bindings.lead,
              partner: {
                role: "partner",
                agent: "claude",
                sessionId: "session-1",
                cwd: "/tmp/project",
                status: "ready",
                error: null,
              },
            },
            collab: {
              enabled: true,
              rounds: rounds ?? 1,
              lead: "codex",
              partner: "claude",
              runState: "idle",
              step: null,
              round: null,
              startedAt: null,
              stopRequested: false,
              lastError: null,
            },
          }),
        ),
        collabOff: vi.fn(),
        collabStop: vi.fn(),
      },
    });

    const handled = await handlers.handleCocoCommand({
      chatKey: "feishu:oc_1",
      text: "/coco collab on 3",
      reply,
    });

    expect(handled).toBe(true);
    expect(reply).toHaveBeenCalledWith(expect.stringContaining("Collab mode enabled for 3 turns."));
    expect(reply).toHaveBeenCalledWith(expect.stringContaining("Lead: codex"));
    expect(reply).toHaveBeenCalledWith(expect.stringContaining("Partner: claude"));
    expect(reply).toHaveBeenCalledWith(expect.stringContaining("Turns: 3"));
  });

  it("forwards slash commands to the active session without xcheck", async () => {
    const reply = vi.fn(async (_text: string) => {});
    const sendToActive = vi.fn(async () => [
      {
        type: "agent" as const,
        role: "partner" as const,
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
        collabOn: vi.fn(),
        collabOff: vi.fn(),
        collabStop: vi.fn(),
      },
    });

    const handled = await handlers.handlePlainText({
      chatKey: "feishu:oc_1",
      text: "/compact",
      reply,
    });

    expect(handled).toBe(true);
    expect(reply).toHaveBeenCalledWith("[partner claude sess-1]\nlooks good");
    expect(sendToActive).toHaveBeenCalledWith(
      "feishu:oc_1",
      "/compact",
      expect.objectContaining({
        bypassSessionMode: true,
        onOutput: expect.any(Function),
      }),
    );
  });

  it("renders all xcheck phases in order without duplicating callback-driven replies", async () => {
    const reply = vi.fn(async (_text: string) => {});
    const outputs = [
      {
        type: "agent" as const,
        role: "lead" as const,
        phase: "draft" as const,
        result: {
          agent: "codex" as const,
          sessionId: "thread-1",
          text: "draft answer",
        },
      },
      {
        type: "agent" as const,
        role: "partner" as const,
        phase: "review" as const,
        result: {
          agent: "claude" as const,
          sessionId: "session-1",
          text: "review notes",
        },
      },
      {
        type: "agent" as const,
        role: "lead" as const,
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
        collabOn: vi.fn(),
        collabOff: vi.fn(),
        collabStop: vi.fn(),
      },
    });

    const handled = await handlers.handlePlainText({
      chatKey: "feishu:oc_1",
      text: "please review this",
      reply,
    });

    expect(handled).toBe(true);
    expect(reply.mock.calls).toEqual([
      ["[lead codex draft thread-1]\ndraft answer"],
      ["[partner claude review session-1]\nreview notes"],
      ["[lead codex final thread-1]\nfinal answer"],
    ]);
  });
});
