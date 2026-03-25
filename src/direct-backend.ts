import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";

export type DirectAgent = "codex" | "claude";
export type DirectBindingStatus = "ready" | "busy" | "error" | "exited";

export type DirectSendResult = {
  agent: DirectAgent;
  sessionId: string;
  text: string;
};

export interface DirectBinding {
  readonly agent: DirectAgent;
  sessionId(): string;
  status(): DirectBindingStatus;
  error(): string | null;
  send(prompt: string): Promise<DirectSendResult>;
  close(): Promise<void>;
}

export async function createDirectBinding(
  agent: DirectAgent,
  sessionId: string,
  cwd: string,
): Promise<DirectBinding> {
  if (agent === "codex") {
    return new CodexResumeBinding(sessionId, cwd);
  }
  return ClaudeResumeBinding.create(sessionId, cwd);
}

class CodexResumeBinding implements DirectBinding {
  readonly agent = "codex" as const;

  #sessionId: string;
  #cwd: string;
  #status: DirectBindingStatus = "ready";
  #error: string | null = null;

  constructor(sessionId: string, cwd: string) {
    this.#sessionId = sessionId;
    this.#cwd = cwd;
  }

  sessionId(): string {
    return this.#sessionId;
  }

  status(): DirectBindingStatus {
    return this.#status;
  }

  error(): string | null {
    return this.#error;
  }

  async send(prompt: string): Promise<DirectSendResult> {
    if (this.#status === "busy") {
      throw new Error("codex session is busy");
    }
    if (this.#status === "exited") {
      throw new Error("codex binding has been detached");
    }

    this.#status = "busy";
    this.#error = null;

    try {
      const result = await runCodexResumeTurn(this.#cwd, this.#sessionId, prompt);
      this.#sessionId = result.sessionId;
      this.#status = "ready";
      return result;
    } catch (err) {
      this.#status = "error";
      this.#error = String(err);
      throw err;
    }
  }

  async close(): Promise<void> {
    this.#status = "exited";
  }
}

class ClaudeResumeBinding implements DirectBinding {
  readonly agent = "claude" as const;

  #sessionId: string;
  #cwd: string;
  #child: ChildProcessWithoutNullStreams;
  #status: DirectBindingStatus = "ready";
  #error: string | null = null;
  #stderr = "";
  #closed = false;
  #pending:
    | {
        chunks: string[];
        resolve(result: DirectSendResult): void;
        reject(error: Error): void;
      }
    | null = null;

  static async create(sessionId: string, cwd: string): Promise<ClaudeResumeBinding> {
    const child = await spawnClaudeResumeProcess(sessionId, cwd);
    return new ClaudeResumeBinding(sessionId, cwd, child);
  }

