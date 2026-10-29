// Stops subagents of a caller and everything they launched. Targets are authorized from fresh
// session reads; every selected session is latched before anything is interrupted, so a wake that
// lands mid-stop is caught by the latch; and each result is read back from session state after the
// final probe, so it holds no matter which instance or path made the interrupt.

import {
  assertDescendant,
  collectSubtree,
  collectSubtreeTruncated,
  type Descendant,
  difference,
  dropNested,
  MAX_SCAN_SESSIONS,
  postOrder,
  scanDirectChildren,
} from "@/core/ancestry";
import type { Latch } from "@/core/latch";
import type {
  Clock,
  Logger,
  SessionControl,
  SessionID,
  SessionInfo,
  SessionReader,
} from "@/core/ports";
import type { RunStateTracker } from "@/core/run-state";
import { sanitizeReason } from "@/core/sanitize";

/** Distinct session IDs one call may name. */
export const MAX_TARGETS = 20;
export const DEFAULT_SETTLE_MS = 4000;
/** Settle-and-retry rounds after the first interrupts. */
export const SETTLE_ROUNDS = 3;
/** Permission resource for a root whose session records no agent. */
export const UNKNOWN_AGENT = "unknown";

export const CONTINUE_OWN_NOTE =
  "To continue a stopped subagent you launched, call subagent with its sessionID.";

export const CONTINUE_NESTED_NOTE =
  "Subagents launched by your subagents can only be continued by their own parent.";

/** Shown with every result that stopped something; the native notices it mentions are not ours. */
export const STOPPED_NOTE = `If you launched any of these in the background, you may also get a native notice saying cancelled, or completed if it finished first. It only confirms this result; do not relaunch the work or report it twice. ${CONTINUE_OWN_NOTE} ${CONTINUE_NESTED_NOTE}`;

export const NOTHING_RUNNING_NOTE =
  "None of your subagents is running, so nothing was stopped.";

/** Added to an `all` result when the tree was too large to check in full. */
export const PARTIAL_CHECK_NOTE = `Your subagent tree is too large to check in full: only ${MAX_SCAN_SESSIONS} sessions under your most recently updated subagents were checked, so subagents under older ones may still be running. Stop those by sessionID.`;

export const NOTHING_FOUND_RUNNING_NOTE =
  "None of the subagents checked is running, so nothing was stopped.";

/**
 * - `deleted`: the session was deleted during the stop.
 * - `continued`: someone gave it new work while the stop ran; it was left alone.
 * - `stopping`: still running when the bounded wait ended.
 * - `stopped`: a run ended interrupted during the stop.
 * - `finished`: a run ended on its own (succeeded or failed) during the stop.
 * - `already_idle`: no run ended during the stop.
 */
export type NodeResult =
  | "deleted"
  | "continued"
  | "stopping"
  | "stopped"
  | "finished"
  | "already_idle";

export interface StoppedNode {
  readonly sessionID: SessionID;
  readonly parentID: SessionID;
  /** Levels below the caller: 1 for the caller's direct children. */
  readonly depth: number;
  readonly title?: string;
  readonly agent?: string;
  readonly result: NodeResult;
}

export interface StopOutput {
  /** Every session the stop covered, shallowest first. */
  readonly nodes: readonly StoppedNode[];
  readonly note: string;
}

export interface StopRequest {
  /** Sessions to stop with their subtrees. An empty list counts as absent. */
  readonly sessionIDs?: readonly SessionID[];
  /** Selects every direct child whose subtree has a session that is running or in unknown state. */
  readonly all?: boolean;
  /** Model-written; sanitized before it is stored. */
  readonly reason: string;
}

export interface StopCall {
  readonly callerID: SessionID;
  /** Identifies this stop in every key it writes. Must be unique per stop. */
  readonly generation: string;
  /** Aborted when the calling tool call is interrupted. */
  readonly signal: AbortSignal;
  /**
   * Asked once per distinct agent among the selected roots, after the subtree walk and before any
   * write or interrupt. A rejection propagates and nothing is changed.
   */
  readonly confirm?: (agent: string) => Promise<void>;
}

