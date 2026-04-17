import * as Lark from "@larksuiteoapi/node-sdk";
import { HttpsProxyAgent } from "https-proxy-agent";
import {
  buildDirectSessionEntryText,
  buildNoActiveTargetText,
  createCocoCommandHandlers,
} from "./coco-commands.js";
import { directSessions } from "./direct-session.js";

const MAX_TEXT_CHARS = 4000;
const RECENT_MESSAGE_TTL_MS = 10 * 60_000;

export type FeishuEnv = {
  botKey: string;
  appId: string;
  appSecret: string;
  domain: string;
  proxy: string | null;
  allowedUserIds: string[];
  allowedChatIds: string[];
};

export type FeishuInboundMessage = {
  messageId: string;
  chatId: string;
  userId: string;
  text: string;
};

type FeishuEventEnvelope = {
  sender?: {
    sender_id?: {
      open_id?: string;
    };
    sender_type?: string;
  };
  message?: {
    message_id?: string;
    chat_id?: string;
    message_type?: string;
    content?: string;
  };
};

export async function startFeishuBot(env = readFeishuEnv()): Promise<void> {
  await startFeishuBots([env]);
}

export async function startFeishuBots(envs = readFeishuEnvs()): Promise<void> {
  const wsClients: Lark.WSClient[] = [];

  try {
    for (const env of envs) {
      wsClients.push(await startSingleFeishuBot(env));
    }
  } catch (err) {
    for (const wsClient of wsClients) {
      try {
        wsClient.close({ force: true });
      } catch {
        // Ignore cleanup errors while aborting startup.
      }
    }
    throw err;
  }

  installShutdownHandlers(wsClients);
  await new Promise<void>(() => {});
}

async function startSingleFeishuBot(env: FeishuEnv): Promise<Lark.WSClient> {
  const domain = resolveFeishuDomain(env.domain);
  const client = new Lark.Client({
    appId: env.appId,
    appSecret: env.appSecret,
    domain,
    loggerLevel: Lark.LoggerLevel.warn,
  });
  const wsClientParams: ConstructorParameters<typeof Lark.WSClient>[0] = {
    appId: env.appId,
    appSecret: env.appSecret,
    domain,
    loggerLevel: Lark.LoggerLevel.warn,
    autoReconnect: true,
  };
  const wsProxyAgent = createFeishuProxyAgent(env.proxy);
  if (wsProxyAgent) {
    wsClientParams.agent = wsProxyAgent;
  }
  const wsClient = new Lark.WSClient(wsClientParams);
  const cocoHandlers = createCocoCommandHandlers({
    deps: {
      bind: (chatKey, role, agent, sessionId, cwd) => directSessions.bind(chatKey, role, agent, sessionId, cwd),
      use: (chatKey, role) => directSessions.use(chatKey, role),
      ask: (chatKey, role, text) => directSessions.ask(chatKey, role, text),
      sendToActive: (chatKey, text, options) => directSessions.sendToActive(chatKey, text, options),
      current: (chatKey) => directSessions.current(chatKey),
      detach: (chatKey, role) => directSessions.detach(chatKey, role),
      xcheckOn: (chatKey, rounds) => directSessions.xcheckOn(chatKey, rounds),
      xcheckOff: (chatKey) => directSessions.xcheckOff(chatKey),
      xcheckStop: (chatKey) => directSessions.xcheckStop(chatKey),
      collabOn: (chatKey, rounds) => directSessions.collabOn(chatKey, rounds),
      collabOff: (chatKey) => directSessions.collabOff(chatKey),
      collabStop: (chatKey) => directSessions.collabStop(chatKey),
    },
  });
  const recentMessageIds = new Map<string, number>();

  const eventDispatcher = new Lark.EventDispatcher({}).register({
    "im.message.receive_v1": async (eventData: unknown) => {
      const inbound = extractInboundMessage(eventData, recentMessageIds);
      if (!inbound) return;

      const message = {
        chatId: inbound.chatId,
        userId: inbound.userId,
        text: inbound.text,
        reply: async (text: string) => sendFeishuText(client, inbound.chatId, text),
      };
      const chatKey = buildFeishuChatKey(env.botKey, inbound.chatId);
      if (!isAllowedFeishuMessage(env, inbound)) {
        await message.reply("Not authorized.");
        return;
      }

      if (await cocoHandlers.handleCocoCommand({ ...message, chatKey })) {
        return;
      }
      if (await cocoHandlers.handlePlainText({ ...message, chatKey })) {
        return;
      }

      const text = inbound.text.trim();
      const state = directSessions.current(chatKey);
      await message.reply(text.startsWith("/") ? buildDirectSessionEntryText(state) : buildNoActiveTargetText(state));
    },
  });

  console.log(`${formatFeishuLogPrefix(env)} Starting bot...`);
  await wsClient.start({ eventDispatcher });
  console.log(`${formatFeishuLogPrefix(env)} Bot is running`);
  return wsClient;
}

