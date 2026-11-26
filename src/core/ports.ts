// Interfaces between the pure core modules and the OpenCode plugin host. The host adapter in
// `src/host.ts` implements them over `ctx`; unit tests implement them with fakes.

import type {
  JsonValue,
  ModelInfo,
  OpenCodeEvent,
  SessionInfo,
  SessionMessageInfo,
} from "@opencode/client";

export type { OpenCodeEvent, SessionInfo, SessionMessageInfo };

export type SessionID = string;

/** The ID the plugin registers under, which also names it in the metadata of what it posts. */
export const PLUGIN_ID = "subagent-intervene";

export type Json =
  | null
  | boolean
  | number
  | string
  | readonly Json[]
  | { readonly [key: string]: Json };

/** Reads sessions. `get` resolves `undefined` when the session does not exist. */
export interface SessionReader {
  get(sessionID: SessionID): Promise<SessionInfo | undefined>;
  /**
   * One page of direct children ordered by `time.updated`, oldest first unless `order` is
   * `"desc"`. `next` is the cursor for the following page in the same order.
   */
  children(
    parentID: SessionID,
    cursor?: string,
    order?: "asc" | "desc",
  ): Promise<{ data: readonly SessionInfo[]; next?: string }>;
  /** Active stored history, including the latest completed compaction. */
  context(sessionID: SessionID): Promise<readonly SessionMessageInfo[]>;
  /** Actions of permission requests waiting for an answer in this session. */
  pendingPermissions(sessionID: SessionID): Promise<readonly string[]>;
}

export type ContextModel = Pick<ModelInfo, "id" | "providerID" | "limit">;

/** Reads the catalog in the session's location, which can differ from the plugin's. */
export interface ModelReader {
  list(directory: string): Promise<readonly ContextModel[]>;
}

export interface CompactionAdmission {
  readonly id: string;
  readonly delivery: "steer" | "queue";
}

export interface SessionCompactor {
  /** Returns admission only. A coalesced request retains its existing ID and delivery. */
  compact(input: {
    readonly sessionID: SessionID;
    readonly id: string;
    readonly delivery: "steer";
  }): Promise<CompactionAdmission>;
}

export interface SessionControl {
  /** Interrupts the session's current run with `resume: false`. True if an active run was stopped. */
  interrupt(sessionID: SessionID): Promise<boolean>;
  /**
   * Resolves when the session has no active run; immediately when idle. Never starts work. The host
   * shares one outstanding call per session, because the underlying call cannot be cancelled.
   * Rejects on hosts without the call.
   */
  waitIdle(sessionID: SessionID): Promise<void>;
}

/** Reads permission requests. */
export interface PermissionReader {
  /**
   * IDs of the permission requests waiting for an answer in this session. Sees only requests held
   * in the plugin instance's own location.
   */
  pendingRequestIDs(sessionID: SessionID): Promise<readonly string[]>;
}

/** A message the plugin adds to a session. The model reads it as a user message holding `text`. */
export interface SyntheticMessage {
  readonly sessionID: SessionID;
  /**
   * Inbox item ID; must start with `msg_`. The first admission of an ID wins: posting it again
   * returns the existing item, delivered or not, and adds nothing.
   */
  readonly id?: string;
  readonly text: string;
  /** Shown to people in OpenCode; never reaches the model. */
  readonly description: string;
  /** Never reaches the model. */
  readonly metadata: Readonly<Record<string, string>>;
  /**
   * `steer` reaches a running session at its next step boundary, after the current model response
   * and every tool call in flight finish. Neither delivery interrupts anything.
   */
  readonly delivery: "steer" | "queue";
  /**
   * `false` leaves an idle session idle: the message waits until something else wakes it. A
   * running session reads a steered message either way.
   */
  readonly resume: boolean;
}

export interface SessionMessenger {
  /**
   * Admits the message into the session's inbox. Resolves with the inbox item's ID, which the
   * message keeps once delivered into the session's messages, and when it was admitted, in epoch
   * milliseconds.
   */
  synthetic(
    message: SyntheticMessage,
  ): Promise<{ readonly id: string; readonly createdAt: number }>;
}

/**
 * Keyed entries in a session's instructions. The host renders each active entry as a
 * `<context key="...">` block in the system context and announces puts and removals as chronological
 * updates at the next step boundary. The host keeps entries across compaction; a change can appear
 * as a chronological update on a previously observed baseline. Entries outlive the plugin instance
 * that wrote them.
 */
export interface SessionInstructionEntries {
  /** Active entries only; removed keys are absent. */
  list(
    sessionID: SessionID,
  ): Promise<ReadonlyArray<{ readonly key: string; readonly value: Json }>>;
  /**
   * Creates or replaces the entry; the last successful put wins. Keys match
   * `/^[a-z0-9][a-z0-9._-]*$/` and the JSON-encoded value is at most 256 KiB.
   */
  put(input: {
    readonly sessionID: SessionID;
    readonly key: string;
    readonly value: JsonValue;
  }): Promise<void>;
  /** Removes the entry. Removing a key that is absent or already removed changes nothing. */
  remove(input: {
    readonly sessionID: SessionID;
    readonly key: string;
  }): Promise<void>;
}

/** Timers for work that must not keep the server process alive. */
export interface Scheduler {
  /** Runs `task` once after `ms`. Returns a function that cancels it if it has not run yet. */
  schedule(ms: number, task: () => void): () => void;
}

/** Plugin storage: a global key-value store with no compare-and-set. */
export interface Store {
  get(key: string): Promise<Json | undefined>;
  set(key: string, value: Json): Promise<void>;
  remove(key: string): Promise<void>;
  scan(
    prefix: string,
  ): Promise<ReadonlyArray<{ readonly key: string; readonly value: Json }>>;
}

export interface Clock {
  now(): number;
  /** Resolves after `ms`, or early when `signal` aborts. Never rejects. */
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
}

export interface Logger {
  info(message: string, data?: Record<string, unknown>): void;
  warn(message: string, data?: Record<string, unknown>): void;
}

export type RunState = "running" | "idle" | "unknown";

export interface RunObservation {
  readonly state: RunState;
  readonly source: "event" | "probe";
  /**
   * Set with an idle state when OpenCode reports the session idle but its last run recorded no
   * end, so nothing will report that run as finished.
   */
  readonly noRecordedEnd?: true;
}
