import { Error as ToolError, type Info } from "@opencode/plugin/promise/tool";
import { Schema } from "effect";
import {
  COMPACT_TOOL_NAME,
  CompactionError,
  HANDOFF_MAX_CODE_POINTS,
  requestSelfCompaction,
  type CompactionDeps,
} from "@/core/compaction";

export const NAME = COMPACT_TOOL_NAME;
export const DESCRIPTION =
  "Request compaction of your own session. Compaction replaces earlier context and can require rebuilding cached context. Optionally supply working notes preserving the current goal, relevant decisions, outstanding work and the exact next action. Avoid unrelated tool calls in the same batch. Returns admission only, not a completed summary. OpenCode produces the summary and continues the session.";

export const Input = Schema.Struct({
  handoff: Schema.optionalKey(Schema.String).annotate({
    description: `Agent-written working notes of 1 to ${HANDOFF_MAX_CODE_POINTS} characters, kept as an ordinary synthetic message.`,
  }),
});

export const Output = Schema.Struct({
  sessionID: Schema.String,
  id: Schema.String,
  delivery: Schema.Literals(["steer", "queue"]),
  status: Schema.Literal("requested"),
  handoff: Schema.Struct({
    status: Schema.Literals(["omitted", "stored", "failed"]),
    messageID: Schema.optionalKey(Schema.String),
    error: Schema.optionalKey(Schema.String),
  }),
  note: Schema.String,
});

export function contextCompactTool(
  deps: CompactionDeps,
): Info<typeof Input, typeof Output> {
  return {
    name: NAME,
    description: DESCRIPTION,
    input: Input,
    output: Output,
    options: { codemode: false, permission: NAME },
    execute: async (input, context) => {
      try {
        const output = await requestSelfCompaction(deps, context, input.handoff);
        return {
          output,
          content: `Compaction ${output.id} requested for ${output.sessionID} with ${output.delivery} delivery. ${output.handoff.status === "stored" ? `Handoff message ${output.handoff.messageID} was admitted. ` : ""}${output.note}`,
        };
      } catch (error) {
        if (error instanceof CompactionError) {
          throw new ToolError({ message: error.message });
        }
        throw error;
      }
    },
  };
}
