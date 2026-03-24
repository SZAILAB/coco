import type { RunStatus } from "./run-status.js";

export type NotificationCursor = {
  runId: string | null;
  lastForwardKey: string | null;
  lastStopKey: string | null;
  lastExitKey: string | null;
  lastResendKey: string | null;
  lastRecoveryAt: string | null;
  lastRecoveryText: string | null;
};

export type StatusNotification = {
  kind: "forward" | "recovery" | "stop";
  runId: string;
  text: string;
};

type NotifyOptions = {
  recoveryThrottleMs?: number;
};

export function createNotificationCursor(): NotificationCursor {
  return {
    runId: null,
    lastForwardKey: null,
    lastStopKey: null,
    lastExitKey: null,
    lastResendKey: null,
    lastRecoveryAt: null,
    lastRecoveryText: null,
  };
}

export function collectStatusNotifications(
  cursor: NotificationCursor,
  status: RunStatus | null,
  options: NotifyOptions = {},
): { cursor: NotificationCursor; notifications: StatusNotification[] } {
  if (!status) {
    return { cursor, notifications: [] };
  }

  const recoveryThrottleMs = options.recoveryThrottleMs ?? 30_000;

  let next =
    cursor.runId === status.runId
      ? { ...cursor }
      : {
          runId: status.runId,
          lastForwardKey: null,
          lastStopKey: null,
          lastExitKey: null,
          lastResendKey: null,
          lastRecoveryAt: null,
          lastRecoveryText: null,
        };

  const notifications: StatusNotification[] = [];

  if (status.phase !== "stopped") {
    const exitKey = buildExitKey(status);
    if (exitKey && exitKey !== next.lastExitKey) {
      const text = [
        `Recovery alert for ${status.runId}`,
        exitKey.includes(":left:")
          ? `codex exited; waiting for watchdog restart.`
          : `claude exited; waiting for watchdog restart.`,
        status.progressSummary?.text,
      ]
        .filter(Boolean)
        .join("\n\n");
      pushRecoveryNotification(notifications, next, status.updatedAt, text, recoveryThrottleMs);
    }
    next.lastExitKey = exitKey;

    const resendKey = buildResendKey(status);
    if (resendKey && resendKey !== next.lastResendKey && status.waitingFor) {
      const text = [
        `Recovery update for ${status.runId}`,
        `Resent the current prompt to ${status.waitingFor.agent} turn ${status.waitingFor.turn} (resends ${status.waitingFor.resentCount}).`,
        status.progressSummary?.text,
      ]
        .filter(Boolean)
        .join("\n\n");
      pushRecoveryNotification(notifications, next, status.updatedAt, text, recoveryThrottleMs);
    }
    next.lastResendKey = resendKey;
  } else {
    next.lastExitKey = null;
    next.lastResendKey = null;
  }

  const forwardKey = status.lastForward ? `${status.runId}:${status.lastForward.at}` : null;
  if (forwardKey && forwardKey !== next.lastForwardKey && status.lastForward) {
    notifications.push({
      kind: "forward",
      runId: status.runId,
      text: [
        `Progress update for ${status.runId}`,
        `Round ${status.lastForward.round}: ${status.lastForward.from} -> ${status.lastForward.to}`,
        status.lastForward.preview,
        status.progressSummary?.text,
      ]
        .filter(Boolean)
        .join("\n\n"),
    });
  }
  next.lastForwardKey = forwardKey;

  const stopKey =
    status.phase === "stopped" ? `${status.runId}:${status.stoppedAt ?? status.updatedAt}` : null;
  if (stopKey && stopKey !== next.lastStopKey) {
    notifications.push({
      kind: "stop",
      runId: status.runId,
      text: [
        buildStopHeadline(status),
        status.stopTextPreview ? `Final: ${status.stopTextPreview}` : null,
        status.progressSummary?.text,
      ]
        .filter(Boolean)
        .join("\n\n"),
    });
  }
  next.lastStopKey = stopKey;

  return { cursor: next, notifications };
}

function pushRecoveryNotification(
  notifications: StatusNotification[],
  cursor: NotificationCursor,
  updatedAt: string,
  text: string,
  throttleMs: number,
): void {
  const lastAtMs = cursor.lastRecoveryAt ? Date.parse(cursor.lastRecoveryAt) : Number.NaN;
  const currentMs = Date.parse(updatedAt);
  const throttled =
    cursor.lastRecoveryText === text &&
    Number.isFinite(lastAtMs) &&
    Number.isFinite(currentMs) &&
    currentMs - lastAtMs < throttleMs;

  if (throttled) return;

  notifications.push({
    kind: "recovery",
    runId: cursor.runId ?? "unknown",
    text,
  });
  cursor.lastRecoveryAt = updatedAt;
  cursor.lastRecoveryText = text;
}

function buildStopHeadline(status: RunStatus): string {
  const reason = status.stopReason ?? "unknown";
  const by = status.stopBy ?? "unknown";

  if (reason === "fatal" || reason === "timeout" || reason === "session-exit") {
    return `Run ${status.runId} failed (${reason}) by ${by}.`;
  }

  if (reason === "interrupted") {
    return `Run ${status.runId} was interrupted by ${by}.`;
  }

  return `Run ${status.runId} stopped (${reason}) by ${by}.`;
}

function buildExitKey(status: RunStatus): string | null {
  if (status.sessions.left.status === "exited") {
    return `${status.runId}:left:${status.sessions.left.pid ?? "none"}`;
  }
  if (status.sessions.right.status === "exited") {
    return `${status.runId}:right:${status.sessions.right.pid ?? "none"}`;
  }
  return null;
}

function buildResendKey(status: RunStatus): string | null {
  if (!status.waitingFor || status.waitingFor.resentCount <= 0) return null;
  return `${status.runId}:${status.waitingFor.agent}:${status.waitingFor.turn}:${status.waitingFor.resentCount}`;
}
