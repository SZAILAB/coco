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
      phase: "default" | "draft" | "review" | "collab" | "final";
      result: DirectSendResult;
    }
  | {
      type: "system";
      text: string;
    };

export type DirectDispatchOptions = {
  bypassSessionMode?: boolean;
  onOutput?(output: DirectDispatchOutput): Promise<void> | void;
};

export type DirectXcheckStep = "owner-draft" | "reviewer-review" | "owner-final";
export type DirectCollabStep = "lead-turn" | "partner-turn";

type DirectModeRun<Step extends string> = {
  step: Step;
  startedAt: number;
  stopRequested: boolean;
  round: number;
  totalRounds: number;
};

type DirectModeSnapshot<Step extends string> = {
  enabled: boolean;
  rounds: number;
  runState: "idle" | "running";
  step: Step | null;
  round: number | null;
  startedAt: string | null;
  stopRequested: boolean;
  lastError: string | null;
};

export type DirectXcheckSnapshot = DirectModeSnapshot<DirectXcheckStep> & {
  owner: DirectAgent | null;
  reviewer: DirectAgent | null;
};

export type DirectCollabSnapshot = DirectModeSnapshot<DirectCollabStep> & {
  lead: DirectAgent | null;
  partner: DirectAgent | null;
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
  collab: DirectCollabSnapshot;
};

type DirectChatRuntime = {
  activeTarget: DirectAgent | null;
  bindings: Partial<Record<DirectAgent, DirectBinding>>;
  xcheck: {
    enabled: boolean;
    rounds: number;
    run:
      | DirectModeRun<DirectXcheckStep>
      | null;
    lastError: string | null;
  };
  collab: {
    enabled: boolean;
    rounds: number;
    run: DirectModeRun<DirectCollabStep> | null;
    lastError: string | null;
  };
};

type DirectPair = {
  active: DirectAgent;
  other: DirectAgent;
  activeBinding: DirectBinding;
  otherBinding: DirectBinding;
};

export class DirectSessionManager {
  readonly #chats = new Map<string, DirectChatRuntime>();
  readonly #bindingFactory: typeof createDirectBinding;

  constructor(bindingFactory = createDirectBinding) {
    this.#bindingFactory = bindingFactory;
  }

  async bind(chatKey: string, agent: DirectAgent, sessionId: string, cwd: string): Promise<DirectChatState> {
    const chat = this.#getOrCreateChat(chatKey);
    this.#assertNoModeRun(chat, "bind a session");

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

    this.#assertNoModeRun(chat, "switch the active target");
    chat.activeTarget = agent;
    return this.current(chatKey);
  }

  async ask(chatKey: string, agent: DirectAgent, text: string): Promise<DirectSendResult> {
    const chat = this.#chats.get(chatKey);
    const binding = chat?.bindings[agent];
    if (!binding) {
      throw new Error(`No ${agent} session is bound for this chat`);
    }

    this.#assertNoModeRun(chat, "send a directed message");
    return await binding.send(text);
  }

  async sendToActive(
    chatKey: string,
    text: string,
    options?: DirectDispatchOptions,
  ): Promise<DirectDispatchOutput[] | null> {
    const chat = this.#chats.get(chatKey);
    if (!chat?.activeTarget) return null;

    const activeMode = this.#activeModeRun(chat);
    if (activeMode) {
      return await this.#withSingleOutput(
        { type: "system", text: `${activeMode.name} already running, please wait` },
        options,
      );
    }

    const binding = chat.bindings[chat.activeTarget];
    if (!binding) return null;

    if (options?.bypassSessionMode || (!chat.xcheck.enabled && !chat.collab.enabled)) {
      return await this.#sendDirect(binding, text, options);
    }

