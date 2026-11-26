// `subagents.list`: the caller's subagents with live run state, last activity, outcome, cost, and
// tokens. The parent needs it because compaction can drop the sessionIDs it was given, and because
// cost and liveness are what it weighs before stopping something. A long-running orchestrator can
// have thousands of subagents, so the list pages with a cursor and can look sessions up by ID.

import { Error as ToolError, type Info } from "@opencode/plugin/promise/tool";
import { Schema } from "effect";
import { type ActivityTracker, idleSince } from "@/core/activity";
import {
  AncestryError,
  assertDescendant,
  collectSubtreeTruncated,
  type Descendant,
  MAX_SCAN_SESSIONS,
  NotDescendantError,
  scanDirectChildren,
  walkDescendants,
} from "@/core/ancestry";
import type { Latch, StopDescription } from "@/core/latch";
import {
  CursorError,
  type ListSnapshot,
  ListSnapshots,
} from "@/core/list-pages";
import type {
  Clock,
  Logger,
  RunObservation,
  SessionID,
  SessionInfo,
  SessionReader,
} from "@/core/ports";
import type { RunStateTracker } from "@/core/run-state";
import { suggestionPool, type SuggestionPool } from "@/core/suggest";
import {
  type DisplayedState,
  displayedState,
  errorMessage,
  explainNotDescendant,
  modelName,
  NAMESPACE,
  OutcomeSchema,
  pendingActions,
  READ_GUIDANCE,
  RunStateSchema,
  renderAge,
  renderRunState,
  renderStopped,
  sessionLabel,
  settledOutcome,
  StateSourceSchema,
  StoppedSchema,
  stopRecord,
  TOOL_PERMISSION,
  toToolError,
} from "@/tools/shared";

export const NAME = "list";
export const MAX_ENTRIES = 50;
export const MAX_DEPTH = 4;
export const MAX_SESSION_IDS = 50;
export const MAX_ACTIVE_WITHIN_MINUTES = 7 * 24 * 60;
const MINUTE_MS = 60 * 1000;
/**
 * Sessions a later page may read, counting those already read, which the walk passes again. New
 * sessions it reads are capped at the scan cap, like the first call.
 */
const PAGE_READ_LIMIT = 5 * MAX_SCAN_SESSIONS;

export const DESCRIPTION = `List the subagents you launched, running ones first, with their run state, last activity, last outcome, cost, and tokens, the directory each works in, whether one is waiting on a permission prompt, and whether it was stopped. Filter by state, by recent activity, or look up sessionIDs directly. At most ${MAX_ENTRIES} entries per call; pass nextCursor as cursor for the next page. ${READ_GUIDANCE}`;

export const Input = Schema.Struct({
  depth: Schema.optionalKey(
    Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: MAX_DEPTH })),
  ).annotate({
    description: `How many levels to include: 1 (the default) for the subagents you launched, up to ${MAX_DEPTH} to include the ones they launched. Does not apply to sessionIDs.`,
  }),
  state: Schema.optionalKey(
    Schema.Literals(["running", "idle", "all"]),
  ).annotate({
    description:
      'Which subagents to include. "running" also includes those whose state could not be determined. Defaults to "all".',
  }),
  activeWithinMinutes: Schema.optionalKey(
    Schema.Int.check(
      Schema.isBetween({ minimum: 1, maximum: MAX_ACTIVE_WITHIN_MINUTES }),
    ),
  ).annotate({
    description:
      "Keep only subagents that are running, or whose last activity or end was within this many minutes.",
  }),
  sessionIDs: Schema.optionalKey(
    Schema.Array(Schema.String).check(Schema.isMaxLength(MAX_SESSION_IDS)),
  ).annotate({
    description: `Up to ${MAX_SESSION_IDS} sessionIDs to look up directly: any subagent you launched or one launched below it, however many subagents you have. Those that are not come back in errors with close matches. state and activeWithinMinutes still apply; depth does not.`,
  }),
  cursor: Schema.optionalKey(Schema.String).annotate({
    description:
      "nextCursor from an earlier call, for the next page. Pass the same depth, state and activeWithinMinutes as that call.",
  }),
});

