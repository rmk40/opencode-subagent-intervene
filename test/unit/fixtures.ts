// In-memory fakes for the core ports and typed builders for sessions and events.

import type {
  Clock,
  Json,
  Logger,
  OpenCodeEvent,
  PermissionReader,
  Scheduler,
  SessionControl,
  SessionID,
  SessionInfo,
  SessionMessageInfo,
  SessionMessenger,
  SessionReader,
  Store,
  SyntheticMessage,
} from "@/core/ports";

export type EventOf<Type extends OpenCodeEvent["type"]> = Extract<
  OpenCodeEvent,
  { type: Type }
>;

export interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}

export function deferred<T>(): Deferred<T> {
  let resolve: (value: T) => void = () => {};
  let reject: (error: unknown) => void = () => {};
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Lets every pending promise callback run. */
export function flush(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

type StoreMethod = "get" | "set" | "remove" | "scan";

export class MemoryStore implements Store {
  readonly data = new Map<string, Json>();
  /** Methods that reject while listed. */
  readonly failing = new Set<StoreMethod>();
  /** When set, `set` rejects for the keys it matches. */
  failSet: ((key: string) => boolean) | undefined;
  /** Count of `set` and `remove` calls that went through. */
  writes = 0;

  async get(key: string): Promise<Json | undefined> {
    this.check("get");
    return this.data.get(key);
  }

  async set(key: string, value: Json): Promise<void> {
    this.check("set");
    if (this.failSet?.(key) === true) throw new Error(`set ${key} failed`);
    this.writes++;
    this.data.set(key, value);
  }

  async remove(key: string): Promise<void> {
    this.check("remove");
    this.writes++;
    this.data.delete(key);
  }

  async scan(
    prefix: string,
  ): Promise<ReadonlyArray<{ readonly key: string; readonly value: Json }>> {
    this.check("scan");
    return [...this.data]
      .filter(([key]) => key.startsWith(prefix))
      .map(([key, value]) => ({ key, value }));
  }

  keys(): string[] {
    return [...this.data.keys()].sort();
  }

  private check(method: StoreMethod): void {
    if (this.failing.has(method)) throw new Error(`store ${method} failed`);
  }
}

/** A clock that only moves when told to. Timers fire from `advance`. */
export class FakeClock implements Clock {
  private time: number;
  private timers: Array<{ readonly at: number; readonly fire: () => void }> =
    [];

  constructor(start = 0) {
    this.time = start;
  }

  now(): number {
    return this.time;
  }

  sleep(ms: number, signal?: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
      if (signal?.aborted === true) {
        resolve();
        return;
      }
      const timer = { at: this.time + ms, fire: resolve };
      this.timers.push(timer);
      signal?.addEventListener(
        "abort",
        () => {
          this.timers = this.timers.filter((other) => other !== timer);
          resolve();
        },
        { once: true },
      );
    });
  }

  advance(ms: number): void {
    this.time += ms;
    const due = this.timers.filter((timer) => timer.at <= this.time);
    this.timers = this.timers.filter((timer) => timer.at > this.time);
    for (const timer of due) timer.fire();
  }

  /** Sleeps that have neither fired nor been aborted. */
  get pendingTimers(): number {
    return this.timers.length;
  }

  /** When the earliest pending sleep fires, or `undefined` when none is pending. */
  get nextTimerAt(): number | undefined {
    if (this.timers.length === 0) return undefined;
    return Math.min(...this.timers.map((timer) => timer.at));
  }
}

/** Timers on a `FakeClock`: a task runs when `advance` reaches its delay, unless it was cancelled. */
export class ClockScheduler implements Scheduler {
  private readonly clock: FakeClock;

  constructor(clock: FakeClock) {
    this.clock = clock;
  }

  schedule(ms: number, task: () => void): () => void {
    const timer = new AbortController();
    void this.clock.sleep(ms, timer.signal).then(() => {
      if (!timer.signal.aborted) task();
    });
    return () => timer.abort();
  }
}

/**
 * Records every synthetic message admitted. While `failing` is set, posts reject and record
 * nothing. A message posted without an ID gets `msg_posted_<n>`, counting this messenger's posts
 * from 1, as core assigns one.
 */