export function readFeishuEnv(): FeishuEnv {
  const [env] = readFeishuEnvs();
  return env;
}

export function readFeishuEnvs(env: NodeJS.ProcessEnv = process.env): FeishuEnv[] {
  const shared = readSharedFeishuEnv(env);
  const numberedBots = readNumberedFeishuBots(env);
  if (numberedBots.length > 0) {
    return numberedBots.map((bot) => ({ ...shared, ...bot }));
  }

  const appId = env.COCO_FEISHU_APP_ID?.trim() ?? "";
  const appSecret = env.COCO_FEISHU_APP_SECRET?.trim() ?? "";

  if (!appId || !appSecret) {
    throw new Error("COCO_FEISHU_APP_ID and COCO_FEISHU_APP_SECRET are required");
  }

  return [
    {
      ...shared,
      botKey: "default",
      appId,
      appSecret,
    },
  ];
}

export function resolveFeishuDomain(domain: string): string | Lark.Domain {
  const normalized = domain.trim().toLowerCase();
  if (!normalized || normalized === "feishu") return Lark.Domain.Feishu;
  if (normalized === "lark") return Lark.Domain.Lark;
  return domain;
}

export function readFeishuProxy(env: NodeJS.ProcessEnv): string | null {
  return firstNonEmptyString(
    env.COCO_FEISHU_PROXY,
    env.HTTPS_PROXY,
    env.HTTP_PROXY,
    env.ALL_PROXY,
    env.https_proxy,
    env.http_proxy,
    env.all_proxy,
  );
}

export function createFeishuProxyAgent(proxy: string | null): HttpsProxyAgent<string> | null {
  if (!proxy) return null;
  return new HttpsProxyAgent(proxy);
}

export function extractInboundMessage(
  eventData: unknown,
  recentMessageIds = new Map<string, number>(),
  nowMs = Date.now(),
): FeishuInboundMessage | null {
  if (!isRecord(eventData)) return null;

  const envelope = eventData as FeishuEventEnvelope;
  const senderType = envelope.sender?.sender_type ?? "user";
  if (senderType === "bot") return null;

  const messageId = envelope.message?.message_id ?? "";
  const chatId = envelope.message?.chat_id ?? "";
  const userId = envelope.sender?.sender_id?.open_id ?? "";
  const messageType = envelope.message?.message_type ?? "text";
  const contentRaw = envelope.message?.content ?? "";

  if (!chatId || !userId || !contentRaw) return null;
  if (!trackRecentMessage(recentMessageIds, messageId, nowMs)) return null;

  const text = parseFeishuMessageText(contentRaw, messageType).trim();
  if (!text) return null;

  return { messageId, chatId, userId, text };
}

export function parseFeishuMessageText(contentRaw: string, messageType: string): string {
  switch (messageType) {
    case "text": {
      const parsed = safeParseJson(contentRaw);
      return typeof parsed?.text === "string" ? parsed.text : "";
    }

    case "post": {
      const parsed = safeParseJson(contentRaw);
      const texts: string[] = [];
      collectPostText(parsed, texts);
      return texts.join("\n");
    }

    default:
      return "";
  }
}

async function sendFeishuText(
  client: InstanceType<typeof Lark.Client>,
  chatId: string,
  text: string,
): Promise<void> {
  for (const chunk of chunkText(text, MAX_TEXT_CHARS)) {
    await client.im.v1.message.create({
      params: {
        receive_id_type: "chat_id",
      },
      data: {
        receive_id: chatId,
        content: JSON.stringify({ text: chunk }),
        msg_type: "text",
      },
    });
  }
}

