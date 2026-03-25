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
        status: "ready",
        error: null,
      },
    },
    ...overrides,
  };
}

describe("coco direct commands", () => {
  it("parses bind and ask commands", () => {
    expect(parseCocoCommand("/coco bind codex thread-1")).toEqual({
      name: "bind",
      agent: "codex",
      sessionId: "thread-1",
    });
    expect(parseCocoCommand("/coco ask claude review this")).toEqual({
      name: "ask",
      agent: "claude",
      text: "review this",
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
      },
    });

    const handled = await handlers.handleCocoCommand({
      chatKey: "telegram:1001",
      text: "/coco bind codex thread-1",
      reply,
    });

    expect(handled).toBe(true);
    expect(reply).toHaveBeenCalledWith(
      expect.stringContaining("Bound codex session thread-1."),
    );
  });

  it("forwards plain text to the active session", async () => {
    const reply = vi.fn(async (_text: string) => {});
    const handlers = createCocoCommandHandlers({
      deps: {
        bind: vi.fn(),
        use: vi.fn(),
        ask: vi.fn(),
        sendToActive: vi.fn(async () => ({
          agent: "claude" as const,
          sessionId: "sess-1",
          text: "looks good",
        })),
        current: vi.fn(() => makeState()),
        detach: vi.fn(),
      },
    });

    const handled = await handlers.handlePlainText({
      chatKey: "feishu:oc_1",
      text: "/compact",
      reply,
    });

    expect(handled).toBe(true);
    expect(reply).toHaveBeenCalledWith("[claude sess-1]\nlooks good");
  });
});