export class RecordingMessenger implements SessionMessenger {
  readonly posts: SyntheticMessage[] = [];
  failing = false;
  /** The admission time every post reports. */
  createdAt = 1_000;

  async synthetic(
    message: SyntheticMessage,
  ): Promise<{ readonly id: string; readonly createdAt: number }> {
    if (this.failing) throw new Error("synthetic failed");
    this.posts.push(message);
    return {
      id: message.id ?? `msg_posted_${this.posts.length}`,
      createdAt: this.createdAt,
    };
  }
}

/** Pending permission request IDs per session. `impl`, when set, answers every lookup instead. */
export class FakePermissions implements PermissionReader {
  readonly pending = new Map<SessionID, readonly string[]>();
  impl: ((sessionID: SessionID) => Promise<readonly string[]>) | undefined;

  pendingRequestIDs(sessionID: SessionID): Promise<readonly string[]> {
    return (
      this.impl?.(sessionID) ??
      Promise.resolve(this.pending.get(sessionID) ?? [])
    );
  }
}

export class RecordingLogger implements Logger {
  readonly entries: Array<{
    readonly level: "info" | "warn";
    readonly message: string;
  }> = [];

  info(message: string): void {
    this.entries.push({ level: "info", message });
  }

  warn(message: string): void {
    this.entries.push({ level: "warn", message });
  }

  warnings(): string[] {
    return this.entries
      .filter((entry) => entry.level === "warn")
      .map((entry) => entry.message);
  }
}

export class FakeControl implements SessionControl {
  readonly interrupts: SessionID[] = [];
  readonly waits: SessionID[] = [];
  /** Answers each `waitIdle` call. Defaults to a wait that never settles. */
  waitIdleImpl: (sessionID: SessionID) => Promise<void> = () =>
    new Promise(() => {});
  interruptImpl: (sessionID: SessionID) => Promise<boolean> = async () => true;

  interrupt(sessionID: SessionID): Promise<boolean> {
    this.interrupts.push(sessionID);
    return this.interruptImpl(sessionID);
  }

  waitIdle(sessionID: SessionID): Promise<void> {
    this.waits.push(sessionID);
    return this.waitIdleImpl(sessionID);
  }
}

/** `time.created` and `time.updated` default to 0. */
export function sessionInfo(
  id: SessionID,
  parentID?: SessionID,
  time: { readonly created?: number; readonly updated?: number } = {},
): SessionInfo {
  return {
    id,
    ...(parentID === undefined ? {} : { parentID }),
    projectID: "project",
    cost: 0,
    tokens: {
      input: 0,
      output: 0,
      reasoning: 0,
      cache: { read: 0, write: 0 },
    },
    time: { created: time.created ?? 0, updated: time.updated ?? 0 },
    location: { directory: "/work" },
  };
}

export type ListOrder = "asc" | "desc";

type Page = { data: readonly SessionInfo[]; next?: string };

export interface ChildrenRead {
  readonly parentID: SessionID;
  readonly cursor?: string;
  readonly order: ListOrder;
}

/**
 * Sessions held in memory. Insertion order stands for ascending `time.updated`, so add sessions
 * oldest first. `children` pages through the sessions whose `parentID` matches, `pageSize` at a
 * time, in insertion order for `"asc"` (the default) and reversed for `"desc"`; a cursor is an
 * offset into that order. `listings` replaces the listing for one parent.
 */
export class FakeSessionReader implements SessionReader {
  private readonly sessions = new Map<SessionID, SessionInfo>();
  readonly listings = new Map<
    SessionID,
    (cursor: string | undefined, order: ListOrder) => Page
  >();
  /** Every `children` call, in order. */
  readonly reads: ChildrenRead[] = [];
  readonly pageSize: number;
  /** What `context` returns per session; no messages when unset. */
  readonly contexts = new Map<SessionID, readonly SessionMessageInfo[]>();
  /** What `pendingPermissions` returns per session; none when unset. */
  readonly pending = new Map<SessionID, readonly string[]>();
  /** Sessions whose `get` rejects. */
  readonly failingGets = new Set<SessionID>();
  /** Sessions whose `context` rejects. */
  readonly failingContexts = new Set<SessionID>();

