import { describe, expect, it, vi } from "vitest";
import { createTelegramCommandHandlers, type TelegramCommandContext } from "./telegram-commands.js";

function makeContext(overrides: Partial<TelegramCommandContext> = {}) {
  const reply = vi.fn(async (_text: string) => {});
  return {
    from: { id: 2001 },
    reply,
    ...overrides,
  };
}

function createHarness(options?: { allowedUserIds?: number[] }) {
  const handlers = createTelegramCommandHandlers({
    allowedUserIds: options?.allowedUserIds ?? [2001],
  });

  return { handlers };
}

describe("telegram command handlers", () => {
  it("blocks unauthorized users in the auth guard", async () => {
    const { handlers } = createHarness();
    const ctx = makeContext({ from: { id: 9999 } });
    const next = vi.fn();

    await handlers.authGuard(ctx, next);

    expect(ctx.reply).toHaveBeenCalledWith("Not authorized.");
    expect(next).not.toHaveBeenCalled();
  });

  it("shows direct-session help", async () => {
    const { handlers } = createHarness();
    const ctx = makeContext();

    await handlers.help(ctx);

    expect(ctx.reply).toHaveBeenCalledWith(expect.stringContaining("No active direct session target"));
    expect(ctx.reply).toHaveBeenCalledWith(expect.stringContaining("/coco bind codex <thread_id> <cwd>"));
  });
});
