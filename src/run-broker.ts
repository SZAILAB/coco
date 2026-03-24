import crypto from "node:crypto";
import path from "node:path";

import { Broker } from "./broker.js";
import { PtySession, type AgentSpec } from "./pty-session.js";
import { RunStatusWriter } from "./run-status.js";
import { attachTranscript } from "./transcript.js";
import { Watchdog } from "./watchdog.js";

const STARTUP_BLOCKERS = [/Update available!/i, /Press enter to continue/i, /Continue anyway\?/i];

function parseArgsEnv(name: string, fallback: string[]): string[] {
  const value = process.env[name];
  if (!value) return fallback;
  return value
    .split(/\s+/)
    .map((part) => part.trim())
    .filter(Boolean);
}

function buildFileProtocol(outputPath: string, donePath: string): string {
  return [
    "File protocol:",
    `- Write your final reply body to: ${outputPath}`,
    `- When the file is complete, create this done marker: ${donePath}`,
    "- Overwrite the output file completely for this turn.",
    "- Do not print the full reply in the terminal. Use the terminal only for tool progress if needed.",
  ].join("\n");
}

function buildWriterPrompt(task: string, outputPath: string, donePath: string): string {
  return [
    "You are the writer agent in a two-agent coding discussion.",
    "Propose a concrete answer or implementation approach for the task below.",
    "Be concise and technical.",
    "Do not try to end the discussion on your first reply.",
    "When both sides agree, write exactly AGREED on its own line.",
    "If you cannot continue, write exactly BLOCKED on its own line.",
    `Task: ${task}`,
    buildFileProtocol(outputPath, donePath),
  ].join("\n\n");
}

function buildReviewerPrompt(task: string, proposal: string, outputPath: string, donePath: string): string {
  return [
    "You are the reviewer agent in a two-agent coding discussion.",
    "Critique the other agent's proposal, call out risks, and ask for fixes or clarifications.",
    "Be concise and technical.",
    "If the proposal is already good enough and no changes are needed, write exactly AGREED on its own line.",
    "If it is not good enough, say exactly what must change.",
    `Task: ${task}`,
    "Writer proposal:",
    proposal,
    buildFileProtocol(outputPath, donePath),
  ].join("\n\n");
}

function buildWriterFollowup(feedbackFrom: string, feedback: string, outputPath: string, donePath: string): string {
  return [
    `Reviewer feedback from ${feedbackFrom}:`,
    feedback,
    "Revise or defend your proposal based on this feedback.",
    "If the discussion has converged, write exactly AGREED on its own line.",
    "If you cannot continue, write exactly BLOCKED on its own line.",
    buildFileProtocol(outputPath, donePath),
  ].join("\n\n");
}

function buildReviewerFollowup(writerFrom: string, update: string, outputPath: string, donePath: string): string {
  return [
    `Writer update from ${writerFrom}:`,
    update,
    "Review the update. If it is now good enough, write exactly AGREED on its own line.",
    "Otherwise explain the remaining fixes concisely.",
    buildFileProtocol(outputPath, donePath),
  ].join("\n\n");
}

function looksReady(session: PtySession, output: string): boolean {
  const name = session.spec.name.toLowerCase();
  if (name.includes("codex")) {
    return /Use \/skills/i.test(output) || /\b\d+%\s+left\b/i.test(output) || /\bgpt-[\w.-]+/i.test(output);
  }
  if (name.includes("claude")) {
    return /bypass permissions on/i.test(output) || /\/effort/i.test(output) || /esc to interrupt/i.test(output) || /❯/.test(output);
  }
  return output.trim().length > 0;
}

