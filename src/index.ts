import { PtySession, type AgentSpec } from "./pty-session.js";
import { attachTranscript } from "./transcript.js";
import { Watchdog } from "./watchdog.js";

// ---------------------------------------------------------------------------
// Config — change this to match your agent
// ---------------------------------------------------------------------------

const agent: AgentSpec = {
  name: "codex",
  command: process.argv[2] ?? "codex",
  args: process.argv[3] ? process.argv.slice(3) : ["--full-auto"],
  cwd: process.env.COCO_CWD ?? process.cwd(),
};

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.log(`[coco] Starting agent: ${agent.name}`);
  console.log(`[coco] Command: ${agent.command} ${(agent.args ?? []).join(" ")}`);
  console.log(`[coco] CWD: ${agent.cwd}`);

  const session = new PtySession(agent);

  // Attach transcript logging
  const { transcript, detach } = attachTranscript(session, "./logs");
  console.log(`[coco] Transcript: ${transcript.filePath}`);

  // Print output to terminal in real time
  session.onEvent((event) => {
    if (event.type === "output") {
      process.stdout.write(event.data);
    } else if (event.type === "exit") {
      console.log(`\n[coco] Process exited (code=${event.exitCode}, signal=${event.signal})`);
    } else if (event.type === "start") {
      console.log(`[coco] Process started (pid=${event.pid})`);
    }
  });

  // Start watchdog first — so it can rescue a failed initial start
  const watchdog = new Watchdog(session, {
    maxRestarts: 3,
    onAlert: (msg) => console.log(`\n${msg}`),
  });
  watchdog.start();

  // Launch — failure here won't kill coco; watchdog will retry
  try {
    await session.start();
  } catch (err) {
    console.error(`[coco] Initial start failed: ${err}`);
  }

  // Forward stdin to the agent
  process.stdin.setRawMode?.(true);
  process.stdin.resume();
  process.stdin.on("data", (chunk) => {
    try {
      // Ctrl+Q to quit coco itself
      if (chunk[0] === 0x11) {
        console.log("\n[coco] Ctrl+Q received, shutting down...");
        shutdown();
        return;
      }
      session.write(chunk.toString());
    } catch {
      // session may have stopped
    }
  });

  // Graceful shutdown (guard against double entry)
  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    watchdog.stop();
    await session.stop();
    detach();
    await transcript.close();
    process.stdin.setRawMode?.(false);
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  console.error("[coco] Fatal:", err);
  process.exit(1);
});