  constructor(sessions: readonly SessionInfo[] = [], pageSize = 100) {
    for (const session of sessions) this.sessions.set(session.id, session);
    this.pageSize = pageSize;
  }

  /** Adds a session, or replaces it in place, so a replaced session keeps its listing position. */
  put(session: SessionInfo): void {
    this.sessions.set(session.id, session);
  }

  remove(sessionID: SessionID): void {
    this.sessions.delete(sessionID);
  }

  async get(sessionID: SessionID): Promise<SessionInfo | undefined> {
    if (this.failingGets.has(sessionID)) {
      throw new Error(`get ${sessionID} failed`);
    }
    return this.sessions.get(sessionID);
  }

  async children(
    parentID: SessionID,
    cursor?: string,
    order: ListOrder = "asc",
  ): Promise<Page> {
    this.reads.push({
      parentID,
      order,
      ...(cursor === undefined ? {} : { cursor }),
    });
    const listing = this.listings.get(parentID);
    if (listing !== undefined) return listing(cursor, order);
    const oldestFirst = [...this.sessions.values()].filter(
      (session) => session.parentID === parentID,
    );
    const all = order === "asc" ? oldestFirst : oldestFirst.toReversed();
    const start = cursor === undefined ? 0 : Number(cursor);
    const end = start + this.pageSize;
    const data = all.slice(start, end);
    return end < all.length ? { data, next: String(end) } : { data };
  }

  async context(sessionID: SessionID): Promise<readonly SessionMessageInfo[]> {
    if (this.failingContexts.has(sessionID)) {
      throw new Error(`context ${sessionID} failed`);
    }
    return this.contexts.get(sessionID) ?? [];
  }

  async pendingPermissions(sessionID: SessionID): Promise<readonly string[]> {
    return this.pending.get(sessionID) ?? [];
  }
}

type AssistantMessage = Extract<SessionMessageInfo, { type: "assistant" }>;
export type AssistantPart = AssistantMessage["content"][number];
export type ToolPart = Extract<AssistantPart, { type: "tool" }>;
export type ToolState = ToolPart["state"];
export type ToolInput = Extract<ToolState, { status: "running" }>["input"];
export type StructuredError = NonNullable<AssistantMessage["error"]>;

let messageCounter = 0;

export function assistant(
  content: AssistantPart[],
  error?: StructuredError,
): AssistantMessage {
  messageCounter++;
  return {
    id: `message-${messageCounter}`,
    time: { created: messageCounter },
    type: "assistant",
    agent: "general",
    model: { id: "model", providerID: "provider" },
    content,
    ...(error === undefined ? {} : { error }),
  };
}

export function user(text: string): SessionMessageInfo {
  messageCounter++;
  return {
    id: `message-${messageCounter}`,
    time: { created: messageCounter },
    type: "user",
    text,
  };
}

/** A delivered synthetic message, which keeps its inbox item's ID. */
export function synthetic(id: string, text = "a notice"): SessionMessageInfo {
  messageCounter++;
  return { id, time: { created: messageCounter }, type: "synthetic", text };
}

/** `summary` applies to a completed compaction only. */
export function compaction(
  status: "running" | "completed" | "failed",
  summary = "earlier work",
): SessionMessageInfo {
  messageCounter++;
  const base = {
    type: "compaction",
    id: `message-${messageCounter}`,
    time: { created: messageCounter },
    reason: "auto",
  } as const;
  switch (status) {
    case "running":
      return { ...base, status, summary: "" };
    case "completed":
      return { ...base, status, summary };
    case "failed":
      return {
        ...base,
        status,
        error: { type: "CompactionError", message: "" },
      };
  }
}

export function text(value: string): AssistantPart {
  return { type: "text", text: value };
}

export function reasoning(value: string): AssistantPart {
  return { type: "reasoning", text: value };
}

