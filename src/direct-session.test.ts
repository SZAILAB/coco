import { describe, expect, it, vi } from "vitest";
import { DirectSessionManager } from "./direct-session.js";
import type { DirectAgent, DirectBinding, DirectBindingStatus, DirectSendResult } from "./direct-backend.js";

function createFakeBinding(
  agent: DirectAgent,
  sessionId: string,
  cwd = "/tmp/project",
  sendImpl?: (prompt: string) => Promise<DirectSendResult>,
): DirectBinding {
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
      try {
        return sendImpl
          ? await sendImpl(prompt)
          : {
              agent,
              sessionId,
              text: `${agent}:${prompt}`,
            };
      } finally {
        status = "ready";
      }
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

    expect(result).toEqual([
      {
        type: "agent",
        phase: "default",
        result: {
          agent: "codex",
          sessionId: "thread-1",
          text: "codex:hello",
        },
      },
    ]);
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

  it("requires both agents before enabling xcheck", async () => {
    const manager = new DirectSessionManager(async (agent, sessionId) => createFakeBinding(agent, sessionId));

    await manager.bind("chat-1", "codex", "thread-1", "/tmp/project");

    expect(() => manager.xcheckOn("chat-1")).toThrow(
      "Xcheck requires both codex and claude to be bound and an active target selected",
    );
  });

  it("requires both agents before enabling collab", async () => {
    const manager = new DirectSessionManager(async (agent, sessionId) => createFakeBinding(agent, sessionId));

    await manager.bind("chat-1", "codex", "thread-1", "/tmp/project");

    expect(() => manager.collabOn("chat-1")).toThrow(
      "Collab requires both codex and claude to be bound and an active target selected",
    );
  });

  it("runs the fixed owner draft reviewer review owner final pipeline", async () => {
    const codexSend = vi
      .fn<(prompt: string) => Promise<DirectSendResult>>()
      .mockResolvedValueOnce({
        agent: "codex",
        sessionId: "thread-1",
        text: "draft from codex",
      })
      .mockResolvedValueOnce({
        agent: "codex",
        sessionId: "thread-1",
        text: "final from codex",
      });
    const claudeSend = vi.fn<(prompt: string) => Promise<DirectSendResult>>().mockResolvedValue({
      agent: "claude",
      sessionId: "session-1",
      text: "review from claude",
    });

    const manager = new DirectSessionManager(async (agent, sessionId) =>
      createFakeBinding(
        agent,
        sessionId,
        "/tmp/project",
        agent === "codex" ? codexSend : claudeSend,
      ),
    );

    await manager.bind("chat-1", "codex", "thread-1", "/tmp/project");
    await manager.bind("chat-1", "claude", "session-1", "/tmp/project");
    manager.xcheckOn("chat-1");

    const result = await manager.sendToActive("chat-1", "please fix this");

    expect(result).toEqual([
      {
        type: "agent",
        phase: "draft",
        result: {
          agent: "codex",
          sessionId: "thread-1",
          text: "draft from codex",
        },
      },
      {
        type: "agent",
        phase: "review",
        result: {
          agent: "claude",
          sessionId: "session-1",
          text: "review from claude",
        },
      },
      {
        type: "agent",
        phase: "final",
        result: {
          agent: "codex",
          sessionId: "thread-1",
          text: "final from codex",
        },
      },
    ]);
    expect(claudeSend).toHaveBeenCalledWith(expect.stringContaining("Original user message:\nplease fix this"));
    expect(claudeSend).toHaveBeenCalledWith(expect.stringContaining("Draft to review:\ndraft from codex"));
    expect(codexSend).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining("Reviewer feedback:\nreview from claude"),
    );
  });

  it("supports multiple xcheck rounds before the final response", async () => {
    const codexSend = vi
      .fn<(prompt: string) => Promise<DirectSendResult>>()
      .mockResolvedValueOnce({
        agent: "codex",
        sessionId: "thread-1",
        text: "draft round 1",
      })
      .mockResolvedValueOnce({
        agent: "codex",
        sessionId: "thread-1",
        text: "draft round 2",
      })
      .mockResolvedValueOnce({
        agent: "codex",
        sessionId: "thread-1",
        text: "final from codex",
      });
    const claudeSend = vi
      .fn<(prompt: string) => Promise<DirectSendResult>>()
      .mockResolvedValueOnce({
        agent: "claude",
        sessionId: "session-1",
        text: "review round 1",
      })
      .mockResolvedValueOnce({
        agent: "claude",
        sessionId: "session-1",
        text: "review round 2",
      });

    const manager = new DirectSessionManager(async (agent, sessionId) =>
      createFakeBinding(
        agent,
        sessionId,
        "/tmp/project",
        agent === "codex" ? codexSend : claudeSend,
      ),
    );

    await manager.bind("chat-1", "codex", "thread-1", "/tmp/project");
    await manager.bind("chat-1", "claude", "session-1", "/tmp/project");
    manager.xcheckOn("chat-1", 2);

    const result = await manager.sendToActive("chat-1", "please fix this");

    expect(result).toEqual([
      {
        type: "agent",
        phase: "draft",
        result: {
          agent: "codex",
          sessionId: "thread-1",
          text: "draft round 1",
        },
      },
      {
        type: "agent",
        phase: "review",
        result: {
          agent: "claude",
          sessionId: "session-1",
          text: "review round 1",
        },
      },
      {
        type: "agent",
        phase: "draft",
        result: {
          agent: "codex",
          sessionId: "thread-1",
          text: "draft round 2",
        },
      },
      {
        type: "agent",
        phase: "review",
        result: {
          agent: "claude",
          sessionId: "session-1",
          text: "review round 2",
        },
      },
      {
        type: "agent",
        phase: "final",
        result: {
          agent: "codex",
          sessionId: "thread-1",
          text: "final from codex",
        },
      },
    ]);
    expect(manager.current("chat-1").xcheck.rounds).toBe(2);
    expect(claudeSend).toHaveBeenNthCalledWith(
      1,
      expect.stringContaining("Round: 1/2"),
    );
    expect(claudeSend).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining("Round: 2/2"),
    );
    expect(codexSend).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining("Return an updated draft only."),
    );
    expect(codexSend).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining("Round: 2/2"),
    );
    expect(codexSend).toHaveBeenNthCalledWith(
      3,
      expect.stringContaining("Final round: 2/2"),
    );
  });

  it("alternates raw collab turns by relaying each reply unchanged", async () => {
    const codexSend = vi
      .fn<(prompt: string) => Promise<DirectSendResult>>()
      .mockResolvedValueOnce({
        agent: "codex",
        sessionId: "thread-1",
        text: "codex turn 1",
      })
      .mockResolvedValueOnce({
        agent: "codex",
        sessionId: "thread-1",
        text: "codex turn 3",
      });
    const claudeSend = vi
      .fn<(prompt: string) => Promise<DirectSendResult>>()
      .mockResolvedValueOnce({
        agent: "claude",
        sessionId: "session-1",
        text: "claude turn 2",
      })
      .mockResolvedValueOnce({
        agent: "claude",
        sessionId: "session-1",
        text: "claude turn 4",
      });

    const manager = new DirectSessionManager(async (agent, sessionId) =>
      createFakeBinding(
        agent,
        sessionId,
        "/tmp/project",
        agent === "codex" ? codexSend : claudeSend,
      ),
    );

    await manager.bind("chat-1", "codex", "thread-1", "/tmp/project");
    await manager.bind("chat-1", "claude", "session-1", "/tmp/project");
    manager.collabOn("chat-1", 4);

    const result = await manager.sendToActive("chat-1", "help me improve this");

    expect(result).toEqual([
      {
        type: "agent",
        phase: "collab",
        result: {
          agent: "codex",
          sessionId: "thread-1",
          text: "codex turn 1",
        },
      },
      {
        type: "agent",
        phase: "collab",
        result: {
          agent: "claude",
          sessionId: "session-1",
          text: "claude turn 2",
        },
      },
      {
        type: "agent",
        phase: "collab",
        result: {
          agent: "codex",
          sessionId: "thread-1",
          text: "codex turn 3",
        },
      },
      {
        type: "agent",
        phase: "collab",
        result: {
          agent: "claude",
          sessionId: "session-1",
          text: "claude turn 4",
        },
      },
    ]);
    expect(manager.current("chat-1").collab.rounds).toBe(4);
    expect(codexSend).toHaveBeenNthCalledWith(1, "help me improve this");
    expect(claudeSend).toHaveBeenNthCalledWith(1, "codex turn 1");
    expect(codexSend).toHaveBeenNthCalledWith(2, "claude turn 2");
    expect(claudeSend).toHaveBeenNthCalledWith(2, "codex turn 3");
  });

  it("emits xcheck outputs incrementally as each step completes", async () => {
    let releaseReview: ((value: DirectSendResult) => void) | null = null;
    const seenPhases: string[] = [];
    const codexSend = vi
      .fn<(prompt: string) => Promise<DirectSendResult>>()
      .mockResolvedValueOnce({
        agent: "codex",
        sessionId: "thread-1",
        text: "draft from codex",
      })
      .mockResolvedValueOnce({
        agent: "codex",
        sessionId: "thread-1",
        text: "final from codex",
      });
    const claudeSend = vi
      .fn<(prompt: string) => Promise<DirectSendResult>>()
      .mockImplementationOnce(
        () =>
          new Promise<DirectSendResult>((resolve) => {
            releaseReview = resolve;
          }),
      );
    const manager = new DirectSessionManager(async (agent, sessionId) =>
      createFakeBinding(
        agent,
        sessionId,
        "/tmp/project",
        agent === "codex" ? codexSend : claudeSend,
      ),
    );

    await manager.bind("chat-1", "codex", "thread-1", "/tmp/project");
    await manager.bind("chat-1", "claude", "session-1", "/tmp/project");
    manager.xcheckOn("chat-1");

    const running = manager.sendToActive("chat-1", "please fix this", {
      onOutput: (output) => {
        if (output.type === "agent") {
          seenPhases.push(output.phase);
        }
      },
    });

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(seenPhases).toEqual(["draft"]);

    if (!releaseReview) {
      throw new Error("expected review resolver to be set");
    }
    const resolveReview = releaseReview as (value: DirectSendResult) => void;
    resolveReview({
      agent: "claude",
      sessionId: "session-1",
      text: "review from claude",
    });

    await expect(running).resolves.toEqual([
      {
        type: "agent",
        phase: "draft",
        result: {
          agent: "codex",
          sessionId: "thread-1",
          text: "draft from codex",
        },
      },
      {
        type: "agent",
        phase: "review",
        result: {
          agent: "claude",
          sessionId: "session-1",
          text: "review from claude",
        },
      },
      {
        type: "agent",
        phase: "final",
        result: {
          agent: "codex",
          sessionId: "thread-1",
          text: "final from codex",
        },
      },
    ]);
    expect(seenPhases).toEqual(["draft", "review", "final"]);
  });

  it("blocks re-entry while an xcheck run is active", async () => {
    let releaseDraft: ((value: DirectSendResult) => void) | null = null;
    const codexSend = vi
      .fn<(prompt: string) => Promise<DirectSendResult>>()
      .mockImplementationOnce(
        () =>
          new Promise<DirectSendResult>((resolve) => {
            releaseDraft = resolve;
          }),
      )
      .mockResolvedValueOnce({
        agent: "codex",
        sessionId: "thread-1",
        text: "final from codex",
      });
    const claudeSend = vi.fn<(prompt: string) => Promise<DirectSendResult>>().mockResolvedValue({
      agent: "claude",
      sessionId: "session-1",
      text: "review from claude",
    });
    const manager = new DirectSessionManager(async (agent, sessionId) =>
      createFakeBinding(
        agent,
        sessionId,
        "/tmp/project",
        agent === "codex" ? codexSend : claudeSend,
      ),
    );

    await manager.bind("chat-1", "codex", "thread-1", "/tmp/project");
    await manager.bind("chat-1", "claude", "session-1", "/tmp/project");
    manager.xcheckOn("chat-1");

    const running = manager.sendToActive("chat-1", "first request");
    const blocked = await manager.sendToActive("chat-1", "second request");

    expect(blocked).toEqual([{ type: "system", text: "xcheck already running, please wait" }]);

    if (!releaseDraft) {
      throw new Error("expected draft resolver to be set");
    }
    const resolveDraft = releaseDraft as (value: DirectSendResult) => void;
    resolveDraft({
      agent: "codex",
      sessionId: "thread-1",
      text: "draft from codex",
    });
    await expect(running).resolves.toEqual([
      {
        type: "agent",
        phase: "draft",
        result: {
          agent: "codex",
          sessionId: "thread-1",
          text: "draft from codex",
        },
      },
      {
        type: "agent",
        phase: "review",
        result: {
          agent: "claude",
          sessionId: "session-1",
          text: "review from claude",
        },
      },
      {
        type: "agent",
        phase: "final",
        result: {
          agent: "codex",
          sessionId: "thread-1",
          text: "final from codex",
        },
      },
    ]);
  });

  it("stops after the current xcheck step when stop is requested", async () => {
    let releaseDraft: ((value: DirectSendResult) => void) | null = null;
    const codexSend = vi
      .fn<(prompt: string) => Promise<DirectSendResult>>()
      .mockImplementationOnce(
        () =>
          new Promise<DirectSendResult>((resolve) => {
            releaseDraft = resolve;
          }),
      );
    const claudeSend = vi.fn<(prompt: string) => Promise<DirectSendResult>>().mockResolvedValue({
      agent: "claude",
      sessionId: "session-1",
      text: "review from claude",
    });
    const manager = new DirectSessionManager(async (agent, sessionId) =>
      createFakeBinding(
        agent,
        sessionId,
        "/tmp/project",
        agent === "codex" ? codexSend : claudeSend,
      ),
    );

    await manager.bind("chat-1", "codex", "thread-1", "/tmp/project");
    await manager.bind("chat-1", "claude", "session-1", "/tmp/project");
    manager.xcheckOn("chat-1");

    const running = manager.sendToActive("chat-1", "first request");
    const stopState = manager.xcheckStop("chat-1");

    expect(stopState.xcheck.runState).toBe("running");
    expect(stopState.xcheck.stopRequested).toBe(true);

    if (!releaseDraft) {
      throw new Error("expected draft resolver to be set");
    }
    const resolveDraft = releaseDraft as (value: DirectSendResult) => void;
    resolveDraft({
      agent: "codex",
      sessionId: "thread-1",
      text: "draft from codex",
    });

    await expect(running).resolves.toEqual([
      {
        type: "agent",
        phase: "draft",
        result: {
          agent: "codex",
          sessionId: "thread-1",
          text: "draft from codex",
        },
      },
      {
        type: "system",
        text: "Xcheck stopped after owner draft (round 1/1).",
      },
    ]);
    expect(claudeSend).not.toHaveBeenCalled();
    expect(manager.current("chat-1").xcheck.runState).toBe("idle");
  });

  it("stops after the current collab step when stop is requested", async () => {
    let releaseDraft: ((value: DirectSendResult) => void) | null = null;
    const codexSend = vi
      .fn<(prompt: string) => Promise<DirectSendResult>>()
      .mockImplementationOnce(
        () =>
          new Promise<DirectSendResult>((resolve) => {
            releaseDraft = resolve;
          }),
      );
    const claudeSend = vi.fn<(prompt: string) => Promise<DirectSendResult>>().mockResolvedValue({
      agent: "claude",
      sessionId: "session-1",
      text: "partner notes",
    });
    const manager = new DirectSessionManager(async (agent, sessionId) =>
      createFakeBinding(
        agent,
        sessionId,
        "/tmp/project",
        agent === "codex" ? codexSend : claudeSend,
      ),
    );

    await manager.bind("chat-1", "codex", "thread-1", "/tmp/project");
    await manager.bind("chat-1", "claude", "session-1", "/tmp/project");
    manager.collabOn("chat-1");

    const running = manager.sendToActive("chat-1", "first request");
    const stopState = manager.collabStop("chat-1");

    expect(stopState.collab.runState).toBe("running");
    expect(stopState.collab.stopRequested).toBe(true);

    if (!releaseDraft) {
      throw new Error("expected draft resolver to be set");
    }
    const resolveDraft = releaseDraft as (value: DirectSendResult) => void;
    resolveDraft({
      agent: "codex",
      sessionId: "thread-1",
      text: "first collab turn from codex",
    });

    await expect(running).resolves.toEqual([
      {
        type: "agent",
        phase: "collab",
        result: {
          agent: "codex",
          sessionId: "thread-1",
          text: "first collab turn from codex",
        },
      },
      {
        type: "system",
        text: "Collab stopped after lead turn (turn 1/1).",
      },
    ]);
    expect(claudeSend).not.toHaveBeenCalled();
    expect(manager.current("chat-1").collab.runState).toBe("idle");
  });

  it("keeps xcheck and collab mutually exclusive", async () => {
    const manager = new DirectSessionManager(async (agent, sessionId) => createFakeBinding(agent, sessionId));

    await manager.bind("chat-1", "codex", "thread-1", "/tmp/project");
    await manager.bind("chat-1", "claude", "session-1", "/tmp/project");

    const collabState = manager.collabOn("chat-1", 3);
    expect(collabState.collab.enabled).toBe(true);
    expect(collabState.collab.rounds).toBe(3);
    expect(collabState.xcheck.enabled).toBe(false);

    const xcheckState = manager.xcheckOn("chat-1", 2);
    expect(xcheckState.xcheck.enabled).toBe(true);
    expect(xcheckState.xcheck.rounds).toBe(2);
    expect(xcheckState.collab.enabled).toBe(false);
  });
});
