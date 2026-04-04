import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";

export type DirectAgent = "codex" | "claude";
export type DirectBindingStatus = "ready" | "busy" | "error" | "exited";
type SpawnProcess = typeof spawn;

export type DirectSendResult = {
  agent: DirectAgent;
  sessionId: string;
  text: string;
};

export interface DirectBinding {
  readonly agent: DirectAgent;
  sessionId(): string;
  cwd(): string;
  status(): DirectBindingStatus;
  error(): string | null;
  send(prompt: string): Promise<DirectSendResult>;
  close(): Promise<void>;
}

const DEFAULT_CODEX_RESUME_MAX_ATTEMPTS = 5;
const DEFAULT_CODEX_RESUME_RETRY_DELAY_MS = 3_000;
const directBackendRuntime: { spawn: SpawnProcess } = {
  spawn,
};

export const directBackendTesting = {
  setSpawn(spawnImpl: SpawnProcess): void {
    directBackendRuntime.spawn = spawnImpl;
  },
  reset(): void {
    directBackendRuntime.spawn = spawn;
  },
};

export async function createDirectBinding(
  agent: DirectAgent,
  sessionId: string,
  cwd: string,
): Promise<DirectBinding> {
  await assertSessionExists(agent, sessionId, cwd);
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

  cwd(): string {
    return this.#cwd;
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

  cwd(): string {
    return this.#cwd;
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
  let currentSessionId = sessionId;
  const maxAttempts = readPositiveIntEnv(
    process.env.COCO_CODEX_RESUME_MAX_ATTEMPTS,
    DEFAULT_CODEX_RESUME_MAX_ATTEMPTS,
  );
  const retryDelayMs = readPositiveIntEnv(
    process.env.COCO_CODEX_RESUME_RETRY_DELAY_MS,
    DEFAULT_CODEX_RESUME_RETRY_DELAY_MS,
  );

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await runCodexResumeTurnOnce(cwd, currentSessionId, prompt);
    } catch (err) {
      const normalized = toCodexResumeTurnError(err, currentSessionId);
      currentSessionId = normalized.sessionId;

      if (!normalized.retryable || attempt >= maxAttempts) {
        if (attempt === 1) {
          throw normalized;
        }
        throw new Error(`codex transport failed after ${attempt} attempts: ${normalized.message}`);
      }

      console.warn(
        `[codex] transient resume failure for ${currentSessionId} (attempt ${attempt}/${maxAttempts}), retrying in ${retryDelayMs}ms: ${normalized.message}`,
      );
      await delay(retryDelayMs);
    }
  }

  throw new Error("codex transport failed before any resume attempt completed");
}

async function runCodexResumeTurnOnce(
  cwd: string,
  sessionId: string,
  prompt: string,
): Promise<DirectSendResult> {
  return await new Promise<DirectSendResult>((resolve, reject) => {
    const child = directBackendRuntime.spawn(
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
    let turnFailure: string | null = null;
    let streamError: string | null = null;
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
          turnFailure = extractCodexError(raw) ?? "turn failed";
          break;
        case "error":
          if (typeof raw.message === "string" && raw.message) {
            streamError = raw.message;
          }
          break;
        default:
          break;
      }
    });

    child.stderr.on("data", (chunk: Buffer | string) => {
      stderr += chunk.toString();
    });
    child.on("error", (err) =>
      reject(
        new CodexResumeTurnError(err.message, {
          retryable: false,
          sessionId: currentSessionId,
          hasAssistantOutput: pendingTexts.length > 0,
        }),
      ),
    );
    child.on("close", (code) => {
      const hasAssistantOutput = pendingTexts.length > 0;
      if (turnFailure) {
        reject(
          new CodexResumeTurnError(turnFailure, {
            retryable: isRetryableCodexTransportError(turnFailure, hasAssistantOutput),
            sessionId: currentSessionId,
            hasAssistantOutput,
          }),
        );
        return;
      }
      if (done) {
        resolve({
          agent: "codex",
          sessionId: currentSessionId,
          text: pendingTexts.join("\n\n").trim(),
        });
        return;
      }
      if (code !== 0 && stderr.trim()) {
        const message = stderr.trim();
        reject(
          new CodexResumeTurnError(message, {
            retryable: isRetryableCodexTransportError(message, hasAssistantOutput),
            sessionId: currentSessionId,
            hasAssistantOutput,
          }),
        );
        return;
      }
      const message = streamError || stderr.trim() || `codex exited before turn completion (code=${code})`;
      reject(
        new CodexResumeTurnError(message, {
          retryable: isRetryableCodexTransportError(message, hasAssistantOutput),
          sessionId: currentSessionId,
          hasAssistantOutput,
        }),
      );
    });
  });
}