/** `ran` is when the tool started running, in epoch milliseconds; left out by default. */
export function tool(
  name: string,
  state: ToolState,
  time: { readonly ran?: number } = {},
): ToolPart {
  messageCounter++;
  return {
    type: "tool",
    id: `call-${messageCounter}`,
    name,
    state,
    time: {
      created: messageCounter,
      ...(time.ran === undefined ? {} : { ran: time.ran }),
    },
  };
}

export function streaming(input: string): ToolState {
  return { status: "streaming", input };
}

export function running(
  input: ToolInput = {},
  metadata: ToolInput = {},
): ToolState {
  return { status: "running", input, metadata };
}

export function completed(input: ToolInput = {}): ToolState {
  return {
    status: "completed",
    input,
    content: [{ type: "text", text: "ok" }],
  };
}

export function failed(
  error: StructuredError,
  input: ToolInput = {},
): ToolState {
  return { status: "error", input, error };
}

let eventCounter = 0;

function envelope(created: number): { id: string; created: number } {
  eventCounter++;
  return { id: `event-${eventCounter}`, created };
}

export function executionStarted(
  sessionID: SessionID,
  created = 0,
): EventOf<"session.execution.started"> {
  return {
    ...envelope(created),
    type: "session.execution.started",
    durable: { aggregateID: sessionID, seq: eventCounter, version: 1 },
    data: { sessionID },
  };
}

export type TerminalEventType =
  | "session.execution.succeeded"
  | "session.execution.failed"
  | "session.execution.interrupted";

export function executionEnded(
  type: TerminalEventType,
  sessionID: SessionID,
  created = 0,
): OpenCodeEvent {
  const base = envelope(created);
  const durable = {
    aggregateID: sessionID,
    seq: eventCounter,
    version: 1,
  } as const;
  switch (type) {
    case "session.execution.succeeded":
      return { ...base, type, durable, data: { sessionID } };
    case "session.execution.failed":
      return {
        ...base,
        type,
        durable,
        data: { sessionID, error: { type: "ProviderError", message: "boom" } },
      };
    case "session.execution.interrupted":
      return { ...base, type, durable, data: { sessionID, reason: "user" } };
  }
}

export function sessionCreated(
  sessionID: SessionID,
  parentID?: SessionID,
  created = 0,
): EventOf<"session.created"> {
  return {
    ...envelope(created),
    type: "session.created",
    durable: { aggregateID: sessionID, seq: eventCounter, version: 1 },
    data: {
      sessionID,
      projectID: "project",
      location: { directory: "/work" },
      ...(parentID === undefined ? {} : { parentID }),
      slug: sessionID,
      version: "2.2.0",
    },
  };
}

export function sessionDeleted(
  sessionID: SessionID,
  created = 0,
): EventOf<"session.deleted"> {
  return {
    ...envelope(created),
    type: "session.deleted",
    durable: { aggregateID: sessionID, seq: eventCounter, version: 2 },
    data: { sessionID },
  };
}

type InboxItem = EventOf<"session.inbox.enqueued">["data"]["item"];

type Delivery = InboxItem["delivery"];

function inboxItem(type: InboxItem["type"], delivery?: Delivery): InboxItem {
  switch (type) {
    case "user":
      return {
        type,
        payload: { text: "continue" },
        delivery: delivery ?? "steer",
      };
    case "synthetic":
      return {
        type,
        payload: { text: "a shell finished" },
        delivery: delivery ?? "queue",
      };
    case "compaction":
      return { type, payload: {}, delivery: delivery ?? "queue" };
    case "move":
      return {
        type,
        payload: {
          location: { directory: "/elsewhere" },
          projectID: "project",
        },
        delivery: delivery ?? "queue",
      };
  }
}

/** `delivery` defaults to steer for a user item and to queue for the others. */
export function inboxEnqueued(
  sessionID: SessionID,
  itemType: InboxItem["type"],
  created = 0,
  delivery?: Delivery,
): EventOf<"session.inbox.enqueued"> {
  return {
    ...envelope(created),
    type: "session.inbox.enqueued",
    durable: { aggregateID: sessionID, seq: eventCounter, version: 1 },
    data: {
      sessionID,
      inboxID: `inbox-${eventCounter}`,
      item: inboxItem(itemType, delivery),
    },
  };
}

