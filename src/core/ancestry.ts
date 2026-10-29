// Decides which sessions belong to a caller. Every answer comes from fresh session reads, never
// from memory: a target is the caller's when walking `parentID` upward from it reaches the caller,
// and a subtree is whatever paging through `children` finds below its roots.

import type { SessionID, SessionInfo, SessionReader } from "@/core/ports";

export const MAX_ANCESTRY_HOPS = 32;
/** Levels in one subtree, counting its root as the first. */
export const MAX_SUBTREE_DEPTH = 8;
/** Sessions in one walk over a subtree that is about to be changed, roots included. */
export const MAX_SUBTREE_SESSIONS = 200;
/**
 * Sessions a read-only scan may read: listing subagents, or finding which children `all` stops. A
 * long-running orchestrator can have hundreds of children, most of them long finished.
 */
export const MAX_SCAN_SESSIONS = 2000;

/** Base class of the errors below. Their messages are written for the calling model. */
export class AncestryError extends Error {
  override name = "AncestryError";
}

/**
 * The target does not exist or does not descend from the caller. Both cases share one message, so
 * the error does not reveal whether a session the caller does not own exists.
 */
export class NotDescendantError extends AncestryError {
  override name = "NotDescendantError";
  readonly sessionID: SessionID;

  constructor(sessionID: SessionID) {
    super(`Session ${sessionID} is not one of your subagents.`);
    this.sessionID = sessionID;
  }
}

/** The target is the calling session itself. */
export class SelfTargetError extends AncestryError {
  override name = "SelfTargetError";
  readonly sessionID: SessionID;

  constructor(sessionID: SessionID) {
    super(
      `Session ${sessionID} is your own session. Target one of your subagents instead.`,
    );
    this.sessionID = sessionID;
  }
}

/** A walk found more levels or more sessions than its caps allow. */
export class SubtreeTooLargeError extends AncestryError {
  override name = "SubtreeTooLargeError";
  readonly limit: "depth" | "sessions";

  constructor(limit: "depth" | "sessions", maxSessions = MAX_SUBTREE_SESSIONS) {
    super(
      limit === "depth"
        ? `The subagent tree is more than ${MAX_SUBTREE_DEPTH} levels deep; nothing was changed.`
        : `The subagent tree has more than ${maxSessions} sessions; nothing was changed.`,
    );
    this.limit = limit;
  }
}

/** A session below the caller. */
export interface Descendant {
  readonly id: SessionID;
  readonly info: SessionInfo;
  /** The session that launched this one: the caller or another descendant. */
  readonly parentID: SessionID;
  /** Levels below the caller: 1 for the caller's direct children. */
  readonly depth: number;
  /** The chain from the caller down to `parentID`, the caller first. Its length is `depth`. */
  readonly ancestors: readonly SessionID[];
}

/**
 * Returns the target if walking its `parentID` chain upward reaches the caller within 32 hops.
 * Throws `SelfTargetError` when the target is the caller, and `NotDescendantError` when the target
 * is missing, the chain ends or breaks first, it loops, or it runs past 32 hops.
 */
export async function assertDescendant(
  reader: SessionReader,
  targetID: SessionID,
  callerID: SessionID,
): Promise<Descendant> {
  if (targetID === callerID) throw new SelfTargetError(targetID);
  const target = await reader.get(targetID);
  if (target === undefined) throw new NotDescendantError(targetID);

  // Ancestors found so far, the target's parent first.
  const chain: SessionID[] = [];
  const seen = new Set<SessionID>([targetID]);
  let current: SessionInfo = target;
  for (let hop = 1; hop <= MAX_ANCESTRY_HOPS; hop++) {
    const parentID = current.parentID;
    if (parentID === undefined) break;
    if (parentID === callerID) {
      const ancestors = [callerID, ...chain.toReversed()];
      return {
        id: target.id,
        info: target,
        parentID: chain[0] ?? callerID,
        depth: ancestors.length,
        ancestors,
      };
    }
    if (hop === MAX_ANCESTRY_HOPS || seen.has(parentID)) break;
    seen.add(parentID);
    chain.push(parentID);
    const parent = await reader.get(parentID);
    if (parent === undefined) break;
    current = parent;
  }
  throw new NotDescendantError(targetID);
}

