// Interfaces between the pure core modules and the OpenCode plugin host. The host adapter in
// `src/host.ts` implements them over `ctx`; unit tests implement them with fakes.

import type {
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
  /** Messages after the latest compaction. */
  context(sessionID: SessionID): Promise<readonly SessionMessageInfo[]>;
  /** Actions of permission requests waiting for an answer in this session. */
  pendingPermissions(sessionID: SessionID): Promise<readonly string[]>;
}

export interface SessionControl {
  /** Interrupts the session's current run with `resume: false`. True if an active run was stopped. */
  interrupt(sessionID: SessionID): Promise<boolean>;
  /**
   * Resolves when the session has no active run; immediately when idle. Never starts work. The host
   * shares one outstanding call per session, because the underlying call cannot be cancelled.
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
}
