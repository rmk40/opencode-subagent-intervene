// Sends a message from a parent to one of its running subagents without stopping it. The message is
// steered into the subagent's inbox without a wake, so a running subagent reads it at its next step
// boundary and an idle one is never started: a run the plugin starts has no subagent job, so its
// result would never reach the parent.

import { type ActivityTracker, idleSince } from "@/core/activity";
import { assertDescendant, type Descendant } from "@/core/ancestry";
import { overLimit } from "@/core/errors";
import type { Latch } from "@/core/latch";
import {
  type Clock,
  PLUGIN_ID,
  type RunState,
  type SessionID,
  type SessionInfo,
  type SessionMessenger,
  type SessionReader,
} from "@/core/ports";
import type { RunStateTracker } from "@/core/run-state";
import { sanitizeBlock, sanitizeText } from "@/core/sanitize";
import { CONTINUE_NESTED_NOTE, CONTINUE_OWN_NOTE } from "@/core/stop";
import { formatDuration } from "@/core/summarize";

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
  readonly clock: Pick<Clock, "now">;
  /** Live activity, for the target's last activity. Without it, none is known. */
  readonly activity?: Pick<ActivityTracker, "get">;
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
 * `AncestryError` before anything is sent: a stopped or idle target is refused, and so is one
 * OpenCode reports idle although its last run recorded no end, since nothing would read the
 * message until it is continued. Resolves `undefined` when `call.signal` aborts before the message
 * is posted, and then sends nothing. Surrounding whitespace in the session ID is ignored.
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
    request.sessionID.trim(),
    call.callerID,
  );
  if (latching && (await deps.latch.isActive(target.id))) {
    throw new SendError(
      `Subagent ${target.id} is stopped, so nothing was sent. ${continueNote(target, CONTINUE_OWN_NOTE)}`,
    );
  }
  const before = await deps.runState.observe(target.id, target.info);
  if (before.state === "idle") {
    // Read again: the session may have ended its run since the ancestry check read it.
    const info = (await deps.reader.get(target.id)) ?? target.info;
    throw new SendError(
      before.noRecordedEnd === true
        ? `Subagent ${target.id} is not running, so nothing was sent: OpenCode reports it idle, but its last run recorded no end, so the message would not be read until it is continued with subagent. ${unendedAge(deps, target.id)} ${continueNote(target, CONTINUE_IDLE_NOTE)}`
        : `Subagent ${target.id} is idle, so nothing was sent: a message only reaches a running subagent. ${idleAge(info, deps.clock.now())} ${continueNote(target, CONTINUE_IDLE_NOTE)}`,
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

  const after = await deps.runState.observe(target.id, target.info);
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
  const from = sanitizeText(
    callerID,
    CALLER_ID_MAX_CODE_POINTS,
    "attribute",
  ).text;
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
      `message is ${overLimit(length, MESSAGE_MAX_CODE_POINTS)}. Nothing was sent.`,
    );
  }
  return text;
}

/** How long ago an idle session went idle, as a sentence. */
function idleAge(info: SessionInfo, now: number): string {
  const idle = idleSince(info, false);
  return idle === undefined
    ? "When it went idle was not recorded."
    : `It went idle ${formatDuration(Math.max(0, now - idle))} ago.`;
}

/** For a session whose last run recorded no end, its idle time is unknown; its last activity may not be. */
function unendedAge(deps: SendDeps, sessionID: SessionID): string {
  const last = deps.activity?.get(sessionID)?.lastProgressAt;
  return last === undefined
    ? "When it stopped running is unknown."
    : `When it stopped running is unknown; its last activity was ${formatDuration(Math.max(0, deps.clock.now() - last))} ago.`;
}