export interface StopDeps {
  readonly reader: SessionReader;
  readonly control: SessionControl;
  readonly latch: Pick<Latch, "add" | "owe" | "isActive" | "isLifted">;
  readonly runState: Pick<RunStateTracker, "observeAll">;
  readonly clock: Clock;
  readonly logger: Logger;
}

export interface StopOptions {
  /** Latch every stopped session. `false` makes the stop a plain subtree interrupt. Default true. */
  readonly latch?: boolean;
  /** Owe each stopped root a stop note for the prompt that continues it. Default true. */
  readonly notifyChild?: boolean;
  /** Settlement wait per round. Default 4000. */
  readonly settleMs?: number;
}

/** The request names neither or both selectors, or too many sessions. */
export class StopInputError extends Error {
  override name = "StopInputError";
}

type Selector =
  | { readonly all: true }
  | { readonly all: false; readonly ids: readonly SessionID[] };

/**
 * Stops the selected subagents and their whole subtrees. Throws `StopInputError`,
 * `EmptyReasonError`, or an `AncestryError` before any side effect. Resolves `undefined` when
 * `call.signal` aborts: from then on it writes and interrupts nothing, and keeps every latch already
 * written.
 */
export async function stopSubagents(
  deps: StopDeps,
  call: StopCall,
  request: StopRequest,
  options: StopOptions = {},
): Promise<StopOutput | undefined> {
  const latching = options.latch ?? true;
  const notifyChild = latching && (options.notifyChild ?? true);
  const settleMs = options.settleMs ?? DEFAULT_SETTLE_MS;
  const { callerID, generation, signal } = call;

  const selector = validate(request);
  const reason = sanitizeReason(request.reason);
  const selected = selector.all
    ? await activeChildren(deps, callerID)
    : {
        children: await Promise.all(
          selector.ids.map((id) => assertDescendant(deps.reader, id, callerID)),
        ),
        partial: false,
      };
  const roots = dropNested(selected.children);
  if (roots.length === 0) {
    return {
      nodes: [],
      note: selected.partial
        ? `${NOTHING_FOUND_RUNNING_NOTE} ${PARTIAL_CHECK_NOTE}`
        : NOTHING_RUNNING_NOTE,
    };
  }

  const startedAt = deps.clock.now();
  let nodes = postOrder(await collectSubtree(deps.reader, roots));
  // `time.idle` marks the last finished run; a changed value later means a run ended during the stop.
  const idleBefore = new Map<SessionID, number | undefined>(
    nodes.map((node) => [node.id, node.info.time.idle]),
  );
  if (call.confirm !== undefined) {
    for (const agent of distinctAgents(roots)) await call.confirm(agent);
  }

  const live = () => !signal.aborted;
  const cancelled = (stage: string, sessionID?: SessionID): undefined => {
    deps.logger.info(
      "stop: cancelled; issuing no further writes or interrupts",
      {
        generation,
        stage,
        ...(sessionID === undefined ? {} : { sessionID }),
      },
    );
    return undefined;
  };
  const rootIDs = new Set(roots.map((root) => root.id));
  const record = {
    generation,
    parentSessionID: callerID,
    reason,
    at: startedAt,
  };

  if (latching) {
    for (const node of nodes) {
      if (!live()) return cancelled("latch", node.id);
      await deps.latch.add(node.id, record);
      if (notifyChild && rootIDs.has(node.id)) {
        if (!live()) return cancelled("note", node.id);
        await deps.latch.owe(node.id, generation);
      }
    }
  }

  // Sessions whose latch from this stop is no longer active: continued, superseded by a newer
  // stop, expired, or given up by the safety valve. None of that reverts, since lift and gaveup
  // keys are written once and an older latch never becomes current again, so these sessions are left
  // out of every later wait and retry.
  const released = new Set<SessionID>();
  const ours = (node: Descendant) => !released.has(node.id);

  /** Interrupts the node unless someone continued it since this stop latched it. */
  const interruptIfStillOurs = async (node: Descendant): Promise<void> => {
    if (latching && !(await deps.latch.isActive(node.id, generation))) {
      released.add(node.id);
      return;
    }
    if (!live()) return;
    try {
      await deps.control.interrupt(node.id);
    } catch (error) {
      // A session deleted meanwhile rejects here; classification reports it.
      deps.logger.warn("stop: interrupt failed", {
        sessionID: node.id,
        generation,
        error: errorMessage(error),
      });
    }
  };

  for (const node of nodes) {
    if (!live()) return cancelled("interrupt", node.id);
    await interruptIfStillOurs(node);
  }

  for (let round = 0; round < SETTLE_ROUNDS; round++) {
    if (!live()) return cancelled("settle");
    await settle(deps, nodes.filter(ours), settleMs, signal);
    if (!live()) return cancelled("settle");
    // Sessions launched below a released session belong to whoever continued it, so the walk does
    // not descend through released sessions. A session continued while idle gets no interrupt
    // attempt, so check every known node before walking.
    if (latching) {
      for (const node of nodes) {
        if (released.has(node.id)) continue;
        if (!(await deps.latch.isActive(node.id, generation)))
          released.add(node.id);
      }
    }
    const fresh = difference(
      postOrder(await rewalk(deps, roots, generation, released)),
      nodes,
    );
    // These sessions were created during the stop, so any `time.idle` they have was set during it.
    for (const node of fresh) idleBefore.set(node.id, undefined);
    if (latching) {
      // Recheck each parent right before latching its child, in walk order, so a parent continued
      // after the check above, or a fresh parent already released, keeps its new children.
      for (const node of [...fresh].sort((a, b) => a.depth - b.depth)) {
        if (!live()) return cancelled("latch", node.id);
        const parentReleased =
          released.has(node.parentID) ||
          (!rootIDs.has(node.id) &&
            !(await deps.latch.isActive(node.parentID, generation)));
        if (parentReleased || node.ancestors.some((id) => released.has(id))) {
          released.add(node.id);
          continue;
        }
        await deps.latch.add(node.id, record);
      }
    }
    const candidates = nodes.filter(ours);
    const observed = await deps.runState.observeAll(
      candidates.map((node) => node.id),
    );
    const busy = candidates.filter(
      (node) => observed.get(node.id)?.state !== "idle",
    );
    const freshOurs = fresh.filter(ours);
    nodes = [...nodes, ...freshOurs];
    if (freshOurs.length === 0 && busy.length === 0) break;
    for (const node of postOrder([...freshOurs, ...busy])) {
      if (!live()) return cancelled("interrupt", node.id);
      await interruptIfStillOurs(node);
    }
  }

  if (!live()) return cancelled("classify");
  return {
    nodes: await classifyAll(deps, nodes, generation, idleBefore, latching),
    note: selected.partial
      ? `${STOPPED_NOTE} ${PARTIAL_CHECK_NOTE}`
      : STOPPED_NOTE,
  };
}