type ListInput = typeof Input.Type;
type StateFilter = "running" | "idle" | "all";

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
  stateSource: StateSourceSchema,
  noRecordedEnd: Schema.optionalKey(Schema.Boolean).annotate({
    description:
      "True when OpenCode reports it idle but its last run recorded no end. It is not running, and a message sent to it is read only once it is continued with subagent.",
  }),
  waitingOnPermission: Schema.Boolean,
  outcome: Schema.optionalKey(OutcomeSchema),
  createdAt: Schema.Number,
  lastIdleAt: Schema.optionalKey(Schema.Number),
  lastActivityAt: Schema.optionalKey(Schema.Number).annotate({
    description:
      "When it last made progress, as this plugin instance observed it, or for an idle subagent when its run ended. Absent when unknown.",
  }),
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

const SuggestionSchema = Schema.Struct({
  sessionID: Schema.String,
  title: Schema.optionalKey(Schema.String),
  agent: Schema.optionalKey(Schema.String),
  state: RunStateSchema,
  noRecordedEnd: Schema.optionalKey(Schema.Boolean),
});

export const Output = Schema.Struct({
  entries: Schema.Array(EntrySchema),
  total: Schema.Number.annotate({
    description:
      "How many matching subagents this listing has found so far, across its pages. While complete is false, more may exist.",
  }),
  truncated: Schema.Boolean.annotate({
    description:
      "More matching subagents were found than this page shows, on earlier pages or on later ones nextCursor reaches.",
  }),
  complete: Schema.Boolean.annotate({
    description: `False while part of your subagent tree is unread. The first call reads ${MAX_SCAN_SESSIONS} sessions under your most recently updated subagents; each page after it reads further, and complete turns true once the whole tree is read.`,
  }),
  nextCursor: Schema.optionalKey(Schema.String).annotate({
    description:
      "Pass as cursor, with the same filters, for the next page. Absent on the last page. Following it to the end lists every matching subagent once, give or take sessions created or deleted meanwhile.",
  }),
  errors: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({
        sessionID: Schema.String,
        error: Schema.String,
        suggestions: Schema.Array(SuggestionSchema).annotate({
          description:
            "Your direct subagents with close IDs. Check before using one; none was acted on.",
        }),
      }),
    ),
  ).annotate({
    description: "sessionIDs that are not your subagents.",
  }),
});

export type ListOutput = typeof Output.Type;

export interface ListToolDeps {
  readonly reader: SessionReader;
  readonly latch: Pick<Latch, "describe">;
  readonly runState: Pick<RunStateTracker, "observeAll">;
  readonly clock: Pick<Clock, "now">;
  readonly logger: Logger;
  /** Live activity, for the last activity of running subagents. Without it, that is unknown. */
  readonly activity?: Pick<ActivityTracker, "get">;
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

/** A session read by the listing, with what the filters and the entry need. */
interface Evaluated {
  readonly node: Descendant;
  readonly shown: DisplayedState;
  readonly lastActivityAt?: number;
}

interface Filters {
  readonly state: StateFilter;
  readonly windowMs?: number;
}

interface Page {
  readonly page: readonly Evaluated[];
  readonly total: number;
  readonly complete: boolean;
  readonly nextCursor?: string;
  readonly errors?: ListOutput["errors"];
}

export function listTool(
  deps: ListToolDeps,
  options: ListToolOptions = {},
): Info<typeof Input, typeof Output> {
  const latching = options.latch ?? true;
  const snapshots = new ListSnapshots(deps.clock);
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
        const filters: Filters = {
          state: input.state ?? "all",
          ...(input.activeWithinMinutes === undefined
            ? {}
            : { windowMs: input.activeWithinMinutes * MINUTE_MS }),
        };
        const sessionIDs = input.sessionIDs ?? [];
        if (sessionIDs.length > 0 && input.cursor !== undefined) {
          throw new ToolError({
            message:
              "A listing by sessionIDs fits on one page and returns no cursor. Pass cursor without sessionIDs.",
          });
        }
        const [found, callerDirectory] = await Promise.all([
          sessionIDs.length > 0
            ? listByIDs(deps, context.sessionID, sessionIDs, filters)
            : input.cursor === undefined
              ? firstPage(deps, snapshots, context.sessionID, input, filters)
              : nextPage(deps, snapshots, context.sessionID, input, filters),
          sessionDirectory(deps.reader, deps.logger, context.sessionID),
        ]);
        const entries = await Promise.all(
          found.page.map(async (evaluated) => {
            const [pending, stopped] = await Promise.all([
              pendingActions(deps.reader, deps.logger, evaluated.node.id),
              latching
                ? stopRecord(deps.latch, deps.logger, evaluated.node.id)
                : undefined,
            ]);
            return toEntry(evaluated, pending.length > 0, stopped);
          }),
        );
        const output: ListOutput = {
          entries,
          total: found.total,
          truncated: found.total > entries.length,
          complete: found.complete,
          ...(found.nextCursor === undefined
            ? {}
            : { nextCursor: found.nextCursor }),
          ...(found.errors === undefined || found.errors.length === 0
            ? {}
            : { errors: found.errors }),
        };
        return {
          output,
          content: renderList(
            output,
            {
              state: filters.state,
              ...(input.activeWithinMinutes === undefined
                ? {}
                : { activeWithinMinutes: input.activeWithinMinutes }),
              sessionIDs: new Set(sessionIDs.map((id) => id.trim())).size,
            },
            callerDirectory,
            deps.clock.now(),
          ),
        };
      } catch (error) {
        if (error instanceof CursorError) {
          throw new ToolError({ message: error.message });
        }
        throw toToolError(error);
      }
    },
  };
}