function installShutdownHandlers(wsClients: Lark.WSClient[]): void {
  let shuttingDown = false;

  const shutdown = (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[feishu] Shutting down (${signal})...`);
    for (const wsClient of wsClients) {
      try {
        wsClient.close({ force: true });
      } catch {
        // Ignore close errors during shutdown.
      }
    }
    process.exit(0);
  };

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

function chunkText(text: string, maxChars: number): string[] {
  const chars = [...text];
  if (chars.length <= maxChars) return [text];

  const chunks: string[] = [];
  for (let i = 0; i < chars.length; i += maxChars) {
    chunks.push(chars.slice(i, i + maxChars).join(""));
  }
  return chunks;
}

function collectPostText(value: unknown, acc: string[]): void {
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed) acc.push(trimmed);
    return;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      collectPostText(item, acc);
    }
    return;
  }

  if (!isRecord(value)) return;

  if (value.tag === "text" && typeof value.text === "string") {
    const trimmed = value.text.trim();
    if (trimmed) acc.push(trimmed);
  }

  for (const nested of Object.values(value)) {
    collectPostText(nested, acc);
  }
}

function parseCsv(input: string | undefined): string[] {
  return (input ?? "")
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
}

function firstNonEmptyString(...values: Array<string | undefined | null>): string | null {
  for (const value of values) {
    const trimmed = value?.trim();
    if (trimmed) {
      return trimmed;
    }
  }
  return null;
}

function safeParseJson(input: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(input);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function trackRecentMessage(
  recentMessageIds: Map<string, number>,
  messageId: string,
  nowMs: number,
): boolean {
  pruneRecentMessages(recentMessageIds, nowMs);
  if (!messageId) return true;
  if (recentMessageIds.has(messageId)) return false;
  recentMessageIds.set(messageId, nowMs);
  return true;
}

function pruneRecentMessages(recentMessageIds: Map<string, number>, nowMs: number): void {
  for (const [messageId, seenAt] of recentMessageIds) {
    if (nowMs - seenAt > RECENT_MESSAGE_TTL_MS) {
      recentMessageIds.delete(messageId);
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function buildFeishuChatKey(botKey: string, chatId: string): string {
  return `feishu:${botKey}:${chatId}`;
}

function isAllowedFeishuMessage(env: FeishuEnv, message: FeishuInboundMessage): boolean {
  const userAllowed =
    env.allowedUserIds.length === 0 || env.allowedUserIds.includes(message.userId);
  const chatAllowed =
    env.allowedChatIds.length === 0 || env.allowedChatIds.includes(message.chatId);
  return userAllowed && chatAllowed;
}

function readSharedFeishuEnv(env: NodeJS.ProcessEnv): Omit<FeishuEnv, "botKey" | "appId" | "appSecret"> {
  return {
    domain: env.COCO_FEISHU_DOMAIN?.trim() || "feishu",
    proxy: readFeishuProxy(env),
    allowedUserIds: parseCsv(env.COCO_FEISHU_USERS),
    allowedChatIds: parseCsv(env.COCO_FEISHU_CHATS),
  };
}

function readNumberedFeishuBots(
  env: NodeJS.ProcessEnv,
): Array<Pick<FeishuEnv, "botKey" | "appId" | "appSecret">> {
  const suffixes = new Set<string>();

  for (const key of Object.keys(env)) {
    const match = key.match(/^COCO_FEISHU_APP_(?:ID|SECRET)_(\d+)$/);
    if (match?.[1]) {
      suffixes.add(match[1]);
    }
  }

  return [...suffixes]
    .sort((left, right) => Number.parseInt(left, 10) - Number.parseInt(right, 10))
    .map((suffix) => {
      const appId = env[`COCO_FEISHU_APP_ID_${suffix}`]?.trim() ?? "";
      const appSecret = env[`COCO_FEISHU_APP_SECRET_${suffix}`]?.trim() ?? "";

      if (!appId || !appSecret) {
        throw new Error(
          `COCO_FEISHU_APP_ID_${suffix} and COCO_FEISHU_APP_SECRET_${suffix} are required together`,
        );
      }

      return {
        botKey: suffix,
        appId,
        appSecret,
      };
    });
}

function formatFeishuLogPrefix(env: FeishuEnv): string {
  return env.botKey === "default" ? "[feishu]" : `[feishu:${env.botKey}]`;
}
