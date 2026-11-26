// `subagent_send`: a direct tool next to `subagent_stop`, for telling a running subagent something,
// or switching its agent or model, without stopping it.

import {
  Error as ToolError,
  type Info,
  type ToolContext,
} from "@opencode/plugin/promise/tool";
import { Schema } from "effect";
import { activityPhase, type SessionActivity } from "@/core/activity";
import type { Descendant } from "@/core/ancestry";
import type {
  Logger,
  RunState,
  SessionID,
  SessionInfo,
  SessionMessageInfo,
} from "@/core/ports";
import type { RunStateTracker } from "@/core/run-state";
import {
  continueNote,
  MESSAGE_MAX_CODE_POINTS,
  type SendDeps,
  SendError,
  type SendOptions,
  type SendResult,
  sendToSubagent,
} from "@/core/send";
import {
  type ActiveToolTime,
  activeToolTimes,
  formatDuration,
  sinceCompaction,
} from "@/core/summarize";
import {
  agentChange,
  describeChanges,
  formatModelRef,
  modelChange,
  NOTHING_SWITCHED,
  sameModel,
  SwitchError,
  type SwitchPlan,
  switchedValues,
} from "@/core/switch";
import {
  errorMessage,
  modelName,
  pendingActions,
  RunStateSchema,
  sessionLabel,
  TOOL_PERMISSION,
  toToolErrorWithSuggestions,
} from "@/tools/shared";

export const NAME = "subagent_send";

export const DESCRIPTION =
  "Send a message to one of your running subagents without stopping it, for example to correct or add to its instructions, and optionally switch its model or agent. It reaches subagents launched by your subagents too. It never interrupts: the subagent reads the message, and starts using a new model or agent, at its next model request, after its current tool calls finish, or only after someone answers a permission prompt it is waiting on. To redirect a subagent right away, stop it with subagent_stop and continue it with subagent. For an idle subagent, use subagent with its sessionID instead.";

export const Input = Schema.Struct({
  sessionID: Schema.String.annotate({
    description:
      "The sessionID of a running subagent you launched, or one launched below it. Surrounding whitespace is ignored.",
  }),
  message: Schema.optionalKey(Schema.String).annotate({
    description: `What to tell it, at most ${MESSAGE_MAX_CODE_POINTS} characters. Line breaks, indentation, lists, and code arrive as you write them. Optional when you give model or agent; give at least one of the three.`,
  }),
  model: Schema.optionalKey(Schema.String).annotate({
    description:
      'Switch it to this model. Only set this when the user asks for a particular model or variant. It must be an available chat model. The value is written as "providerID/modelID", or "providerID/modelID#variant" to include a variant. It makes its next model request with this model.',
  }),
  agent: Schema.optionalKey(Schema.String).annotate({
    description:
      "Switch it to this agent: one that can run as a subagent and that you are allowed to launch. Without model, it also switches to the agent's configured model, if the agent has one. It makes its next model request as this agent.",
  }),
});

const ChangeSchema = Schema.Struct({
  from: Schema.optionalKey(Schema.String).annotate({
    description:
      "What it had before; absent when it had none recorded and ran OpenCode's default.",
  }),
  to: Schema.String,
});

