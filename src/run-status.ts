import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

export type RunPhase = "starting" | "waiting-turn" | "stopped";

export type WaitingFor = {
  agent: string;
  turn: number;
  round: number;
  outputPath: string;
  donePath: string;
  resentCount: number;
};

export type LastForward = {
  from: string;
  to: string;
  round: number;
  preview: string;
  at: string;
};

export type ProgressSummary = {
  text: string;
  updatedAt: string;
};

export type HeartbeatSnapshot = {
  intervalMs: number;
  count: number;
  lastAt: string | null;
  lastText: string | null;
};

export type SessionSnapshot = {
  name: string;
  pid: number | null;
  status: "starting" | "running" | "exited";
};

export type RunStatus = {
  runId: string;
  task: string;
  cwd: string;
  pid: number;
  pidFile: string;
  turnDir: string;
  statusFile: string;
  phase: RunPhase;
  round: number;
  startedAt: string;
  updatedAt: string;
  stoppedAt: string | null;
  stopReason: string | null;
  stopBy: string | null;
  stopTextPreview: string | null;
  waitingFor: WaitingFor | null;
  lastForward: LastForward | null;
  recentTurns: LastForward[];
  progressSummary: ProgressSummary | null;
  heartbeat: HeartbeatSnapshot;
  sessions: {
    left: SessionSnapshot;
    right: SessionSnapshot;
  };
};

type LatestRunPointer = {
  runId: string;
  statusFile: string;
  turnDir: string;
  pidFile: string;
  updatedAt: string;
};

type RunStatusPaths = {
  brokerRoot: string;
  turnDir: string;
  statusFile: string;
  latestFile: string;
  pidFile: string;
};

export class RunStatusWriter {
  private readonly paths: RunStatusPaths;
  private status: RunStatus;
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(
    paths: RunStatusPaths,
    init: {
      runId: string;
      task: string;
      cwd: string;
      leftName: string;
      rightName: string;
    },
  ) {
    const now = new Date().toISOString();
    this.paths = paths;
    this.status = {
      runId: init.runId,
      task: init.task,
      cwd: init.cwd,
      pid: process.pid,
      pidFile: paths.pidFile,
      turnDir: paths.turnDir,
      statusFile: paths.statusFile,
      phase: "starting",
      round: 0,
      startedAt: now,
      updatedAt: now,
      stoppedAt: null,
      stopReason: null,
      stopBy: null,
      stopTextPreview: null,
      waitingFor: null,
      lastForward: null,
      recentTurns: [],
      progressSummary: null,
      heartbeat: {
        intervalMs: 0,
        count: 0,
        lastAt: null,
        lastText: null,
      },
      sessions: {
        left: { name: init.leftName, pid: null, status: "starting" },
        right: { name: init.rightName, pid: null, status: "starting" },
      },
    };
    this.refreshSummary(now);
  }

  async init(): Promise<void> {
    await mkdir(this.paths.brokerRoot, { recursive: true });
    await mkdir(this.paths.turnDir, { recursive: true });
    await writeFile(this.paths.pidFile, `${process.pid}\n`, "utf8");
    await this.flush();
  }

  async sessionStarted(side: "left" | "right", pid: number): Promise<void> {
    this.status.sessions[side] = {
      ...this.status.sessions[side],
      pid,
      status: "running",
    };
    this.refreshSummary();
    await this.flush();
  }

  async sessionExited(side: "left" | "right"): Promise<void> {
    this.status.sessions[side] = {
      ...this.status.sessions[side],
      status: "exited",
    };
    this.refreshSummary();
    await this.flush();
  }

  async waitingForTurn(event: {
    agent: string;
    round: number;
    turn: number;
    outputPath: string;
    donePath: string;
    resent: boolean;
  }): Promise<void> {
    const previous = this.status.waitingFor;
    const resentCount =
      event.resent && previous?.agent === event.agent && previous.turn === event.turn
        ? previous.resentCount + 1
        : 0;
    this.status.phase = "waiting-turn";
    this.status.round = event.round;
    this.status.waitingFor = {
      agent: event.agent,
      round: event.round,
      turn: event.turn,
      outputPath: event.outputPath,
      donePath: event.donePath,
      resentCount,
    };
    this.refreshSummary();
    await this.flush();
  }

  async forwarded(event: { from: string; to: string; round: number; text: string }): Promise<void> {
    const forward: LastForward = {
      from: event.from,
      to: event.to,
      round: event.round,
      preview: preview(event.text),
      at: new Date().toISOString(),
    };
    this.status.round = event.round;
    this.status.lastForward = forward;
    this.status.recentTurns = [...this.status.recentTurns, forward].slice(-3);
    this.refreshSummary(forward.at);
    await this.flush();
  }

  async heartbeat(intervalMs: number): Promise<void> {
    if (this.status.phase === "stopped") return;

    const now = new Date().toISOString();
    this.status.heartbeat = {
      intervalMs,
      count: this.status.heartbeat.count + 1,
      lastAt: now,
      lastText: buildHeartbeatText(this.status),
    };
    this.refreshSummary(now);
    await this.flush();
  }