function filterKey(input: ListInput): string {
  return JSON.stringify([
    input.depth ?? 1,
    input.state ?? "all",
    input.activeWithinMinutes ?? null,
  ]);
}

/**
 * The first page. It reads up to the scan cap, keeping the most recently updated children, where
 * running ones are, when there are more. When matches or unread sessions remain, it keeps a
 * snapshot for the cursor: the matches in page order and a walk over the whole tree for what this
 * read could not reach.
 */
async function firstPage(
  deps: ListToolDeps,
  snapshots: ListSnapshots,
  callerID: SessionID,
  input: ListInput,
  filters: Filters,
): Promise<Page> {
  const depth = input.depth ?? 1;
  const children = await scanDirectChildren(deps.reader, callerID);
  const walked =
    depth === 1 || children.nodes.length === 0
      ? { nodes: children.nodes, truncated: false }
      : await collectSubtreeTruncated(deps.reader, children.nodes, {
          maxDepth: depth,
          truncate: true,
          maxSessions: MAX_SCAN_SESSIONS,
        });
  const unread = children.truncated || walked.truncated;
  const matching = sortForList(await evaluate(deps, walked.nodes, filters));
  const page = matching.slice(0, MAX_ENTRIES);
  if (matching.length === page.length && !unread) {
    return { page, total: matching.length, complete: true };
  }
  const snapshot = snapshots.create({
    callerID,
    filters: filterKey(input),
    matches: matching.map((evaluated) => evaluated.node),
    seen: new Set(walked.nodes.map((node) => node.id)),
    walker: unread ? walkDescendants(deps.reader, callerID, depth) : undefined,
    complete: !unread,
  });
  return {
    page,
    total: matching.length,
    complete: !unread,
    nextCursor: snapshots.cursor(snapshot, page.length),
  };
}

/**
 * A later page: the snapshot's matches from the cursor's offset. When fewer than a page are left
 * and part of the tree is unread, it reads further first, appending the new matches in page order.
 * The snapshot fixes which sessions the listing holds and their order, so the filters are not
 * applied to those found by an earlier call again. Their session records are read again and their
 * state observed again, so every detail on the page is current, and a session deleted since is
 * left out.
 */
