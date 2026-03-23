import crypto from "node:crypto";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type AgentSpec = {
  /** Display name, e.g. "codex" or "claude" */
  name: string;
  /** Binary to run, e.g. "codex" */
  command: string;
  /** Arguments, e.g. ["--full-auto"] */
  args?: string[];
  /** Working directory */
  cwd?: string;
};

export type SessionStatus = "idle" | "starting" | "running" | "stopped" | "crashed";

export type SessionEvent =
  | { type: "output"; data: string; ts: number }
  | { type: "input"; data: string; ts: number }
  | { type: "exit"; exitCode: number | null; signal: number | null; ts: number }
  | { type: "start"; pid: number; ts: number }
  | { type: "error"; message: string; ts: number };

export type SessionEventHandler = (event: SessionEvent) => void;

// ---------------------------------------------------------------------------
// PtySession — wraps a single interactive agent process
// ---------------------------------------------------------------------------

export class PtySession {
  readonly id: string;
  readonly spec: AgentSpec;

  private pty: PtyHandle | null = null;
  private _generation = 0; // increments on each start, guards stale onExit
  private _status: SessionStatus = "idle";
  private _pid: number | null = null;
  private _startedAt: number | null = null;
  private _lastOutputAt: number | null = null;
  private _exitCode: number | null = null;
  private _exitResolve: (() => void) | null = null;
  private _restartCount = 0;
  private listeners: SessionEventHandler[] = [];
  private logBuffer: string[] = [];
  private static readonly MAX_LOG_LINES = 2000;

  constructor(spec: AgentSpec, id?: string) {
    this.spec = spec;
    this.id = id ?? crypto.randomUUID().slice(0, 8);
  }

  // -- public API -----------------------------------------------------------

  get status(): SessionStatus {
    return this._status;
  }

  get pid(): number | null {
    return this._pid;
  }

  get startedAt(): number | null {
    return this._startedAt;
  }

  get lastOutputAt(): number | null {
    return this._lastOutputAt;
  }

  get restartCount(): number {
    return this._restartCount;
  }

  /** Subscribe to session lifecycle + I/O events. */
  onEvent(handler: SessionEventHandler): () => void {
    this.listeners.push(handler);
    return () => {
      this.listeners = this.listeners.filter((h) => h !== handler);
    };
  }

  /** Start the agent process. */
  async start(): Promise<void> {
    if (this._status === "running" || this._status === "starting") return;
    this._status = "starting";

    let ptyMod: PtyModule;
    try {
      ptyMod = await importNodePty();
    } catch (err) {
      this._status = "crashed";
      this.emit({ type: "error", message: `Failed to load node-pty: ${err}`, ts: Date.now() });
      throw err;
    }

    const gen = ++this._generation;
    let pty: PtyHandle;
    try {
      pty = ptyMod.spawn(this.spec.command, this.spec.args ?? [], {
        name: process.env.TERM ?? "xterm-256color",
        cols: 120,
        rows: 30,
        cwd: this.spec.cwd ?? process.cwd(),
        env: process.env as Record<string, string>,
      });
    } catch (err) {
      this._status = "crashed";
      this.emit({ type: "error", message: `Failed to spawn ${this.spec.command}: ${err}`, ts: Date.now() });
      throw err;
    }

    this.pty = pty;
    this._pid = pty.pid;
    this._startedAt = Date.now();
    this._lastOutputAt = Date.now();
    this._status = "running";
    this._exitResolve = null;

    this.emit({ type: "start", pid: pty.pid, ts: Date.now() });

    pty.onData((data: string) => {
      if (this._generation !== gen) return;
      this._lastOutputAt = Date.now();
      this.appendLog(data);
      this.emit({ type: "output", data, ts: Date.now() });
    });

    pty.onExit((e: { exitCode: number; signal?: number }) => {
      if (this._generation !== gen) return;
      this._exitCode = e.exitCode;
      const crashed = e.exitCode !== 0;
      this._status = crashed ? "crashed" : "stopped";
      this.emit({ type: "exit", exitCode: e.exitCode, signal: e.signal ?? null, ts: Date.now() });
      this.pty = null;
      this._pid = null;
      // Resolve anyone waiting in stop()
      this._exitResolve?.();
      this._exitResolve = null;
    });
  }

  /** Write data to the agent's stdin. */
  write(data: string): void {
    if (!this.pty) throw new Error(`Session ${this.id} is not running`);
    this.pty.write(data);
    this.emit({ type: "input", data, ts: Date.now() });
  }

  /** Send data + Enter key. */
  send(text: string): void {
    this.write(text + "\r");
  }

  /** Read the last N lines of captured output. */
  read(tail = 50): string[] {
    if (tail >= this.logBuffer.length) return [...this.logBuffer];
    return this.logBuffer.slice(-tail);
  }

  /** Stop the process. Waits for the PTY to actually exit so onExit fires before returning. */
  async stop(): Promise<void> {
    if (!this.pty) return;
    let timedOut = false;
    const exitPromise = new Promise<void>((resolve) => {
      this._exitResolve = resolve;
      setTimeout(() => {
        timedOut = true;
        resolve();
      }, 5000);
    });
    try {
      this.pty.kill();
    } catch {
      // ignore
    }
    await exitPromise;
    // If onExit never fired, clean up manually so restart() can proceed
    if (timedOut && this.pty) {
      this.emit({ type: "error", message: `PTY exit timeout — force cleanup`, ts: Date.now() });
      this.pty = null;
      this._pid = null;
      this._status = "crashed";
    }
  }

  /** Restart (increments restart counter). */
  async restart(): Promise<void> {
    await this.stop();
    this._restartCount++;
    await this.start();
  }

  // -- internals ------------------------------------------------------------

  private emit(event: SessionEvent) {
    for (const handler of this.listeners) {
      try {
        handler(event);
      } catch {
        // don't let a bad listener break the session
      }
    }
  }

  private appendLog(data: string) {
    // Split on newlines, merge partial last line
    const parts = data.split("\n");
    for (const part of parts) {
      if (part.length > 0) {
        this.logBuffer.push(part);
      }
    }
    // Trim buffer to cap
    if (this.logBuffer.length > PtySession.MAX_LOG_LINES) {
      this.logBuffer = this.logBuffer.slice(-PtySession.MAX_LOG_LINES);
    }
  }
}

// ---------------------------------------------------------------------------
// node-pty dynamic import (keeps it lazy like OpenClaw does)
// ---------------------------------------------------------------------------

type PtyExitEvent = { exitCode: number; signal?: number };
type PtyHandle = {
  pid: number;
  write(data: string): void;
  kill(signal?: string): void;
  onData(listener: (data: string) => void): void;
  onExit(listener: (event: PtyExitEvent) => void): void;
};
type PtyModule = {
  spawn(
    file: string,
    args: string[],
    options: {
      name?: string;
      cols?: number;
      rows?: number;
      cwd?: string;
      env?: Record<string, string>;
    },
  ): PtyHandle;
};

let cachedPty: PtyModule | null = null;

async function importNodePty(): Promise<PtyModule> {
  if (cachedPty) return cachedPty;
  const mod = (await import("node-pty")) as unknown as { default?: PtyModule } & PtyModule;
  cachedPty = mod.default ?? mod;
  return cachedPty;
}