export const Output = Schema.Struct({
  sessionID: Schema.String,
  title: Schema.optionalKey(Schema.String),
  agent: Schema.optionalKey(Schema.String).annotate({
    description: "Its agent, after any switch.",
  }),
  status: Schema.optionalKey(
    Schema.Literals(["sent", "delivered", "queued", "unconfirmed"]),
  ).annotate({
    description:
      "sent: it is running, or its state is unknown, and has not read the message yet; it reads it at its next step. delivered: it has already read the message, and may have finished its run since. queued: it finished its run without reading the message, which waits until it is next continued. unconfirmed: it finished its run, and whether it read the message first could not be checked; if it did not, the message waits until it is next continued. Absent when the call carried no message.",
  }),
  switched: Schema.optionalKey(
    Schema.Struct({
      agent: Schema.optionalKey(ChangeSchema),
      model: Schema.optionalKey(ChangeSchema).annotate({
        description: "Models are written as providerID/modelID#variant.",
      }),
    }),
  ).annotate({
    description:
      "What was switched. It makes its next model request with the new agent and model. Absent when nothing was switched.",
  }),
  state: RunStateSchema.annotate({
    description:
      "Its run state right after the message was sent, or after the switch when there was no message.",
  }),
  activeTools: Schema.Array(Schema.String).annotate({
    description:
      "Tool calls it is running, which finish before its next model request. Empty unless it is running and has not read the message.",
  }),
  waitingOnPermission: Schema.Boolean.annotate({
    description:
      "It is waiting on a permission prompt and makes its next model request only after someone answers. False unless it is running and has not read the message.",
  }),
  lastActivityAt: Schema.optionalKey(Schema.Number).annotate({
    description:
      "When it last made progress, in epoch milliseconds, as this plugin instance observed it. Absent when it has observed none.",
  }),
  note: Schema.String.annotate({
    description:
      "When it reads the message and starts using what was switched, with how long its current tool calls or model response have been going.",
  }),
});

export type SendOutput = typeof Output.Type;

/** One check that the caller may run an agent as a subagent, as `ctx.permission.assert` takes it. */
export interface SubagentPermissionRequest {
  readonly sessionID: string;
  readonly agent: string;
  readonly messageID: string;
  readonly callID: string;
  /** The agent the subagent is switched to: the permission resource. */
  readonly subagent: string;
}

export interface SendToolDeps extends SendDeps {
  readonly logger: Logger;
  /** `observeAll` gives the state of the IDs suggested for a mistyped target. */
  readonly runState: Pick<RunStateTracker, "observe" | "observeAll">;
  /**
   * Checks the `subagent` permission for the agent switched to, as OpenCode does before it runs an
   * agent as a subagent. Resolves when allowed. It asks a person only when the caller's rules say to
   * ask; a deny rule or a refusal rejects, and the rejection must propagate out of the tool.
   */
  readonly assertSubagent: (request: SubagentPermissionRequest) => Promise<void>;
}

export function sendTool(
  deps: SendToolDeps,
  options: SendOptions = {},
): Info<typeof Input, typeof Output> {
  return {
    name: NAME,
    description: DESCRIPTION,
    input: Input,
    output: Output,
    options: { codemode: false, permission: TOOL_PERMISSION },
    execute: async (input, context) => {
      try {
        const result = await sendToSubagent(
          deps,
          {
            callerID: context.sessionID,
            signal: context.signal,
            confirmAgent: (agent) => confirmAgent(deps, context, agent),
          },
          input,
          options,
        );
        // Core has already recorded a cancelled call as aborted and ignores this result.
        if (result === undefined) {
          const switching = [input.model, input.agent].some(
            (value) => value !== undefined && value.trim() !== "",
          );
          throw new ToolError({
            message: `The call was cancelled; ${switching ? "nothing was switched or sent" : "nothing was sent"}.`,
          });
        }
        const output = await describeResult(deps, result);
        return { output, content: renderSendResult(output) };
      } catch (error) {
        if (error instanceof SendError || error instanceof SwitchError) {
          throw new ToolError({ message: error.message });
        }
        throw await toToolErrorWithSuggestions(error, deps, context.sessionID);
      }
    },
  };
}

/**
 * Asserts the permission for `agent`. A deny rule or a refusal with feedback becomes the call's
 * failure; a plain refusal is rethrown unchanged, because it must end the caller's step.
 */