async function nextPage(
  deps: ListToolDeps,
  snapshots: ListSnapshots,
  callerID: SessionID,
  input: ListInput,
  filters: Filters,
): Promise<Page> {
  const { snapshot, offset } = snapshots.resolve(
    input.cursor ?? "",
    callerID,
    filterKey(input),
  );
  return snapshots.run(snapshot, async () => {
    const fresh = new Map<SessionID, Evaluated>();
    if (snapshot.matches.length < offset + MAX_ENTRIES) {
      const read = await readFurther(deps, snapshot);
      for (const evaluated of sortForList(await evaluate(deps, read, filters))) {
        snapshot.matches.push(evaluated.node);
        fresh.set(evaluated.node.id, evaluated);
      }
    }
    const nodes = snapshot.matches.slice(offset, offset + MAX_ENTRIES);
    const again = await evaluate(
      deps,
      await reread(
        deps,
        nodes.filter((node) => !fresh.has(node.id)),
      ),
      { state: "all" },
    );
    const byID = new Map(again.map((evaluated) => [evaluated.node.id, evaluated]));
    const page = nodes.flatMap((node) => {
      const evaluated = fresh.get(node.id) ?? byID.get(node.id);
      return evaluated === undefined ? [] : [evaluated];
    });
    const end = offset + nodes.length;
    const more =
      end < snapshot.matches.length || snapshot.walker !== undefined;
    if (!more) snapshots.drop(snapshot);
    return {
      page,
      total: snapshot.matches.length,
      complete: snapshot.complete,
      ...(more ? { nextCursor: snapshots.cursor(snapshot, end) } : {}),
    };
  });
}

/**
 * The nodes with their session records read now, in the same order, without the sessions that no
 * longer exist. A node whose record cannot be read keeps the record its walk read, with a warning.
 */
async function reread(
  deps: ListToolDeps,
  nodes: readonly Descendant[],
): Promise<Descendant[]> {
  const read = await Promise.all(
    nodes.map(async (node): Promise<Descendant | undefined> => {
      try {
        const info = await deps.reader.get(node.id);
        return info === undefined ? undefined : { ...node, info };
      } catch (error) {
        deps.logger.warn("list: could not read a subagent again; showing what was read before", {
          sessionID: node.id,
          error: errorMessage(error),
        });
        return node;
      }
    }),
  );
  return read.filter((node): node is Descendant => node !== undefined);
}

/**
 * Sessions the snapshot's walk reaches that no earlier call read, up to the scan cap, reading at
 * most `PAGE_READ_LIMIT` in all. A failed read ends the walk; the listing then stays incomplete.
 */
async function readFurther(
  deps: ListToolDeps,
  snapshot: ListSnapshot,
): Promise<Descendant[]> {
  const fresh: Descendant[] = [];
  for (let read = 0; read < PAGE_READ_LIMIT; read++) {
    const walker = snapshot.walker;
    if (walker === undefined || fresh.length >= MAX_SCAN_SESSIONS) break;
    let next: IteratorResult<Descendant, void>;
    try {
      next = await walker.next();
    } catch (error) {
      deps.logger.warn("list: could not read further into the subagent tree", {
        error: errorMessage(error),
      });
      snapshot.walker = undefined;
      break;
    }
    if (next.done === true) {
      snapshot.walker = undefined;
      snapshot.complete = true;
      break;
    }
    if (snapshot.seen.has(next.value.id)) continue;
    snapshot.seen.add(next.value.id);
    fresh.push(next.value);
  }
  return fresh;
}

/**
 * Looks each ID up with the ancestry check, so any subagent the caller could stop is found
 * whatever the scan cap. IDs that are not the caller's subagents become errors with close matches
 * among its direct children. Found sessions keep the order they were given in.
 */
