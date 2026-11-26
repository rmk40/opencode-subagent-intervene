// `subagents.inspect`: a bounded view of one subagent's recent activity, built from the messages
// after its latest compaction and that compaction's summary of the work before it.

import type { Info } from "@opencode/plugin/promise/tool";
import { Schema } from "effect";
import {
  type ActivityPhase,
  type ActivityTracker,
  activityPhase,
  busySince,
  idleSince,
  type SessionActivity,
} from "@/core/activity";
import { assertDescendant, type Descendant } from "@/core/ancestry";
import type { Latch, StopDescription } from "@/core/latch";
import type {
  Clock,
  Logger,
  SessionInfo,
  SessionMessageInfo,
  SessionReader,
} from "@/core/ports";
import type { RunStateTracker } from "@/core/run-state";
import {
  DEFAULT_MAX_CHARS,
  formatDuration,
  MAX_MAX_CHARS,
  MIN_MAX_CHARS,
  renderContextSummary,
  sinceCompaction,
  summarizeContext,
  type ContextSummary,
} from "@/core/summarize";
import {
  displayedState,
  type DisplayedState,
  NAMESPACE,
  OutcomeSchema,
  pendingActions,
  READ_GUIDANCE,
  renderRunState,
  RunStateSchema,
  renderStopped,
  sessionLabel,
  settledOutcome,
  StateSourceSchema,
  StoppedSchema,
  stopRecord,
  TimeSourceSchema,
  TOOL_PERMISSION,
  toToolErrorWithSuggestions,
} from "@/tools/shared";

export const NAME = "inspect";

export const DESCRIPTION = `Show one subagent's directory and recent activity: when its run and current model response started and when it last made progress, the tools it is running, with their full input and how long they have run, its latest text, its latest error, and any permission prompts it is waiting on. Covers only messages since its last compaction, plus that compaction's summary of the earlier work when there is room for it, all cut to fit maxChars. ${READ_GUIDANCE}`;

const TimeSchema = Schema.Struct({
  at: Schema.Number.annotate({ description: "Epoch milliseconds." }),
  ageMs: Schema.Number.annotate({ description: "Milliseconds before now." }),
  source: TimeSourceSchema,
});

const PHASES = ["prompt", "tool", "retry", "model", "between"] as const;

export const Input = Schema.Struct({
  sessionID: Schema.String.annotate({
    description:
      "The sessionID of a subagent you launched, or one launched below it. Surrounding whitespace is ignored.",
  }),
  maxChars: Schema.optionalKey(
    Schema.Int.check(
      Schema.isBetween({ minimum: MIN_MAX_CHARS, maximum: MAX_MAX_CHARS }),
    ),
  ).annotate({
    description: `Budget for the text in the result. Defaults to ${DEFAULT_MAX_CHARS}.`,
  }),
});

export const Output = Schema.Struct({
  sessionID: Schema.String,
  directory: Schema.String.annotate({
    description: "The directory the subagent works in.",
  }),
  state: RunStateSchema,
  stateSource: StateSourceSchema,
  noRecordedEnd: Schema.optionalKey(Schema.Boolean).annotate({
    description:
      "True when OpenCode reports it idle but its last run recorded no end. It is not running, and a message sent to it is read only once it is continued with subagent.",
  }),
  outcome: Schema.optionalKey(OutcomeSchema),
  phase: Schema.optionalKey(Schema.Literals(PHASES)).annotate({
    description:
      "What it is doing, from live events: prompt (waiting on a permission prompt or question), tool, retry (waiting to retry a failed model request), model (a model response is streaming), or between (none of these, such as between steps). Absent when it is idle or no live events were seen.",
  }),
  executionStarted: Schema.optionalKey(TimeSchema).annotate({
    description:
      "When its current or unfinished run started. Absent when it is idle or the time is unknown.",
  }),
  responseStarted: Schema.optionalKey(TimeSchema).annotate({
    description:
      "When its current model response started. Absent when no response is in progress or the time is unknown.",
  }),
  lastActivity: Schema.optionalKey(TimeSchema).annotate({
    description:
      "When it last made progress, or when it went idle. Stored times never include streaming, so a stored time can be older than its real last activity.",
  }),
  activeTools: Schema.Array(
    Schema.Struct({
      name: Schema.String,
      status: Schema.Literals(["streaming", "running"]),
      input: Schema.String.annotate({
        description:
          "The tool's input on one line: JSON once it runs, the text streamed so far before that. Cut only to fit maxChars, and active tools are fitted first.",
      }),
      runningForMs: Schema.optionalKey(Schema.Number).annotate({
        description:
          "Milliseconds since the tool started running, or since its input started when OpenCode stored no start of running. Absent while its input is still streaming.",
      }),
      streamingForMs: Schema.optionalKey(Schema.Number).annotate({
        description:
          "Milliseconds since the tool's input started streaming. Present only while it streams.",
      }),
    }),
  ).annotate({
    description: "Tool calls still streaming or running, oldest first.",
  }),
  lastText: Schema.optionalKey(Schema.String),
  lastError: Schema.optionalKey(Schema.String),
  recentToolNames: Schema.Array(Schema.String),
  pendingPermissions: Schema.Array(Schema.String),
  earlierSummary: Schema.optionalKey(Schema.String).annotate({
    description:
      "The last compaction's summary of the work before it. It gets only the room the other fields leave, keeping its start when cut.",
  }),
  earlierSummaryOmitted: Schema.optionalKey(Schema.Boolean).annotate({
    description:
      "True when the last compaction has a summary but none of it fit maxChars. Pass a larger maxChars to see it.",
  }),
  stopped: Schema.optionalKey(StoppedSchema),
  scope: Schema.Literal("since-last-compaction"),
  truncated: Schema.Boolean.annotate({
    description: "Something was cut or left out to fit maxChars.",
  }),
});