  constructor(sessionId: string, cwd: string, child: ChildProcessWithoutNullStreams) {
    this.#sessionId = sessionId;
    this.#cwd = cwd;
    this.#child = child;

    const stdout = createInterface({ input: child.stdout });
    stdout.on("line", (line) => this.#handleStdoutLine(line));
    child.stderr.on("data", (chunk: Buffer | string) => {
      this.#stderr += chunk.toString();
    });
    child.on("exit", (code, signal) => {
      this.#closed = true;
      if (this.#status !== "exited") {
        this.#status = "exited";
      }
      if (this.#pending) {
        const message = this.#stderr.trim() || `claude exited (code=${code}, signal=${signal})`;
        this.#pending.reject(new Error(message));
        this.#pending = null;
      }
    });
    child.on("error", (err) => {
      this.#error = err.message;
      this.#status = "error";
      if (this.#pending) {
        this.#pending.reject(err);
        this.#pending = null;
      }
    });
  }

  sessionId(): string {
    return this.#sessionId;
  }

  status(): DirectBindingStatus {
    return this.#status;
  }

  error(): string | null {
    return this.#error;
  }

  async send(prompt: string): Promise<DirectSendResult> {
    if (this.#status === "busy") {
      throw new Error("claude session is busy");
    }
    if (this.#closed || this.#status === "exited") {
      throw new Error("claude session has exited");
    }

    this.#status = "busy";
    this.#error = null;

    return await new Promise<DirectSendResult>((resolve, reject) => {
      this.#pending = {
        chunks: [],
        resolve: (result) => {
          this.#status = "ready";
          resolve(result);
        },
        reject: (err) => {
          this.#status = "error";
          this.#error = err.message;
          reject(err);
        },
      };

      this.#writeJSON({
        type: "user",
        message: {
          role: "user",
          content: prompt,
        },
      }).catch((err) => {
        const pending = this.#pending;
        this.#pending = null;
        pending?.reject(err);
      });
    });
  }

  async close(): Promise<void> {
    if (this.#closed) {
      this.#status = "exited";
      return;
    }

    this.#status = "exited";
    this.#closed = true;
    this.#child.kill("SIGTERM");
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        this.#child.kill("SIGKILL");
        resolve();
      }, 2_000);
      this.#child.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  #handleStdoutLine(line: string): void {
    if (!line.trim()) return;

    let raw: Record<string, unknown>;
    try {
      raw = JSON.parse(line) as Record<string, unknown>;
    } catch {
      return;
    }

    const type = typeof raw.type === "string" ? raw.type : "";
    switch (type) {
      case "system":
        this.#handleSystem(raw);
        return;
      case "assistant":
        this.#handleAssistant(raw);
        return;
      case "result":
        this.#handleResult(raw);
        return;
      case "control_request":
        void this.#respondPermission(raw);
        return;
      default:
        return;
    }
  }

  #handleSystem(raw: Record<string, unknown>): void {
    const sessionId = typeof raw.session_id === "string" ? raw.session_id : "";
    if (sessionId) {
      this.#sessionId = sessionId;
    }
  }

  #handleAssistant(raw: Record<string, unknown>): void {
    if (!this.#pending) return;

    const message = asRecord(raw.message);
    const content = Array.isArray(message?.content) ? message.content : [];
    for (const item of content) {
      const contentItem = asRecord(item);
      if (!contentItem) continue;
      if (contentItem.type === "text" && typeof contentItem.text === "string" && contentItem.text) {
        this.#pending.chunks.push(contentItem.text);
      }
    }
  }

  #handleResult(raw: Record<string, unknown>): void {
    const pending = this.#pending;
    if (!pending) return;
    this.#pending = null;

    const sessionId = typeof raw.session_id === "string" ? raw.session_id : this.#sessionId;
    if (sessionId) {
      this.#sessionId = sessionId;
    }

    const content =
      (typeof raw.result === "string" && raw.result) || pending.chunks.join("\n\n").trim();
    pending.resolve({
      agent: this.agent,
      sessionId: this.#sessionId,
      text: content,
    });
  }

  async #respondPermission(raw: Record<string, unknown>): Promise<void> {
    const requestId = typeof raw.request_id === "string" ? raw.request_id : "";
    const request = asRecord(raw.request);
    const input = asRecord(request?.input) ?? {};
    if (!requestId) return;

    await this.#writeJSON({
      type: "control_response",
      response: {
        subtype: "success",
        request_id: requestId,
        response: {
          behavior: "allow",
          updatedInput: input,
        },
      },
    });
  }

  async #writeJSON(value: unknown): Promise<void> {
    if (this.#closed) {
      throw new Error("claude session has exited");
    }

    const payload = JSON.stringify(value) + "\n";
    await new Promise<void>((resolve, reject) => {
      this.#child.stdin.write(payload, (err) => {
        if (err) reject(err);
        else resolve();
      });
    });
  }
}

