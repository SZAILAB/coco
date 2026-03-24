import { afterEach, describe, expect, it, vi } from "vitest";

import { PtySession } from "./pty-session.js";

function attachFakePty(session: PtySession, writes: string[]) {
  const hacked = session as unknown as {
    pty: { write: (data: string) => void };
    _status: string;
    _generation: number;
  };
  hacked.pty = {
    write(data: string) {
      writes.push(data);
    },
  };
  hacked._status = "running";
  hacked._generation = 1;
}

describe("PtySession.send", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("writes the prompt and submit key separately for non-Claude sessions", async () => {
    vi.useFakeTimers();

    const session = new PtySession({ name: "codex", command: "codex" });
    const writes: string[] = [];
    attachFakePty(session, writes);

    session.send("hello");
    await vi.advanceTimersByTimeAsync(0);

    expect(writes).toEqual(["hello"]);

    await vi.advanceTimersByTimeAsync(25);
    expect(writes).toEqual(["hello", "\r"]);
  });

  it("chunks long Claude prompts but emits a single logical input event", async () => {
    vi.useFakeTimers();

    const session = new PtySession({ name: "claude", command: "claude" });
    const writes: string[] = [];
    const inputs: string[] = [];
    attachFakePty(session, writes);
    session.onEvent((event) => {
      if (event.type === "input") {
        inputs.push(event.data);
      }
    });

    const prompt = "x".repeat(320);
    session.send(prompt);
    await vi.advanceTimersByTimeAsync(0);

    expect(inputs).toEqual([prompt]);
    expect(writes[0]).toHaveLength(16);

    await vi.runAllTimersAsync();

    expect(inputs).toEqual([prompt, "\r"]);
    expect(writes.at(-1)).toBe("\r");
    expect(writes.slice(0, -1).join("")).toBe(prompt);
  });
});