export type InspectOutput = typeof Output.Type;

export interface InspectToolDeps {
  readonly reader: SessionReader;
  readonly latch: Pick<Latch, "describe">;
  readonly runState: Pick<RunStateTracker, "observe" | "observeAll">;
  readonly clock: Pick<Clock, "now">;
  readonly logger: Logger;
  /** Live activity. Without it, every time comes from storage. */
  readonly activity?: Pick<ActivityTracker, "get">;
}

export interface InspectToolOptions {
  /** Whether stop records are kept; without them `stopped` is left out. Default true. */
  readonly latch?: boolean;
}

export function inspectTool(
  deps: InspectToolDeps,
  options: InspectToolOptions = {},
): Info<typeof Input, typeof Output> {
  const latching = options.latch ?? true;
  return {
    name: NAME,
    description: DESCRIPTION,
    input: Input,
    output: Output,
    options: {
      namespace: NAMESPACE,
      codemode: true,
      pinned: true,
      permission: TOOL_PERMISSION,
    },
    execute: async (input, context) => {
      try {
        const target = await assertDescendant(
          deps.reader,
          input.sessionID.trim(),
          context.sessionID,
        );
        const [observation, messages, pending, stopped] = await Promise.all([
          deps.runState.observe(target.id, target.info),
          deps.reader.context(target.id),
          pendingActions(deps.reader, deps.logger, target.id),
          latching ? stopRecord(deps.latch, deps.logger, target.id) : undefined,
        ]);
        const now = deps.clock.now();
        const shown = displayedState(observation, target.info);
        const summary = summarizeContext(messages, {
          ...(input.maxChars === undefined ? {} : { maxChars: input.maxChars }),
          omitActiveTools: shown.state === "idle",
          now,
        });
        const live = deps.activity?.get(target.id);
        const output = toOutput(
          target,
          shown,
          settledOutcome(shown, target.info),
          timesOf(shown, target.info, messages, live, now),
          summary,
          pending,
          stopped,
        );
        const header = [
          `Session ${target.id}${sessionLabel(target.info)}`,
          `Directory: ${output.directory}`,
          `State: ${stateLine(output)}`,
          ...timeLines(output),
          `Pending permissions: ${output.pendingPermissions.length === 0 ? "none" : output.pendingPermissions.join(", ")}`,
          ...(stopped === undefined ? [] : [`Stop: ${renderStopped(stopped)}`]),
          scopeLine(output),
        ];
        return {
          output,
          content: [...header, renderContextSummary(summary)].join("\n"),
        };
      } catch (error) {
        throw await toToolErrorWithSuggestions(error, deps, context.sessionID);
      }
    },
  };
}

interface Times {
  readonly phase?: ActivityPhase;
  readonly executionStarted?: InspectOutput["executionStarted"];
  readonly responseStarted?: InspectOutput["responseStarted"];
  readonly lastActivity?: InspectOutput["lastActivity"];
}

/**
 * The run's times. Live events this instance observed come first; otherwise they come from
 * storage: the recorded start of the latest execution, the latest assistant message while it has
 * not completed, and the latest stored progress, or `time.idle` for a session whose run ended.
 */