/**
 * The caller's direct children for a read-only scan, most recently updated first, at most
 * `maxSessions` (default 2000). Up to the cap, paging runs oldest first, so a child updated while
 * the scan pages moves to a later page and is still found. Over the cap, the scan re-reads newest
 * first and keeps the most recently updated children, since running children are among them, and
 * reports the cut. That second read can miss a child updated while it pages, which is acceptable
 * for a read that is already partial.
 */
export async function scanDirectChildren(
  reader: SessionReader,
  callerID: SessionID,
  options: { readonly maxSessions?: number } = {},
): Promise<{ nodes: Descendant[]; truncated: boolean }> {
  const max = options.maxSessions ?? MAX_SCAN_SESSIONS;
  const oldestFirst = await readChildren(reader, callerID, "asc", max + 1);
  const truncated = oldestFirst.length > max;
  // Deliberately two reads: only the oldest-first one can't skip a child updated mid-scan, and only
  // the newest-first one keeps the newest children when there are too many.
  const infos = truncated
    ? await readChildren(reader, callerID, "desc", max)
    : oldestFirst;
  const nodes = infos.map((info): Descendant => ({
    id: info.id,
    info,
    parentID: callerID,
    depth: 1,
    ancestors: [callerID],
  }));
  return { nodes: newestFirst(nodes), truncated };
}

/** Distinct direct children in the given paging order, stopping once `limit` are found. */
async function readChildren(
  reader: SessionReader,
  parentID: SessionID,
  order: "asc" | "desc",
  limit: number,
): Promise<SessionInfo[]> {
  const found: SessionInfo[] = [];
  const seen = new Set<SessionID>();
  for await (const info of listChildren(reader, parentID, order)) {
    if (seen.has(info.id)) continue;
    seen.add(info.id);
    found.push(info);
    if (found.length >= limit) break;
  }
  return found;
}

/** Most recently updated first; ties keep their order. */
function newestFirst(nodes: readonly Descendant[]): Descendant[] {
  return nodes.toSorted((a, b) => b.info.time.updated - a.info.time.updated);
}

export interface SubtreeOptions {
  /** Do not list the children of these sessions; the sessions themselves are still included. */
  readonly stopAt?: ReadonlySet<SessionID>;
  /** Do not descend below this depth relative to the caller. Levels below it are never read. */
  readonly maxDepth?: number;
  /**
   * Stop at the caps instead of throwing, for read-only callers. `collectSubtreeTruncated` reports
   * whether the walk stopped early.
   */
  readonly truncate?: boolean;
  /**
   * With `truncate`, whether the depth cap also truncates. Default true. Set false when a deeper
   * tree must fail the walk, because what lies below the cap cannot be acted on either.
   */
  readonly truncateDepth?: boolean;
  /** Session cap for this walk, roots included. Defaults to the 200 allowed for a change. */
  readonly maxSessions?: number;
}

/** `collectSubtree` that also says whether it stopped at a cap; only stops early with `truncate`. */
export async function collectSubtreeTruncated(
  reader: SessionReader,
  roots: readonly Descendant[],
  options: SubtreeOptions = {},
): Promise<{ nodes: Descendant[]; truncated: boolean }> {
  const nodes: Descendant[] = [];
  const truncated = await walkSubtree(reader, roots, options, nodes);
  return { nodes, truncated };
}

/**
 * Every session in the subtrees of `roots`, roots included, each once, in breadth-first order.
 * Throws `SubtreeTooLargeError` as soon as a subtree has a ninth level or the walk finds a 201st
 * session, so a caller that walks before acting changes nothing over the caps.
 */
export async function collectSubtree(
  reader: SessionReader,
  roots: readonly Descendant[],
  options: SubtreeOptions = {},
): Promise<Descendant[]> {
  const nodes: Descendant[] = [];
  await walkSubtree(reader, roots, options, nodes);
  return nodes;
}

