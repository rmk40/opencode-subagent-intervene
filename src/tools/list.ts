// `subagents.list`: the caller's subagents with live run state, outcome, cost, and tokens. The
// parent needs it because compaction can drop the sessionIDs it was given, and because cost and
// liveness are what it weighs before stopping something.

import type { Info } from "@opencode/plugin/promise/tool";
import { Schema } from "effect";
import {
  collectSubtreeTruncated,
  type Descendant,
  MAX_SCAN_SESSIONS,
  scanDirectChildren,
} from "@/core/ancestry";
import type { Latch, StopDescription } from "@/core/latch";
import type {
  Logger,
  RunObservation,
  SessionID,
  SessionReader,
} from "@/core/ports";
import type { RunStateTracker } from "@/core/run-state";
import {
  errorMessage,
  modelName,
  NAMESPACE,
  OutcomeSchema,
  READ_GUIDANCE,
  RunStateSchema,
  renderStopped,
  sessionLabel,
  settledOutcome,
  StoppedSchema,
  stopRecord,
  pendingActions,
  TOOL_PERMISSION,
  toToolError,
} from "@/tools/shared";

export const NAME = "list";
export const MAX_ENTRIES = 50;
export const MAX_DEPTH = 4;

export const DESCRIPTION = `List the subagents you launched, running ones first, with their run state, last outcome, cost, and tokens, the directory each works in, whether one is waiting on a permission prompt, and whether it was stopped. At most ${MAX_ENTRIES} entries. ${READ_GUIDANCE}`;

export const Input = Schema.Struct({
  depth: Schema.optionalKey(
    Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: MAX_DEPTH })),
  ).annotate({
    description: `How many levels to include: 1 (the default) for the subagents you launched, up to ${MAX_DEPTH} to include the ones they launched.`,
  }),
  state: Schema.optionalKey(
    Schema.Literals(["running", "idle", "all"]),
  ).annotate({
    description:
      'Which subagents to include. "running" also includes those whose state could not be determined. Defaults to "all".',
  }),
});

const EntrySchema = Schema.Struct({
  sessionID: Schema.String,
  parentID: Schema.String,
  depth: Schema.Number,
  title: Schema.optionalKey(Schema.String),
  agent: Schema.optionalKey(Schema.String),
  model: Schema.optionalKey(Schema.String),
  directory: Schema.String.annotate({
    description:
      "The directory the subagent works in. It starts in its parent's and changes only when the session is moved.",
  }),
  state: RunStateSchema,
  stateSource: Schema.Literals(["event", "probe"]),
  waitingOnPermission: Schema.Boolean,
  outcome: Schema.optionalKey(OutcomeSchema),
  createdAt: Schema.Number,
  lastIdleAt: Schema.optionalKey(Schema.Number),
  cost: Schema.Number.annotate({
    description:
      "USD. 0 when the provider reports no pricing for the model, which is common with subscription sign-ins.",
  }),
  tokens: Schema.Struct({
    input: Schema.Number,
    cacheRead: Schema.Number,
    output: Schema.Number,
  }),
  stopped: Schema.optionalKey(StoppedSchema),
});

export type ListEntry = typeof EntrySchema.Type;

export const Output = Schema.Struct({
  entries: Schema.Array(EntrySchema),
  total: Schema.Number.annotate({
    description:
      "How many of the subagents read matched the state filter. When complete is false, more may exist.",
  }),
  truncated: Schema.Boolean.annotate({
    description: `More matching subagents were found than the ${MAX_ENTRIES} entries shown.`,
  }),
  complete: Schema.Boolean.annotate({
    description:
      "False when the subagent tree was too large to read in full; only sessions under the most recently updated subagents were read.",
  }),
});

export interface ListToolDeps {
  readonly reader: SessionReader;
  readonly latch: Pick<Latch, "describe">;
  readonly runState: Pick<RunStateTracker, "observeAll">;
  readonly logger: Logger;
}

export interface ListToolOptions {
  /** Whether stop records are kept; without them `stopped` is left out. Default true. */
  readonly latch?: boolean;
}

const STATE_ORDER: Readonly<Record<RunObservation["state"], number>> = {
  running: 0,
  unknown: 1,
  idle: 2,
};