async function listByIDs(
  deps: ListToolDeps,
  callerID: SessionID,
  sessionIDs: readonly string[],
  filters: Filters,
): Promise<Page> {
  const ids = [...new Set(sessionIDs.map((id) => id.trim()))];
  const settled = await Promise.allSettled(
    ids.map((id) => assertDescendant(deps.reader, id, callerID)),
  );
  const found: Descendant[] = [];
  const failed: Array<{ readonly sessionID: SessionID; readonly error: AncestryError }> =
    [];
  settled.forEach((result, index) => {
    const sessionID = ids[index] ?? "";
    if (result.status === "fulfilled") {
      found.push(result.value);
      return;
    }
    if (!(result.reason instanceof AncestryError)) throw result.reason;
    failed.push({ sessionID, error: result.reason });
  });
  let pool: SuggestionPool | undefined;
  const errors: Array<NonNullable<ListOutput["errors"]>[number]> = [];
  for (const { sessionID, error } of failed) {
    if (!(error instanceof NotDescendantError)) {
      errors.push({ sessionID, error: error.message, suggestions: [] });
      continue;
    }
    pool ??= await suggestionPool(deps.reader, callerID);
    const explained = await explainNotDescendant(
      deps,
      pool,
      sessionID,
      error.message,
    );
    errors.push({
      sessionID,
      error: explained.message,
      suggestions: explained.suggestions,
    });
  }
  const matching = await evaluate(deps, found, filters);
  return { page: matching, total: matching.length, complete: true, errors };
}

/** Observes the nodes, in input order, and keeps the ones the filters match. */
async function evaluate(
  deps: ListToolDeps,
  nodes: readonly Descendant[],
  filters: Filters,
): Promise<Evaluated[]> {
  const observed = await deps.runState.observeAll(
    nodes.map((node) => node.id),
    new Map<SessionID, SessionInfo>(nodes.map((node) => [node.id, node.info])),
  );
  const now = deps.clock.now();
  return nodes.flatMap((node): Evaluated[] => {
    const shown = displayedState(
      observed.get(node.id) ?? { state: "unknown", source: "probe" },
      node.info,
    );
    const lastActivityAt = lastActivityOf(deps, node, shown);
    const evaluated: Evaluated = {
      node,
      shown,
      ...(lastActivityAt === undefined ? {} : { lastActivityAt }),
    };
    return matches(evaluated, filters, now) ? [evaluated] : [];
  });
}

/** Running ones first, then unknown, then idle; newest first within each. */
function sortForList(evaluated: readonly Evaluated[]): Evaluated[] {
  return evaluated.toSorted(
    (a, b) =>
      STATE_ORDER[a.shown.state] - STATE_ORDER[b.shown.state] ||
      b.node.info.time.created - a.node.info.time.created,
  );
}

function matches(evaluated: Evaluated, filters: Filters, now: number): boolean {
  const { state } = evaluated.shown;
  if (filters.state === "idle" && state !== "idle") return false;
  if (filters.state === "running" && state === "idle") return false;
  if (filters.windowMs === undefined || state !== "idle") return true;
  const last = evaluated.lastActivityAt;
  return last !== undefined && now - last <= filters.windowMs;
}

/**
 * Live progress when this instance observed some; for an idle session whose end was recorded,
 * when it went idle; otherwise unknown.
 */