async function runCodexResumeTurn(
  cwd: string,
  sessionId: string,
  prompt: string,
): Promise<DirectSendResult> {
  return await new Promise<DirectSendResult>((resolve, reject) => {
    const child = spawn(
      "codex",
      [
        "exec",
        "resume",
        "--skip-git-repo-check",
        "--dangerously-bypass-approvals-and-sandbox",
        sessionId,
        "--json",
        prompt,
      ],
      {
        cwd,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );

    let stderr = "";
    let currentSessionId = sessionId;
    let done = false;
    let failure: string | null = null;
    const pendingTexts: string[] = [];

    const stdout = createInterface({ input: child.stdout });
    stdout.on("line", (line) => {
      if (!line.trim()) return;
      let raw: Record<string, unknown>;
      try {
        raw = JSON.parse(line) as Record<string, unknown>;
      } catch {
        return;
      }

      const eventType = typeof raw.type === "string" ? raw.type : "";
      switch (eventType) {
        case "thread.started":
          if (typeof raw.thread_id === "string" && raw.thread_id) {
            currentSessionId = raw.thread_id;
          }
          break;
        case "item.completed": {
          const item = asRecord(raw.item);
          if (!item) break;
          const itemType = typeof item.type === "string" ? item.type : "";
          if (itemType === "agent_message" || itemType === "message") {
            const text = extractCodexItemText(item);
            if (text) pendingTexts.push(text);
          }
          break;
        }
        case "turn.completed":
          done = true;
          break;
        case "turn.failed":
          failure = extractCodexError(raw) ?? "turn failed";
          break;
        case "error":
          if (typeof raw.message === "string" && raw.message) {
            failure = raw.message;
          }
          break;
        default:
          break;
      }
    });

    child.stderr.on("data", (chunk: Buffer | string) => {
      stderr += chunk.toString();
    });
    child.on("error", (err) => reject(err));
    child.on("close", (code) => {
      if (failure) {
        reject(new Error(failure));
        return;
      }
      if (code !== 0 && stderr.trim()) {
        reject(new Error(stderr.trim()));
        return;
      }
      if (!done) {
        reject(new Error(stderr.trim() || `codex exited before turn completion (code=${code})`));
        return;
      }
      resolve({
        agent: "codex",
        sessionId: currentSessionId,
        text: pendingTexts.join("\n\n").trim(),
      });
    });
  });
}

async function spawnClaudeResumeProcess(
  sessionId: string,
  cwd: string,
): Promise<ChildProcessWithoutNullStreams> {
  return await new Promise<ChildProcessWithoutNullStreams>((resolve, reject) => {
    const child = spawn(
      "claude",
      [
        "--output-format",
        "stream-json",
        "--input-format",
        "stream-json",
        "--permission-prompt-tool",
        "stdio",
        "--permission-mode",
        "bypassPermissions",
        "--resume",
        sessionId,
      ],
      {
        cwd,
        stdio: ["pipe", "pipe", "pipe"],
        env: filterEnv(process.env, "CLAUDECODE"),
      },
    );

    child.once("spawn", () => resolve(child));
    child.once("error", reject);
  });
}

function extractCodexItemText(item: Record<string, unknown>): string {
  const content = Array.isArray(item.content) ? item.content : [];
  const parts: string[] = [];
  for (const entry of content) {
    const part = asRecord(entry);
    if (!part) continue;
    if (part.type === "output_text" && typeof part.text === "string" && part.text) {
      parts.push(part.text);
    }
  }
  if (parts.length > 0) {
    return parts.join("\n");
  }
  return typeof item.text === "string" ? item.text : "";
}

function extractCodexError(raw: Record<string, unknown>): string | null {
  const error = asRecord(raw.error);
  if (!error) return null;
  if (typeof error.message === "string" && error.message) {
    return error.message;
  }
  return null;
}

function filterEnv(
  env: NodeJS.ProcessEnv,
  ...keysToRemove: string[]
): NodeJS.ProcessEnv {
  const blocked = new Set(keysToRemove);
  const next: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(env)) {
    if (blocked.has(key)) continue;
    next[key] = value;
  }
  return next;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
}
