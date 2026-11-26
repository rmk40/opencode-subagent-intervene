// Pieces the three tools share: error mapping, the read tools' guidance, the schemas and renderings
// of run state and stop records, and lookups that degrade instead of failing a read tool.

import { Error as ToolError } from "@opencode/plugin/promise/tool";
import { Schema } from "effect";
import { AncestryError, NotDescendantError } from "@/core/ancestry";
import type { Latch, StopDescription } from "@/core/latch";
import { recordsOpenRun } from "@/core/activity";
import type {
  Logger,
  RunObservation,
  RunState,
  SessionID,
  SessionInfo,
  SessionReader,
} from "@/core/ports";
import type { RunStateTracker } from "@/core/run-state";
import { EmptyReasonError } from "@/core/sanitize";
import { StopInputError } from "@/core/stop";
import { formatDuration } from "@/core/summarize";
import {
  closestChildren,
  describeSuggestions,
  type Suggestion,
  type SuggestionPool,
  suggestionPool,
} from "@/core/suggest";

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

export interface SuggestionDeps {
  readonly reader: SessionReader;
  readonly runState: Pick<RunStateTracker, "observeAll">;
}

/**
 * `toToolError`, with close matches among the caller's direct children added when the target is
 * not one of its subagents. The suggestions are only listed; nothing acts on them.
 */
export async function toToolErrorWithSuggestions(
  error: unknown,
  deps: SuggestionDeps,
  callerID: SessionID,
): Promise<unknown> {
  if (!(error instanceof NotDescendantError)) return toToolError(error);
  const pool = await suggestionPool(deps.reader, callerID);
  const { message } = await explainNotDescendant(
    deps,
    pool,
    error.sessionID,
    error.message,
  );
  return new ToolError({ message });
}

/** The error message for a target that is not one of the caller's subagents, with suggestions. */
export async function explainNotDescendant(
  deps: Pick<SuggestionDeps, "runState">,
  pool: SuggestionPool,
  sessionID: SessionID,
  base: string,
): Promise<{ readonly message: string; readonly suggestions: Suggestion[] }> {
  const suggestions = await describeSuggestions(
    deps.runState,
    closestChildren(pool.children, sessionID),
  );
  return {
    message: [base, ...renderSuggestions(suggestions, pool)].join("\n"),
    suggestions,
  };
}

function renderSuggestions(
  suggestions: readonly Suggestion[],
  pool: SuggestionPool,
): string[] {
  if (pool.failed === true) {
    return ["Your subagents couldn't be read, so no close matches were looked up."];
  }
  const { complete } = pool;
  const lines =
    suggestions.length === 0
      ? []
      : [
          "Close matches among the subagents you launched; check the ID before using one:",
          ...suggestions.map(
            (suggestion) =>
              `- ${suggestion.sessionID}${sessionLabel(suggestion)}: ${renderRunState(suggestion.state, suggestion.noRecordedEnd === true)}`,
          ),
        ];
  if (!complete) {
    lines.push(
      suggestions.length === 0
        ? "Only your most recently updated subagents were checked for a close match."
        : "Only your most recently updated subagents were checked, so these suggestions may be incomplete.",
    );
  }
  return lines;
}

/** `idle, its last run recorded no end` for such a session, otherwise the state. */
export function renderRunState(state: RunState, noRecordedEnd: boolean): string {
  return noRecordedEnd ? `${state}, its last run recorded no end` : state;
}

/** `3m 12s ago` for a time in the past. */
export function renderAge(at: number, now: number): string {
  return `${formatDuration(Math.max(0, now - at))} ago`;
}

export const RunStateSchema = Schema.Literals(["running", "idle", "unknown"]);

export const TimeSourceSchema = Schema.Literals(["live", "stored"]).annotate({
  description:
    "live: from events this plugin instance observed. stored: from OpenCode's stored session and messages, which never record streaming and can lag behind.",
});

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

export const StateSourceSchema = Schema.Literals([
  "event",
  "probe",
  "stored",
]).annotate({
  description:
    "event: from the run events this plugin instance observed. probe: from asking OpenCode whether the session is idle. stored: the probe failed, so this is OpenCode's stored record of the latest run, which a lost end leaves showing running.",
});

/** The run state a read tool shows. */
export interface DisplayedState {
  readonly state: RunState;
  readonly source: "event" | "probe" | "stored";
  readonly noRecordedEnd: boolean;
}

/**
 * The observed state, or, when the probe could not tell and the host records execution starts,
 * the state storage records. Only for display: callers that act on the state use the observation.
 */
export function displayedState(
  observation: RunObservation,
  info: SessionInfo,
): DisplayedState {
  const noRecordedEnd = observation.noRecordedEnd === true;
  if (observation.state === "unknown") {
    const open = recordsOpenRun(info);
    if (open !== undefined) {
      return {
        state: open ? "running" : "idle",
        source: "stored",
        noRecordedEnd,
      };
    }
  }
  return { state: observation.state, source: observation.source, noRecordedEnd };
}

/**
 * The outcome of the session's last finished run, given only when the session is shown idle and
 * its last run recorded an end. While it runs, when its state is unknown, or when its last run
 * recorded no end, the outcome may describe an earlier run.
 */
export function settledOutcome(
  shown: { readonly state: RunState; readonly noRecordedEnd: boolean },
  info: SessionInfo,
): SessionInfo["outcome"] {
  return shown.state === "idle" && !shown.noRecordedEnd
    ? info.outcome
    : undefined;
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