async function confirmAgent(
  deps: SendToolDeps,
  context: ToolContext,
  agent: string,
): Promise<void> {
  try {
    await deps.assertSubagent({
      sessionID: context.sessionID,
      agent: context.agent,
      messageID: context.messageID,
      callID: context.id,
      subagent: agent,
    });
  } catch (error) {
    const message = toolErrorMessage(error)?.trim();
    if (message === undefined) throw error;
    const reason =
      message === ""
        ? "no reason was given."
        : /[.!?]$/.test(message)
          ? message
          : `${message}.`;
    throw new SendError(
      `Running agent ${agent} as a subagent was refused: ${reason} ${NOTHING_SWITCHED}`,
    );
  }
}

/**
 * The message of a `Tool.Error`, recognized by its tag as well, since the host's class can differ
 * from the one this plugin imports; undefined for any other error.
 */
function toolErrorMessage(error: unknown): string | undefined {
  if (error instanceof ToolError) return error.message;
  if (
    typeof error === "object" &&
    error !== null &&
    "_tag" in error &&
    error._tag === "Tool.Error" &&
    "message" in error &&
    typeof error.message === "string"
  ) {
    return error.message;
  }
  return undefined;
}

const REDIRECT_NOTE =
  "Sending never interrupts; to redirect it right away, stop it with subagent_stop and continue it with subagent.";

const SWITCH_REDIRECT_NOTE =
  "Switching never interrupts; to redirect it right away, stop it with subagent_stop and continue it with subagent.";

const CONTINUE_NOW_NOTE =
  "To continue it now, call subagent with its sessionID.";

/** What a send or switch reported in its note depends on. */
interface Described {
  readonly target: Descendant;
  readonly before: RunState;
  readonly after: RunState;
  /** `agent and model`, `agent` or `model`: what the call changed; undefined when nothing. */
  readonly what: string | undefined;
  /** Sentences about what the call asked for that it did not change, or where a model came from. */
  readonly facts: readonly string[];
  /** For a direct child whose agent changed: how continuing it with `subagent` keeps that agent. */
  readonly agentNote: string | undefined;
}

/**
 * Classifies the send from the target's messages read after the second observation: a message
 * among them has been read; otherwise a running target reads it at its next step, and an idle one
 * has not read it. The messages are those since the last compaction, so when they cannot be read,
 * or include a completed compaction that started at or after the message was admitted, an idle
 * target's delivery cannot be checked. A call with no message reports when the switch takes effect.
 */