function validate(request: StopRequest): Selector {
  const ids =
    request.sessionIDs !== undefined && request.sessionIDs.length > 0
      ? request.sessionIDs
      : undefined;
  const all = request.all === true;
  if (all && ids !== undefined) {
    throw new StopInputError("Pass either sessionIDs or all: true, not both.");
  }
  if (all) return { all: true };
  if (ids === undefined) {
    throw new StopInputError(
      "Pass sessionIDs with the subagents to stop, or all: true to stop every running one.",
    );
  }
  const unique = [...new Set(ids)];
  if (unique.length > MAX_TARGETS) {
    throw new StopInputError(
      `Pass at most ${MAX_TARGETS} sessionIDs; nothing was changed.`,
    );
  }
  return { all: false, ids: unique };
}

/**
 * Direct children whose subtree has a session that is running or in unknown state. Finding them is
 * a read-only scan over every child, so it uses the larger scan cap; the stop that follows applies
 * the usual cap to the subtrees it selects. Over the scan cap it checks the most recently updated
 * sessions, where running ones are, and reports the check as `partial` so the result can say so.
 */
async function activeChildren(
  deps: StopDeps,
  callerID: SessionID,
): Promise<{ children: Descendant[]; partial: boolean }> {
  const scan = await scanDirectChildren(deps.reader, callerID);
  const children = scan.nodes;
  if (children.length === 0) return { children: [], partial: false };
  // Only the session cap truncates. A subtree past the depth cap fails the call, as the stop that
  // would follow fails too, rather than reporting that nothing below it is running.
  const walked = await collectSubtreeTruncated(deps.reader, children, {
    truncate: true,
    truncateDepth: false,
    maxSessions: MAX_SCAN_SESSIONS,
  });
  const partial = scan.truncated || walked.truncated;
  if (partial) {
    deps.logger.warn(
      "stop: too many subagents to check them all; checked the most recently updated",
      { callerID },
    );
  }
  const nodes = walked.nodes;
  const observed = await deps.runState.observeAll(nodes.map((node) => node.id));
  const active = new Set<SessionID>();
  for (const node of nodes) {
    if (observed.get(node.id)?.state === "idle") continue;
    // `ancestors` starts with the caller, so its second entry is the direct child above the node.
    active.add(node.ancestors[1] ?? node.id);
  }
  return {
    children: children.filter((child) => active.has(child.id)),
    partial,
  };
}

