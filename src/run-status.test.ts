import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { RunStatusWriter, readLatestRunStatus } from "./run-status.js";

const tempDirs: string[] = [];

async function makePaths(runId = "run-123") {
  const brokerRoot = await mkdtemp(path.join(os.tmpdir(), "coco-status-"));
  const turnDir = path.join(brokerRoot, runId);
  tempDirs.push(brokerRoot);
  return {
    brokerRoot,
    turnDir,
    pidFile: path.join(turnDir, "broker.pid"),
    statusFile: path.join(turnDir, "status.json"),
    latestFile: path.join(brokerRoot, "latest-run.json"),
  };
}

describe("RunStatusWriter", () => {
  afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it("writes a progress summary with waiting state and recent turns", async () => {
    const paths = await makePaths();
    const writer = new RunStatusWriter(paths, {
      runId: "run-123",
      task: "Decide on retry policy",
      cwd: "/tmp/coco",
      leftName: "codex",
      rightName: "claude",
    });

    await writer.init();
    await writer.sessionStarted("left", 101);
    await writer.sessionStarted("right", 102);
    await writer.forwarded({
      from: "codex",
      to: "claude",
      round: 1,
      text: "Use capped exponential backoff with jitter and a maximum retry budget.",
    });
    await writer.waitingForTurn({
      agent: "claude",
      round: 1,
      turn: 1,
      outputPath: "/tmp/coco/claude/turn-001.md",
      donePath: "/tmp/coco/claude/turn-001.done",
      resent: false,
    });

    const status = await readLatestRunStatus(paths.brokerRoot, "run-123");
    expect(status?.progressSummary?.text).toContain("Waiting for claude turn 1");
    expect(status?.progressSummary?.text).toContain("Recent progress:");
    expect(status?.progressSummary?.text).toContain("Round 1 codex -> claude");
    expect(status?.recentTurns).toHaveLength(1);
    expect(status?.heartbeat.count).toBe(0);
  });

  it("keeps only the last three turns in the summary and marks stopped runs", async () => {
    const paths = await makePaths("run-456");
    const writer = new RunStatusWriter(paths, {
      runId: "run-456",
      task: "Reach agreement",
      cwd: "/tmp/coco",
      leftName: "codex",
      rightName: "claude",
    });

    await writer.init();
    await writer.forwarded({ from: "codex", to: "claude", round: 1, text: "First proposal." });
    await writer.forwarded({ from: "claude", to: "codex", round: 2, text: "First review." });
    await writer.forwarded({ from: "codex", to: "claude", round: 3, text: "Revised proposal." });
    await writer.forwarded({ from: "claude", to: "codex", round: 4, text: "AGREED" });
    await writer.stopped({ reason: "keyword", by: "claude", text: "AGREED" });

    const status = await readLatestRunStatus(paths.brokerRoot, "run-456");
    expect(status?.recentTurns).toHaveLength(3);
    expect(status?.recentTurns[0]?.round).toBe(2);
    expect(status?.progressSummary?.text).toContain("Stopped (keyword) by claude.");
    expect(status?.progressSummary?.text).toContain("Final: AGREED");
    expect(status?.progressSummary?.text).not.toContain("Round 1 codex -> claude");
  });

  it("records periodic heartbeats without losing current progress context", async () => {
    const paths = await makePaths("run-789");
    const writer = new RunStatusWriter(paths, {
      runId: "run-789",
      task: "Wait for reviewer",
      cwd: "/tmp/coco",
      leftName: "codex",
      rightName: "claude",
    });

    await writer.init();
    await writer.forwarded({
      from: "codex",
      to: "claude",
      round: 2,
      text: "Updated proposal with capped retries.",
    });
    await writer.waitingForTurn({
      agent: "claude",
      round: 2,
      turn: 2,
      outputPath: "/tmp/coco/claude/turn-002.md",
      donePath: "/tmp/coco/claude/turn-002.done",
      resent: true,
    });
    await writer.heartbeat(60_000);

    const status = await readLatestRunStatus(paths.brokerRoot, "run-789");
    expect(status?.heartbeat.count).toBe(1);
    expect(status?.heartbeat.intervalMs).toBe(60_000);
    expect(status?.heartbeat.lastAt).toBeTruthy();
    expect(status?.heartbeat.lastText).toContain("Still waiting for claude turn 2");
    expect(status?.heartbeat.lastText).toContain("Latest forward: round 2 codex -> claude");
    expect(status?.progressSummary?.text).toContain("Waiting for claude turn 2");
  });
});
