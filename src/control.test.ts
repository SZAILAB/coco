import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  execSync: vi.fn(),
  readLatestRunStatus: vi.fn(),
  spawn: vi.fn(),
}));

vi.mock("node:child_process", () => ({
  execSync: mocks.execSync,
  spawn: mocks.spawn,
}));

vi.mock("./run-status.js", () => ({
  readLatestRunStatus: mocks.readLatestRunStatus,
}));

import { startBroker, stopBroker } from "./control.js";

function makeStatus(pid: number) {
  return {
    runId: "run-123",
    task: "test",
    cwd: "/tmp/coco",
    pid,
    pidFile: "/tmp/coco/state/broker/run-123/broker.pid",
    turnDir: "/tmp/coco/state/broker/run-123",
    statusFile: "/tmp/coco/state/broker/run-123/status.json",
    phase: "waiting-turn",
    round: 0,
    startedAt: "2026-03-24T00:00:00.000Z",
    updatedAt: "2026-03-24T00:00:00.000Z",
    stoppedAt: null,
    stopReason: null,
    stopBy: null,
    stopTextPreview: null,
    waitingFor: null,
    lastForward: null,
    sessions: {
      left: { name: "codex", pid: null, status: "starting" },
      right: { name: "claude", pid: null, status: "starting" },
    },
  } as const;
}

describe("control", () => {
  beforeEach(() => {
    mocks.execSync.mockReset();
    mocks.readLatestRunStatus.mockReset();
    mocks.spawn.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("does not signal a live pid when it is not a broker process", async () => {
    mocks.readLatestRunStatus.mockResolvedValue(makeStatus(123));
    mocks.execSync.mockReturnValue("sleep 60\n");

    const kill = vi.spyOn(process, "kill").mockImplementation(((pid: number, signal?: number | NodeJS.Signals) => {
      expect(pid).toBe(123);
      expect(signal).toBe(0);
      return true;
    }) as typeof process.kill);

    const result = await stopBroker(undefined, {
      cwd: "/tmp/coco",
      brokerRoot: "/tmp/coco/state/broker",
    });

    expect(result).toEqual({
      found: true,
      pid: 123,
      signal: "SIGTERM",
      wasAlive: false,
    });
    expect(mocks.execSync).toHaveBeenCalledWith("ps -p 123 -o command=", {
      encoding: "utf8",
      timeout: 3000,
    });
    expect(kill).toHaveBeenCalledTimes(1);
  });

  it("surfaces async spawn failures without crashing the caller", async () => {
    vi.useFakeTimers();
    mocks.readLatestRunStatus.mockResolvedValue(null);

    const child = {
      pid: undefined as number | undefined,
      unref: vi.fn(),
      on: vi.fn((event: string, handler: (err: Error) => void) => {
        if (event === "error") {
          queueMicrotask(() => handler(new Error("spawn npx ENOENT")));
        }
        return child;
      }),
    };
    mocks.spawn.mockReturnValue(child);

    const start = startBroker("test task", {
      cwd: "/tmp/coco",
      brokerRoot: "/tmp/coco/state/broker",
    });
    const rejection = expect(start).rejects.toThrow("Broker spawn failed: spawn npx ENOENT");

    await vi.advanceTimersByTimeAsync(250);

    await rejection;
    expect(child.unref).toHaveBeenCalledOnce();
  });
});