    if (chat.collab.enabled) {
      return await this.#runCollab(chat, text, options);
    }
    return await this.#runXcheck(chat, text, options);
  }

  xcheckOn(chatKey: string, rounds = 1): DirectChatState {
    const chat = this.#getOrCreateChat(chatKey);
    this.#assertNoModeRun(chat, "enable xcheck");
    this.#requirePair(chat, "Xcheck");
    assertValidModeRounds(rounds);
    chat.xcheck.enabled = true;
    chat.xcheck.rounds = rounds;
    chat.xcheck.lastError = null;
    chat.collab.enabled = false;
    return this.current(chatKey);
  }

  xcheckOff(chatKey: string): DirectChatState {
    const chat = this.#chats.get(chatKey);
    if (!chat) {
      return this.#emptyState();
    }

    this.#assertNoModeRun(chat, "disable xcheck");
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

  collabOn(chatKey: string, rounds = 1): DirectChatState {
    const chat = this.#getOrCreateChat(chatKey);
    this.#assertNoModeRun(chat, "enable collab");
    this.#requirePair(chat, "Collab");
    assertValidModeRounds(rounds);
    chat.collab.enabled = true;
    chat.collab.rounds = rounds;
    chat.collab.lastError = null;
    chat.xcheck.enabled = false;
    return this.current(chatKey);
  }

  collabOff(chatKey: string): DirectChatState {
    const chat = this.#chats.get(chatKey);
    if (!chat) {
      return this.#emptyState();
    }

    this.#assertNoModeRun(chat, "disable collab");
    chat.collab.enabled = false;
    chat.collab.lastError = null;
    return this.current(chatKey);
  }

  collabStop(chatKey: string): DirectChatState {
    const chat = this.#chats.get(chatKey);
    const run = chat?.collab.run;
    if (!chat || !run) {
      throw new Error("No collab run is currently active for this chat");
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
      collab: this.#snapshotCollab(chat),
    };
  }

  async detach(chatKey: string, agent?: DirectAgent): Promise<DirectChatState> {
    const chat = this.#chats.get(chatKey);
    if (!chat) {
      return this.#emptyState();
    }

    this.#assertNoModeRun(chat, "detach a session");

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
      chat.collab.enabled = false;
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
    let pair: DirectPair;
    try {
      pair = this.#requirePair(chat, "Xcheck");
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
      let draft = await pair.activeBinding.send(userText);
      await this.#pushOutput(
        outputs,
        {
          type: "agent",
          phase: "draft",
          result: draft,
        },
        options,
      );
      if (
        await this.#finalizeStoppedRun(
          chat.xcheck.run,
          outputs,
          options,
          "Xcheck",
          formatXcheckRunStep,
        )
      ) {
        return outputs;
      }

      for (let round = 1; round <= chat.xcheck.rounds; round += 1) {
        chat.xcheck.run.step = "reviewer-review";
        chat.xcheck.run.round = round;
        const review = await pair.otherBinding.send(
          buildXcheckReviewPrompt(pair.active, userText, draft.text, round, chat.xcheck.rounds),
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
        if (
          await this.#finalizeStoppedRun(
            chat.xcheck.run,
            outputs,
            options,
            "Xcheck",
            formatXcheckRunStep,
          )
        ) {
          return outputs;
        }

        if (round === chat.xcheck.rounds) {
          chat.xcheck.run.step = "owner-final";
          const final = await pair.activeBinding.send(
            buildXcheckFinalPrompt(pair.other, userText, review.text, round, chat.xcheck.rounds),
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
        draft = await pair.activeBinding.send(
          buildXcheckRevisionPrompt(pair.other, userText, review.text, round + 1, chat.xcheck.rounds),
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
        if (
          await this.#finalizeStoppedRun(
            chat.xcheck.run,
            outputs,
            options,
            "Xcheck",
            formatXcheckRunStep,
          )
        ) {
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

  async #runCollab(
    chat: DirectChatRuntime,
    userText: string,
    options?: DirectDispatchOptions,
  ): Promise<DirectDispatchOutput[]> {
    let pair: DirectPair;
    try {
      pair = this.#requirePair(chat, "Collab");
    } catch (err) {
      chat.collab.enabled = false;
      chat.collab.lastError = String(err);
      return await this.#withSingleOutput({ type: "system", text: `Collab was disabled: ${err}` }, options);
    }

    const outputs: DirectDispatchOutput[] = [];
    chat.collab.lastError = null;
    chat.collab.run = {
      step: "lead-turn",
      startedAt: Date.now(),
      stopRequested: false,
      round: 1,
      totalRounds: chat.collab.rounds,
    };

    try {
      let previousSpeaker = pair.active;
      let previousText = "";

      for (let round = 1; round <= chat.collab.rounds; round += 1) {
        const isLeadTurn = round % 2 === 1;
        const currentSpeaker = isLeadTurn ? pair.active : pair.other;
        const currentBinding = isLeadTurn ? pair.activeBinding : pair.otherBinding;

        chat.collab.run.step = isLeadTurn ? "lead-turn" : "partner-turn";
        chat.collab.run.round = round;

        const prompt =
          round === 1
            ? userText
            : round === 2
              ? buildCollabFirstRelayPrompt(previousSpeaker, userText, previousText)
              : buildCollabRelayPrompt(previousSpeaker, previousText);
        const response = await currentBinding.send(prompt);
        previousSpeaker = currentSpeaker;
        previousText = response.text;

        await this.#pushOutput(
          outputs,
          {
            type: "agent",
            phase: "collab",
            result: response,
          },
          options,
        );
        if (
          await this.#finalizeStoppedRun(
            chat.collab.run,
            outputs,
            options,
            "Collab",
            formatCollabRunStep,
          )
        ) {
          return outputs;
        }
      }

      return outputs;
    } catch (err) {
      chat.collab.lastError = String(err);
      const step = chat.collab.run?.step ?? "lead-turn";
      await this.#pushOutput(
        outputs,
        {
          type: "system",
          text: `Collab failed during ${formatCollabRunStep(step, chat.collab.run?.round, chat.collab.run?.totalRounds)}: ${err}`,
        },
        options,
      );
      return outputs;
    } finally {
      chat.collab.run = null;
    }
  }

  async #finalizeStoppedRun<Step extends string>(
    run: DirectModeRun<Step> | null,
    outputs: DirectDispatchOutput[],
    options: DirectDispatchOptions | undefined,
    modeName: string,
    formatStep: (step: Step, round: number | null | undefined, totalRounds: number | null | undefined) => string,
  ): Promise<boolean> {
    if (!run?.stopRequested) {
      return false;
    }

    await this.#pushOutput(
      outputs,
      {
        type: "system",
        text: `${modeName} stopped after ${formatStep(run.step, run.round, run.totalRounds)}.`,
      },
      options,
    );
    return true;
  }

  #snapshotXcheck(chat: DirectChatRuntime): DirectXcheckSnapshot {
    const { active: owner, other: reviewer } = this.#pairedAgents(chat);
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

  #snapshotCollab(chat: DirectChatRuntime): DirectCollabSnapshot {
    const { active: lead, other: partner } = this.#pairedAgents(chat);
    return {
      enabled: chat.collab.enabled,
      rounds: chat.collab.rounds,
      lead,
      partner,
      runState: chat.collab.run ? "running" : "idle",
      step: chat.collab.run?.step ?? null,
      round: chat.collab.run?.round ?? null,
      startedAt: chat.collab.run ? new Date(chat.collab.run.startedAt).toISOString() : null,
      stopRequested: chat.collab.run?.stopRequested ?? false,
      lastError: chat.collab.lastError,
    };
  }

  #pairedAgents(chat: DirectChatRuntime): { active: DirectAgent | null; other: DirectAgent | null } {
    const active = chat.activeTarget;
    if (!active) {
      return { active: null, other: null };
    }

    const other =
      active === "codex"
        ? chat.bindings.claude
          ? "claude"
          : null
        : chat.bindings.codex
          ? "codex"
          : null;

    return { active, other };
  }

  #requirePair(chat: DirectChatRuntime, modeName: "Xcheck" | "Collab"): DirectPair {
    const { active, other } = this.#pairedAgents(chat);
    if (!active || !other) {
      throw new Error(`${modeName} requires both codex and claude to be bound and an active target selected`);
    }

    const activeBinding = chat.bindings[active];
    const otherBinding = chat.bindings[other];
    if (!activeBinding || !otherBinding) {
      throw new Error(`${modeName} bindings are incomplete for this chat`);
    }

    return { active, other, activeBinding, otherBinding };
  }

  #activeModeRun(
    chat: DirectChatRuntime,
  ): { name: "xcheck"; run: DirectModeRun<DirectXcheckStep> } | { name: "collab"; run: DirectModeRun<DirectCollabStep> } | null {
    if (chat.xcheck.run) {
      return { name: "xcheck", run: chat.xcheck.run };
    }
    if (chat.collab.run) {
      return { name: "collab", run: chat.collab.run };
    }
    return null;
  }

  #assertNoModeRun(chat: DirectChatRuntime, action: string): void {
    const activeMode = this.#activeModeRun(chat);
    if (activeMode) {
      throw new Error(`Cannot ${action} while ${activeMode.name} is running`);
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
      collab: {
        enabled: false,
        rounds: 1,
        lead: null,
        partner: null,
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
        collab: {
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

function buildCollabFirstRelayPrompt(
  previousSpeaker: DirectAgent,
  userText: string,
  previousMessage: string,
): string {
  return [
    "Collaboration mode.",
    "",
    "### Original user message",
    userText,
    "",
    `### Previous message from ${previousSpeaker}`,
    previousMessage,
    "",
    "What do you think? Try your best to contribute something useful.",
  ].join("\n");
}

function buildCollabRelayPrompt(
  previousSpeaker: DirectAgent,
  previousMessage: string,
): string {
  return [
    "Collaboration mode.",
    "",
    `### Previous message from ${previousSpeaker}`,
    previousMessage,
    "",
    "What do you think? Try your best to contribute something useful.",
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

function formatCollabStep(step: DirectCollabStep): string {
  switch (step) {
    case "lead-turn":
      return "lead turn";
    case "partner-turn":
      return "partner turn";
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

function formatCollabRunStep(
  step: DirectCollabStep,
  round: number | null | undefined,
  totalRounds: number | null | undefined,
): string {
  const label = formatCollabStep(step);
  if (!round || !totalRounds) {
    return label;
  }
  return `${label} (turn ${round}/${totalRounds})`;
}

function assertValidModeRounds(rounds: number): void {
  if (!Number.isInteger(rounds) || rounds < 1) {
    throw new Error("Rounds must be a positive integer");
  }
}
