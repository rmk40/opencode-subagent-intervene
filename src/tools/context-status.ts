import type { Info } from "@opencode/plugin/promise/tool";
import { Schema } from "effect";
import {
  DEFAULT_CONTEXT_WARNING_PERCENT,
  readContextUsage,
  renderContextUsage,
  type ContextUsageDeps,
} from "@/core/context-usage";

export const NAME = "context_status";
export const DESCRIPTION =
  "Read your own session's latest completed response usage and latest visible compaction as a compact status line. Input-window usage drives plugin notices, using the smaller positive input or context limit, or the only positive limit available. Shows the UI/context percentage only when its denominator differs. Structured output retains both percentages, model, limits, raw token counts and measurement IDs, plus signed token headroom to the input window and to the default auto estimate when a current-model measurement exists; negative headroom means the measurement is past that point. Later messages and pending tool or subagent results, including this call, are not included in the measurement. The default auto estimate assumes automatic compaction is enabled with OpenCode's default buffer and no override. The actual resolved automatic-compaction threshold is unavailable.";

export const Input = Schema.Struct({});
const Model = Schema.Struct({
  providerID: Schema.String,
  id: Schema.String,
  variant: Schema.optionalKey(Schema.String),
});
export const Output = Schema.Struct({
  sessionID: Schema.String,
  model: Schema.optionalKey(Model),
  limits: Schema.Struct({
    context: Schema.optionalKey(Schema.Number),
    input: Schema.optionalKey(Schema.Number),
    output: Schema.optionalKey(Schema.Number),
  }),
  usableInputWindow: Schema.optionalKey(Schema.Number),
  status: Schema.Literals([
    "available",
    "missing",
    "awaiting-post-compaction",
    "different-model",
    "model-unknown",
    "revert-boundary-unavailable",
  ]),
  measurement: Schema.optionalKey(
    Schema.Struct({
      messageID: Schema.String,
      measuredAt: Schema.optionalKey(Schema.Number),
      model: Model,
      tokens: Schema.Struct({
        input: Schema.Number,
        output: Schema.Number,
        reasoning: Schema.Number,
        cache: Schema.Struct({ read: Schema.Number, write: Schema.Number }),
      }),
      reportedTokens: Schema.Number,
    }),
  ),
  reportedContextPercent: Schema.optionalKey(Schema.Number),
  reportedWindowPercent: Schema.optionalKey(Schema.Number),
  inputHeadroomTokens: Schema.optionalKey(Schema.Number),
  defaultAutoCompactionHeadroomTokens: Schema.optionalKey(Schema.Number),
  completedCompactionID: Schema.optionalKey(Schema.String),
  latestCompaction: Schema.optionalKey(
    Schema.Struct({
      id: Schema.String,
      status: Schema.Literals(["running", "completed", "failed"]),
      failureMessage: Schema.optionalKey(Schema.String),
    }),
  ),
  historyBoundary: Schema.Literals([
    "active",
    "before-revert",
    "revert-marker-missing",
  ]),
  revertMessageID: Schema.optionalKey(Schema.String),
  autoCompactionThreshold: Schema.Literal("unknown"),
  defaultAutoCompactionThreshold: Schema.optionalKey(
    Schema.Struct({ tokens: Schema.Number, percent: Schema.Number }),
  ),
  contextWarningPercent: Schema.Number,
  warningsEnabled: Schema.Boolean,
  measurementScope: Schema.String,
});

export function contextStatusTool(
  deps: ContextUsageDeps,
  options: {
    readonly warningPercent?: number;
    readonly warningsEnabled?: boolean;
  } = {},
): Info<typeof Input, typeof Output> {
  const warningsEnabled = options.warningsEnabled ?? true;
  return {
    name: NAME,
    description: DESCRIPTION,
    input: Input,
    output: Output,
    options: { codemode: false, permission: NAME },
    execute: async (_input, context) => {
      const { usage } = await readContextUsage(
        deps,
        context,
        options.warningPercent ?? DEFAULT_CONTEXT_WARNING_PERCENT,
      );
      return {
        output: { ...usage, warningsEnabled },
        content: renderContextUsage(usage, warningsEnabled),
      };
    },
  };
}
