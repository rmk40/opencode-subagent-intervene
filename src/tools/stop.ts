// `subagent_stop`: a direct tool, next to `subagent` in the model's tool list, because stopping is
// urgent and must be easy to find.

import { Error as ToolError, type Info } from "@opencode/plugin/promise/tool";
import { Schema } from "effect";
import { REASON_MAX_CODE_POINTS } from "@/core/sanitize";
import {
  MAX_TARGETS,
  type NodeResult,
  type StopDeps,
  type StopOptions,
  type StopOutput,
  type StoppedNode,
  stopSubagents,
} from "@/core/stop";
import { sessionLabel, TOOL_PERMISSION, toToolError } from "@/tools/shared";

export const NAME = "subagent_stop";

export const DESCRIPTION =
  "Stop one or more of your subagents and everything they launched. Use when a subagent is heading the wrong way, stuck, or no longer needed. Stopped subagents keep their history and stay stopped until you continue them with subagent and their sessionID. Give a short reason. To change a running subagent's instructions without stopping it, use subagent_send instead.";

export const Input = Schema.Struct({
  sessionIDs: Schema.optionalKey(
    Schema.Array(Schema.String).check(Schema.isMaxLength(MAX_TARGETS)),
  ).annotate({
    description: `The sessionIDs of the subagents to stop, at most ${MAX_TARGETS}. Each must be a subagent you launched or one launched below it. Give this or all, not both.`,
  }),
  all: Schema.optionalKey(Schema.Boolean).annotate({
    description:
      "Set to true to stop every subagent you launched that is still running, or that has running work below it. Give this or sessionIDs, not both.",
  }),
  reason: Schema.String.annotate({
    description: `Why you are stopping them, in a short sentence (at most ${REASON_MAX_CODE_POINTS} characters are kept). The subagent sees it if it is continued later.`,
  }),
});

const NodeResultSchema = Schema.Literals([
  "deleted",
  "continued",
  "stopping",
  "stopped",
  "finished",
  "already_idle",
]);

export const Output = Schema.Struct({
  nodes: Schema.Array(
    Schema.Struct({
      sessionID: Schema.String,
      parentID: Schema.String,
      depth: Schema.Number,
      title: Schema.optionalKey(Schema.String),
      agent: Schema.optionalKey(Schema.String),
      result: NodeResultSchema,
    }),
  ),
  note: Schema.String,
});

/** One permission check for a stop, as `ctx.permission.assert` takes it. */
export interface StopPermissionRequest {
  readonly sessionID: string;
  readonly agent: string;
  readonly messageID: string;
  readonly callID: string;
  /** The stopped root's agent: the permission resource. */
  readonly rootAgent: string;
}

export interface StopToolOptions extends StopOptions {
  /** Set to ask for permission once per distinct root agent before anything is stopped. */
  readonly confirm?: (request: StopPermissionRequest) => Promise<void>;
}

export function stopTool(
  deps: StopDeps,
  options: StopToolOptions = {},
): Info<typeof Input, typeof Output> {
  const { confirm, ...stopOptions } = options;
  return {
    name: NAME,
    description: DESCRIPTION,
    input: Input,
    output: Output,
    options: { codemode: false, permission: TOOL_PERMISSION },
    execute: async (input, context) => {
      try {
        const output = await stopSubagents(
          deps,
          {
            callerID: context.sessionID,
            // Provider call IDs are not unique across messages (some servers reuse `call_0`), and a
            // reused generation would find an earlier stop's lift key.
            generation: `${context.messageID}:${context.id}`,
            signal: context.signal,
            ...(confirm === undefined
              ? {}
              : {
                  confirm: (rootAgent: string) =>
                    confirm({
                      sessionID: context.sessionID,
                      agent: context.agent,
                      messageID: context.messageID,
                      callID: context.id,
                      rootAgent,
                    }),
                }),
          },
          input,
          stopOptions,
        );
        // Core has already recorded a cancelled call as aborted and ignores this result.
        if (output === undefined) {
          throw new ToolError({
            message: "The stop was cancelled before it finished.",
          });
        }
        return { output, content: renderStopResult(output) };
      } catch (error) {
        throw toToolError(error);
      }
    },
  };
}

const RESULT_TEXT: Readonly<Record<NodeResult, string>> = {
  stopped: "stopped",
  finished: "finished on its own before the stop landed",
  already_idle: "already idle",
  stopping: "still stopping when the wait ended",
  continued: "given new work while the stop ran, so it was left running",
  deleted: "deleted",
};

/** Plain-text rendering of the result, which is what the model reads from a direct call. */
export function renderStopResult(output: StopOutput): string {
  if (output.nodes.length === 0) return output.note;
  return [...output.nodes.map(renderNode), "", output.note].join("\n");
}

function renderNode(node: StoppedNode): string {
  const below = node.depth > 1 ? `, launched by ${node.parentID}` : "";
  return `- ${node.sessionID}${sessionLabel(node)}${below}: ${RESULT_TEXT[node.result]}`;
}
