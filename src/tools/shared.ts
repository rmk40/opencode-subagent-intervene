// Pieces the three tools share: error mapping, the read tools' guidance, the schemas and renderings
// of run state and stop records, and lookups that degrade instead of failing a read tool.

import { Error as ToolError } from "@opencode/plugin/promise/tool";
import { Schema } from "effect";
import { AncestryError } from "@/core/ancestry";
import type { Latch, StopDescription } from "@/core/latch";
import type {
  Logger,
  RunState,
  SessionID,
  SessionInfo,
  SessionReader,
} from "@/core/ports";
import { EmptyReasonError } from "@/core/sanitize";
import { StopInputError } from "@/core/stop";

/** Code Mode namespace of the read tools. */
export const NAMESPACE = "subagents";

export const NAMESPACE_DESCRIPTION =
  "See the subagents you launched: list them with live run state and cost, or inspect one's recent activity.";

export const READ_GUIDANCE =
  "You are notified automatically when subagents finish. Use this only to decide whether to stop or redirect a subagent, or when the user asks. Do not poll.";

/** The permission whose rules decide who sees the tools: whoever may launch subagents. */
export const TOOL_PERMISSION = "subagent";

/**
 * Errors whose messages are written for the calling model become its tool failure. Everything else,
 * including a `Tool.Error` or a declined permission prompt, is returned unchanged for rethrowing.
 */
export function toToolError(error: unknown): unknown {
  if (
    error instanceof AncestryError ||
    error instanceof EmptyReasonError ||
    error instanceof StopInputError
  ) {
    return new ToolError({ message: error.message });
  }
  return error;
}

export const RunStateSchema = Schema.Literals(["running", "idle", "unknown"]);

export const OutcomeSchema = Schema.Literals([
  "succeeded",
  "failed",
  "interrupted",
]);

export const StoppedSchema = Schema.Struct({
  at: Schema.Number,
  reason: Schema.String,
  latch: Schema.Literals(["active", "lifted", "gave_up", "expired"]),
});

/**
 * The outcome of the session's last finished run, given only when the session is observed idle.
 * While it runs, or when its state is unknown, the outcome may describe an earlier run.
 */
export function settledOutcome(
  state: RunState,
  info: SessionInfo,
): SessionInfo["outcome"] {
  return state === "idle" ? info.outcome : undefined;
}

/** Actions awaiting approval in the session; empty, with a warning, when they cannot be read. */
export async function pendingActions(
  reader: SessionReader,
  logger: Logger,
  sessionID: SessionID,
): Promise<readonly string[]> {
  try {
    return await reader.pendingPermissions(sessionID);
  } catch (error) {
    logger.warn("could not read pending permissions", {
      sessionID,
      error: errorMessage(error),
    });
    return [];
  }
}

/** The session's stop record; undefined, with a warning, when storage cannot be read. */
export async function stopRecord(
  latch: Pick<Latch, "describe">,
  logger: Logger,
  sessionID: SessionID,
): Promise<StopDescription | undefined> {
  try {
    return await latch.describe(sessionID);
  } catch (error) {
    logger.warn("could not read the stop record", {
      sessionID,
      error: errorMessage(error),
    });
    return undefined;
  }
}

const LATCH_TEXT: Readonly<Record<StopDescription["latch"], string>> = {
  active: "kept stopped",
  lifted: "continued since",
  gave_up: "no longer kept stopped: it was woken too often",
  expired: "no longer kept stopped: the stop expired",
};

export function renderStopped(stopped: StopDescription): string {
  return `stopped by parent at ${new Date(stopped.at).toISOString()} (${LATCH_TEXT[stopped.latch]}): ${stopped.reason}`;
}

/** `providerID/modelID#variant`. */
export function modelName(info: SessionInfo): string | undefined {
  if (info.model === undefined) return undefined;
  const base = `${info.model.providerID}/${info.model.id}`;
  return info.model.variant === undefined
    ? base
    : `${base}#${info.model.variant}`;
}

/** ` (agent, "title")`, or an empty string when the session has neither. */
export function sessionLabel(info: {
  readonly agent?: string;
  readonly title?: string;
}): string {
  const parts = [
    ...(info.agent === undefined ? [] : [info.agent]),
    ...(info.title === undefined ? [] : [JSON.stringify(info.title)]),
  ];
  return parts.length === 0 ? "" : ` (${parts.join(", ")})`;
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