async function describeResult(
  deps: SendToolDeps,
  result: SendResult,
): Promise<SendOutput> {
  const { target, posted, before, after } = result;
  const plan = result.switch;
  const values = plan === undefined ? {} : switchedValues(plan);
  const live = deps.activity?.get(target.id);
  const agent = values.agent?.to ?? target.info.agent;
  const base = {
    sessionID: target.id,
    ...(target.info.title === undefined ? {} : { title: target.info.title }),
    ...(agent === undefined ? {} : { agent }),
    ...(values.agent === undefined && values.model === undefined
      ? {}
      : { switched: values }),
    state: after,
    ...(live?.lastProgressAt === undefined
      ? {}
      : { lastActivityAt: live.lastProgressAt }),
  };
  const described: Described = {
    target,
    before,
    after,
    what: plan === undefined ? undefined : changedWhat(plan),
    facts: plan === undefined ? [] : switchFacts(plan, target.info),
    agentNote: plan === undefined ? undefined : agentNote(plan, target),
  };
  const [messages, pending] = await Promise.all([
    readContext(deps, target.id),
    after === "idle" ? [] : pendingActions(deps.reader, deps.logger, target.id),
  ]);
  const unsent = { activeTools: [], waitingOnPermission: false };
  const note = (...parts: ReadonlyArray<string | undefined>) =>
    [...described.facts, ...parts, described.agentNote]
      .filter((part) => part !== undefined && part !== "")
      .join(" ");

  if (posted === undefined) {
    if (described.what === undefined) {
      return { ...base, ...unsent, note: note() };
    }
    if (after === "idle") {
      return {
        ...base,
        ...unsent,
        note: note(
          unknownBefore(before, "switching"),
          `It finished its run; when it is next continued, it runs with the new ${described.what}.`,
          continueNote(target, CONTINUE_NOW_NOTE),
        ),
      };
    }
    const activeTools = messages === undefined ? [] : activeToolTimes(messages);
    return {
      ...base,
      activeTools: activeTools.map((tool) => tool.name),
      waitingOnPermission: pending.length > 0,
      note: note(
        switchedNote(described, described.what, pending, {
          now: deps.clock.now(),
          tools: activeTools,
          live,
          storedResponseStart:
            messages === undefined ? undefined : openResponseStart(messages),
        }),
      ),
    };
  }

  const sinceSwitch =
    described.what === undefined
      ? undefined
      : `Every model request it starts after the switch uses the new ${described.what}.`;
  if (messages?.some((message) => message.id === posted.messageID) === true) {
    return {
      ...base,
      status: "delivered",
      ...unsent,
      note: note(
        unknownBefore(before, "sending"),
        after === "idle"
          ? "It read your message, then finished its run."
          : "It has already read your message.",
        sinceSwitch,
      ),
    };
  }
  if (after === "idle") {
    const continueNow = continueNote(target, CONTINUE_NOW_NOTE);
    const nextRun =
      described.what === undefined
        ? undefined
        : `When it is next continued, it runs with the new ${described.what}.`;
    if (messages === undefined || compactedSince(messages, posted.postedAt)) {
      const why =
        messages === undefined
          ? "its messages could not be read"
          : "its context was compacted since";
      return {
        ...base,
        status: "unconfirmed",
        ...unsent,
        note: note(
          unknownBefore(before, "sending"),
          `It finished its run, and whether it read your message first cannot be checked: ${why}. If it did not, the message waits in its queue and is delivered when it is next continued.`,
          nextRun,
          continueNow,
        ),
      };
    }
    return {
      ...base,
      status: "queued",
      ...unsent,
      note: note(
        unknownBefore(before, "sending"),
        "It finished its run before reading your message, so the message waits in its queue and is delivered when it is next continued.",
        nextRun,
        continueNow,
      ),
    };
  }
  const activeTools = messages === undefined ? [] : activeToolTimes(messages);
  return {
    ...base,
    status: "sent",
    activeTools: activeTools.map((tool) => tool.name),
    waitingOnPermission: pending.length > 0,
    note: note(
      sentNote(described, pending, {
        now: deps.clock.now(),
        tools: activeTools,
        live,
        storedResponseStart:
          messages === undefined ? undefined : openResponseStart(messages),
      }),
    ),
  };
}

/** The values the plan changes, as `agent and model`, `agent` or `model`; undefined for none. */
function changedWhat(plan: SwitchPlan): string | undefined {
  const agent = agentChange(plan) !== undefined;
  const model = modelChange(plan) !== undefined;
  if (agent && model) return "agent and model";
  if (agent) return "agent";
  if (model) return "model";
  return undefined;
}

/**
 * What the plan asked for that was already in effect, and where a model came from when the agent
 * switched without one, each as a sentence. With nothing changed, it opens with `Nothing was
 * switched.`
 */
function switchFacts(plan: SwitchPlan, info: SessionInfo): string[] {
  const facts: string[] = [];
  const { agent, model } = plan;
  if (agent !== undefined && agent.from === agent.to) {
    facts.push(`It already runs agent ${agent.to}.`);
  }
  if (model !== undefined) {
    const name = formatModelRef(model.to);
    if (model.source === "agent") {
      facts.push(
        sameModel(model.from, model.to)
          ? `It keeps model ${name}, the configured model of agent ${agent?.to}.`
          : `${name} is the configured model of agent ${agent?.to}.`,
      );
    } else if (sameModel(model.from, model.to)) {
      facts.push(`It already uses model ${name}.`);
    }
  } else if (agentChange(plan) !== undefined) {
    const current = modelName(info);
    facts.push(
      `It keeps ${current === undefined ? "its model" : `model ${current}`}, since agent ${agent?.to} has no configured model.`,
    );
  }
  return changedWhat(plan) === undefined
    ? ["Nothing was switched.", ...facts]
    : facts;
}

