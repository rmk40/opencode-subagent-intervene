// Sends a message from a parent to one of its running subagents without stopping it. The message is
// steered into the subagent's inbox without a wake, so a running subagent reads it at its next step
// boundary and an idle one is never started: a run the plugin starts has no subagent job, so its
// result would never reach the parent.

import { assertDescendant, type Descendant } from "@/core/ancestry";
import type { Latch } from "@/core/latch";
import {
  PLUGIN_ID,
  type RunState,
  type SessionID,
  type SessionMessenger,
  type SessionReader,
} from "@/core/ports";
import type { RunStateTracker } from "@/core/run-state";
import { sanitizeBlock, sanitizeText } from "@/core/sanitize";
import { CONTINUE_NESTED_NOTE, CONTINUE_OWN_NOTE } from "@/core/stop";

export const MESSAGE_MAX_CODE_POINTS = 8000;
/** The element that wraps a parent message in the text the subagent reads. */
export const MESSAGE_WRAPPER = "parent-message";
/** Shown to people in OpenCode next to the message. */
export const MESSAGE_DESCRIPTION = "Message from parent";
/** `kind` in the metadata of a parent message. */
export const MESSAGE_KIND = "parent-message";
/** Cap on the caller's session ID inside the message markup. */
const CALLER_ID_MAX_CODE_POINTS = 100;

const CONTINUE_IDLE_NOTE =
  "To give it your message, continue it: call subagent with its sessionID and the message.";

/** Nothing was sent. The message is written for the calling model. */
export class SendError extends Error {
  override name = "SendError";
}

export interface SendDeps {
  readonly reader: SessionReader;
  readonly messenger: SessionMessenger;
  readonly latch: Pick<Latch, "isActive">;
  readonly runState: Pick<RunStateTracker, "observe">;
}

export interface SendCall {
  readonly callerID: SessionID;
  /** Aborted when the calling tool call is interrupted. */
  readonly signal: AbortSignal;
}

export interface SendRequest {
  readonly sessionID: SessionID;
  /** Model-written; sanitized before it is sent. */
  readonly message: string;
}

export interface SendOptions {
  /** Whether stopped sessions are kept stopped. With it on, a stopped target is refused. Default true. */
  readonly latch?: boolean;
}

export interface SendResult {
  readonly target: Descendant;
  /**
   * The message's inbox item ID. Core keeps it as the message's ID once the message is delivered,
   * so finding it among the target's messages shows the target has read it.
   */
  readonly messageID: string;
  /** When the message was admitted, in epoch milliseconds. */
  readonly postedAt: number;
  /** Run state observed before the message was posted: running or unknown. */
  readonly before: RunState;
  /** Run state observed right after the message was admitted. */
  readonly after: RunState;
}

/**
 * Steers the message into a running subagent of the caller. Throws `SendError` or an
 * `AncestryError` before anything is sent: a stopped or idle target is refused. Resolves
 * `undefined` when `call.signal` aborts before the message is posted, and then sends nothing.
 */
export async function sendToSubagent(
  deps: SendDeps,
  call: SendCall,
  request: SendRequest,
  options: SendOptions = {},
): Promise<SendResult | undefined> {
  const latching = options.latch ?? true;
  const message = sanitizeMessage(request.message);
  const target = await assertDescendant(
    deps.reader,
    request.sessionID,
    call.callerID,
  );
  if (latching && (await deps.latch.isActive(target.id))) {
    throw new SendError(
      `Subagent ${target.id} is stopped, so nothing was sent. ${continueNote(target, CONTINUE_OWN_NOTE)}`,
    );
  }
  const before = await deps.runState.observe(target.id);
  if (before.state === "idle") {
    throw new SendError(
      `Subagent ${target.id} is idle, so nothing was sent: a message only reaches a running subagent. ${continueNote(target, CONTINUE_IDLE_NOTE)}`,
    );
  }
  if (call.signal.aborted) return undefined;

  const posted = await deps.messenger.synthetic({
    sessionID: target.id,
    text: renderParentMessage(call.callerID, message),
    description: MESSAGE_DESCRIPTION,
    metadata: { plugin: PLUGIN_ID, kind: MESSAGE_KIND, from: call.callerID },
    delivery: "steer",
    resume: false,
  });

  const after = await deps.runState.observe(target.id);
  return {
    target,
    messageID: posted.id,
    postedAt: posted.createdAt,
    before: before.state,
    after: after.state,
  };
}

/**
 * The text the subagent reads: the message from `sanitizeBlock`, on lines of its own between the
 * tags that mark it as coming from the caller.
 */
export function renderParentMessage(
  callerID: SessionID,
  message: string,
): string {
  const from = sanitizeText(callerID, CALLER_ID_MAX_CODE_POINTS).text;
  return `<${MESSAGE_WRAPPER} from="${from}">\n${message}\n</${MESSAGE_WRAPPER}>`;
}

/**
 * `own` for a direct child of the caller. Only a session's own parent can continue it, so for a
 * deeper target the note names that parent instead.
 */
export function continueNote(target: Descendant, own: string): string {
  return target.depth === 1
    ? own
    : `${CONTINUE_NESTED_NOTE} This one was launched by ${target.parentID}.`;
}

function sanitizeMessage(raw: string): string {
  const text = sanitizeBlock(raw, MESSAGE_WRAPPER);
  if (text === "") {
    throw new SendError("message must contain visible text; nothing was sent.");
  }
  const length = [...text].length;
  if (length > MESSAGE_MAX_CODE_POINTS) {
    throw new SendError(
      `The message is ${length} characters long; keep it to ${MESSAGE_MAX_CODE_POINTS} at most. Nothing was sent.`,
    );
  }
  return text;
}