export function listTool(
  deps: ListToolDeps,
  options: ListToolOptions = {},
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
        const depth = input.depth ?? 1;
        const filter = input.state ?? "all";
        // A read-only listing reads up to the scan cap and reports `complete: false` instead of failing.
        // Over the cap it keeps the most recently updated children, where running ones are.
        const [children, callerDirectory] = await Promise.all([
          scanDirectChildren(deps.reader, context.sessionID),
          sessionDirectory(deps.reader, deps.logger, context.sessionID),
        ]);
        const walked =
          depth === 1 || children.nodes.length === 0
            ? { nodes: children.nodes, truncated: false }
            : await collectSubtreeTruncated(deps.reader, children.nodes, {
                maxDepth: depth,
                truncate: true,
                maxSessions: MAX_SCAN_SESSIONS,
              });
        const walkTruncated = children.truncated || walked.truncated;
        const nodes = walked.nodes;
        const observed = await deps.runState.observeAll(
          nodes.map((node) => node.id),
        );
        const matching = nodes
          .map((node) => ({
            node,
            observation: observed.get(node.id) ?? {
              state: "unknown" as const,
              source: "probe" as const,
            },
          }))
          .filter(({ observation }) =>
            filter === "all"
              ? true
              : filter === "idle"
                ? observation.state === "idle"
                : observation.state !== "idle",
          )
          .toSorted(
            (a, b) =>
              STATE_ORDER[a.observation.state] -
                STATE_ORDER[b.observation.state] ||
              b.node.info.time.created - a.node.info.time.created,
          );
        const kept = matching.slice(0, MAX_ENTRIES);
        const entries = await Promise.all(
          kept.map(async ({ node, observation }) => {
            const [pending, stopped] = await Promise.all([
              pendingActions(deps.reader, deps.logger, node.id),
              latching
                ? stopRecord(deps.latch, deps.logger, node.id)
                : undefined,
            ]);
            return toEntry(node, observation, pending.length > 0, stopped);
          }),
        );
        const output = {
          entries,
          total: matching.length,
          truncated: matching.length > kept.length,
          complete: !walkTruncated,
        };
        return {
          output,
          content: renderList(output, filter, callerDirectory),
        };
      } catch (error) {
        throw toToolError(error);
      }
    },
  };
}

/** The session's directory; undefined, with a warning, when the session cannot be read. */
async function sessionDirectory(
  reader: SessionReader,
  logger: Logger,
  sessionID: SessionID,
): Promise<string | undefined> {
  try {
    return (await reader.get(sessionID))?.location.directory;
  } catch (error) {
    logger.warn("could not read the session's directory", {
      sessionID,
      error: errorMessage(error),
    });
    return undefined;
  }
}

function toEntry(
  node: Descendant,
  observation: RunObservation,
  waitingOnPermission: boolean,
  stopped: StopDescription | undefined,
): ListEntry {
  const { info } = node;
  const model = modelName(info);
  const outcome = settledOutcome(observation.state, info);
  return {
    sessionID: node.id,
    parentID: node.parentID,
    depth: node.depth,
    ...(info.title === undefined ? {} : { title: info.title }),
    ...(info.agent === undefined ? {} : { agent: info.agent }),
    ...(model === undefined ? {} : { model }),
    directory: info.location.directory,
    state: observation.state,
    stateSource: observation.source,
    waitingOnPermission,
    ...(outcome === undefined ? {} : { outcome }),
    createdAt: info.time.created,
    ...(info.time.idle === undefined ? {} : { lastIdleAt: info.time.idle }),
    cost: info.cost,
    tokens: {
      input: info.tokens.input,
      cacheRead: info.tokens.cache.read,
      output: info.tokens.output,
    },
    ...(stopped === undefined
      ? {}
      : {
          stopped: {
            at: stopped.at,
            reason: stopped.reason,
            latch: stopped.latch,
          },
        }),
  };
}

/**
 * Plain-text rendering of the list, which is what the model reads from a direct call. An entry
 * names its directory when it differs from `callerDirectory`, and always when that is unknown.
 */
export function renderList(
  output: {
    readonly entries: readonly ListEntry[];
    readonly total: number;
    readonly truncated: boolean;
    readonly complete: boolean;
  },
  filter: "running" | "idle" | "all",
  callerDirectory?: string,
): string {
  const partial = output.complete
    ? []
    : [
        "Your subagent tree is too large to read in full; only sessions under your most recently updated subagents were checked.",
      ];
  if (output.entries.length === 0) {
    const none =
      filter === "all"
        ? "You have no subagents."
        : `None of your subagents is ${filter}.`;
    return [none, ...partial].join(" ");
  }
  const lines = output.entries.map((entry) =>
    renderEntry(entry, callerDirectory),
  );
  if (output.truncated) {
    lines.push(
      filter === "all"
        ? `Showing ${output.entries.length} of ${output.total} found, running ones first. Pass state: "running" to list only the running ones.`
        : `Showing ${output.entries.length} of ${output.total} found.`,
    );
  }
  lines.push(...partial);
  return lines.join("\n");
}

function renderEntry(
  entry: ListEntry,
  callerDirectory: string | undefined,
): string {
  const state =
    entry.outcome === undefined
      ? entry.state
      : `${entry.state}, last run ${entry.outcome}`;
  const details = [
    state,
    ...(entry.depth > 1 ? [`launched by ${entry.parentID}`] : []),
    ...(entry.model === undefined ? [] : [entry.model]),
    // A cost of 0 usually means the provider reports no pricing, not that the work was free.
    entry.cost > 0 ? `$${entry.cost.toFixed(4)}` : "no cost reported",
    `${entry.tokens.input} in + ${entry.tokens.cacheRead} cached / ${entry.tokens.output} out tokens`,
    ...(entry.directory === callerDirectory
      ? []
      : [`directory ${entry.directory}`]),
    ...(entry.waitingOnPermission ? ["waiting on a permission prompt"] : []),
    ...(entry.stopped === undefined ? [] : [renderStopped(entry.stopped)]),
  ];
  return `- ${entry.sessionID}${sessionLabel(entry)}: ${details.join("; ")}`;
}
