import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createDirectBinding,
  createNewDirectBinding,
  directBackendTesting,
  PENDING_DIRECT_SESSION_ID,
} from "./direct-backend.js";

const spawnMock = vi.fn();

type FakeChild = EventEmitter & {
  stdin: PassThrough;
  stdout: PassThrough;
  stderr: PassThrough;
  kill: ReturnType<typeof vi.fn>;
};

const RETRYABLE_ERROR =
  "Reconnecting... 2/5 (stream disconnected before completion: IO error: peer closed connection without sending TLS close_notify)";

afterEach(() => {
  spawnMock.mockReset();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  directBackendTesting.reset();
});

describe("direct backend codex retry handling", () => {
  it("retries a transient codex transport failure when no assistant output was emitted", async () => {
    const codexHome = createCodexHome("thread-1");
    vi.stubEnv("CODEX_HOME", codexHome);
    vi.stubEnv("COCO_CODEX_RESUME_MAX_ATTEMPTS", "2");
    vi.stubEnv("COCO_CODEX_RESUME_RETRY_DELAY_MS", "1");

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    spawnMock
      .mockImplementationOnce(() =>
        createFakeChild((child) => {
          emitJsonLine(child.stdout, { type: "error", message: RETRYABLE_ERROR });
          closeChild(child, 1);
        }),
      )
      .mockImplementationOnce(() =>
        createFakeChild((child) => {
          emitJsonLine(child.stdout, { type: "thread.started", thread_id: "thread-2" });
          emitJsonLine(child.stdout, {
            type: "item.completed",
            item: {
              type: "message",
              content: [{ type: "output_text", text: "reply after retry" }],
            },
          });
          emitJsonLine(child.stdout, { type: "turn.completed" });
          closeChild(child, 0);
        }),
      );

    directBackendTesting.setSpawn(spawnMock as never);
    const binding = await createDirectBinding("codex", "thread-1", "/tmp/project");
    const result = await binding.send("hello");

    expect(result).toEqual({
      agent: "codex",
      sessionId: "thread-2",
      text: "reply after retry",
    });
    expect(spawnMock).toHaveBeenCalledTimes(2);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("retrying in 1ms"));

    fs.rmSync(codexHome, { recursive: true, force: true });
  });

  it("accepts a completed turn even if a transient stream error was emitted earlier", async () => {
    const codexHome = createCodexHome("thread-1");
    vi.stubEnv("CODEX_HOME", codexHome);

    spawnMock.mockImplementationOnce(() =>
      createFakeChild((child) => {
        emitJsonLine(child.stdout, { type: "error", message: RETRYABLE_ERROR });
        emitJsonLine(child.stdout, { type: "thread.started", thread_id: "thread-2" });
        emitJsonLine(child.stdout, {
          type: "item.completed",
          item: {
            type: "message",
            content: [{ type: "output_text", text: "reply after reconnect" }],
          },
        });
        emitJsonLine(child.stdout, { type: "turn.completed" });
        closeChild(child, 0);
      }),
    );

    directBackendTesting.setSpawn(spawnMock as never);
    const binding = await createDirectBinding("codex", "thread-1", "/tmp/project");
    const result = await binding.send("hello");

    expect(result).toEqual({
      agent: "codex",
      sessionId: "thread-2",
      text: "reply after reconnect",
    });
    expect(spawnMock).toHaveBeenCalledTimes(1);

    fs.rmSync(codexHome, { recursive: true, force: true });
  });

  it("does not retry when assistant output has already started", async () => {
    const codexHome = createCodexHome("thread-1");
    vi.stubEnv("CODEX_HOME", codexHome);
    vi.stubEnv("COCO_CODEX_RESUME_MAX_ATTEMPTS", "2");
    vi.stubEnv("COCO_CODEX_RESUME_RETRY_DELAY_MS", "1");

    spawnMock.mockImplementationOnce(() =>
      createFakeChild((child) => {
        emitJsonLine(child.stdout, {
          type: "item.completed",
          item: {
            type: "message",
            content: [{ type: "output_text", text: "partial reply" }],
          },
        });
        emitJsonLine(child.stdout, { type: "error", message: RETRYABLE_ERROR });
        closeChild(child, 1);
      }),
    );

    directBackendTesting.setSpawn(spawnMock as never);
    const binding = await createDirectBinding("codex", "thread-1", "/tmp/project");

    await expect(binding.send("hello")).rejects.toThrow(RETRYABLE_ERROR);
    expect(spawnMock).toHaveBeenCalledTimes(1);

    fs.rmSync(codexHome, { recursive: true, force: true });
  });
});

