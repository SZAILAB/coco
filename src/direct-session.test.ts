import { describe, expect, it, vi } from "vitest";
import { DirectSessionManager } from "./direct-session.js";
import type { DirectAgent, DirectBinding, DirectBindingStatus, DirectSendResult } from "./direct-backend.js";

function createFakeBinding(agent: DirectAgent, sessionId: string, cwd = "/tmp/project"): DirectBinding {
  let status: DirectBindingStatus = "ready";
  let error: string | null = null;

  return {
    agent,
    sessionId: () => sessionId,
    cwd: () => cwd,
    status: () => status,
    error: () => error,
    async send(prompt: string): Promise<DirectSendResult> {
      status = "busy";
      status = "ready";
      return {
        agent,
        sessionId,
        text: `${agent}:${prompt}`,
      };
    },
    async close(): Promise<void> {
      status = "exited";
      error = null;
    },
  };
}

describe("direct session manager", () => {
  it("binds two agents and switches the active target", async () => {
    const manager = new DirectSessionManager(async (agent, sessionId) => createFakeBinding(agent, sessionId));

    await manager.bind("chat-1", "codex", "thread-1", "/tmp/project");
    await manager.bind("chat-1", "claude", "session-1", "/tmp/project");
    const state = manager.use("chat-1", "claude");

    expect(state.activeTarget).toBe("claude");
    expect(state.bindings.codex?.sessionId).toBe("thread-1");
    expect(state.bindings.codex?.cwd).toBe("/tmp/project");
    expect(state.bindings.claude?.sessionId).toBe("session-1");
    expect(state.bindings.claude?.cwd).toBe("/tmp/project");
  });

  it("sends plain text to the active binding", async () => {
    const manager = new DirectSessionManager(async (agent, sessionId) => createFakeBinding(agent, sessionId));

    await manager.bind("chat-1", "codex", "thread-1", "/tmp/project");
    const result = await manager.sendToActive("chat-1", "hello");

    expect(result).toEqual({
      agent: "codex",
      sessionId: "thread-1",
      text: "codex:hello",
    });
  });

  it("detaches the active binding and falls back to the remaining one", async () => {
    const closeCodex = vi.fn(async () => {});
    const closeClaude = vi.fn(async () => {});
    const manager = new DirectSessionManager(async (agent, sessionId) => ({
      agent,
      sessionId: () => sessionId,
      cwd: () => "/tmp/project",
      status: () => "ready",
      error: () => null,
      send: async (prompt) => ({ agent, sessionId, text: prompt }),
      close: agent === "codex" ? closeCodex : closeClaude,
    }));

    await manager.bind("chat-1", "codex", "thread-1", "/tmp/project");
    await manager.bind("chat-1", "claude", "session-1", "/tmp/project");
    manager.use("chat-1", "claude");

    const state = await manager.detach("chat-1");

    expect(closeClaude).toHaveBeenCalledOnce();
    expect(closeCodex).not.toHaveBeenCalled();
    expect(state.activeTarget).toBe("codex");
    expect(state.bindings.claude).toBeUndefined();
    expect(state.bindings.codex?.sessionId).toBe("thread-1");
    expect(state.bindings.codex?.cwd).toBe("/tmp/project");
  });
});