async function waitForReady(session: PtySession, timeoutMs = 15_000): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    let buffer = "";
    const timer = setTimeout(() => {
      unsubscribe();
      reject(new Error(`${session.spec.name} did not become ready within ${timeoutMs}ms`));
    }, timeoutMs);
    timer.unref?.();

    const unsubscribe = session.onEvent((event) => {
      if (event.type === "start") {
        buffer = "";
        return;
      }
      if (event.type !== "output") return;

      buffer = (buffer + event.data).slice(-32_000);
      if (STARTUP_BLOCKERS.some((pattern) => pattern.test(buffer))) {
        clearTimeout(timer);
        unsubscribe();
        reject(new Error(`${session.spec.name} requires manual startup input`));
        return;
      }
      if (!looksReady(session, buffer)) return;

      clearTimeout(timer);
      unsubscribe();
      resolve();
    });
  });
}

async function startSession(session: PtySession): Promise<void> {
  try {
    await session.start();
  } catch (err) {
    console.error(`[broker] Initial start failed for ${session.spec.name}:`, err);
  }
}

async function wait(ms: number): Promise<void> {
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

async function main() {
  const task = process.argv.slice(2).join(" ").trim() || "Discuss the task and converge on a final answer.";
  const cwd = process.env.COCO_CWD ?? process.cwd();
  const startupTimeoutMs = Number.parseInt(process.env.COCO_STARTUP_TIMEOUT_MS ?? "15000", 10) || 15_000;
  const turnTimeoutMs = Number.parseInt(process.env.COCO_TURN_TIMEOUT_MS ?? "300000", 10) || 300_000;
  const brokerRoot = path.resolve(cwd, process.env.COCO_BROKER_STATE_DIR ?? "state/broker");
  const runId = crypto.randomUUID().slice(0, 8);
  const turnDir = path.join(brokerRoot, runId);
  const pidFile = path.join(turnDir, "broker.pid");
  const statusFile = path.join(turnDir, "status.json");
  const latestFile = path.join(brokerRoot, "latest-run.json");

  const left: AgentSpec = {
    name: process.env.COCO_LEFT_NAME ?? "codex",
    command: process.env.COCO_LEFT_CMD ?? "codex",
    args: parseArgsEnv("COCO_LEFT_ARGS", ["--full-auto", "--no-alt-screen"]),
    cwd,
  };
  const right: AgentSpec = {
    name: process.env.COCO_RIGHT_NAME ?? "claude",
    command: process.env.COCO_RIGHT_CMD ?? "claude",
    args: parseArgsEnv("COCO_RIGHT_ARGS", ["--dangerously-skip-permissions"]),
    cwd,
  };

  console.log(`[broker] Left: ${left.name} -> ${left.command} ${(left.args ?? []).join(" ")}`);
  console.log(`[broker] Right: ${right.name} -> ${right.command} ${(right.args ?? []).join(" ")}`);
  console.log(`[broker] CWD: ${cwd}`);
  console.log(`[broker] Task: ${task}`);
  console.log(`[broker] Turn dir: ${turnDir}`);

  const status = new RunStatusWriter(
    { brokerRoot, turnDir, pidFile, statusFile, latestFile },
    {
      runId,
      task,
      cwd,
      leftName: left.name,
      rightName: right.name,
    },
  );
  await status.init();
  let statusQueue: Promise<void> = Promise.resolve();
  const queueStatus = (fn: () => Promise<void>) => {
    statusQueue = statusQueue.then(fn).catch((err) => {
      console.error("[broker] Status update failed:", err);
    });
    return statusQueue;
  };

  const leftSession = new PtySession(left);
  const rightSession = new PtySession(right);

  leftSession.onEvent((event) => {
    if (event.type === "start") {
      void queueStatus(() => status.sessionStarted("left", event.pid));
    } else if (event.type === "exit") {
      void queueStatus(() => status.sessionExited("left"));
    }
  });
  rightSession.onEvent((event) => {
    if (event.type === "start") {
      void queueStatus(() => status.sessionStarted("right", event.pid));
    } else if (event.type === "exit") {
      void queueStatus(() => status.sessionExited("right"));
    }
  });

  const leftTranscript = attachTranscript(leftSession, "./logs");
  const rightTranscript = attachTranscript(rightSession, "./logs");
  console.log(`[broker] Left transcript: ${leftTranscript.transcript.filePath}`);
  console.log(`[broker] Right transcript: ${rightTranscript.transcript.filePath}`);

  const leftWatchdog = new Watchdog(leftSession, {
    maxRestarts: 3,
    onAlert: (msg) => console.log(`[left] ${msg}`),
  });
  const rightWatchdog = new Watchdog(rightSession, {
    maxRestarts: 3,
    onAlert: (msg) => console.log(`[right] ${msg}`),
  });

  const broker = new Broker(leftSession, rightSession, {
    turnDir,
    turnTimeoutMs,
    buildInitialMessage: ({ outputPath, donePath }) => buildWriterPrompt(task, outputPath, donePath),
    onAwaitTurn: ({ by, round, turn, outputPath, donePath, resent }) => {
      void queueStatus(() =>
        status.waitingForTurn({
          agent: by,
          round,
          turn,
          outputPath,
          donePath,
          resent,
        }),
      );
    },
    renderMessage: (from, text, ctx) => {
      if (ctx.to === right.name) {
        if (ctx.round === 1) {
          return buildReviewerPrompt(task, text, ctx.outputPath, ctx.donePath);
        }
        return buildReviewerFollowup(from, text, ctx.outputPath, ctx.donePath);
      }
      return buildWriterFollowup(from, text, ctx.outputPath, ctx.donePath);
    },
    onForward: ({ from, to, round, text }) => {
      void queueStatus(() => status.forwarded({ from, to, round, text }));
      const preview = text.replace(/\s+/g, " ").slice(0, 120);
      console.log(`[broker] round ${round}: ${from} -> ${to}: ${preview}`);
    },
    onStop: ({ reason, by, round, text }) => {
      void queueStatus(() => status.stopped({ reason, by, text }));
      const preview = text.replace(/\s+/g, " ").slice(0, 120);
      console.log(`[broker] stopping (${reason}) after ${round} rounds, by ${by}: ${preview}`);
    },
  });

  let shuttingDown = false;
  let shutdownCode = 0;
  const shutdown = async (code = 0, reason?: "interrupted" | "fatal") => {
    if (shuttingDown) return;
    shuttingDown = true;
    shutdownCode = code;
    broker.stop();
    leftWatchdog.stop();
    rightWatchdog.stop();
    if (reason) {
      await queueStatus(() =>
        status.ensureStopped({
          reason,
          by: "system",
          text: reason === "interrupted" ? "broker interrupted by signal" : "broker stopped after fatal error",
        }),
      );
    }
    await statusQueue;
    await status.drain();
    await Promise.all([leftSession.stop(), rightSession.stop()]);
    // Session exit handlers can enqueue one last status write after stop().
    await statusQueue;
    await status.drain();
    leftTranscript.detach();
    rightTranscript.detach();
    await Promise.all([leftTranscript.transcript.close(), rightTranscript.transcript.close()]);
    process.exit(shutdownCode);
  };

  process.on("SIGINT", () => void shutdown(0, "interrupted"));
  process.on("SIGTERM", () => void shutdown(0, "interrupted"));

  leftWatchdog.start();
  rightWatchdog.start();

  await Promise.all([startSession(leftSession), startSession(rightSession)]);

  try {
    await Promise.all([waitForReady(leftSession, startupTimeoutMs), waitForReady(rightSession, startupTimeoutMs)]);
  } catch (err) {
    console.error("[broker] Startup failed:", err);
    await shutdown(1, "fatal");
    return;
  }

  await wait(500);

  try {
    await broker.start();
    await shutdown();
  } catch (err) {
    console.error("[broker] Fatal:", err);
    await shutdown(1, "fatal");
  }
}

main().catch((err) => {
  console.error("[broker] Fatal:", err);
  process.exit(1);
});
