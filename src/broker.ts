import { access, mkdir, readFile, rm } from "node:fs/promises";
import path from "node:path";

import type { SessionEvent } from "./pty-session.js";

export type BrokerSession = {
  id: string;
  spec?: { name?: string };
  onEvent(handler: (event: SessionEvent) => void): () => void;
  send?(text: string): void;
  write(data: string): void;
};

export type BrokerStopReason = "keyword" | "duplicate" | "max-rounds" | "timeout" | "session-exit";

export type TurnContext = {
  from: string;
  to: string;
  round: number;
  turn: number;
  outputPath: string;
  donePath: string;
};

export type InitialTurnContext = {
  to: string;
  turn: number;
  outputPath: string;
  donePath: string;
};

export type BrokerOptions = {
  turnDir: string;
  pollMs?: number;
  turnTimeoutMs?: number;
  maxRounds?: number;
  stopWords?: string[];
  buildInitialMessage?: (ctx: InitialTurnContext) => string;
  renderMessage?: (from: string, text: string, ctx: TurnContext) => string;
  onAwaitTurn?: (event: {
    by: string;
    round: number;
    turn: number;
    outputPath: string;
    donePath: string;
    resent: boolean;
  }) => void;
  onForward?: (event: { from: string; to: string; round: number; text: string }) => void;
  onStop?: (event: { reason: BrokerStopReason; by: string; round: number; text: string }) => void;
};

type SideState = {
  key: "left" | "right";
  name: string;
  dirName: string;
  session: BrokerSession;
  nextTurn: number;
};

type TurnRequest = {
  side: SideState;
  turn: number;
  outputPath: string;
  donePath: string;
  lastPrompt?: string;
};

type SessionStatus = "running" | "exited";

type SessionTracker = {
  side: SideState;
  status: SessionStatus;
  lastExitText: string;
};

const DEFAULT_STOP_WORDS = ["AGREED", "BLOCKED", "FINAL"];

export class Broker {
  private readonly left: SideState;
  private readonly right: SideState;
  private readonly opts: Required<BrokerOptions>;
  private readonly unsubscribes: Array<() => void> = [];
  private rounds = 0;
  private stopped = false;
  private lastSnippet = "";
  private trackers = new Map<string, SessionTracker>();
  private runPromise: Promise<void> | null = null;

  constructor(left: BrokerSession, right: BrokerSession, opts: BrokerOptions) {
    this.left = {
      key: "left",
      name: left.spec?.name ?? "left",
      dirName: safeName(left.spec?.name ?? "left", "left"),
      session: left,
      nextTurn: 1,
    };
    this.right = {
      key: "right",
      name: right.spec?.name ?? "right",
      dirName: safeName(right.spec?.name ?? "right", "right"),
      session: right,
      nextTurn: 1,
    };
    this.opts = {
      turnDir: opts.turnDir,
      pollMs: opts.pollMs ?? 250,
      turnTimeoutMs: opts.turnTimeoutMs ?? 300_000,
      maxRounds: opts.maxRounds ?? 8,
      stopWords: opts.stopWords ?? DEFAULT_STOP_WORDS,
      buildInitialMessage:
        opts.buildInitialMessage ??
        ((ctx) => defaultInitialMessage(this.left.name, ctx.outputPath, ctx.donePath)),
      renderMessage:
        opts.renderMessage ??
        ((from, text, ctx) =>
          defaultForwardMessage(from, text, ctx.outputPath, ctx.donePath)),
      onAwaitTurn: opts.onAwaitTurn ?? (() => {}),
      onForward: opts.onForward ?? (() => {}),
      onStop: opts.onStop ?? (() => {}),
    };
  }

  async start(): Promise<void> {
    if (this.runPromise) {
      return this.runPromise;
    }
    this.runPromise = this.runLoop();
    return this.runPromise;
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    for (const unsubscribe of this.unsubscribes.splice(0)) {
      unsubscribe();
    }
  }

  private async runLoop(): Promise<void> {
    await this.prepareTurnDirs();
    this.subscribeSessionEvents();

    const firstRequest = await this.allocateTurn(this.left);
    const initialMessage = this.opts.buildInitialMessage({
      to: this.left.name,
      turn: firstRequest.turn,
      outputPath: firstRequest.outputPath,
      donePath: firstRequest.donePath,
    });
    this.send(this.left.session, initialMessage);
    firstRequest.lastPrompt = initialMessage;
    this.opts.onAwaitTurn({
      by: this.left.name,
      round: 0,
      turn: firstRequest.turn,
      outputPath: firstRequest.outputPath,
      donePath: firstRequest.donePath,
      resent: false,
    });

    let request: TurnRequest | null = firstRequest;

    while (request && !this.stopped) {
      const text = await this.waitForTurn(request);
      if (this.stopped || text === null) return;

      const currentSnippet = snippet(text);
      if (this.containsStopWord(text)) {
        this.finish("keyword", request.side, text);
        return;
      }

      if (currentSnippet && currentSnippet === this.lastSnippet) {
        this.finish("duplicate", request.side, text);
        return;
      }

      if (this.rounds >= this.opts.maxRounds) {
        this.finish("max-rounds", request.side, text);
        return;
      }

      const target = this.otherSide(request.side);
      const nextRequest = await this.allocateTurn(target);
      this.lastSnippet = currentSnippet;
      this.rounds += 1;

      const message = this.opts.renderMessage(request.side.name, text, {
        from: request.side.name,
        to: target.name,
        round: this.rounds,
        turn: nextRequest.turn,
        outputPath: nextRequest.outputPath,
        donePath: nextRequest.donePath,
      });
      this.send(target.session, message);
      nextRequest.lastPrompt = message;
      this.opts.onAwaitTurn({
        by: target.name,
        round: this.rounds,
        turn: nextRequest.turn,
        outputPath: nextRequest.outputPath,
        donePath: nextRequest.donePath,
        resent: false,
      });
      this.opts.onForward({ from: request.side.name, to: target.name, round: this.rounds, text });

      request = nextRequest;
    }
  }

