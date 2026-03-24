import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createNotificationCursor } from "./telegram-notify.js";
import {
  createTelegramStatePaths,
  loadTelegramNotifierState,
  loadTelegramSubscribers,
  saveTelegramNotifierState,
  saveTelegramSubscribers,
} from "./telegram-state.js";

const tempDirs: string[] = [];

async function makePaths() {
  const root = await mkdtemp(path.join(os.tmpdir(), "coco-telegram-state-"));
  tempDirs.push(root);
  return createTelegramStatePaths(root);
}

describe("telegram-state", () => {
  afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it("returns empty defaults when state files do not exist", async () => {
    const paths = await makePaths();

    await expect(loadTelegramSubscribers(paths)).resolves.toEqual([]);
    await expect(loadTelegramNotifierState(paths)).resolves.toEqual({
      seeded: false,
      cursor: createNotificationCursor(),
    });
  });

  it("round-trips subscriptions and dedupes by chat id", async () => {
    const paths = await makePaths();

    await saveTelegramSubscribers(paths, [
      { chatId: 1001, userId: 2001 },
      { chatId: -1002, userId: 2002 },
      { chatId: 1001, userId: 2999 },
    ]);

    await expect(loadTelegramSubscribers(paths)).resolves.toEqual([
      { chatId: 1001, userId: 2999 },
      { chatId: -1002, userId: 2002 },
    ]);
  });

  it("round-trips notifier seeded state and cursor", async () => {
    const paths = await makePaths();
    const cursor = createNotificationCursor();
    cursor.runId = "run-123";
    cursor.lastForwardKey = "run-123:2026-03-24T00:00:10.000Z";

    await saveTelegramNotifierState(paths, {
      seeded: true,
      cursor,
    });

    await expect(loadTelegramNotifierState(paths)).resolves.toEqual({
      seeded: true,
      cursor: {
        ...createNotificationCursor(),
        runId: "run-123",
        lastForwardKey: "run-123:2026-03-24T00:00:10.000Z",
      },
    });
  });
});
