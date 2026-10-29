// `subagent_send`: a direct tool next to `subagent_stop`, for telling a running subagent something
// without stopping it.

import { Error as ToolError, type Info } from "@opencode/plugin/promise/tool";
import { Schema } from "effect";
import type {
  Logger,
  RunState,
  SessionID,
  SessionMessageInfo,
} from "@/core/ports";
import {
  continueNote,
  MESSAGE_MAX_CODE_POINTS,
  type SendDeps,
  SendError,
  type SendOptions,
  type SendResult,
  sendToSubagent,
} from "@/core/send";
import { activeToolNames } from "@/core/summarize";
import {
  errorMessage,
  pendingActions,
  RunStateSchema,
  sessionLabel,
  TOOL_PERMISSION,
  toToolError,
} from "@/tools/shared";

export const NAME = "subagent_send";

export const DESCRIPTION =
  "Send a message to one of your running subagents without stopping it, for example to correct or add to its instructions. It never interrupts: the subagent reads the message after its current tool calls finish, or only after someone answers a permission prompt it is waiting on. To redirect a subagent right away, stop it with subagent_stop and continue it with subagent. For an idle subagent, use subagent with its sessionID instead.";

export const Input = Schema.Struct({
  sessionID: Schema.String.annotate({
    description:
      "The sessionID of a running subagent you launched, or one launched below it.",
  }),
  message: Schema.String.annotate({
    description: `What to tell it, at most ${MESSAGE_MAX_CODE_POINTS} characters. Line breaks, indentation, lists, and code arrive as you write them.`,
  }),
});

export const Output = Schema.Struct({
  sessionID: Schema.String,
  title: Schema.optionalKey(Schema.String),
  agent: Schema.optionalKey(Schema.String),
  status: Schema.Literals([
    "sent",
    "delivered",
    "queued",
    "unconfirmed",
  ]).annotate({
    description:
      "sent: it is running, or its state is unknown, and has not read the message yet; it reads it at its next step. delivered: it has already read the message, and may have finished its run since. queued: it finished its run without reading the message, which waits until it is next continued. unconfirmed: it finished its run, and whether it read the message first could not be checked; if it did not, the message waits until it is next continued.",
  }),
  state: RunStateSchema.annotate({
    description: "Its run state right after the message was sent.",
  }),
  activeTools: Schema.Array(Schema.String).annotate({
    description:
      "Tool calls it is running, which finish before it reads the message. Empty unless status is sent.",
  }),
  waitingOnPermission: Schema.Boolean.annotate({
    description:
      "It is waiting on a permission prompt and reads the message only after someone answers. False unless status is sent.",
  }),
  note: Schema.String,
});

export type SendOutput = typeof Output.Type;

export interface SendToolDeps extends SendDeps {
  readonly logger: Logger;
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
          { callerID: context.sessionID, signal: context.signal },
          input,
          options,
        );
        // Core has already recorded a cancelled call as aborted and ignores this result.
        if (result === undefined) {
          throw new ToolError({
            message: "The call was cancelled; nothing was sent.",
          });
        }
        const output = await describeResult(deps, result);
        return { output, content: renderSendResult(output) };
      } catch (error) {
        if (error instanceof SendError) {
          throw new ToolError({ message: error.message });
        }
        throw toToolError(error);
      }
    },
  };
}

const UNKNOWN_BEFORE_NOTE =
  "Its run state could not be determined before sending.";

const REDIRECT_NOTE =
  "Sending never interrupts; to redirect it right away, stop it with subagent_stop and continue it with subagent.";

const CONTINUE_NOW_NOTE =
  "To continue it now, call subagent with its sessionID.";

/**
 * Classifies the send from the target's messages read after the second observation: a message
 * among them has been read; otherwise a running target reads it at its next step, and an idle one
 * has not read it. The messages are those since the last compaction, so when they cannot be read,
 * or include a completed compaction that started at or after the message was admitted, an idle
 * target's delivery cannot be checked.
 */
async function describeResult(
  deps: SendToolDeps,
  result: SendResult,
): Promise<SendOutput> {
  const { target, messageID, postedAt, before, after } = result;
  const base = {
    sessionID: target.id,
    ...(target.info.title === undefined ? {} : { title: target.info.title }),
    ...(target.info.agent === undefined ? {} : { agent: target.info.agent }),
    state: after,
  };
  const unknownBefore = before === "unknown" ? `${UNKNOWN_BEFORE_NOTE} ` : "";
  const [messages, pending] = await Promise.all([
    readContext(deps, target.id),
    after === "idle" ? [] : pendingActions(deps.reader, deps.logger, target.id),
  ]);
  const unsent = { activeTools: [], waitingOnPermission: false };
  if (messages?.some((message) => message.id === messageID) === true) {
    return {
      ...base,
      status: "delivered",
      ...unsent,
      note: `${unknownBefore}${after === "idle" ? "It read your message, then finished its run." : "It has already read your message."}`,
    };
  }
  if (after === "idle") {
    const continueNow = continueNote(target, CONTINUE_NOW_NOTE);
    if (messages === undefined || compactedSince(messages, postedAt)) {
      const why =
        messages === undefined
          ? "its messages could not be read"
          : "its context was compacted since";
      return {
        ...base,
        status: "unconfirmed",
        ...unsent,
        note: `${unknownBefore}It finished its run, and whether it read your message first cannot be checked: ${why}. If it did not, the message waits in its queue and is delivered when it is next continued. ${continueNow}`,
      };
    }
    return {
      ...base,
      status: "queued",
      ...unsent,
      note: `${unknownBefore}It finished its run before reading your message, so the message waits in its queue and is delivered when it is next continued. ${continueNow}`,
    };
  }
  const activeTools = messages === undefined ? [] : activeToolNames(messages);
  return {
    ...base,
    status: "sent",
    activeTools,
    waitingOnPermission: pending.length > 0,
    note: sentNote(before, after, activeTools, pending),
  };
}

function sentNote(
  before: RunState,
  after: Exclude<RunState, "idle">,
  activeTools: readonly string[],
  pending: readonly string[],
): string {
  const unknownBefore = before === "unknown" ? `${UNKNOWN_BEFORE_NOTE} ` : "";
  if (pending.length > 0) {
    const state =
      after === "unknown"
        ? `Its run state could not be determined${before === "unknown" ? "" : " after sending"}. `
        : unknownBefore;
    return `${state}It is waiting on a permission prompt (${pending.join(", ")}), so it reads your message only after someone answers it. Only a person can answer it, in OpenCode.`;
  }
  const when =
    activeTools.length > 0
      ? `after its current tool calls finish: ${activeTools.join(", ")}`
      : "once its current model response finishes";
  if (after === "unknown") {
    const moment = before === "unknown" ? "" : " after sending";
    return `Its run state could not be determined${moment}. If it is running, it reads your message ${when}; if it is idle, the message waits until it is next continued.`;
  }
  return `${unknownBefore}It reads your message ${when}. ${REDIRECT_NOTE}`;
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

const OUTCOME_TEXT: Readonly<Record<SendOutput["status"], string>> = {
  sent: "sent to",
  delivered: "delivered to",
  queued: "queued for",
  unconfirmed: "sent to",
};

/** Plain-text rendering of the result, which is what the model reads from a direct call. */
export function renderSendResult(output: SendOutput): string {
  return `Message ${OUTCOME_TEXT[output.status]} ${output.sessionID}${sessionLabel(output)}. ${output.note}`;
}