async function spawnClaudeResumeProcess(
  sessionId: string,
  cwd: string,
): Promise<ChildProcessWithoutNullStreams> {
  return await new Promise<ChildProcessWithoutNullStreams>((resolve, reject) => {
    const child = directBackendRuntime.spawn(
      "claude",
      [
        "--output-format",
        "stream-json",
        "--input-format",
        "stream-json",
        "--permission-prompt-tool",
        "stdio",
        "--verbose",
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

function isRetryableCodexTransportError(message: string, hasAssistantOutput: boolean): boolean {
  if (hasAssistantOutput) {
    return false;
  }

  return (
    /stream disconnected before completion/i.test(message) ||
    /peer closed connection without sending tls close_notify/i.test(message) ||
    /unexpected eof/i.test(message) ||
    (/reconnecting\.\.\./i.test(message) && /(io error|transport error|stream disconnected)/i.test(message))
  );
}

class CodexResumeTurnError extends Error {
  readonly retryable: boolean;
  readonly sessionId: string;
  readonly hasAssistantOutput: boolean;

  constructor(
    message: string,
    options: {
      retryable: boolean;
      sessionId: string;
      hasAssistantOutput: boolean;
    },
  ) {
    super(message);
    this.name = "CodexResumeTurnError";
    this.retryable = options.retryable;
    this.sessionId = options.sessionId;
    this.hasAssistantOutput = options.hasAssistantOutput;
  }
}

function toCodexResumeTurnError(err: unknown, sessionId: string): CodexResumeTurnError {
  if (err instanceof CodexResumeTurnError) {
    return err;
  }

  const message = err instanceof Error ? err.message : String(err);
  return new CodexResumeTurnError(message, {
    retryable: false,
    sessionId,
    hasAssistantOutput: false,
  });
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

function readPositiveIntEnv(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

async function delay(ms: number): Promise<void> {
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

async function assertSessionExists(
  agent: DirectAgent,
  sessionId: string,
  cwd: string,
): Promise<void> {
  if (agent === "claude") {
    if (!claudeSessionFileExists(cwd, sessionId)) {
      throw new Error(`No Claude session found for id ${sessionId} in ${cwd}`);
    }
    return;
  }

  if (!codexSessionFileExists(sessionId)) {
    throw new Error(`No Codex session transcript found for id ${sessionId}`);
  }
}

function claudeSessionFileExists(cwd: string, sessionId: string): boolean {
  const homeDir = os.homedir();
  const absCwd = path.resolve(cwd);
  const projectDir = path.join(
    homeDir,
    ".claude",
    "projects",
    absCwd.replaceAll("/", "-"),
  );
  return fs.existsSync(path.join(projectDir, `${sessionId}.jsonl`));
}

function codexSessionFileExists(sessionId: string): boolean {
  const codexHome = process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
  const sessionsDir = path.join(codexHome, "sessions");
  if (!fs.existsSync(sessionsDir)) return false;

  const stack = [sessionsDir];
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) continue;
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const entryPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(entryPath);
        continue;
      }
      if (entry.isFile() && entry.name.includes(sessionId) && entry.name.endsWith(".jsonl")) {
        return true;
      }
    }
  }
  return false;
}