function lastActivityOf(
  deps: ListToolDeps,
  node: Descendant,
  shown: DisplayedState,
): number | undefined {
  const live = deps.activity?.get(node.id)?.lastProgressAt;
  if (live !== undefined) return live;
  return shown.state === "idle"
    ? idleSince(node.info, shown.noRecordedEnd)
    : undefined;
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
  evaluated: Evaluated,
  waitingOnPermission: boolean,
  stopped: StopDescription | undefined,
): ListEntry {
  const { node, shown, lastActivityAt } = evaluated;
  const { info } = node;
  const model = modelName(info);
  const outcome = settledOutcome(shown, info);
  return {
    sessionID: node.id,
    parentID: node.parentID,
    depth: node.depth,
    ...(info.title === undefined ? {} : { title: info.title }),
    ...(info.agent === undefined ? {} : { agent: info.agent }),
    ...(model === undefined ? {} : { model }),
    directory: info.location.directory,
    state: shown.state,
    stateSource: shown.source,
    ...(shown.noRecordedEnd ? { noRecordedEnd: true } : {}),
    waitingOnPermission,
    ...(outcome === undefined ? {} : { outcome }),
    createdAt: info.time.created,
    ...(info.time.idle === undefined ? {} : { lastIdleAt: info.time.idle }),
    ...(lastActivityAt === undefined ? {} : { lastActivityAt }),
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

/** For a listing that could not read the whole tree and has nothing further to read. */
const PARTIAL_READ_NOTE =
  "Your subagent tree is too large to read in full; only sessions under your most recently updated subagents were checked.";

/** For a listing whose cursor reads the part of the tree not read yet. */
const UNREAD_NOTE =
  "Part of your subagent tree is not read yet; the pages after this one read it.";

/** The filters a listing applied, as its rendering names them. */
export interface RenderedFilters {
  readonly state: StateFilter;
  readonly activeWithinMinutes?: number;
  /** How many distinct sessionIDs were looked up; 0 for a listing of the tree. */
  readonly sessionIDs: number;
}

/**
 * Why a listing has no entries. A caller is told it has no subagents only when nothing filtered
 * any out; otherwise the sentence names what an entry had to be.
 */
function noMatch(filters: RenderedFilters, errors: number): string {
  const condition = requiredCondition(filters);
  if (filters.sessionIDs > 0 && errors >= filters.sessionIDs) {
    return "None of the sessionIDs is one of your subagents.";
  }
  if (condition === undefined) return "You have no subagents.";
  return filters.sessionIDs > 0
    ? `None of the sessionIDs that are your subagents ${condition}.`
    : `None of your subagents ${condition}.`;
}

/**
 * What the filters require of an entry, as a predicate, such as `is running or was active within
 * the last 10 minutes`. Undefined when they require nothing. The activity window keeps every
 * running subagent, so it adds nothing to `state: "running"`.
 */
function requiredCondition(filters: RenderedFilters): string | undefined {
  const minutes = filters.activeWithinMinutes;
  const window =
    minutes === undefined
      ? undefined
      : `was active within the last ${minutes} minute${minutes === 1 ? "" : "s"}`;
  switch (filters.state) {
    case "running":
      return "is running";
    case "idle":
      return window === undefined ? "is idle" : `is idle and ${window}`;
    case "all":
      return window === undefined ? undefined : `is running or ${window}`;
  }
}

/**
 * Plain-text rendering of the list, which is what the model reads from a direct call. An entry
 * names its directory when it differs from `callerDirectory`, and always when that is unknown.
 */
export function renderList(
  output: ListOutput,
  filters: RenderedFilters,
  callerDirectory: string | undefined,
  now: number,
): string {
  const filter = filters.state;
  // An error's suggestions are lines of their own, indented under it.
  const errors = (output.errors ?? []).flatMap((error) =>
    error.error
      .split("\n")
      .map((line, index) => (index === 0 ? `- ${line}` : `  ${line}`)),
  );
  const next =
    output.nextCursor === undefined
      ? []
      : [
          `For the next page, pass cursor: ${JSON.stringify(output.nextCursor)} with the same filters.`,
        ];
  const partial = output.complete
    ? []
    : [output.nextCursor === undefined ? PARTIAL_READ_NOTE : UNREAD_NOTE];
  if (output.entries.length === 0) {
    const none =
      output.nextCursor !== undefined
        ? "No matching subagents on this page."
        : output.total > 0
          ? `No more matching subagents; the earlier pages showed all ${output.total}.`
          : noMatch(filters, output.errors?.length ?? 0);
    return [[none, ...partial].join(" "), ...errors, ...next].join("\n");
  }
  const lines = output.entries.map((entry) =>
    renderEntry(entry, callerDirectory, now),
  );
  if (output.truncated) {
    const found = output.complete
      ? `${output.total} found`
      : `${output.total} found so far`;
    lines.push(
      filter === "all"
        ? `Showing ${output.entries.length} of ${found}, running ones first. Pass state: "running" to list only the running ones.`
        : `Showing ${output.entries.length} of ${found}.`,
    );
  }
  lines.push(...partial, ...errors, ...next);
  return lines.join("\n");
}

function renderEntry(
  entry: ListEntry,
  callerDirectory: string | undefined,
  now: number,
): string {
  const state = renderRunState(entry.state, entry.noRecordedEnd === true);
  const details = [
    entry.outcome === undefined ? state : `${state}, last run ${entry.outcome}`,
    ...(entry.stateSource === "stored" ? ["state as stored, not confirmed"] : []),
    ...(entry.lastActivityAt === undefined
      ? []
      : [`last activity ${renderAge(entry.lastActivityAt, now)}`]),
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