  private subscribeSessionEvents(): void {
    if (this.unsubscribes.length > 0) return;
    this.initTracker(this.left);
    this.initTracker(this.right);
    this.unsubscribes.push(this.left.session.onEvent((event) => this.handleSessionEvent(this.left, event)));
    this.unsubscribes.push(this.right.session.onEvent((event) => this.handleSessionEvent(this.right, event)));
  }

  private initTracker(side: SideState): void {
    this.trackers.set(side.key, { side, status: "running", lastExitText: "" });
  }

  private handleSessionEvent(side: SideState, event: SessionEvent): void {
    if (this.stopped) return;
    const tracker = this.trackers.get(side.key);
    if (!tracker) return;

    if (event.type === "exit") {
      const signal = event.signal === null ? "none" : `${event.signal}`;
      tracker.status = "exited";
      tracker.lastExitText = `session exited (code=${event.exitCode ?? "null"}, signal=${signal})`;
    } else if (event.type === "start") {
      // Watchdog restarted the session — mark it running again
      tracker.status = "running";
    } else if (event.type === "error") {
      tracker.lastExitText = event.message;
    }
  }

  private isSessionExited(side: SideState): boolean {
    return this.trackers.get(side.key)?.status === "exited";
  }

  private getExitText(side: SideState): string {
    return this.trackers.get(side.key)?.lastExitText ?? "unknown exit";
  }

  private async waitForTurn(request: TurnRequest): Promise<string | null> {
    const deadline = Date.now() + this.opts.turnTimeoutMs;
    let wasExited = false;

    while (!this.stopped) {
      const doneExists = await exists(request.donePath);
      if (doneExists) {
        const text = await readTurnText(request.outputPath);
        if (!text) {
          this.finish("timeout", request.side, `empty turn file: ${path.basename(request.outputPath)}`);
          return null;
        }
        return text;
      }

      if (this.isSessionExited(request.side)) {
        wasExited = true;
        // Don't immediately fatal — give watchdog time to restart
      } else if (wasExited) {
        // Session came back after watchdog restart — re-send the last prompt
        // so the new process knows what to do
        wasExited = false;
        if (request.lastPrompt) {
          this.send(request.side.session, request.lastPrompt);
          this.opts.onAwaitTurn({
            by: request.side.name,
            round: this.rounds,
            turn: request.turn,
            outputPath: request.outputPath,
            donePath: request.donePath,
            resent: true,
          });
        }
      }

      if (Date.now() >= deadline) {
        if (this.isSessionExited(request.side)) {
          this.finish("session-exit", request.side, this.getExitText(request.side));
        } else {
          this.finish("timeout", request.side, `timed out waiting for ${path.basename(request.donePath)}`);
        }
        return null;
      }

      await sleep(this.opts.pollMs);
    }

    return null;
  }

  private async prepareTurnDirs(): Promise<void> {
    await mkdir(this.opts.turnDir, { recursive: true });
    await Promise.all([
      mkdir(path.join(this.opts.turnDir, this.left.dirName), { recursive: true }),
      mkdir(path.join(this.opts.turnDir, this.right.dirName), { recursive: true }),
    ]);
  }

  private async allocateTurn(side: SideState): Promise<TurnRequest> {
    const turn = side.nextTurn++;
    const base = path.join(this.opts.turnDir, side.dirName, `turn-${String(turn).padStart(3, "0")}`);
    const outputPath = `${base}.md`;
    const donePath = `${base}.done`;
    await Promise.all([rm(outputPath, { force: true }), rm(donePath, { force: true })]);
    return { side, turn, outputPath, donePath };
  }

  private containsStopWord(text: string): boolean {
    return this.opts.stopWords.some((word) => {
      const upper = word.toUpperCase();
      const re = new RegExp(`\\b${upper}\\b`);
      return re.test(text);
    });
  }

  private otherSide(side: SideState): SideState {
    return side.key === "left" ? this.right : this.left;
  }

  private finish(reason: BrokerStopReason, side: SideState, text: string): void {
    if (this.stopped) return;
    this.opts.onStop({ reason, by: side.name, round: this.rounds, text });
    this.stop();
  }

  private send(session: BrokerSession, text: string): void {
    if (typeof session.send === "function") {
      session.send(text);
      return;
    }
    session.write(`${text}\r`);
  }
}

function defaultInitialMessage(name: string, outputPath: string, donePath: string): string {
  return [
    `You are ${name}.`,
    `Write your reply body to: ${outputPath}`,
    `When the file is complete, create: ${donePath}`,
    "Do not print the full reply in the terminal.",
  ].join("\n\n");
}

function defaultForwardMessage(from: string, text: string, outputPath: string, donePath: string): string {
  return [
    `Message from ${from}:`,
    text,
    `Write your reply body to: ${outputPath}`,
    `When the file is complete, create: ${donePath}`,
    "Do not print the full reply in the terminal.",
  ].join("\n\n");
}

function safeName(name: string, fallback: string): string {
  const sanitized = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return sanitized || fallback;
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function readTurnText(filePath: string): Promise<string> {
  try {
    const text = await readFile(filePath, "utf8");
    return text.replace(/\r\n?/g, "\n").trim();
  } catch {
    return "";
  }
}

async function sleep(ms: number): Promise<void> {
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

function snippet(text: string, max = 200): string {
  return text.replace(/\s+/g, " ").trim().slice(0, max).toLowerCase();
}
