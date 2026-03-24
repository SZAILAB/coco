import { execSync } from "node:child_process";
import { spawn } from "node:child_process";
import path from "node:path";
import { readLatestRunStatus, type RunStatus } from "./run-status.js";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export type ControlConfig = {
  /** Working directory for the broker process. */
  cwd: string;
  /** Root directory for broker state (status.json, turn files, etc.). */
  brokerRoot: string;
};

export function defaultControlConfig(): ControlConfig {
  const cwd = process.env.COCO_CWD ?? process.cwd();
  return {
    cwd,
    brokerRoot: path.resolve(cwd, process.env.COCO_BROKER_STATE_DIR ?? "state/broker"),
  };
}

// ---------------------------------------------------------------------------
// startBroker — launch a broker run in the background
// ---------------------------------------------------------------------------

export type StartResult = {
  pid: number;
  runId: string | null;
};

export async function startBroker(task: string, cfg?: ControlConfig): Promise<StartResult> {
  const { cwd, brokerRoot } = cfg ?? defaultControlConfig();

  // Check for an already-active run
  const existing = await readStatus(undefined, cfg);
  if (existing && existing.phase !== "stopped") {
    const alive = isPidAlive(existing.pid);
    if (alive) {
      throw new Error(`A broker is already running (pid=${existing.pid}, run=${existing.runId})`);
    }
  }

  // Launch run-broker.ts as a detached child
  let child;
  const spawnState = { error: null as string | null };

  try {
    child = spawn(
      "npx",
      ["tsx", path.resolve(import.meta.dirname ?? ".", "run-broker.ts"), task],
      {
        cwd,
        stdio: "ignore",
        detached: true,
        env: {
          ...process.env,
          COCO_CWD: cwd,
          COCO_BROKER_STATE_DIR: brokerRoot,
        },
      },
    );
  } catch (err) {
    throw new Error(`Failed to spawn broker: ${err}`);
  }

  // Capture async spawn errors (e.g. ENOENT) into a flag — no dangling promise
  child.on("error", (err) => {
    spawnState.error = err.message;
  });
  child.unref();

  const pid = child.pid ?? -1;

  // Wait briefly for status.json to appear so we can read runId
  let runId: string | null = null;
  for (let i = 0; i < 20; i++) {
    await sleep(250);
    if (spawnState.error) {
      throw new Error(`Broker spawn failed: ${spawnState.error}`);
    }
    if (pid > 0) {
      const status = await readLatestRunStatus(brokerRoot);
      if (status && status.pid === pid) {
        runId = status.runId;
        break;
      }
    }
  }

  if (spawnState.error) {
    throw new Error(`Broker spawn failed: ${spawnState.error}`);
  }

  if (pid < 0) {
    throw new Error("Failed to spawn broker: no pid assigned");
  }

  return { pid, runId };
}

// ---------------------------------------------------------------------------
// readStatus — read the current or specified run's status
// ---------------------------------------------------------------------------

export async function readStatus(
  runId?: string,
  cfg?: ControlConfig,
): Promise<RunStatus | null> {
  const { brokerRoot } = cfg ?? defaultControlConfig();
  return readLatestRunStatus(brokerRoot, runId);
}

// ---------------------------------------------------------------------------
// stopBroker — send SIGTERM to the broker, wait for exit, fallback to SIGKILL
// ---------------------------------------------------------------------------

export type StopResult = {
  found: boolean;
  pid: number;
  signal: "SIGTERM" | "SIGKILL";
  wasAlive: boolean;
};

export async function stopBroker(runId?: string, cfg?: ControlConfig): Promise<StopResult> {
  const status = await readStatus(runId, cfg);
  if (!status) {
    throw new Error("No broker run found");
  }

  const pid = status.pid;
  const alive = isPidAlive(pid);
  if (!alive) {
    return { found: true, pid, signal: "SIGTERM", wasAlive: false };
  }

  // Verify this pid is actually a broker process, not a recycled unrelated pid
  if (!isBrokerProcess(pid)) {
    return { found: true, pid, signal: "SIGTERM", wasAlive: false };
  }

  // Try SIGTERM first
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    return { found: true, pid, signal: "SIGTERM", wasAlive: false };
  }

  // Wait up to 10s for graceful exit
  for (let i = 0; i < 40; i++) {
    await sleep(250);
    if (!isPidAlive(pid)) {
      return { found: true, pid, signal: "SIGTERM", wasAlive: true };
    }
  }

  // Fallback to SIGKILL
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    // already dead
  }

  return { found: true, pid, signal: "SIGKILL", wasAlive: true };
}

// ---------------------------------------------------------------------------
// lastTurn — quick summary of the latest run's last forward
// ---------------------------------------------------------------------------

export type LastTurnSummary = {
  runId: string;
  phase: string;
  round: number;
  lastForward: RunStatus["lastForward"];
  progressSummary: RunStatus["progressSummary"];
  stopReason: string | null;
  stopBy: string | null;
};

export async function lastTurn(runId?: string, cfg?: ControlConfig): Promise<LastTurnSummary | null> {
  const status = await readStatus(runId, cfg);
  if (!status) return null;

  return {
    runId: status.runId,
    phase: status.phase,
    round: status.round,
    lastForward: status.lastForward,
    progressSummary: status.progressSummary,
    stopReason: status.stopReason,
    stopBy: status.stopBy,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Check if a pid belongs to a broker process by inspecting its command line. */
function isBrokerProcess(pid: number): boolean {
  try {
    const cmd = execSync(`ps -p ${pid} -o command=`, { encoding: "utf8", timeout: 3000 }).trim();
    return cmd.includes("run-broker");
  } catch {
    return false;
  }
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function sleep(ms: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, ms));
}