function timesOf(
  shown: DisplayedState,
  info: SessionInfo,
  messages: readonly SessionMessageInfo[],
  live: SessionActivity | undefined,
  now: number,
): Times {
  const at = (time: number, source: "live" | "stored") => ({
    at: time,
    ageMs: Math.max(0, now - time),
    source,
  });
  const unfinished = shown.state !== "idle" || shown.noRecordedEnd;
  const latest = sinceCompaction(messages).assistants.at(-1);
  const busy = busySince(info);
  const executionStarted =
    live?.executionStartedAt !== undefined && unfinished
      ? at(live.executionStartedAt, "live")
      : busy !== undefined && unfinished
        ? at(busy, "stored")
        : undefined;
  const responseStarted =
    shown.state === "idle"
      ? undefined
      : live !== undefined
        ? live.responding && live.responseStartedAt !== undefined
          ? at(live.responseStartedAt, "live")
          : undefined
        : latest !== undefined &&
            latest.time.streamed === undefined &&
            latest.time.completed === undefined
          ? at(latest.time.created, "stored")
          : undefined;
  const idle = shown.state === "idle" ? idleSince(info, shown.noRecordedEnd) : undefined;
  const stored = latest === undefined ? undefined : storedProgress(latest);
  const lastActivity =
    live?.lastProgressAt !== undefined
      ? at(live.lastProgressAt, "live")
      : idle !== undefined
        ? at(idle, "stored")
        : stored !== undefined
          ? at(stored, "stored")
          : undefined;
  return {
    ...(live === undefined || shown.state === "idle"
      ? {}
      : { phase: activityPhase(live, now) }),
    ...(executionStarted === undefined ? {} : { executionStarted }),
    ...(responseStarted === undefined ? {} : { responseStarted }),
    ...(lastActivity === undefined ? {} : { lastActivity }),
  };
}

type AssistantMessage = Extract<SessionMessageInfo, { type: "assistant" }>;

/** The latest time stored on the message or its parts. */
function storedProgress(message: AssistantMessage): number {
  let latest = Math.max(
    message.time.created,
    message.time.streamed ?? 0,
    message.time.completed ?? 0,
  );
  for (const part of message.content) {
    if (part.type === "tool") {
      latest = Math.max(
        latest,
        part.time.created,
        part.time.ran ?? 0,
        part.time.completed ?? 0,
      );
    } else if (part.type === "reasoning" && part.time !== undefined) {
      latest = Math.max(latest, part.time.created, part.time.completed ?? 0);
    }
  }
  return latest;
}

const PHASE_TEXT: Readonly<Record<ActivityPhase, string>> = {
  prompt: "waiting on a permission prompt or question",
  tool: "running tool calls",
  retry: "waiting to retry a failed model request",
  model: "a model response is streaming",
  between: "between steps, with no model response or tool call in progress",
};

function stateLine(output: InspectOutput): string {
  const state = renderRunState(output.state, output.noRecordedEnd === true);
  const recorded =
    output.stateSource === "stored"
      ? `${state} (as stored; a probe could not confirm it)`
      : state;
  return output.outcome === undefined
    ? recorded
    : `${recorded}, last run ${output.outcome}`;
}

function timeLines(output: InspectOutput): string[] {
  const line = (label: string, time: InspectOutput["lastActivity"]) =>
    time === undefined
      ? []
      : [`${label}: ${formatDuration(time.ageMs)} ago (${time.source})`];
  return [
    ...(output.phase === undefined ? [] : [`Phase: ${PHASE_TEXT[output.phase]}`]),
    ...line("Run started", output.executionStarted),
    ...line("Model response started", output.responseStarted),
    ...line("Last activity", output.lastActivity),
  ];
}

function toOutput(
  target: Descendant,
  shown: DisplayedState,
  outcome: InspectOutput["outcome"],
  times: Times,
  summary: ContextSummary,
  pendingPermissions: readonly string[],
  stopped: StopDescription | undefined,
): InspectOutput {
  return {
    sessionID: target.id,
    directory: target.info.location.directory,
    state: shown.state,
    stateSource: shown.source,
    ...(shown.noRecordedEnd ? { noRecordedEnd: true } : {}),
    ...(outcome === undefined ? {} : { outcome }),
    ...times,
    activeTools: summary.activeTools,
    ...(summary.lastText === undefined ? {} : { lastText: summary.lastText }),
    ...(summary.lastError === undefined
      ? {}
      : { lastError: summary.lastError }),
    recentToolNames: summary.recentToolNames,
    pendingPermissions,
    ...(summary.earlierSummary === undefined
      ? {}
      : { earlierSummary: summary.earlierSummary }),
    ...(summary.earlierSummaryOmitted === true
      ? { earlierSummaryOmitted: true }
      : {}),
    ...(stopped === undefined
      ? {}
      : {
          stopped: {
            at: stopped.at,
            reason: stopped.reason,
            latch: stopped.latch,
          },
        }),
    scope: "since-last-compaction",
    truncated: summary.truncated,
  };
}

function scopeLine(output: InspectOutput): string {
  if (output.earlierSummaryOmitted === true) {
    return "Scope: messages since the last compaction; its summary of the earlier work did not fit, pass a larger maxChars to see it";
  }
  return output.earlierSummary === undefined
    ? "Scope: messages since the last compaction"
    : "Scope: messages since the last compaction, plus its summary of the earlier work";
}
