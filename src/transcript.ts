import fs from "node:fs";
import path from "node:path";
import type { SessionEvent } from "./pty-session.js";

// ---------------------------------------------------------------------------
// Transcript — appends session events to a JSONL file
// ---------------------------------------------------------------------------

export class Transcript {
  private stream: fs.WriteStream;
  readonly filePath: string;

  constructor(logDir: string, sessionId: string) {
    fs.mkdirSync(logDir, { recursive: true });
    this.filePath = path.join(logDir, `${sessionId}.jsonl`);
    this.stream = fs.createWriteStream(this.filePath, { flags: "a" });
  }

  /** Append a session event as one JSONL line. */
  write(event: SessionEvent): void {
    const line = JSON.stringify(event);
    this.stream.write(line + "\n");
  }

  /** Flush and close the file. Resolves when all data is flushed to disk. */
  close(): Promise<void> {
    return new Promise((resolve) => {
      this.stream.end(() => resolve());
    });
  }
}

/**
 * Convenience: wire a Transcript to a PtySession so all events auto-log.
 * Returns the Transcript instance and an unsubscribe function.
 */
export function attachTranscript(
  session: { id: string; onEvent: (h: (e: SessionEvent) => void) => () => void },
  logDir = "./logs",
): { transcript: Transcript; detach: () => void } {
  const transcript = new Transcript(logDir, session.id);
  const detach = session.onEvent((event) => transcript.write(event));
  return { transcript, detach };
}
