import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { SessionEvent } from "./pty-session.js";
import { Broker, type BrokerSession } from "./broker.js";

class FakeSession implements BrokerSession {
  readonly id: string;
  readonly spec?: { name?: string };
  sent: string[] = [];
  private listeners: Array<(event: SessionEvent) => void> = [];

  constructor(id: string, name: string) {
    this.id = id;
    this.spec = { name };
  }

  onEvent(handler: (event: SessionEvent) => void): () => void {
    this.listeners.push(handler);
    return () => {
      this.listeners = this.listeners.filter((listener) => listener !== handler);
    };
  }

  send(text: string): void {
    this.sent.push(text);
  }

  write(data: string): void {
    this.sent.push(data);
  }

  emit(event: SessionEvent): void {
    for (const listener of this.listeners) {
      listener(event);
    }
  }
}

const tempDirs: string[] = [];

async function makeTurnDir() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "coco-broker-"));
  tempDirs.push(dir);
  return dir;
}

async function writeTurn(baseDir: string, side: string, turn: number, text: string) {
  const prefix = path.join(baseDir, side, `turn-${String(turn).padStart(3, "0")}`);
  await writeFile(`${prefix}.md`, text, "utf8");
  await writeFile(`${prefix}.done`, "done\n", "utf8");
}

async function waitFor(check: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("condition not met before timeout");
}

describe("Broker", () => {
  afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it("forwards file-backed turns and stops on a keyword", async () => {
    const left = new FakeSession("left", "codex");
    const right = new FakeSession("right", "claude");
    const turnDir = await makeTurnDir();
    const stops: string[] = [];

    const broker = new Broker(left, right, {
      turnDir,
      pollMs: 10,
      turnTimeoutMs: 2_000,
      buildInitialMessage: ({ outputPath }) => `writer -> ${outputPath}`,
      renderMessage: (from, text, ctx) => `from ${from} -> ${ctx.outputPath}\n${text}`,
      onStop: ({ reason, by }) => stops.push(`${reason}:${by}`),
    });

    const run = broker.start();
    await waitFor(() => left.sent.length === 1);
    await writeTurn(turnDir, "codex", 1, "Use capped exponential backoff with jitter.");
    await waitFor(() => right.sent.length === 1);
    expect(right.sent[0]).toContain("Use capped exponential backoff with jitter.");

    await writeTurn(turnDir, "claude", 1, "AGREED");
    await run;

    expect(stops).toEqual(["keyword:claude"]);
  });

  it("stops on duplicate file turns before forwarding again", async () => {
    const left = new FakeSession("left", "codex");
    const right = new FakeSession("right", "claude");
    const turnDir = await makeTurnDir();
    const stops: string[] = [];

    const broker = new Broker(left, right, {
      turnDir,
      pollMs: 10,
      turnTimeoutMs: 2_000,
      onStop: ({ reason }) => stops.push(reason),
    });

    const run = broker.start();
    await waitFor(() => left.sent.length === 1);
    await writeTurn(turnDir, "codex", 1, "We should use exponential backoff here.");
    await waitFor(() => right.sent.length === 1);
    await writeTurn(turnDir, "claude", 1, "We should use exponential backoff here.");
    await run;

    expect(stops).toEqual(["duplicate"]);
    expect(left.sent).toHaveLength(1);
  });

  it("stops when a turn file never completes", async () => {
    const left = new FakeSession("left", "codex");
    const right = new FakeSession("right", "claude");
    const turnDir = await makeTurnDir();
    const stops: string[] = [];

    const broker = new Broker(left, right, {
      turnDir,
      pollMs: 10,
      turnTimeoutMs: 50,
      onStop: ({ reason }) => stops.push(reason),
    });

    await broker.start();
    expect(stops).toEqual(["timeout"]);
    expect(right.sent).toEqual([]);
  });

  it("stops if a session exits while waiting for a file turn", async () => {
    const left = new FakeSession("left", "codex");
    const right = new FakeSession("right", "claude");
    const turnDir = await makeTurnDir();
    const stops: string[] = [];

    const broker = new Broker(left, right, {
      turnDir,
      pollMs: 10,
      turnTimeoutMs: 2_000,
      onStop: ({ reason, by }) => stops.push(`${reason}:${by}`),
    });

    const run = broker.start();
    await waitFor(() => left.sent.length === 1);
    left.emit({ type: "exit", exitCode: 1, signal: null, ts: Date.now() });
    await run;

    expect(stops).toEqual(["session-exit:codex"]);
  });

  it("re-sends the current turn prompt after a watchdog restart", async () => {
    const left = new FakeSession("left", "codex");
    const right = new FakeSession("right", "claude");
    const turnDir = await makeTurnDir();
    const stops: string[] = [];

    const broker = new Broker(left, right, {
      turnDir,
      pollMs: 10,
      turnTimeoutMs: 2_000,
      onStop: ({ reason }) => stops.push(reason),
    });

    const run = broker.start();
    await waitFor(() => left.sent.length === 1);
    const firstPrompt = left.sent[0];

    left.emit({ type: "exit", exitCode: 1, signal: null, ts: Date.now() });
    await new Promise<void>((resolve) => setTimeout(resolve, 30));
    left.emit({ type: "start", pid: 1234, ts: Date.now() });
    await waitFor(() => left.sent.length === 2);

    expect(left.sent[1]).toBe(firstPrompt);

    await writeTurn(turnDir, "codex", 1, "Recovered proposal after restart.");
    await waitFor(() => right.sent.length === 1);
    await writeTurn(turnDir, "claude", 1, "AGREED");
    await run;

    expect(stops).toEqual(["keyword"]);
  });

  it("writes turns into per-side numbered files", async () => {
    const left = new FakeSession("left", "codex");
    const right = new FakeSession("right", "claude");
    const turnDir = await makeTurnDir();

    const broker = new Broker(left, right, {
      turnDir,
      pollMs: 10,
      turnTimeoutMs: 2_000,
    });

    const run = broker.start();
    await waitFor(() => left.sent.length === 1);
    await writeTurn(turnDir, "codex", 1, "First proposal.");
    await waitFor(() => right.sent.length === 1);
    await writeTurn(turnDir, "claude", 1, "AGREED");
    await run;

    const text = await readFile(path.join(turnDir, "codex", "turn-001.md"), "utf8");
    expect(text).toBe("First proposal.");
  });
});
