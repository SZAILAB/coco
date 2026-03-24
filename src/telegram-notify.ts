import type { RunStatus } from "./run-status.js";

export type NotificationCursor = {
  runId: string | null;
  lastForwardKey: string | null;
  lastStopKey: string | null;
  lastExitKey: string | null;
  lastResendKey: string | null;
};

export type StatusNotification = {
  kind: "forward" | "recovery" | "stop";
  runId: string;
  text: string;
};

export function createNotificationCursor(): NotificationCursor {
  return {
    runId: null,
    lastForwardKey: null,
    lastStopKey: null,
    lastExitKey: null,
    lastResendKey: null,
  };
}

export function collectStatusNotifications(
  cursor: NotificationCursor,
  status: RunStatus | null,
): { cursor: NotificationCursor; notifications: StatusNotification[] } {
  if (!status) {
    return { cursor, notifications: [] };
  }

  let next =
    cursor.runId === status.runId
      ? { ...cursor }
      : {
          runId: status.runId,
          lastForwardKey: null,
          lastStopKey: null,
          lastExitKey: null,
          lastResendKey: null,
        };

  const notifications: StatusNotification[] = [];

  const exitKey = buildExitKey(status);
  if (exitKey && exitKey !== next.lastExitKey) {
    notifications.push({
      kind: "recovery",
      runId: status.runId,
      text: [
        `Recovery alert for ${status.runId}`,
        exitKey.includes(":left:") ? `codex exited; waiting for watchdog restart.` : `claude exited; waiting for watchdog restart.`,
        status.progressSummary?.text,
      ]
        .filter(Boolean)
        .join("\n\n"),
    });
  }
  next.lastExitKey = exitKey;

  const resendKey = buildResendKey(status);
  if (resendKey && resendKey !== next.lastResendKey && status.waitingFor) {
    notifications.push({
      kind: "recovery",
      runId: status.runId,
      text: [
        `Recovery update for ${status.runId}`,
        `Resent the current prompt to ${status.waitingFor.agent} turn ${status.waitingFor.turn} (resends ${status.waitingFor.resentCount}).`,
        status.progressSummary?.text,
      ]
        .filter(Boolean)
        .join("\n\n"),
    });
  }
  next.lastResendKey = resendKey;

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
        `Run ${status.runId} stopped (${status.stopReason ?? "unknown"}) by ${status.stopBy ?? "unknown"}.`,
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
