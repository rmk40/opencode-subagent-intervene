// The snapshots behind `subagents.list` cursors. Core pages children by `time.updated`, which
// changes as sessions run, so passing its cursor on could repeat or skip sessions. A listing
// instead keeps, in memory, the matching sessions it found in order and a walk that reads the rest
// of the tree, and a cursor is an offset into that snapshot. Each snapshot belongs to one caller
// and one set of filters. Snapshots are never stored, so a cursor works only in the instance that
// made it, and only until it expires.

import { randomUUID } from "node:crypto";
import type { Descendant } from "@/core/ancestry";
import type { Clock, SessionID } from "@/core/ports";

/** How long a cursor stays usable after its listing was last read. */
export const LIST_CURSOR_TTL_MS = 30 * 60 * 1000;
/** Snapshots kept at once; the least recently used is dropped beyond it. */
export const MAX_LIST_SNAPSHOTS = 32;
const CURSOR_PREFIX = "lc1.";

export interface ListSnapshot {
  readonly id: string;
  readonly callerID: SessionID;
  /** The filters the listing was made with, encoded so equal filters compare equal. */
  readonly filters: string;
  /** Matching sessions found so far, in page order. */
  readonly matches: Descendant[];
  /** Every session read so far, matching or not. */
  readonly seen: Set<SessionID>;
  /** Reads the rest of the tree; undefined once all of it was read or the snapshot was dropped. */
  walker: AsyncGenerator<Descendant, void, undefined> | undefined;
  /** The whole tree has been read. */
  complete: boolean;
  expiresAt: number;
  /** Calls on this snapshot, run one at a time. */
  queue: Promise<void>;
}

/** A cursor this instance cannot use. The message is written for the calling model. */
export class CursorError extends Error {
  override name = "CursorError";
}

export const UNKNOWN_CURSOR_MESSAGE =
  "This cursor is unknown or expired, for example because the plugin reloaded or the listing was last read over 30 minutes ago. List again without cursor.";

export const MISMATCHED_CURSOR_MESSAGE =
  "This cursor belongs to a listing with other filters. Pass the same depth, state and activeWithinMinutes as the call that returned it, or list again without cursor.";

export class ListSnapshots {
  private readonly clock: Pick<Clock, "now">;
  private readonly ttlMs: number;
  private readonly max: number;
  /** By ID, least recently used first. */
  private readonly snapshots = new Map<string, ListSnapshot>();

  constructor(
    clock: Pick<Clock, "now">,
    options: { readonly ttlMs?: number; readonly max?: number } = {},
  ) {
    this.clock = clock;
    this.ttlMs = options.ttlMs ?? LIST_CURSOR_TTL_MS;
    this.max = Math.max(1, options.max ?? MAX_LIST_SNAPSHOTS);
  }

  create(input: {
    readonly callerID: SessionID;
    readonly filters: string;
    readonly matches: Descendant[];
    readonly seen: Set<SessionID>;
    readonly walker: AsyncGenerator<Descendant, void, undefined> | undefined;
    readonly complete: boolean;
  }): ListSnapshot {
    this.purge();
    const snapshot: ListSnapshot = {
      id: randomUUID().replaceAll("-", ""),
      ...input,
      expiresAt: this.clock.now() + this.ttlMs,
      queue: Promise.resolve(),
    };
    this.snapshots.set(snapshot.id, snapshot);
    while (this.snapshots.size > this.max) {
      const oldest = this.snapshots.values().next();
      if (oldest.done === true) break;
      this.drop(oldest.value);
    }
    return snapshot;
  }

  /**
   * The snapshot and offset a cursor names. Throws `CursorError` when this instance has no such
   * snapshot for the caller, it expired, or it was made with other filters.
   */
  resolve(
    cursor: string,
    callerID: SessionID,
    filters: string,
  ): { readonly snapshot: ListSnapshot; readonly offset: number } {
    this.purge();
    const parsed = parseCursor(cursor);
    const snapshot =
      parsed === undefined ? undefined : this.snapshots.get(parsed.id);
    // Another caller's snapshot is reported as unknown, so a cursor reveals nothing about it.
    if (
      parsed === undefined ||
      snapshot === undefined ||
      snapshot.callerID !== callerID ||
      parsed.offset > snapshot.matches.length
    ) {
      throw new CursorError(UNKNOWN_CURSOR_MESSAGE);
    }
    if (snapshot.filters !== filters) {
      throw new CursorError(MISMATCHED_CURSOR_MESSAGE);
    }
    snapshot.expiresAt = this.clock.now() + this.ttlMs;
    this.snapshots.delete(snapshot.id);
    this.snapshots.set(snapshot.id, snapshot);
    return { snapshot, offset: parsed.offset };
  }

  cursor(snapshot: ListSnapshot, offset: number): string {
    return `${CURSOR_PREFIX}${snapshot.id}.${offset}`;
  }

  /** Runs `task` once every earlier task on the snapshot has settled. */
  run<T>(snapshot: ListSnapshot, task: () => Promise<T>): Promise<T> {
    const result = snapshot.queue.then(task);
    snapshot.queue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  /** Forgets the snapshot, ending its walk. */
  drop(snapshot: ListSnapshot): void {
    this.snapshots.delete(snapshot.id);
    const walker = snapshot.walker;
    snapshot.walker = undefined;
    void walker?.return(undefined).catch(() => undefined);
  }

  private purge(): void {
    const now = this.clock.now();
    for (const snapshot of [...this.snapshots.values()]) {
      if (snapshot.expiresAt <= now) this.drop(snapshot);
    }
  }
}

function parseCursor(
  cursor: string,
): { readonly id: string; readonly offset: number } | undefined {
  const trimmed = cursor.trim();
  if (!trimmed.startsWith(CURSOR_PREFIX)) return undefined;
  const [id, offset, ...rest] = trimmed.slice(CURSOR_PREFIX.length).split(".");
  if (id === undefined || id === "" || offset === undefined || rest.length > 0) {
    return undefined;
  }
  if (!/^\d+$/.test(offset)) return undefined;
  return { id, offset: Number(offset) };
}
