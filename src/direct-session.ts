import {
  createDirectBinding,
  type DirectAgent,
  type DirectBinding,
  type DirectBindingStatus,
  type DirectSendResult,
} from "./direct-backend.js";

export type DirectDispatchOutput =
  | {
      type: "agent";
      phase: "default" | "draft" | "review" | "final";
      result: DirectSendResult;
    }
  | {
      type: "system";
      text: string;
    };

export type DirectDispatchOptions = {
  bypassXcheck?: boolean;
  onOutput?(output: DirectDispatchOutput): Promise<void> | void;
};

export type DirectXcheckStep = "owner-draft" | "reviewer-review" | "owner-final";

export type DirectXcheckSnapshot = {
  enabled: boolean;
  rounds: number;
  owner: DirectAgent | null;
  reviewer: DirectAgent | null;
  runState: "idle" | "running";
  step: DirectXcheckStep | null;
  round: number | null;
  startedAt: string | null;
  stopRequested: boolean;
  lastError: string | null;
};

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
  xcheck: DirectXcheckSnapshot;
};

type DirectChatRuntime = {
  activeTarget: DirectAgent | null;
  bindings: Partial<Record<DirectAgent, DirectBinding>>;
  xcheck: {
    enabled: boolean;
    rounds: number;
    run:
      | {
          step: DirectXcheckStep;
          startedAt: number;
          stopRequested: boolean;
          round: number;
          totalRounds: number;
        }
      | null;
    lastError: string | null;
  };
};

type XcheckPair = {
  owner: DirectAgent;
  reviewer: DirectAgent;
  ownerBinding: DirectBinding;
  reviewerBinding: DirectBinding;
};

export class DirectSessionManager {
  readonly #chats = new Map<string, DirectChatRuntime>();
  readonly #bindingFactory: typeof createDirectBinding;

  constructor(bindingFactory = createDirectBinding) {
    this.#bindingFactory = bindingFactory;
  }

  async bind(chatKey: string, agent: DirectAgent, sessionId: string, cwd: string): Promise<DirectChatState> {
    const chat = this.#getOrCreateChat(chatKey);
    this.#assertNoXcheckRun(chat, "bind a session");

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

    this.#assertNoXcheckRun(chat, "switch the active target");
    chat.activeTarget = agent;
    return this.current(chatKey);
  }

  async ask(chatKey: string, agent: DirectAgent, text: string): Promise<DirectSendResult> {
    const chat = this.#chats.get(chatKey);
    const binding = chat?.bindings[agent];
    if (!binding) {
      throw new Error(`No ${agent} session is bound for this chat`);
    }

    this.#assertNoXcheckRun(chat, "send a directed message");
    return await binding.send(text);
  }

  async sendToActive(
    chatKey: string,
    text: string,
    options?: DirectDispatchOptions,
  ): Promise<DirectDispatchOutput[] | null> {
    const chat = this.#chats.get(chatKey);
    if (!chat?.activeTarget) return null;

    if (chat.xcheck.run) {
      return await this.#withSingleOutput({ type: "system", text: "xcheck already running, please wait" }, options);
    }

    const binding = chat.bindings[chat.activeTarget];
    if (!binding) return null;

    if (options?.bypassXcheck || !chat.xcheck.enabled) {
      return await this.#sendDirect(binding, text, options);
    }

    return await this.#runXcheck(chat, text, options);
  }

  xcheckOn(chatKey: string, rounds = 1): DirectChatState {
    const chat = this.#getOrCreateChat(chatKey);
    this.#assertNoXcheckRun(chat, "enable xcheck");
    this.#requireXcheckPair(chat);
    assertValidXcheckRounds(rounds);
    chat.xcheck.enabled = true;
    chat.xcheck.rounds = rounds;
    chat.xcheck.lastError = null;
    return this.current(chatKey);
  }

  xcheckOff(chatKey: string): DirectChatState {
    const chat = this.#chats.get(chatKey);
    if (!chat) {
      return this.#emptyState();
    }

    this.#assertNoXcheckRun(chat, "disable xcheck");
    chat.xcheck.enabled = false;
    chat.xcheck.lastError = null;
    return this.current(chatKey);
  }

  xcheckStop(chatKey: string): DirectChatState {
    const chat = this.#chats.get(chatKey);
    const run = chat?.xcheck.run;
    if (!chat || !run) {
      throw new Error("No xcheck run is currently active for this chat");
    }

    run.stopRequested = true;
    return this.current(chatKey);
  }

  current(chatKey: string): DirectChatState {
    const chat = this.#chats.get(chatKey);
    if (!chat) {
      return this.#emptyState();
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
      xcheck: this.#snapshotXcheck(chat),
    };
  }

  async detach(chatKey: string, agent?: DirectAgent): Promise<DirectChatState> {
    const chat = this.#chats.get(chatKey);
    if (!chat) {
      return this.#emptyState();
    }

    this.#assertNoXcheckRun(chat, "detach a session");

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
      return this.#emptyState();
    }

