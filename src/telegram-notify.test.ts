import { describe, expect, it } from "vitest";

import { collectStatusNotifications, createNotificationCursor } from "./telegram-notify.js";
import type { RunStatus } from "./run-status.js";

function makeStatus(overrides: Partial<RunStatus> = {}): RunStatus {
  return {
    runId: "run-123",
    task: "test",
    cwd: "/tmp/coco",
    pid: 123,
    pidFile: "/tmp/coco/broker.pid",
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
    waitingFor: {
      agent: "claude",
      round: 1,
      turn: 1,
      outputPath: "/tmp/out.md",
      donePath: "/tmp/out.done",
      resentCount: 0,
    },
    lastForward: null,
    recentTurns: [],
    progressSummary: {
      text: "Waiting for claude turn 1 (round 1, resends 0).",
      updatedAt: "2026-03-24T00:00:10.000Z",
    },
    heartbeat: {
      intervalMs: 60_000,
      count: 1,
      lastAt: "2026-03-24T00:01:00.000Z",
      lastText: "Still waiting for claude turn 1.",
    },
    sessions: {
      left: { name: "codex", pid: 201, status: "running" },
      right: { name: "claude", pid: 202, status: "running" },
    },
    ...overrides,
  };
}

describe("collectStatusNotifications", () => {
  it("emits a forward notification when lastForward changes", () => {
    const seed = collectStatusNotifications(createNotificationCursor(), makeStatus()).cursor;

    const result = collectStatusNotifications(
      seed,
      makeStatus({
        lastForward: {
          from: "codex",
          to: "claude",
          round: 1,
          preview: "Use capped backoff with jitter.",
          at: "2026-03-24T00:00:11.000Z",
        },
        recentTurns: [
          {
            from: "codex",
            to: "claude",
            round: 1,
            preview: "Use capped backoff with jitter.",
            at: "2026-03-24T00:00:11.000Z",
          },
        ],
        progressSummary: {
          text: "Waiting for claude turn 1 (round 1, resends 0).\nRecent progress:\n- Round 1 codex -> claude: Use capped backoff with jitter.",
          updatedAt: "2026-03-24T00:00:11.000Z",
        },
      }),
    );

    expect(result.notifications).toHaveLength(1);
    expect(result.notifications[0]?.kind).toBe("forward");
    expect(result.notifications[0]?.text).toContain("Round 1: codex -> claude");
    expect(result.notifications[0]?.text).toContain("Use capped backoff with jitter.");
  });

  it("emits recovery notifications for exits and resends", () => {
    const seeded = collectStatusNotifications(createNotificationCursor(), makeStatus()).cursor;

    const exited = collectStatusNotifications(
      seeded,
      makeStatus({
        sessions: {
          left: { name: "codex", pid: 201, status: "exited" },
          right: { name: "claude", pid: 202, status: "running" },
        },
        progressSummary: {
          text: "Recovery: codex exited; waiting for watchdog restart.",
          updatedAt: "2026-03-24T00:00:12.000Z",
        },
      }),
    );

    expect(exited.notifications).toHaveLength(1);
    expect(exited.notifications[0]?.kind).toBe("recovery");
    expect(exited.notifications[0]?.text).toContain("codex exited");

    const resent = collectStatusNotifications(
      exited.cursor,
      makeStatus({
        waitingFor: {
          agent: "codex",
          round: 1,
          turn: 1,
          outputPath: "/tmp/out.md",
          donePath: "/tmp/out.done",
          resentCount: 1,
        },
        progressSummary: {
          text: "Waiting for codex turn 1 (round 1, resends 1).",
          updatedAt: "2026-03-24T00:00:13.000Z",
        },
      }),
    );

    expect(resent.notifications).toHaveLength(1);
    expect(resent.notifications[0]?.kind).toBe("recovery");
    expect(resent.notifications[0]?.text).toContain("Resent the current prompt to codex turn 1");
  });

  it("emits a stop notification once", () => {
    const seeded = collectStatusNotifications(createNotificationCursor(), makeStatus()).cursor;
    const stoppedStatus = makeStatus({
      phase: "stopped",
      stoppedAt: "2026-03-24T00:00:20.000Z",
      stopReason: "keyword",
      stopBy: "claude",
      stopTextPreview: "AGREED",
      waitingFor: null,
      progressSummary: {
        text: "Stopped (keyword) by claude.\nFinal: AGREED",
        updatedAt: "2026-03-24T00:00:20.000Z",
      },
    });

    const first = collectStatusNotifications(seeded, stoppedStatus);
    expect(first.notifications).toHaveLength(1);
    expect(first.notifications[0]?.kind).toBe("stop");
    expect(first.notifications[0]?.text).toContain("Run run-123 stopped (keyword) by claude.");

    const second = collectStatusNotifications(first.cursor, stoppedStatus);
    expect(second.notifications).toHaveLength(0);
  });

  it("throttles repeated identical recovery notifications", () => {
    const base = createNotificationCursor();
    const status = makeStatus({
      sessions: {
        left: { name: "codex", pid: 201, status: "exited" },
        right: { name: "claude", pid: 202, status: "running" },
      },
      updatedAt: "2026-03-24T00:00:12.000Z",
      progressSummary: {
        text: "Recovery: codex exited; waiting for watchdog restart.",
        updatedAt: "2026-03-24T00:00:12.000Z",
      },
    });

    const first = collectStatusNotifications(base, status, { recoveryThrottleMs: 30_000 });
    expect(first.notifications).toHaveLength(1);

    const second = collectStatusNotifications(
      first.cursor,
      {
        ...status,
        updatedAt: "2026-03-24T00:00:20.000Z",
        progressSummary: {
          text: "Recovery: codex exited; waiting for watchdog restart.",
          updatedAt: "2026-03-24T00:00:20.000Z",
        },
      },
      { recoveryThrottleMs: 30_000 },
    );
    expect(second.notifications).toHaveLength(0);
  });

  it("upgrades fatal stop notifications", () => {
    const seeded = collectStatusNotifications(createNotificationCursor(), makeStatus()).cursor;
    const fatal = collectStatusNotifications(
      seeded,
      makeStatus({
        phase: "stopped",
        stoppedAt: "2026-03-24T00:00:20.000Z",
        stopReason: "fatal",
        stopBy: "system",
        stopTextPreview: "broker stopped after fatal error",
        waitingFor: null,
        progressSummary: {
          text: "Stopped (fatal) by system.\nFinal: broker stopped after fatal error",
          updatedAt: "2026-03-24T00:00:20.000Z",
        },
      }),
    );

    expect(fatal.notifications).toHaveLength(1);
    expect(fatal.notifications[0]?.kind).toBe("stop");
    expect(fatal.notifications[0]?.text).toContain("Run run-123 failed (fatal) by system.");
  });

  it("does not emit recovery notifications after a run has stopped", () => {
    const seeded = collectStatusNotifications(createNotificationCursor(), makeStatus()).cursor;
    const stopped = collectStatusNotifications(
      seeded,
      makeStatus({
        phase: "stopped",
        stoppedAt: "2026-03-24T00:00:20.000Z",
        stopReason: "keyword",
        stopBy: "claude",
        stopTextPreview: "AGREED",
        waitingFor: null,
        sessions: {
          left: { name: "codex", pid: 201, status: "exited" },
          right: { name: "claude", pid: 202, status: "running" },
        },
        progressSummary: {
          text: "Stopped (keyword) by claude.\nFinal: AGREED",
          updatedAt: "2026-03-24T00:00:20.000Z",
        },
      }),
    );

    expect(stopped.notifications).toHaveLength(1);
    expect(stopped.notifications[0]?.kind).toBe("stop");
    expect(stopped.notifications[0]?.text).not.toContain("Recovery alert");
  });
});