export function permissionAsked(
  sessionID: SessionID,
  requestID: string,
  options: {
    readonly action?: string;
    readonly resources?: readonly string[];
    readonly created?: number;
  } = {},
): EventOf<"permission.asked"> {
  return {
    ...envelope(options.created ?? 0),
    type: "permission.asked",
    data: {
      id: requestID,
      sessionID,
      action: options.action ?? "shell",
      resources: [...(options.resources ?? ["cargo test"])],
    },
  };
}

export function permissionReplied(
  sessionID: SessionID,
  requestID: string,
): EventOf<"permission.replied"> {
  return {
    ...envelope(0),
    type: "permission.replied",
    data: { sessionID, requestID, reply: "once" },
  };
}

/** A form owned by `sessionID`, which may be `"global"`. */
export function formCreated(
  sessionID: string,
  formID: string,
  options: { readonly title?: string; readonly created?: number } = {},
): EventOf<"form.created"> {
  return {
    ...envelope(options.created ?? 0),
    type: "form.created",
    data: {
      form: {
        id: formID,
        sessionID,
        title: options.title ?? "Pick a branch",
        fields: [{ key: "branch", type: "string" }],
      },
    },
  };
}

export function formReplied(
  sessionID: string,
  formID: string,
): EventOf<"form.replied"> {
  return {
    ...envelope(0),
    type: "form.replied",
    data: { id: formID, sessionID, answer: { branch: "main" } },
  };
}

export function formCancelled(
  sessionID: string,
  formID: string,
): EventOf<"form.cancelled"> {
  return {
    ...envelope(0),
    type: "form.cancelled",
    data: { id: formID, sessionID },
  };
}

export function deliveryChanged(
  sessionID: SessionID,
  delivery: "steer" | "queue",
  created = 0,
): EventOf<"session.inbox.delivery.changed"> {
  return {
    ...envelope(created),
    type: "session.inbox.delivery.changed",
    durable: { aggregateID: sessionID, seq: eventCounter, version: 1 },
    data: { sessionID, inboxID: `inbox-${eventCounter}`, delivery },
  };
}

export function skillActivated(
  sessionID: SessionID,
  created = 0,
): EventOf<"session.skill.activated"> {
  return {
    ...envelope(created),
    type: "session.skill.activated",
    durable: { aggregateID: sessionID, seq: eventCounter, version: 1 },
    data: { sessionID, id: "skill", name: "skill", text: "" },
  };
}

export function revertCleared(
  sessionID: SessionID,
  created = 0,
): EventOf<"session.revert.cleared"> {
  return {
    ...envelope(created),
    type: "session.revert.cleared",
    durable: { aggregateID: sessionID, seq: eventCounter, version: 1 },
    data: { sessionID },
  };
}

/**
 * Progress of tool call `callID` in `sessionID`. Core's `subagent` tool publishes
 * `{ sessionID: <subagent>, status: "running" }` once it has chosen the subagent.
 */
export function toolProgress(
  sessionID: SessionID,
  callID: string,
  metadata: Readonly<Record<string, string>>,
  assistantMessageID = "msg_assistant",
): EventOf<"session.tool.progress"> {
  return {
    ...envelope(0),
    type: "session.tool.progress",
    data: { sessionID, assistantMessageID, id: callID, metadata },
  };
}

export function toolEnded(
  type: "session.tool.success" | "session.tool.failed",
  sessionID: SessionID,
  callID: string,
  assistantMessageID = "msg_assistant",
): OpenCodeEvent {
  const base = envelope(0);
  const durable = {
    aggregateID: sessionID,
    seq: eventCounter,
    version: 2,
  } as const;
  const data = { sessionID, assistantMessageID, id: callID, executed: false };
  switch (type) {
    case "session.tool.success":
      return {
        ...base,
        type,
        durable,
        data: { ...data, content: [{ type: "text", text: "ok" }] },
      };
    case "session.tool.failed":
      return {
        ...base,
        type,
        durable,
        data: { ...data, error: { type: "ToolError", message: "boom" } },
      };
  }
}