  async stopped(event: { reason: string; by: string; text: string }): Promise<void> {
    const now = new Date().toISOString();
    this.status.phase = "stopped";
    this.status.stoppedAt = now;
    this.status.stopReason = event.reason;
    this.status.stopBy = event.by;
    this.status.stopTextPreview = preview(event.text);
    this.status.waitingFor = null;
    this.refreshSummary(now);
    this.status.updatedAt = now;
    await this.writeStatus();
    await this.writeLatest();
  }

  async ensureStopped(event: { reason: string; by: string; text: string }): Promise<void> {
    if (this.status.phase === "stopped") return;
    await this.stopped(event);
  }

  get statusFile(): string {
    return this.paths.statusFile;
  }

  async drain(): Promise<void> {
    await this.writeQueue;
  }

  private async flush(): Promise<void> {
    this.writeQueue = this.writeQueue.then(async () => {
      this.status.updatedAt = new Date().toISOString();
      await this.writeStatus();
      await this.writeLatest();
    });
    await this.writeQueue;
  }

  private async writeStatus(): Promise<void> {
    await writeFile(this.paths.statusFile, `${JSON.stringify(this.status, null, 2)}\n`, "utf8");
  }

  private async writeLatest(): Promise<void> {
    const latest: LatestRunPointer = {
      runId: this.status.runId,
      statusFile: this.paths.statusFile,
      turnDir: this.paths.turnDir,
      pidFile: this.paths.pidFile,
      updatedAt: this.status.updatedAt,
    };
    await writeFile(this.paths.latestFile, `${JSON.stringify(latest, null, 2)}\n`, "utf8");
  }

  private refreshSummary(updatedAt = new Date().toISOString()): void {
    this.status.progressSummary = {
      text: buildProgressSummary(this.status),
      updatedAt,
    };
  }
}

export async function readLatestRunStatus(
  brokerRoot: string,
  explicitRunId?: string,
): Promise<RunStatus | null> {
  const statusFile = explicitRunId
    ? path.join(brokerRoot, explicitRunId, "status.json")
    : await resolveLatestStatusFile(brokerRoot);
  if (!statusFile) return null;

  try {
    const raw = await readFile(statusFile, "utf8");
    return JSON.parse(raw) as RunStatus;
  } catch {
    return null;
  }
}

async function resolveLatestStatusFile(brokerRoot: string): Promise<string | null> {
  const latestFile = path.join(brokerRoot, "latest-run.json");
  try {
    const raw = await readFile(latestFile, "utf8");
    const latest = JSON.parse(raw) as LatestRunPointer;
    return latest.statusFile;
  } catch {
    return null;
  }
}

function preview(text: string, max = 160): string {
  return text.replace(/\s+/g, " ").trim().slice(0, max);
}

function buildProgressSummary(status: RunStatus): string {
  const lines: string[] = [];

  if (status.phase === "stopped") {
    lines.push(`Stopped (${status.stopReason ?? "unknown"}) by ${status.stopBy ?? "unknown"}.`);
    if (status.stopTextPreview) {
      lines.push(`Final: ${status.stopTextPreview}`);
    }
  } else {
    const exited = status.sessions.left.status === "exited" ? status.sessions.left : status.sessions.right.status === "exited" ? status.sessions.right : null;
    if (exited) {
      lines.push(`Recovery: ${exited.name} exited; waiting for watchdog restart.`);
    } else if (status.phase === "starting") {
      lines.push("Starting broker run.");
    }

    if (status.waitingFor) {
      lines.push(
        `Waiting for ${status.waitingFor.agent} turn ${status.waitingFor.turn} (round ${status.waitingFor.round}, resends ${status.waitingFor.resentCount}).`,
      );
    }
  }

  if (status.recentTurns.length > 0) {
    lines.push("Recent progress:");
    for (const turn of status.recentTurns) {
      lines.push(`- Round ${turn.round} ${turn.from} -> ${turn.to}: ${turn.preview}`);
    }
  } else if (status.phase !== "stopped") {
    lines.push("No turns forwarded yet.");
  }

  return lines.join("\n");
}

function buildHeartbeatText(status: RunStatus): string {
  const lines: string[] = [];

  const exited =
    status.sessions.left.status === "exited"
      ? status.sessions.left
      : status.sessions.right.status === "exited"
        ? status.sessions.right
        : null;

  if (exited) {
    lines.push(`Still waiting for watchdog to recover ${exited.name}.`);
  } else if (status.waitingFor) {
    lines.push(
      `Still waiting for ${status.waitingFor.agent} turn ${status.waitingFor.turn} (round ${status.waitingFor.round}, resends ${status.waitingFor.resentCount}).`,
    );
  } else if (status.phase === "starting") {
    lines.push("Broker is still starting.");
  } else {
    lines.push("Broker is still running.");
  }

  if (status.lastForward) {
    lines.push(
      `Latest forward: round ${status.lastForward.round} ${status.lastForward.from} -> ${status.lastForward.to}: ${status.lastForward.preview}`,
    );
  } else {
    lines.push("No turns forwarded yet.");
  }

  return lines.join("\n");
}