describe("direct backend new session creation", () => {
  it("starts a new Codex session on the first send", async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "coco-cwd-"));

    spawnMock.mockImplementationOnce(() =>
      createFakeChild((child) => {
        emitJsonLine(child.stdout, { type: "thread.started", thread_id: "thread-new" });
        emitJsonLine(child.stdout, {
          type: "item.completed",
          item: {
            type: "message",
            content: [{ type: "output_text", text: "new reply" }],
          },
        });
        emitJsonLine(child.stdout, { type: "turn.completed" });
        closeChild(child, 0);
      }),
    );

    directBackendTesting.setSpawn(spawnMock as never);
    const binding = await createNewDirectBinding("codex", cwd);

    expect(binding.sessionId()).toBe(PENDING_DIRECT_SESSION_ID);

    const result = await binding.send("hello new session");

    expect(result).toEqual({
      agent: "codex",
      sessionId: "thread-new",
      text: "new reply",
    });
    expect(binding.sessionId()).toBe("thread-new");
    const args = spawnMock.mock.calls[0]?.[1] as string[];
    expect(args).toEqual([
      "exec",
      "--skip-git-repo-check",
      "--dangerously-bypass-approvals-and-sandbox",
      "--json",
      "hello new session",
    ]);

    fs.rmSync(cwd, { recursive: true, force: true });
  });

  it("creates a new Claude session with a generated session id", async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "coco-cwd-"));

    spawnMock.mockImplementationOnce(() => createFakeSpawnedChild(() => {}));

    directBackendTesting.setSpawn(spawnMock as never);
    const binding = await createNewDirectBinding("claude", cwd);

    expect(binding.sessionId()).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    const args = spawnMock.mock.calls[0]?.[1] as string[];
    expect(args).toContain("--session-id");
    expect(args).toContain(binding.sessionId());
    expect(args).not.toContain("--resume");
    expect(spawnMock.mock.calls[0]?.[2]).toEqual(expect.objectContaining({ cwd }));

    fs.rmSync(cwd, { recursive: true, force: true });
  });
});

function createCodexHome(sessionId: string): string {
  const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), "coco-codex-home-"));
  const sessionsDir = path.join(codexHome, "sessions", "2026", "04", "04");
  fs.mkdirSync(sessionsDir, { recursive: true });
  fs.writeFileSync(path.join(sessionsDir, `rollout-${sessionId}.jsonl`), "");
  return codexHome;
}

function createFakeChild(run: (child: FakeChild) => void): FakeChild {
  const child = new EventEmitter() as FakeChild;
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = vi.fn();

  queueMicrotask(() => run(child));
  return child;
}

function createFakeSpawnedChild(run: (child: FakeChild) => void): FakeChild {
  const child = createFakeChild(run);
  queueMicrotask(() => child.emit("spawn"));
  return child;
}

function emitJsonLine(stream: PassThrough, value: unknown): void {
  stream.write(`${JSON.stringify(value)}\n`);
}

function closeChild(child: FakeChild, code: number): void {
  setTimeout(() => {
    child.stdout.end();
    child.stderr.end();
    child.emit("close", code);
  }, 0);
}
