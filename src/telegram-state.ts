import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { createNotificationCursor, type NotificationCursor } from "./telegram-notify.js";

export type TelegramSubscription = {
  chatId: number;
  userId: number;
};

export type TelegramNotifierState = {
  seeded: boolean;
  cursor: NotificationCursor;
};

export type TelegramStatePaths = {
  rootDir: string;
  subscribersFile: string;
  notifierFile: string;
};

type StoredSubscribers = {
  subscriptions: TelegramSubscription[];
};

type StoredNotifierState = {
  seeded: boolean;
  cursor: NotificationCursor;
};

export function createTelegramStatePaths(rootDir: string): TelegramStatePaths {
  return {
    rootDir,
    subscribersFile: path.join(rootDir, "subscribers.json"),
    notifierFile: path.join(rootDir, "notifier.json"),
  };
}

export async function loadTelegramSubscribers(
  paths: TelegramStatePaths,
): Promise<TelegramSubscription[]> {
  const parsed = await readJson<StoredSubscribers>(paths.subscribersFile);
  if (!parsed || !Array.isArray(parsed.subscriptions)) return [];

  const byChatId = new Map<number, TelegramSubscription>();
  for (const entry of parsed.subscriptions) {
    if (!isSubscription(entry)) continue;
    byChatId.set(entry.chatId, entry);
  }
  return [...byChatId.values()];
}

export async function saveTelegramSubscribers(
  paths: TelegramStatePaths,
  subscriptions: TelegramSubscription[],
): Promise<void> {
  await writeJson(paths.subscribersFile, {
    subscriptions: dedupeSubscriptions(subscriptions),
  } satisfies StoredSubscribers);
}

export async function loadTelegramNotifierState(
  paths: TelegramStatePaths,
): Promise<TelegramNotifierState> {
  const parsed = await readJson<StoredNotifierState>(paths.notifierFile);
  const fallback = createNotificationCursor();
  if (!parsed || typeof parsed.seeded !== "boolean" || !parsed.cursor) {
    return { seeded: false, cursor: fallback };
  }

  const cursor = sanitizeCursor(parsed.cursor);
  return {
    seeded: parsed.seeded,
    cursor,
  };
}

export async function saveTelegramNotifierState(
  paths: TelegramStatePaths,
  state: TelegramNotifierState,
): Promise<void> {
  await writeJson(paths.notifierFile, {
    seeded: state.seeded,
    cursor: sanitizeCursor(state.cursor),
  } satisfies StoredNotifierState);
}

function dedupeSubscriptions(subscriptions: TelegramSubscription[]): TelegramSubscription[] {
  const byChatId = new Map<number, TelegramSubscription>();
  for (const entry of subscriptions) {
    if (!isSubscription(entry)) continue;
    byChatId.set(entry.chatId, entry);
  }
  return [...byChatId.values()];
}

function sanitizeCursor(cursor: NotificationCursor): NotificationCursor {
  const fallback = createNotificationCursor();
  return {
    runId: normalizeNullableString(cursor.runId) ?? fallback.runId,
    lastForwardKey:
      normalizeNullableString(cursor.lastForwardKey) ?? fallback.lastForwardKey,
    lastStopKey: normalizeNullableString(cursor.lastStopKey) ?? fallback.lastStopKey,
    lastExitKey: normalizeNullableString(cursor.lastExitKey) ?? fallback.lastExitKey,
    lastResendKey:
      normalizeNullableString(cursor.lastResendKey) ?? fallback.lastResendKey,
    lastRecoveryAt:
      normalizeNullableString(cursor.lastRecoveryAt) ?? fallback.lastRecoveryAt,
    lastRecoveryText:
      normalizeNullableString(cursor.lastRecoveryText) ?? fallback.lastRecoveryText,
  };
}

function isSubscription(value: unknown): value is TelegramSubscription {
  return (
    typeof value === "object" &&
    value !== null &&
    isNonZeroInt((value as { chatId?: unknown }).chatId) &&
    isPositiveInt((value as { userId?: unknown }).userId)
  );
}

function isPositiveInt(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

function isNonZeroInt(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value !== 0;
}

function normalizeNullableString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

async function readJson<T>(file: string): Promise<T | null> {
  try {
    const raw = await readFile(file, "utf8");
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

async function writeJson(file: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  const tempFile = `${file}.tmp-${process.pid}`;
  // Write-then-rename avoids leaving half-written state files on restart/crash.
  await writeFile(tempFile, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(tempFile, file);
}