/**
 * Only a direct child can be continued with `subagent`, and `subagent` switches the child to the
 * agent it names, so the parent must name the new one to keep it.
 */
function agentNote(plan: SwitchPlan, target: Descendant): string | undefined {
  const agent = agentChange(plan);
  if (agent === undefined || target.depth !== 1) return undefined;
  return `If you continue it later with subagent, pass agent ${agent.to}: any other agent name switches its agent again.`;
}

function unknownBefore(before: RunState, act: "sending" | "switching"): string {
  return before === "unknown"
    ? `Its run state could not be determined before ${act}.`
    : "";
}

/** What the sent note says about the target's current work. */
interface Progress {
  readonly now: number;
  readonly tools: readonly ActiveToolTime[];
  readonly live: SessionActivity | undefined;
  /** When the latest stored model response started, if it has not completed. */
  readonly storedResponseStart: number | undefined;
}

function sentNote(
  described: Described,
  pending: readonly string[],
  progress: Progress,
): string {
  const { before, after, what } = described;
  const switched =
    what === undefined
      ? ""
      : ` It uses the new ${what} from its next model request.`;
  const prefix = unknownBefore(before, "sending");
  const unknownBeforeNote = prefix === "" ? "" : `${prefix} `;
  if (pending.length > 0) {
    const state =
      after === "unknown"
        ? `Its run state could not be determined${before === "unknown" ? "" : " after sending"}. `
        : unknownBeforeNote;
    return `${state}It is waiting on a permission prompt (${pending.join(", ")}), so it reads your message only after someone answers it. Only a person can answer it, in OpenCode.${switched}`;
  }
  const when = whenRead(progress);
  if (after === "unknown") {
    const moment = before === "unknown" ? "" : " after sending";
    return `Its run state could not be determined${moment}. If it is running, it reads your message ${when}; if it is idle, the message waits until it is next continued.${switched}`;
  }
  return `${unknownBeforeNote}It reads your message ${when}.${switched} ${REDIRECT_NOTE}`;
}

/** When a running target, given no message, starts using what was switched. */
function switchedNote(
  described: Described,
  what: string,
  pending: readonly string[],
  progress: Progress,
): string {
  const { before, after } = described;
  const prefix = unknownBefore(before, "switching");
  const unknownBeforeNote = prefix === "" ? "" : `${prefix} `;
  if (pending.length > 0) {
    const state =
      after === "unknown"
        ? `Its run state could not be determined${before === "unknown" ? "" : " after switching"}. `
        : unknownBeforeNote;
    return `${state}It is waiting on a permission prompt (${pending.join(", ")}), so its next model request, the first with the new ${what}, starts only after someone answers it. Only a person can answer it, in OpenCode.`;
  }
  const when = whenNextRequest(progress);
  if (after === "unknown") {
    const moment = before === "unknown" ? "" : " after switching";
    return `Its run state could not be determined${moment}. If it is running, it uses the new ${what} from its next model request, which starts ${when}; if it is idle, from its next run.`;
  }
  return `${unknownBeforeNote}It uses the new ${what} from its next model request, which starts ${when}. ${SWITCH_REDIRECT_NOTE}`;
}

/**
 * When the target makes its next model request. OpenCode retries a failed request with the
 * session's agent and model read again, so during a retry delay that is the retry.
 */
function whenNextRequest(progress: Progress): string {
  const { now, tools, live } = progress;
  if (
    tools.length === 0 &&
    live !== undefined &&
    activityPhase(live, now) === "retry"
  ) {
    return `when it retries a failed model request${live.retryAt === undefined ? "" : `, due in ${formatDuration(live.retryAt - now)}`}`;
  }
  return whenRead(progress);
}

/**
 * When the target reads the message, with ages: its tool calls from their stored start times, and
 * a model response from live events, or from the stored message when the instance saw none.
 */
