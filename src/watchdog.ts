import type { PtySession } from "./pty-session.js";

// ---------------------------------------------------------------------------
// Watchdog — monitors a PtySession for no-output and auto-restarts
// ---------------------------------------------------------------------------

export type WatchdogOptions = {
  /** Max milliseconds without output before declaring "stuck". Default: disabled (0). */
  noOutputTimeoutMs?: number;
  /** Max restart attempts before giving up. Default: 3. */
  maxRestarts?: number;
  /** Polling interval in ms. Default: 10s. */
  checkIntervalMs?: number;
  /** Called when watchdog detects an issue. */
  onAlert?: (msg: string) => void;
};

export class Watchdog {
  private session: PtySession;
  private opts: Required<WatchdogOptions>;
  private timer: NodeJS.Timeout | null = null;
  private stopped = false;

  constructor(session: PtySession, opts: WatchdogOptions = {}) {
    this.session = session;
    this.opts = {
      noOutputTimeoutMs: opts.noOutputTimeoutMs ?? 0,
      maxRestarts: opts.maxRestarts ?? 3,
      checkIntervalMs: opts.checkIntervalMs ?? 10_000,
      onAlert: opts.onAlert ?? ((msg) => console.log(`[watchdog] ${msg}`)),
    };
  }

  /** Start periodic health checks. */
  start(): void {
    if (this.timer) return;
    this.stopped = false;
    this.timer = setInterval(() => {
      this.check().catch((err) => {
        this.opts.onAlert(`Session ${this.session.id} watchdog error: ${err}`);
      });
    }, this.opts.checkIntervalMs);
    this.timer.unref(); // don't keep the process alive just for watchdog
  }

  /** Stop monitoring. */
  stop(): void {
    this.stopped = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private async check(): Promise<void> {
    if (this.stopped) return;

    const status = this.session.status;

    // --- exited / crashed → try restart ---
    if (status === "crashed" || status === "stopped") {
      if (this.session.restartCount >= this.opts.maxRestarts) {
        this.opts.onAlert(
          `Session ${this.session.id} exhausted ${this.opts.maxRestarts} restarts — giving up`,
        );
        this.stop();
        return;
      }
      this.opts.onAlert(
        `Session ${this.session.id} exited (status=${status}), restarting (attempt ${this.session.restartCount + 1}/${this.opts.maxRestarts})`,
      );
      try {
        await this.session.restart();
      } catch (err) {
        this.opts.onAlert(`Session ${this.session.id} restart failed: ${err}`);
      }
      return;
    }

    // --- no-output timeout (disabled when 0) ---
    if (this.opts.noOutputTimeoutMs > 0 && status === "running" && this.session.lastOutputAt) {
      const silenceMs = Date.now() - this.session.lastOutputAt;
      if (silenceMs > this.opts.noOutputTimeoutMs) {
        this.opts.onAlert(
          `Session ${this.session.id} silent for ${Math.round(silenceMs / 1000)}s — restarting`,
        );
        if (this.session.restartCount >= this.opts.maxRestarts) {
          this.opts.onAlert(
            `Session ${this.session.id} exhausted ${this.opts.maxRestarts} restarts — giving up`,
          );
          this.stop();
          return;
        }
        try {
          await this.session.restart();
        } catch (err) {
          this.opts.onAlert(`Session ${this.session.id} restart failed: ${err}`);
        }
      }
    }
  }
}