function distinctAgents(roots: readonly Descendant[]): string[] {
  return [...new Set(roots.map((root) => root.info.agent ?? UNKNOWN_AGENT))];
}

/** Waits until every node is idle, `ms` passes, or the call is cancelled. Never rejects. */
async function settle(
  deps: StopDeps,
  nodes: readonly Descendant[],
  ms: number,
  signal: AbortSignal,
): Promise<void> {
  const timer = new AbortController();
  const stop = () => timer.abort();
  signal.addEventListener("abort", stop, { once: true });
  try {
    await Promise.race([
      Promise.all(
        nodes.map((node) =>
          Promise.resolve()
            .then(() => deps.control.waitIdle(node.id))
            .catch(() => undefined),
        ),
      ),
      deps.clock.sleep(ms, timer.signal),
    ]);
  } finally {
    signal.removeEventListener("abort", stop);
    timer.abort();
  }
}

/**
 * The subtree as it is now. A failed walk (a cap exceeded by sessions created during the stop, or
 * a read error) is logged and yields no new sessions, because the stop has already been applied to
 * every session found before it.
 */
async function rewalk(
  deps: StopDeps,
  roots: readonly Descendant[],
  generation: string,
  released: ReadonlySet<SessionID>,
): Promise<Descendant[]> {
  try {
    return await collectSubtree(deps.reader, roots, { stopAt: released });
  } catch (error) {
    deps.logger.warn("stop: could not re-read the subtree", {
      generation,
      error: errorMessage(error),
    });
    return [];
  }
}

async function classifyAll(
  deps: StopDeps,
  nodes: readonly Descendant[],
  generation: string,
  idleBefore: ReadonlyMap<SessionID, number | undefined>,
  latching: boolean,
): Promise<StoppedNode[]> {
  // Session state is read after this probe, so `time.idle` and `outcome` describe the run that the
  // probe saw end, not an earlier one.
  const observed = await deps.runState.observeAll(nodes.map((node) => node.id));
  const shallowestFirst = nodes.toSorted((a, b) => a.depth - b.depth);
  return Promise.all(
    shallowestFirst.map(async (node) => {
      const [info, lifted] = await Promise.all([
        deps.reader.get(node.id),
        latching ? deps.latch.isLifted(node.id, generation) : false,
      ]);
      const state = observed.get(node.id)?.state ?? "unknown";
      const result = classify(
        info,
        lifted,
        state !== "idle",
        idleBefore.get(node.id),
      );
      return describeNode(node, info ?? node.info, result);
    }),
  );
}

function classify(
  info: SessionInfo | undefined,
  lifted: boolean,
  busy: boolean,
  idleBefore: number | undefined,
): NodeResult {
  if (info === undefined) return "deleted";
  if (lifted) return "continued";
  if (busy) return "stopping";
  // Core advances `time.idle` strictly on every terminal transition and can run it ahead of the
  // wall clock, so only a comparison with the value captured before the stop is reliable.
  if (info.time.idle !== idleBefore) {
    if (info.outcome === "interrupted") return "stopped";
    if (info.outcome === "succeeded" || info.outcome === "failed") {
      return "finished";
    }
  }
  return "already_idle";
}

function describeNode(
  node: Descendant,
  info: SessionInfo,
  result: NodeResult,
): StoppedNode {
  return {
    sessionID: node.id,
    parentID: node.parentID,
    depth: node.depth,
    ...(info.title === undefined ? {} : { title: info.title }),
    ...(info.agent === undefined ? {} : { agent: info.agent }),
    result,
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