    if (!chat.bindings.codex || !chat.bindings.claude || !chat.activeTarget) {
      chat.xcheck.enabled = false;
    }

    return this.current(chatKey);
  }

  async #sendDirect(
    binding: DirectBinding,
    text: string,
    options?: DirectDispatchOptions,
  ): Promise<DirectDispatchOutput[]> {
    try {
      return await this.#withSingleOutput(
        {
          type: "agent",
          phase: "default",
          result: await binding.send(text),
        },
        options,
      );
    } catch (err) {
      return await this.#withSingleOutput(
        { type: "system", text: `Failed to send to ${binding.agent}: ${err}` },
        options,
      );
    }
  }

  async #runXcheck(
    chat: DirectChatRuntime,
    userText: string,
    options?: DirectDispatchOptions,
  ): Promise<DirectDispatchOutput[]> {
    let pair: XcheckPair;
    try {
      pair = this.#requireXcheckPair(chat);
    } catch (err) {
      chat.xcheck.enabled = false;
      chat.xcheck.lastError = String(err);
      return await this.#withSingleOutput({ type: "system", text: `Xcheck was disabled: ${err}` }, options);
    }

    const outputs: DirectDispatchOutput[] = [];
    chat.xcheck.lastError = null;
    chat.xcheck.run = {
      step: "owner-draft",
      startedAt: Date.now(),
      stopRequested: false,
      round: 1,
      totalRounds: chat.xcheck.rounds,
    };

    try {
      let draft = await pair.ownerBinding.send(userText);
      await this.#pushOutput(
        outputs,
        {
          type: "agent",
          phase: "draft",
          result: draft,
        },
        options,
      );
      if (await this.#finalizeStoppedRun(chat, chat.xcheck.run, outputs, options)) {
        return outputs;
      }

      for (let round = 1; round <= chat.xcheck.rounds; round += 1) {
        chat.xcheck.run.step = "reviewer-review";
        chat.xcheck.run.round = round;
        const review = await pair.reviewerBinding.send(
          buildXcheckReviewPrompt(pair.owner, userText, draft.text, round, chat.xcheck.rounds),
        );
        await this.#pushOutput(
          outputs,
          {
            type: "agent",
            phase: "review",
            result: review,
          },
          options,
        );
        if (await this.#finalizeStoppedRun(chat, chat.xcheck.run, outputs, options)) {
          return outputs;
        }

        if (round === chat.xcheck.rounds) {
          chat.xcheck.run.step = "owner-final";
          const final = await pair.ownerBinding.send(
            buildXcheckFinalPrompt(pair.reviewer, userText, review.text, round, chat.xcheck.rounds),
          );
          await this.#pushOutput(
            outputs,
            {
              type: "agent",
              phase: "final",
              result: final,
            },
            options,
          );
          return outputs;
        }

        chat.xcheck.run.step = "owner-draft";
        chat.xcheck.run.round = round + 1;
        draft = await pair.ownerBinding.send(
          buildXcheckRevisionPrompt(pair.reviewer, userText, review.text, round + 1, chat.xcheck.rounds),
        );
        await this.#pushOutput(
          outputs,
          {
            type: "agent",
            phase: "draft",
            result: draft,
          },
          options,
        );
        if (await this.#finalizeStoppedRun(chat, chat.xcheck.run, outputs, options)) {
          return outputs;
        }
      }

      return outputs;
    } catch (err) {
      chat.xcheck.lastError = String(err);
      const step = chat.xcheck.run?.step ?? "owner-draft";
      await this.#pushOutput(
        outputs,
        {
          type: "system",
          text: `Xcheck failed during ${formatXcheckRunStep(step, chat.xcheck.run?.round, chat.xcheck.run?.totalRounds)}: ${err}`,
        },
        options,
      );
      return outputs;
    } finally {
      chat.xcheck.run = null;
    }
  }

  async #finalizeStoppedRun(
    chat: DirectChatRuntime,
    run: NonNullable<DirectChatRuntime["xcheck"]["run"]>,
    outputs: DirectDispatchOutput[],
    options?: DirectDispatchOptions,
  ): Promise<boolean> {
    if (!chat.xcheck.run?.stopRequested) {
      return false;
    }

    await this.#pushOutput(
      outputs,
      {
        type: "system",
        text: `Xcheck stopped after ${formatXcheckRunStep(run.step, run.round, run.totalRounds)}.`,
      },
      options,
    );
    return true;
  }

  #snapshotXcheck(chat: DirectChatRuntime): DirectXcheckSnapshot {
    const { owner, reviewer } = this.#participants(chat);
    return {
      enabled: chat.xcheck.enabled,
      rounds: chat.xcheck.rounds,
      owner,
      reviewer,
      runState: chat.xcheck.run ? "running" : "idle",
      step: chat.xcheck.run?.step ?? null,
      round: chat.xcheck.run?.round ?? null,
      startedAt: chat.xcheck.run ? new Date(chat.xcheck.run.startedAt).toISOString() : null,
      stopRequested: chat.xcheck.run?.stopRequested ?? false,
      lastError: chat.xcheck.lastError,
    };
  }

  #participants(chat: DirectChatRuntime): { owner: DirectAgent | null; reviewer: DirectAgent | null } {
    const owner = chat.activeTarget;
    if (!owner) {
      return { owner: null, reviewer: null };
    }

    const reviewer =
      owner === "codex"
        ? chat.bindings.claude
          ? "claude"
          : null
        : chat.bindings.codex
          ? "codex"
          : null;

    return { owner, reviewer };
  }

  #requireXcheckPair(chat: DirectChatRuntime): XcheckPair {
    const { owner, reviewer } = this.#participants(chat);
    if (!owner || !reviewer) {
      throw new Error("Xcheck requires both codex and claude to be bound and an active target selected");
    }

    const ownerBinding = chat.bindings[owner];
    const reviewerBinding = chat.bindings[reviewer];
    if (!ownerBinding || !reviewerBinding) {
      throw new Error("Xcheck bindings are incomplete for this chat");
    }

    return { owner, reviewer, ownerBinding, reviewerBinding };
  }

  #assertNoXcheckRun(chat: DirectChatRuntime, action: string): void {
    if (chat.xcheck.run) {
      throw new Error(`Cannot ${action} while xcheck is running`);
    }
  }

  async #withSingleOutput(
    output: DirectDispatchOutput,
    options?: DirectDispatchOptions,
  ): Promise<DirectDispatchOutput[]> {
    const outputs: DirectDispatchOutput[] = [];
    await this.#pushOutput(outputs, output, options);
    return outputs;
  }

  async #pushOutput(
    outputs: DirectDispatchOutput[],
    output: DirectDispatchOutput,
    options?: DirectDispatchOptions,
  ): Promise<void> {
    outputs.push(output);
    await options?.onOutput?.(output);
  }

  #emptyState(): DirectChatState {
    return {
      activeTarget: null,
      bindings: {},
      xcheck: {
        enabled: false,
        rounds: 1,
        owner: null,
        reviewer: null,
        runState: "idle",
        step: null,
        round: null,
        startedAt: null,
        stopRequested: false,
        lastError: null,
      },
    };
  }

  #getOrCreateChat(chatKey: string): DirectChatRuntime {
    let chat = this.#chats.get(chatKey);
    if (!chat) {
      chat = {
        activeTarget: null,
        bindings: {},
        xcheck: {
          enabled: false,
          rounds: 1,
          run: null,
          lastError: null,
        },
      };
      this.#chats.set(chatKey, chat);
    }
    return chat;
  }
}

