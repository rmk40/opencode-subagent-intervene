// `subagents.inspect`: a bounded view of one subagent's recent activity, built from the messages
// after its latest compaction and that compaction's summary of the work before it.

import type { Info } from "@opencode/plugin/promise/tool";
import { Schema } from "effect";
import { assertDescendant, type Descendant } from "@/core/ancestry";
import type { Latch, StopDescription } from "@/core/latch";
import type { Clock, Logger, RunState, SessionReader } from "@/core/ports";
import type { RunStateTracker } from "@/core/run-state";
import {
  DEFAULT_MAX_CHARS,
  MAX_MAX_CHARS,
  MIN_MAX_CHARS,
  renderContextSummary,
  summarizeContext,
  type ContextSummary,
} from "@/core/summarize";
import {
  NAMESPACE,
  OutcomeSchema,
  pendingActions,
  READ_GUIDANCE,
  RunStateSchema,
  renderStopped,
  sessionLabel,
  settledOutcome,
  StoppedSchema,
  stopRecord,
  TOOL_PERMISSION,
  toToolError,
} from "@/tools/shared";

export const NAME = "inspect";

export const DESCRIPTION = `Show one subagent's directory and recent activity: the tools it is running, with their full input and how long they have run, its latest text, its latest error, and any permission prompts it is waiting on. Covers only messages since its last compaction, plus that compaction's summary of the earlier work when there is room for it, all cut to fit maxChars. ${READ_GUIDANCE}`;

export const Input = Schema.Struct({
  sessionID: Schema.String.annotate({
    description:
      "The sessionID of a subagent you launched, or one launched below it.",
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
  outcome: Schema.optionalKey(OutcomeSchema),
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
          "Milliseconds since the tool started running. Absent while its input is still streaming.",
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
  readonly runState: Pick<RunStateTracker, "observe">;
  readonly clock: Pick<Clock, "now">;
  readonly logger: Logger;
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
          input.sessionID,
          context.sessionID,
        );
        const [observation, messages, pending, stopped] = await Promise.all([
          deps.runState.observe(target.id),
          deps.reader.context(target.id),
          pendingActions(deps.reader, deps.logger, target.id),
          latching ? stopRecord(deps.latch, deps.logger, target.id) : undefined,
        ]);
        const summary = summarizeContext(messages, {
          ...(input.maxChars === undefined ? {} : { maxChars: input.maxChars }),
          omitActiveTools: observation.state === "idle",
          now: deps.clock.now(),
        });
        const output = toOutput(
          target,
          observation.state,
          settledOutcome(observation.state, target.info),
          summary,
          pending,
          stopped,
        );
        const header = [
          `Session ${target.id}${sessionLabel(target.info)}`,
          `Directory: ${output.directory}`,
          `State: ${output.outcome === undefined ? output.state : `${output.state}, last run ${output.outcome}`}`,
          `Pending permissions: ${output.pendingPermissions.length === 0 ? "none" : output.pendingPermissions.join(", ")}`,
          ...(stopped === undefined ? [] : [`Stop: ${renderStopped(stopped)}`]),
          scopeLine(output),
        ];
        return {
          output,
          content: [...header, renderContextSummary(summary)].join("\n"),
        };
      } catch (error) {
        throw toToolError(error);
      }
    },
  };
}

function toOutput(
  target: Descendant,
  state: RunState,
  outcome: InspectOutput["outcome"],
  summary: ContextSummary,
  pendingPermissions: readonly string[],
  stopped: StopDescription | undefined,
): InspectOutput {
  return {
    sessionID: target.id,
    directory: target.info.location.directory,
    state,
    ...(outcome === undefined ? {} : { outcome }),
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
