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
      sessions: {
        left: { name: init.leftName, pid: null, status: "starting" },
        right: { name: init.rightName, pid: null, status: "starting" },
      },
    };
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
    await this.flush();
  }

  async sessionExited(side: "left" | "right"): Promise<void> {
    this.status.sessions[side] = {
      ...this.status.sessions[side],
      status: "exited",
    };
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
    await this.flush();
  }

  async forwarded(event: { from: string; to: string; round: number; text: string }): Promise<void> {
    this.status.round = event.round;
    this.status.lastForward = {
      from: event.from,
      to: event.to,
      round: event.round,
      preview: preview(event.text),
      at: new Date().toISOString(),
    };
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
