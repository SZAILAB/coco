import {
  createDirectBinding,
  type DirectAgent,
  type DirectBinding,
  type DirectBindingStatus,
  type DirectSendResult,
} from "./direct-backend.js";

export type DirectBindingSnapshot = {
  agent: DirectAgent;
  sessionId: string;
  cwd: string;
  status: DirectBindingStatus;
  error: string | null;
};

export type DirectChatState = {
  activeTarget: DirectAgent | null;
  bindings: Partial<Record<DirectAgent, DirectBindingSnapshot>>;
};

export class DirectSessionManager {
  readonly #chats = new Map<
    string,
    {
      activeTarget: DirectAgent | null;
      bindings: Partial<Record<DirectAgent, DirectBinding>>;
    }
  >();
  readonly #bindingFactory: typeof createDirectBinding;

  constructor(bindingFactory = createDirectBinding) {
    this.#bindingFactory = bindingFactory;
  }

  async bind(chatKey: string, agent: DirectAgent, sessionId: string, cwd: string): Promise<DirectChatState> {
    const chat = this.#getOrCreateChat(chatKey);
    const existing = chat.bindings[agent];
    if (existing) {
      await existing.close();
    }

    const binding = await this.#bindingFactory(agent, sessionId, cwd);
    chat.bindings[agent] = binding;
    if (!chat.activeTarget) {
      chat.activeTarget = agent;
    }
    return this.current(chatKey);
  }

  use(chatKey: string, agent: DirectAgent): DirectChatState {
    const chat = this.#chats.get(chatKey);
    if (!chat?.bindings[agent]) {
      throw new Error(`No ${agent} session is bound for this chat`);
    }
    chat.activeTarget = agent;
    return this.current(chatKey);
  }

  async ask(chatKey: string, agent: DirectAgent, text: string): Promise<DirectSendResult> {
    const chat = this.#chats.get(chatKey);
    const binding = chat?.bindings[agent];
    if (!binding) {
      throw new Error(`No ${agent} session is bound for this chat`);
    }
    return await binding.send(text);
  }

  async sendToActive(chatKey: string, text: string): Promise<DirectSendResult | null> {
    const chat = this.#chats.get(chatKey);
    if (!chat?.activeTarget) return null;
    const binding = chat.bindings[chat.activeTarget];
    if (!binding) return null;
    return await binding.send(text);
  }

  current(chatKey: string): DirectChatState {
    const chat = this.#chats.get(chatKey);
    if (!chat) {
      return { activeTarget: null, bindings: {} };
    }

    const bindings: Partial<Record<DirectAgent, DirectBindingSnapshot>> = {};
    for (const agent of ["codex", "claude"] as const) {
      const binding = chat.bindings[agent];
      if (!binding) continue;
      bindings[agent] = {
        agent,
        sessionId: binding.sessionId(),
        cwd: binding.cwd(),
        status: binding.status(),
        error: binding.error(),
      };
    }

    return {
      activeTarget: chat.activeTarget,
      bindings,
    };
  }

  async detach(chatKey: string, agent?: DirectAgent): Promise<DirectChatState> {
    const chat = this.#chats.get(chatKey);
    if (!chat) {
      return { activeTarget: null, bindings: {} };
    }

    const targets = agent
      ? [agent]
      : chat.activeTarget
        ? [chat.activeTarget]
        : (["codex", "claude"] as DirectAgent[]);

    for (const target of targets) {
      const binding = chat.bindings[target];
      if (!binding) continue;
      await binding.close();
      delete chat.bindings[target];
    }

    if (chat.activeTarget && !chat.bindings[chat.activeTarget]) {
      chat.activeTarget = chat.bindings.codex
        ? "codex"
        : chat.bindings.claude
          ? "claude"
          : null;
    }

    if (!chat.bindings.codex && !chat.bindings.claude) {
      this.#chats.delete(chatKey);
      return { activeTarget: null, bindings: {} };
    }

    return this.current(chatKey);
  }

  #getOrCreateChat(chatKey: string) {
    let chat = this.#chats.get(chatKey);
    if (!chat) {
      chat = {
        activeTarget: null,
        bindings: {},
      };
      this.#chats.set(chatKey, chat);
    }
    return chat;
  }
}

export const directSessions = new DirectSessionManager();