function whenRead(progress: Progress): string {
  const { now, tools, live } = progress;
  const ago = (at: number) => `${formatDuration(Math.max(0, now - at))} ago`;
  if (tools.length > 0) {
    const listed = tools.map(
      (tool) =>
        `${tool.name} (${tool.status} ${formatDuration(Math.max(0, now - tool.since))})`,
    );
    return `after its current tool calls finish: ${listed.join(", ")}`;
  }
  const finishes = "once its current model response finishes";
  if (live === undefined) {
    return progress.storedResponseStart === undefined
      ? finishes
      : `${finishes}; the response started ${ago(progress.storedResponseStart)}`;
  }
  const last =
    live.lastProgressAt === undefined
      ? ""
      : ` and last produced output ${ago(live.lastProgressAt)}`;
  switch (activityPhase(live, now)) {
    case "retry":
      return `${finishes}; it is waiting to retry a failed model request${live.retryAt === undefined ? "" : `, due in ${formatDuration(live.retryAt - now)}`}`;
    case "between":
      return `at its next step${live.lastProgressAt === undefined ? "" : `; its last activity was ${ago(live.lastProgressAt)}`}`;
    default:
      return live.responseStartedAt === undefined
        ? `${finishes}${live.lastProgressAt === undefined ? "" : `; it last produced output ${ago(live.lastProgressAt)}`}`
        : `${finishes}; the response started ${ago(live.responseStartedAt)}${last}`;
  }
}

/** When the latest stored assistant message started, while it has not completed. */
function openResponseStart(
  messages: readonly SessionMessageInfo[],
): number | undefined {
  const latest = sinceCompaction(messages).assistants.at(-1);
  if (latest === undefined || latest.time.completed !== undefined) {
    return undefined;
  }
  return latest.time.created;
}

/**
 * Whether a completed compaction started at or after `postedAt`. A compaction message's
 * `time.created` is when it started, and only one that started after admission can hide a
 * message delivered after admission.
 */
function compactedSince(
  messages: readonly SessionMessageInfo[],
  postedAt: number,
): boolean {
  return messages.some(
    (message) =>
      message.type === "compaction" &&
      message.status === "completed" &&
      message.time.created >= postedAt,
  );
}

/** The target's messages since its last compaction; undefined, with a warning, when unreadable. */
async function readContext(
  deps: SendToolDeps,
  sessionID: SessionID,
): Promise<readonly SessionMessageInfo[] | undefined> {
  try {
    return await deps.reader.context(sessionID);
  } catch (error) {
    deps.logger.warn("send: could not read the subagent's context", {
      sessionID,
      error: errorMessage(error),
    });
    return undefined;
  }
}

type Status = NonNullable<SendOutput["status"]>;

const OUTCOME_TEXT: Readonly<Record<Status, string>> = {
  sent: "sent to",
  delivered: "delivered to",
  queued: "queued for",
  unconfirmed: "sent to",
};

const SWITCHED_OUTCOME_TEXT: Readonly<Record<Status, string>> = {
  sent: "Message sent.",
  delivered: "Message delivered.",
  queued: "Message queued.",
  unconfirmed: "Message sent.",
};

/** Plain-text rendering of the result, which is what the model reads from a direct call. */
export function renderSendResult(output: SendOutput): string {
  const label = sessionLabel(output);
  const changes =
    output.switched === undefined ? undefined : describeChanges(output.switched);
  if (changes !== undefined) {
    const message =
      output.status === undefined
        ? ""
        : ` ${SWITCHED_OUTCOME_TEXT[output.status]}`;
    return `Switched ${output.sessionID}${label} ${changes}.${message} ${output.note}`;
  }
  if (output.status === undefined) {
    return `${output.sessionID}${label}: ${output.note}`;
  }
  return `Message ${OUTCOME_TEXT[output.status]} ${output.sessionID}${label}. ${output.note}`;
}
