import path from "node:path";

import { readLatestRunStatus } from "./run-status.js";

async function main() {
  const cwd = process.env.COCO_CWD ?? process.cwd();
  const brokerRoot = path.resolve(cwd, process.env.COCO_BROKER_STATE_DIR ?? "state/broker");
  const runId = process.argv[2]?.trim() || undefined;
  const status = await readLatestRunStatus(brokerRoot, runId);

  if (!status) {
    console.log("No broker run status found.");
    process.exit(1);
  }

  const pidState = isPidAlive(status.pid) ? "alive" : "dead";
  console.log(`Run: ${status.runId}`);
  console.log(`Phase: ${status.phase}`);
  console.log(`Round: ${status.round}`);
  console.log(`PID: ${status.pid} (${pidState})`);
  console.log(`Started: ${status.startedAt}`);
  console.log(`Updated: ${status.updatedAt}`);
  console.log(`Turn Dir: ${status.turnDir}`);

  if (status.waitingFor) {
    console.log(
      `Waiting: ${status.waitingFor.agent} turn ${status.waitingFor.turn} (round ${status.waitingFor.round}, resends ${status.waitingFor.resentCount})`,
    );
  }

  if (status.lastForward) {
    console.log(
      `Last Forward: ${status.lastForward.from} -> ${status.lastForward.to} (round ${status.lastForward.round})`,
    );
    console.log(`Preview: ${status.lastForward.preview}`);
  }

  if (status.stopReason) {
    console.log(`Stop: ${status.stopReason} by ${status.stopBy ?? "unknown"}`);
    if (status.stopTextPreview) {
      console.log(`Stop Preview: ${status.stopTextPreview}`);
    }
  }

  console.log(
    `Sessions: left=${status.sessions.left.status}:${status.sessions.left.pid ?? "none"} right=${status.sessions.right.status}:${status.sessions.right.pid ?? "none"}`,
  );
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

main().catch((err) => {
  console.error("[status] Fatal:", err);
  process.exit(1);
});