export const directSessions = new DirectSessionManager();

function buildXcheckReviewPrompt(
  owner: DirectAgent,
  userText: string,
  draft: string,
  round: number,
  totalRounds: number,
): string {
  return [
    "Cross-check mode: review the other agent's draft only.",
    "Do not answer the user directly.",
    "Point out concrete mistakes, risks, or missing edge cases.",
    "",
    `Round: ${round}/${totalRounds}`,
    `Owner: ${owner}`,
    "Original user message:",
    userText,
    "",
    "Draft to review:",
    draft,
  ].join("\n");
}

function buildXcheckRevisionPrompt(
  reviewer: DirectAgent,
  userText: string,
  review: string,
  round: number,
  totalRounds: number,
): string {
  return [
    "Cross-check mode: revise your previous draft using the review below.",
    "Return an updated draft only.",
    "Do not return the final user-facing answer yet.",
    "Another review round will follow after this draft.",
    "",
    `Round: ${round}/${totalRounds}`,
    `Reviewer: ${reviewer}`,
    "Original user message:",
    userText,
    "",
    "Reviewer feedback:",
    review,
  ].join("\n");
}

function buildXcheckFinalPrompt(
  reviewer: DirectAgent,
  userText: string,
  review: string,
  round: number,
  totalRounds: number,
): string {
  return [
    "Cross-check mode: revise your previous draft using the review below.",
    "Return the final user-facing answer.",
    "Incorporate good feedback and ignore bad feedback if needed.",
    "",
    `Final round: ${round}/${totalRounds}`,
    `Reviewer: ${reviewer}`,
    "Original user message:",
    userText,
    "",
    "Reviewer feedback:",
    review,
  ].join("\n");
}

function formatXcheckStep(step: DirectXcheckStep): string {
  switch (step) {
    case "owner-draft":
      return "owner draft";
    case "reviewer-review":
      return "reviewer review";
    case "owner-final":
      return "owner final";
  }
}

function formatXcheckRunStep(
  step: DirectXcheckStep,
  round: number | null | undefined,
  totalRounds: number | null | undefined,
): string {
  const label = formatXcheckStep(step);
  if (!round || !totalRounds) {
    return label;
  }
  return `${label} (round ${round}/${totalRounds})`;
}

function assertValidXcheckRounds(rounds: number): void {
  if (!Number.isInteger(rounds) || rounds < 1) {
    throw new Error("Xcheck rounds must be a positive integer");
  }
}