/**
 * Fills `nodes` breadth-first. Over a cap it throws `SubtreeTooLargeError`, or with `truncate`
 * stops and returns true. Sessions past the depth cap are left out; the session cap keeps the
 * first `maxSessions` found.
 */
async function walkSubtree(
  reader: SessionReader,
  roots: readonly Descendant[],
  options: SubtreeOptions,
  nodes: Descendant[],
): Promise<boolean> {
  const truncate = options.truncate === true;
  const truncateDepth = truncate && options.truncateDepth !== false;
  const maxSessions = options.maxSessions ?? MAX_SUBTREE_SESSIONS;
  let truncated = false;
  const rootIDs = new Set(roots.map((root) => root.id));
  // The roots' ancestor chains are seen from the start, so a child listing that loops back up
  // the tree, to the caller included, is never walked.
  const seen = new Set<SessionID>();
  for (const root of roots) {
    for (const ancestor of root.ancestors) {
      if (!rootIDs.has(ancestor)) seen.add(ancestor);
    }
  }
  for (const root of roots) {
    if (seen.has(root.id)) continue;
    seen.add(root.id);
    if (nodes.length === maxSessions) {
      if (truncate) return true;
      throw new SubtreeTooLargeError("sessions", maxSessions);
    }
    nodes.push(root);
  }

  let level = [...nodes];
  // `below` counts levels under the roots; children found in this pass are on level `below + 1`.
  for (let below = 1; level.length > 0; below++) {
    const next: Descendant[] = [];
    for (const parent of level) {
      if (options.stopAt?.has(parent.id) === true) continue;
      if (options.maxDepth !== undefined && parent.depth >= options.maxDepth)
        continue;
      for await (const info of listChildren(reader, parent.id)) {
        if (seen.has(info.id)) continue;
        if (below >= MAX_SUBTREE_DEPTH) {
          if (!truncateDepth) throw new SubtreeTooLargeError("depth");
          truncated = true;
          break;
        }
        seen.add(info.id);
        if (nodes.length === maxSessions) {
          if (truncate) return true;
          throw new SubtreeTooLargeError("sessions", maxSessions);
        }
        const child: Descendant = {
          id: info.id,
          info,
          parentID: parent.id,
          depth: parent.depth + 1,
          ancestors: [...parent.ancestors, parent.id],
        };
        nodes.push(child);
        next.push(child);
      }
    }
    level = next;
  }
  return truncated;
}

/** Deepest first, so every session comes before the session that launched it. Stable. */
export function postOrder(nodes: readonly Descendant[]): Descendant[] {
  return nodes.toSorted((a, b) => b.depth - a.depth);
}

/** Drops duplicates and every root that lies inside another root's subtree. Keeps order. */
export function dropNested(roots: readonly Descendant[]): Descendant[] {
  const ids = new Set(roots.map((root) => root.id));
  const kept = new Set<SessionID>();
  return roots.filter((root) => {
    if (kept.has(root.id)) return false;
    if (root.ancestors.some((ancestor) => ids.has(ancestor))) return false;
    kept.add(root.id);
    return true;
  });
}

/** The nodes whose session is not among `known`. Keeps order. */
export function difference(
  nodes: readonly Descendant[],
  known: readonly Descendant[],
): Descendant[] {
  const ids = new Set(known.map((node) => node.id));
  return nodes.filter((node) => !ids.has(node.id));
}

/**
 * Pages through a session's direct children. Entries whose `parentID` is not the session are
 * skipped, so a listing that ignored its filter cannot pull unrelated sessions into a walk, and a
 * cursor that repeats ends the listing instead of looping.
 */
async function* listChildren(
  reader: SessionReader,
  parentID: SessionID,
  order: "asc" | "desc" = "asc",
): AsyncGenerator<SessionInfo> {
  const cursors = new Set<string>();
  let cursor: string | undefined;
  do {
    const page = await reader.children(parentID, cursor, order);
    for (const info of page.data) {
      if (info.parentID === parentID) yield info;
    }
    cursor = page.next;
    if (cursor !== undefined) {
      if (cursors.has(cursor)) return;
      cursors.add(cursor);
    }
  } while (cursor !== undefined);
}
