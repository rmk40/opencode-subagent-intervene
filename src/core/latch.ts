// The stop latch keeps a stopped session stopped. While a session's latch is active, every run that
// starts in it is interrupted again, until someone deliberately gives the session new work.
//
// Storage is shared by every plugin instance and has no compare-and-set, so each state change is
// its own key, written once and never read back to be changed:
//
//   latch/<sessionID>/<generation>   { parentSessionID, reason, at, expiresAt }
//   lift/<sessionID>/<generation>    the latch of that generation was lifted
//   gaveup/<sessionID>/<generation>  the safety valve stopped enforcing that generation
//   note/<sessionID>/<generation>    a stop note is owed to the prompt that lifts the latch;
//                                    removed once used
//
// A session's current latch is its latch record with the latest `at`. It is active while it has
// not expired and its generation has no lift or gaveup key. Every decision reads storage, because
// another instance may have written any of these keys. Only the safety-valve counters, the startup
// exemptions and the run starts the event handlers saw live in memory. Session IDs contain no `/`,
// so the first `/` after a kind prefix ends the session ID and the rest of the key is the
// generation.
//
// A run that starts under an active latch is interrupted when the ordered event handlers reach its
// `session.execution.started`, so every event that could have lifted the latch is handled first.
// That event arrives after the run began. The `context` hook, which OpenCode calls inside the run
// before each model request, holds the run there until the handlers have decided, so the interrupt
// lands before the first request goes out.
//
// Once a session's newest stop has ended (lifted, given up or expired) for longer than the grace
// period, a sweep removes every key the session has. The grace period is the larger of a week and
// twice this instance's TTL, because instances can be configured with different TTLs. A sweep also
// removes lift, gaveup and note keys whose latch record is gone, which nothing reads. Every
// instance removes a generation's latch record before its markers, so a stop whose records are
// removed while someone reads them never reads as active.

import {
  busySince,
  MAX_TRACKED_SESSIONS,
  recordsOpenRun,
} from "@/core/activity";
import { isSelfCompactionID } from "@/core/compaction";
import type {
  Clock,
  Json,
  Logger,
  OpenCodeEvent,
  Scheduler,
  SessionControl,
  SessionID,
  SessionInfo,
  SessionReader,
  Store,
} from "@/core/ports";

export const DEFAULT_LATCH_TTL_MS = 24 * 60 * 60 * 1000;
export const DEFAULT_VALVE_MAX = 30;
export const DEFAULT_VALVE_WINDOW_MS = 10 * 60 * 1000;
/** The shortest time a session's stop records are kept after its newest stop ended. */
export const SWEEP_GRACE_MIN_MS = 7 * 24 * 60 * 60 * 1000;
export const DEFAULT_SWEEP_INTERVAL_MS = 6 * 60 * 60 * 1000;
/** Sessions one sweep pass looks at, oldest stop first. */
export const DEFAULT_SWEEP_MAX_SESSIONS = 100;
/** How long the `context` hook waits for the event handlers to reach the run's start. */
export const DEFAULT_START_WAIT_MS = 500;
/** How long the `context` hook holds a run, from its start being handled until the run ends. */
export const DEFAULT_HOLD_MS = 5000;

export interface LatchRecord {
  /** The session whose stop wrote the latch. */
  readonly parentSessionID: SessionID;
  /** Sanitized stop reason. */
  readonly reason: string;
  /** When the stop started, in epoch milliseconds. Inherited latches keep their parent's. */
  readonly at: number;
  readonly expiresAt: number;
}

export interface LatchInput {
  /** Identifies one stop in every key it writes. */
  readonly generation: string;
  readonly parentSessionID: SessionID;
  readonly reason: string;
  readonly at: number;
}

/**
 * `gave_up`: the safety valve stopped enforcement. `expired`: the TTL ran out with nobody continuing
 * the session. In both cases nothing keeps the session stopped any more.
 */
export type LatchStatus = "active" | "lifted" | "gave_up" | "expired";

export interface StopDescription {
  readonly at: number;
  readonly reason: string;
  readonly latch: LatchStatus;
}

export interface LatchDeps {
  readonly store: Store;
  readonly control: SessionControl;
  readonly clock: Clock;
  readonly logger: Logger;
  /** Renders the note prepended to the prompt that continues a stopped session. */
  readonly renderNote: (note: {
    readonly at: number;
    readonly reason: string;
  }) => string;
  /** Tells which run a `context` hook runs in. Without it, `beforeRequest` does nothing. */
  readonly reader?: Pick<SessionReader, "get">;
  /** Runs the periodic sweep. Without it, only the first startup pass sweeps. */
  readonly scheduler?: Scheduler;
}

export interface LatchOptions {
  readonly ttlMs?: number;
  /** Re-interrupts of one latch allowed within `valveWindowMs`; the next one trips the valve. */
  readonly valveMax?: number;
  readonly valveWindowMs?: number;
  /** Time between sweep passes. Default 6 hours. */
  readonly sweepIntervalMs?: number;
  /** Sessions one sweep pass looks at. Default 100. */
  readonly sweepMaxSessions?: number;
  /** How long the `context` hook waits for the run's start to be handled. Default 500 ms. */
  readonly startWaitMs?: number;
  /** How long the `context` hook holds a run once its start is handled. Default 5 s. */
  readonly holdMs?: number;
}

type KeyKind = "latch" | "lift" | "gaveup" | "note";

const KEY_KINDS: readonly KeyKind[] = ["latch", "lift", "gaveup", "note"];

/** The kinds that only mean something next to their generation's latch record. */
const MARKER_KINDS: readonly KeyKind[] = ["lift", "gaveup", "note"];

type InboxItemType = Extract<
  OpenCodeEvent,
  { type: "session.inbox.enqueued" }
>["data"]["item"]["type"];

/**
 * Inbox items that only a deliberate request admits. Synthetic items are left out: core's notices,
 * the messages `subagent_send` steers into a subagent, and the waiting notices posted to a parent
 * are all synthetic, and none of them asks to continue a stopped session. Self-compaction
 * admissions are excluded separately by their ID.
 */
const LIFTING_ITEMS: ReadonlySet<InboxItemType> = new Set<InboxItemType>([
  "user",
  "compaction",
  "move",
]);

interface CurrentLatch extends LatchRecord {
  readonly sessionID: SessionID;
  readonly generation: string;
}

/** The latest run start the event handlers handled for a session. */
interface HandledStart {
  /** The start event's creation time. From OpenCode 2.2.2 the session stores it as `time.busy`. */
  readonly startedAt: number;
  /** Whether enforcement interrupted the run. Never rejects. */
  readonly enforcement: Promise<boolean>;
  /** Resolves once the handlers see the run end or the session's deletion. */
  readonly ended: Promise<void>;
  isEnded: boolean;
  end(): void;
}

/**
 * Which run a `context` hook was called in, from the session as stored at that moment. `busy`: the
 * start of the open run, which OpenCode records from 2.2.2. `after`: older hosts record only when
 * the last run ended, so the hook's run is the first start after that.
 */
type RunIdentity =
  | { readonly kind: "busy"; readonly startedAt: number }
  | { readonly kind: "after"; readonly idleAt: number | undefined };

interface StartWaiter {
  readonly identity: RunIdentity;
  readonly settle: (start: HandledStart | undefined) => void;
}

export class Latch {
  private readonly deps: LatchDeps;
  private readonly ttlMs: number;
  private readonly valveMax: number;
  private readonly valveWindowMs: number;
  private readonly sweepGraceMs: number;
  private readonly sweepIntervalMs: number;
  private readonly sweepMaxSessions: number;
  private readonly startWaitMs: number;
  private readonly holdMs: number;
  /** Times this instance re-interrupted each session's current latch, within the valve window. */
  private readonly enforcements = new Map<
    SessionID,
    { readonly generation: string; readonly times: number[] }
  >();
  /** Sessions found running at startup, left alone until their next terminal event. */
  private readonly exempt = new Set<SessionID>();
  /** One set per startup pass in progress: sessions with an execution event since it began. */
  private readonly startupWatchers = new Set<Set<SessionID>>();
  /** The latest run start handled per session, least recently started first. */
  private readonly starts = new Map<SessionID, HandledStart>();
  /** `context` hooks waiting for their run's start to be handled. */
  private readonly waiters = new Map<SessionID, Set<StartWaiter>>();
  /** Whether an event was handled since the instance loaded or since the last gap in the stream. */
  private live = false;
  private startupSwept = false;
  private sweeping = false;
  private cancelSweep: (() => void) | undefined;
  private disposed = false;

  constructor(deps: LatchDeps, options: LatchOptions = {}) {
    this.deps = deps;
    this.ttlMs = options.ttlMs ?? DEFAULT_LATCH_TTL_MS;
    this.valveMax = options.valveMax ?? DEFAULT_VALVE_MAX;
    this.valveWindowMs = options.valveWindowMs ?? DEFAULT_VALVE_WINDOW_MS;
    this.sweepGraceMs = Math.max(SWEEP_GRACE_MIN_MS, 2 * this.ttlMs);
    this.sweepIntervalMs = options.sweepIntervalMs ?? DEFAULT_SWEEP_INTERVAL_MS;
    this.sweepMaxSessions =
      options.sweepMaxSessions ?? DEFAULT_SWEEP_MAX_SESSIONS;
    this.startWaitMs = options.startWaitMs ?? DEFAULT_START_WAIT_MS;
    this.holdMs = options.holdMs ?? DEFAULT_HOLD_MS;
  }

  /** Writes the latch of one generation, expiring `ttlMs` after `at`. */
  async add(sessionID: SessionID, input: LatchInput): Promise<void> {
    await this.deps.store.set(key("latch", sessionID, input.generation), {
      parentSessionID: input.parentSessionID,
      reason: input.reason,
      at: input.at,
      expiresAt: input.at + this.ttlMs,
    });
  }

  /** Records that the prompt continuing this generation's stop gets the stop note. */
  async owe(sessionID: SessionID, generation: string): Promise<void> {
    await this.deps.store.set(key("note", sessionID, generation), {
      at: this.deps.clock.now(),
    });
  }

  /**
   * Whether the session's current latch is active. With `generation`, also requires that latch to
   * be of that generation, so a stop can tell whether its own latch still holds.
   */
  async isActive(sessionID: SessionID, generation?: string): Promise<boolean> {
    const current = await this.current(sessionID);
    if (current === undefined) return false;
    if (generation !== undefined && current.generation !== generation) {
      return false;
    }
    return (await this.status(current)) === "active";
  }

  /** Whether the latch of that generation was lifted, current or not. */
  async isLifted(sessionID: SessionID, generation: string): Promise<boolean> {
    return (
      (await this.deps.store.get(key("lift", sessionID, generation))) !==
      undefined
    );
  }

  /**
   * The session's current latch, or `undefined` when it was never stopped or a sweep removed its
   * stop records, including while this read them.
   */
  async describe(sessionID: SessionID): Promise<StopDescription | undefined> {
    const current = await this.current(sessionID);
    if (current === undefined) return undefined;
    const latch = await this.status(current);
    if (latch === "collected") return undefined;
    return { at: current.at, reason: current.reason, latch };
  }

  /** Handles one event from the plugin's subscription. Never rejects; failures are logged. */
  async onEvent(event: OpenCodeEvent): Promise<void> {
    this.live = true;
    try {
      await this.handle(event);
    } catch (error) {
      this.deps.logger.warn("latch: event handler failed", {
        type: event.type,
        error: errorMessage(error),
      });
    }
  }

  /**
   * Backs the `prompt` hook: a prompt is deliberate new work, so it lifts the session's active
   * latch at `now`. When it lifts one that is owed a stop note, it returns the note to prepend and
   * removes the note key. Never rejects; on any failure it logs and returns `undefined`, and the
   * event that admits the prompt lifts the latch instead.
   */
  async onPrompt(
    sessionID: SessionID,
    now: number,
  ): Promise<string | undefined> {
    try {
      const current = await this.current(sessionID);
      if (current === undefined || now < current.at) return undefined;
      if (!(await this.liftIfActive(current, now))) return undefined;
      const noteKey = key("note", sessionID, current.generation);
      if ((await this.deps.store.get(noteKey)) === undefined) return undefined;
      const note = this.deps.renderNote({
        at: current.at,
        reason: current.reason,
      });
      try {
        await this.deps.store.remove(noteKey);
      } catch (error) {
        this.deps.logger.warn("latch: could not remove a delivered stop note", {
          sessionID,
          generation: current.generation,
          error: errorMessage(error),
        });
      }
      return note;
    } catch (error) {
      this.deps.logger.warn(
        "latch: prompt hook failed; prompt left unchanged",
        {
          sessionID,
          error: errorMessage(error),
        },
      );
      return undefined;
    }
  }

  /**
   * Backs the `context` hook, which OpenCode calls inside a run before each model request. When the
   * session's latch is active, it waits up to `startWaitMs` for the event handlers to reach this
   * run's start, so every event that could lift the latch is handled before enforcement decides.
   * When enforcement interrupted the run, it holds the run here until the run ends, at most
   * `holdMs`: the host only schedules the interrupt, and returning at once would let the request go
   * out first. It returns at once when enforcement left the run alone, and leaves the run to the
   * event path when the stream is uncertain or the start is not handled in time. Never rejects.
   */
  async beforeRequest(sessionID: SessionID): Promise<void> {
    try {
      const reader = this.deps.reader;
      if (reader === undefined || this.disposed || !this.live) return;
      if (this.exempt.has(sessionID)) return;
      const latch = await this.current(sessionID);
      if (latch === undefined || (await this.status(latch)) !== "active") {
        return;
      }
      const info = await reader.get(sessionID);
      if (info === undefined) return;
      const identity = runIdentity(info);
      if (identity === undefined) return;
      const handled = this.starts.get(sessionID);
      const start = await this.handledStart(sessionID, identity);
      if (start === undefined) return;
      await this.hold(sessionID, start, start !== handled);
    } catch (error) {
      this.deps.logger.warn(
        "latch: context hook failed; the request was left alone",
        { sessionID, error: errorMessage(error) },
      );
    }
  }

  /**
   * Forgets the run starts handled so far and releases every waiting `context` hook. Call when
   * events may have been missed. Until the next event is handled, hooks leave runs to the event
   * path.
   */
  reset(): void {
    this.live = false;
    this.starts.clear();
    this.releaseWaiters();
  }

  /** Stops the sweep timer and releases every waiting `context` hook. */
  dispose(): void {
    this.disposed = true;
    this.cancelSweep?.();
    this.cancelSweep = undefined;
    this.releaseWaiters();
  }

  /**
   * One sweep pass: removes every key of each session whose newest stop ended more than the grace
   * period ago, for at most `sweepMaxSessions` sessions, oldest stop first, then schedules the next
   * pass. Never rejects.
   */
  async sweep(): Promise<void> {
    await this.runSweep(undefined);
  }

  /**
   * Runs once when the instance loads, and again after each gap in the event stream. A session
   * with an active latch that is already running is exempt from enforcement until its next terminal
   * event: the instance cannot tell whether a notice or a deliberate prompt it missed started that
   * run. The first pass also starts a sweep from the records it read, which it does not wait for,
   * and the sweep timer. Never rejects.
   */
  async startup(
    isRunning: (sessionID: SessionID) => Promise<boolean>,
  ): Promise<void> {
    const seen = new Set<SessionID>();
    this.startupWatchers.add(seen);
    let entries: ReadonlyArray<StoreEntry> | undefined;
    try {
      const latest = new Map<SessionID, CurrentLatch>();
      entries = await this.deps.store.scan("latch/");
      for (const entry of entries) {
        const parsed = parseKey("latch", entry.key);
        if (parsed === undefined) continue;
        const latch = toCurrentLatch(
          parsed.sessionID,
          parsed.generation,
          entry.value,
        );
        if (latch === undefined) continue;
        const best = latest.get(latch.sessionID);
        if (best === undefined || isNewer(latch, best)) {
          latest.set(latch.sessionID, latch);
        }
      }
      await Promise.all(
        [...latest.values()].map((latch) =>
          this.exemptIfRunning(latch, isRunning, seen),
        ),
      );
    } catch (error) {
      this.deps.logger.warn("latch: startup pass failed", {
        error: errorMessage(error),
      });
    } finally {
      this.startupWatchers.delete(seen);
      if (!this.startupSwept) {
        this.startupSwept = true;
        // A failed scan already logged; the timer's pass tries again.
        if (entries === undefined) this.scheduleSweep();
        else void this.runSweep(entries);
      }
    }
  }

  private async handle(event: OpenCodeEvent): Promise<void> {
    switch (event.type) {
      case "session.execution.started":
        this.watchExecution(event.data.sessionID);
        return this.onStart(event.data.sessionID, event.created);
      case "session.execution.succeeded":
      case "session.execution.failed":
      case "session.execution.interrupted":
        this.watchExecution(event.data.sessionID);
        this.exempt.delete(event.data.sessionID);
        this.starts.get(event.data.sessionID)?.end();
        return;
      case "session.created":
        if (event.data.parentID === undefined) return;
        return this.inherit(event.data.sessionID, event.data.parentID);
      case "session.deleted":
        return this.forget(event.data.sessionID);
      case "session.inbox.enqueued":
        if (
          event.data.item.type === "compaction" &&
          isSelfCompactionID(event.data.inboxID)
        ) return;
        if (!LIFTING_ITEMS.has(event.data.item.type)) return;
        return this.liftOnEvent(event.data.sessionID, event.created);
      case "session.inbox.delivery.changed":
        if (event.data.delivery !== "steer") return;
        return this.liftOnEvent(event.data.sessionID, event.created);
      case "session.skill.activated":
      case "session.revert.cleared":
        return this.liftOnEvent(event.data.sessionID, event.created);
      default:
        return;
    }
  }

  /**
   * Enforces the latch once per run start, whether or not a `context` hook holds the run, so the
   * safety valve counts each run once. Hooks waiting for this start keep the run before its first
   * model request until enforcement has decided.
   */
  private async onStart(
    sessionID: SessionID,
    startedAt: number,
  ): Promise<void> {
    const held = this.takeWaiters(sessionID, startedAt);
    const enforcement = this.enforce(
      sessionID,
      held.length > 0 ? startedAt : undefined,
    );
    const start = this.recordStart(
      sessionID,
      startedAt,
      enforcement.catch(() => false),
    );
    for (const waiter of held) waiter.settle(start);
    await enforcement;
  }

  /**
   * Interrupts a run that started under an active latch, unless the safety valve trips. True if
   * the interrupt stopped a run. `heldSince` is the start of a run a `context` hook holds: that run
   * is checked against storage first, because the hook's wait can outlast it, and the interrupt
   * would then stop whatever runs next.
   */
  private async enforce(
    sessionID: SessionID,
    heldSince?: number,
  ): Promise<boolean> {
    if (this.exempt.has(sessionID)) return false;
    const current = await this.current(sessionID);
    if (current === undefined) return false;
    if ((await this.status(current)) !== "active") {
      this.enforcements.delete(sessionID);
      return false;
    }
    if (
      heldSince !== undefined &&
      !(await this.stillRuns(sessionID, heldSince))
    ) {
      this.deps.logger.info(
        "latch: left a run alone; OpenCode records that it already ended",
        { sessionID, generation: current.generation },
      );
      return false;
    }
    if (this.valveTrips(current)) {
      await this.deps.store.set(key("gaveup", sessionID, current.generation), {
        at: this.deps.clock.now(),
      });
      // The count is cleared only once the marker is written, so a failed write trips the valve
      // again on the next wake.
      this.enforcements.delete(sessionID);
      this.deps.logger.warn(
        "latch: safety valve tripped; the session is no longer kept stopped",
        {
          sessionID,
          generation: current.generation,
          max: this.valveMax,
          windowMs: this.valveWindowMs,
        },
      );
      return false;
    }
    const interrupted = await this.deps.control.interrupt(sessionID);
    this.deps.logger.info("latch: interrupted a run in a stopped session", {
      sessionID,
      generation: current.generation,
      interrupted,
    });
    return interrupted;
  }

  /**
   * Whether the run that started at `startedAt` is still the session's open run, as stored. When
   * the read fails, the run counts as current, the same as when no hook holds it.
   */
  private async stillRuns(
    sessionID: SessionID,
    startedAt: number,
  ): Promise<boolean> {
    const reader = this.deps.reader;
    if (reader === undefined) return true;
    let info: SessionInfo | undefined;
    try {
      info = await reader.get(sessionID);
    } catch (error) {
      this.deps.logger.warn(
        "latch: could not confirm a held run before interrupting it",
        { sessionID, error: errorMessage(error) },
      );
      return true;
    }
    if (info === undefined) return false;
    const identity = runIdentity(info);
    return identity !== undefined && startsRun(identity, startedAt);
  }

  /** Records the session's latest handled start; the one before it is over. */
  private recordStart(
    sessionID: SessionID,
    startedAt: number,
    enforcement: Promise<boolean>,
  ): HandledStart {
    this.starts.get(sessionID)?.end();
    this.starts.delete(sessionID);
    const start = handledStart(startedAt, enforcement);
    this.starts.set(sessionID, start);
    while (this.starts.size > MAX_TRACKED_SESSIONS) {
      const oldest = this.starts.keys().next();
      if (oldest.done === true) break;
      this.starts.delete(oldest.value);
    }
    return start;
  }

  /**
   * The handled start of the run a `context` hook runs in. Waits up to `startWaitMs` for it.
   * `undefined` when the run already ended, when the wait times out, or when a gap or disposal
   * releases it.
   */
  private handledStart(
    sessionID: SessionID,
    identity: RunIdentity,
  ): Promise<HandledStart | undefined> {
    const known = this.starts.get(sessionID);
    if (known !== undefined && startsRun(identity, known.startedAt)) {
      return Promise.resolve(known.isEnded ? undefined : known);
    }
    // A gap or disposal during the hook's reads leaves nothing to wait for.
    if (!this.live || this.disposed) return Promise.resolve(undefined);
    return new Promise((resolve) => {
      const timer = new AbortController();
      const waiter: StartWaiter = {
        identity,
        settle: (start) => {
          timer.abort();
          resolve(start);
        },
      };
      let waiting = this.waiters.get(sessionID);
      if (waiting === undefined) {
        waiting = new Set();
        this.waiters.set(sessionID, waiting);
      }
      waiting.add(waiter);
      void this.deps.clock.sleep(this.startWaitMs, timer.signal).then(() => {
        if (timer.signal.aborted) return;
        this.dropWaiter(sessionID, waiter);
        resolve(undefined);
      });
    });
  }

  /** Removes and returns the waiting hooks whose run started at `startedAt`. */
  private takeWaiters(sessionID: SessionID, startedAt: number): StartWaiter[] {
    const waiting = this.waiters.get(sessionID);
    if (waiting === undefined) return [];
    const held = [...waiting].filter((waiter) =>
      startsRun(waiter.identity, startedAt),
    );
    for (const waiter of held) waiting.delete(waiter);
    if (waiting.size === 0) this.waiters.delete(sessionID);
    return held;
  }

  private dropWaiter(sessionID: SessionID, waiter: StartWaiter): void {
    const waiting = this.waiters.get(sessionID);
    if (waiting === undefined) return;
    waiting.delete(waiter);
    if (waiting.size === 0) this.waiters.delete(sessionID);
  }

  /** Settles waiting hooks with nothing, for all sessions or for one. */
  private releaseWaiters(sessionID?: SessionID): void {
    const released =
      sessionID === undefined
        ? [...this.waiters.values()]
        : [this.waiters.get(sessionID) ?? new Set<StartWaiter>()];
    if (sessionID === undefined) this.waiters.clear();
    else this.waiters.delete(sessionID);
    for (const waiting of released) {
      for (const waiter of waiting) waiter.settle(undefined);
    }
  }

  /**
   * Keeps the hook's run waiting once enforcement interrupted it, until the run ends or `holdMs`
   * passes. A rejected `waitIdle`, as on hosts without `session.wait`, leaves the end event and the
   * deadline.
   */
  private async hold(
    sessionID: SessionID,
    start: HandledStart,
    waitedForStart: boolean,
  ): Promise<void> {
    const timer = new AbortController();
    const deadline = this.deps.clock
      .sleep(this.holdMs, timer.signal)
      .then(() => "deadline" as const);
    try {
      const decided = await Promise.race([start.enforcement, deadline]);
      if (decided !== true) return;
      const released = await Promise.race([
        this.deps.control.waitIdle(sessionID).then(
          () => "idle" as const,
          () => deadline,
        ),
        start.ended.then(() => "ended" as const),
        deadline,
      ]);
      this.deps.logger.info(
        "latch: held an interrupted run before its model request",
        { sessionID, waitedForStart, released },
      );
    } finally {
      timer.abort();
    }
  }

  private scheduleSweep(): void {
    const scheduler = this.deps.scheduler;
    if (
      scheduler === undefined ||
      this.disposed ||
      this.cancelSweep !== undefined
    ) {
      return;
    }
    this.cancelSweep = scheduler.schedule(this.sweepIntervalMs, () => {
      this.cancelSweep = undefined;
      void this.runSweep(undefined);
    });
  }

  /** One sweep pass over `entries`, or a fresh scan, then the next pass's timer. Never rejects. */
  private async runSweep(
    entries: ReadonlyArray<StoreEntry> | undefined,
  ): Promise<void> {
    if (this.disposed || this.sweeping) return;
    this.sweeping = true;
    try {
      await this.sweepEntries(
        entries ?? (await this.deps.store.scan("latch/")),
      );
    } catch (error) {
      this.deps.logger.warn("latch: sweep failed", {
        error: errorMessage(error),
      });
    } finally {
      this.sweeping = false;
      this.scheduleSweep();
    }
  }

  private async sweepEntries(
    entries: ReadonlyArray<StoreEntry>,
  ): Promise<void> {
    const newest = new Map<SessionID, CurrentLatch>();
    /** Every latch record the scan found, readable or not, as `sessionID/generation`. */
    const recorded = new Set<string>();
    for (const entry of entries) {
      const parsed = parseKey("latch", entry.key);
      if (parsed === undefined) continue;
      recorded.add(`${parsed.sessionID}/${parsed.generation}`);
      const latch = toCurrentLatch(
        parsed.sessionID,
        parsed.generation,
        entry.value,
      );
      if (latch === undefined) continue;
      const best = newest.get(latch.sessionID);
      if (best === undefined || isNewer(latch, best)) {
        newest.set(latch.sessionID, latch);
      }
    }
    // A stop ends no earlier than it started, so only stops older than the grace period can be due.
    const now = this.deps.clock.now();
    const candidates = [...newest.values()]
      .filter((latch) => now - latch.at > this.sweepGraceMs)
      .sort((a, b) => a.at - b.at)
      .slice(0, this.sweepMaxSessions);
    let removed = 0;
    const failed = new Set<SessionID>();
    for (const latch of candidates) {
      if (this.disposed) break;
      try {
        if (await this.sweepSession(latch.sessionID)) removed++;
      } catch (error) {
        failed.add(latch.sessionID);
        this.deps.logger.warn(
          "latch: could not sweep a session's stop records",
          { sessionID: latch.sessionID, error: errorMessage(error) },
        );
      }
    }
    if (removed > 0) {
      this.deps.logger.info(
        "latch: removed the records of stops that ended long ago",
        { sessions: removed },
      );
    }
    if (this.disposed) return;
    const cleaned = await this.sweepOrphanMarkers(recorded, failed);
    if (cleaned > 0) {
      this.deps.logger.info(
        "latch: removed stop markers whose latch record was gone",
        { sessions: cleaned },
      );
    }
  }

  /**
   * Removes lift, gaveup and note keys whose generation has no latch record, for at most
   * `sweepMaxSessions` sessions, oldest marker first. Such markers decide nothing, since every
   * decision starts from a latch record, and a session with no latch record left is never found
   * through the latch scan. A pass cut short between a latch record and its markers leaves them,
   * and so can a deletion cut short. `recorded` holds the latch records the pass scanned before
   * any marker, so it only narrows the sessions to look at. Sessions whose sweep failed in this
   * pass are left to the next one. Returns the sessions it cleaned.
   */
  private async sweepOrphanMarkers(
    recorded: ReadonlySet<string>,
    failed: ReadonlySet<SessionID>,
  ): Promise<number> {
    const pages = await Promise.all(
      MARKER_KINDS.map((kind) => this.deps.store.scan(`${kind}/`)),
    );
    const sessions = new Map<
      SessionID,
      { oldest: number; readonly markers: OrphanCandidate[] }
    >();
    MARKER_KINDS.forEach((kind, index) => {
      for (const entry of pages[index] ?? []) {
        const parsed = parseKey(kind, entry.key);
        if (parsed === undefined || failed.has(parsed.sessionID)) continue;
        if (recorded.has(`${parsed.sessionID}/${parsed.generation}`)) continue;
        const at = markerAt(entry.value) ?? -Infinity;
        const marker = { key: entry.key, generation: parsed.generation };
        const session = sessions.get(parsed.sessionID);
        if (session === undefined) {
          sessions.set(parsed.sessionID, { oldest: at, markers: [marker] });
        } else {
          session.oldest = Math.min(session.oldest, at);
          session.markers.push(marker);
        }
      }
    });
    const due = [...sessions.entries()]
      .sort(([, a], [, b]) => a.oldest - b.oldest)
      .slice(0, this.sweepMaxSessions);
    let cleaned = 0;
    for (const [sessionID, { markers }] of due) {
      if (this.disposed) break;
      try {
        if (await this.removeOrphanMarkers(sessionID, markers)) cleaned++;
      } catch (error) {
        this.deps.logger.warn(
          "latch: could not remove stop markers whose latch record was gone",
          { sessionID, error: errorMessage(error) },
        );
      }
    }
    return cleaned;
  }

  /**
   * Removes the markers, read before this call, whose generation has no latch record now. A marker
   * is only ever written after its latch record: a stop writes its latch record before the note it
   * owes, and a lift or gaveup marker is written only once its latch record was read as active. A
   * latch record is only removed once its stop ended more than the grace period ago, and nothing
   * writes the latch record of an ended stop again. A latch record missing after the marker was
   * read is therefore gone for good, so a stop written a moment ago keeps its markers without any
   * minimum age. Each marker is removed only after that read found its latch record gone, which
   * keeps the rule `status` relies on. True if it removed any.
   */
  private async removeOrphanMarkers(
    sessionID: SessionID,
    markers: ReadonlyArray<OrphanCandidate>,
  ): Promise<boolean> {
    const generations = new Set<string>();
    for (const entry of await this.deps.store.scan(`latch/${sessionID}/`)) {
      const parsed = parseKey("latch", entry.key);
      if (parsed !== undefined && parsed.sessionID === sessionID) {
        generations.add(parsed.generation);
      }
    }
    let removedAny = false;
    for (const marker of markers) {
      if (generations.has(marker.generation)) continue;
      if (this.disposed) return removedAny;
      await this.deps.store.remove(marker.key);
      removedAny = true;
    }
    return removedAny;
  }

  /**
   * Removes every key of the session when its newest stop ended more than the grace period ago.
   * True if it did.
   *
   * The session's markers are read first and its latch records after them, in two steps, never
   * at once. A marker is only written after its latch record (see `removeOrphanMarkers`), so the
   * latch read holds the latch record of every marker the pass saw, unless something removed that
   * record in between. A stop another instance writes meanwhile therefore either has written
   * nothing the marker read saw, or has its latch record in the latch read. There it is the
   * session's newest stop and has not ended long ago, so the pass keeps every key: a stop records
   * the time it started, and an inherited latch only goes into a newly created session, whose
   * parent's stop is active. Only markers whose generation has a latch record in the latch read are
   * removed here; any other marker is left to the orphan-marker phase, which checks that its latch
   * record is gone. A marker written after the marker read is missing from it, which can only make
   * a stop look less ended, so the pass keeps the session.
   *
   * Older generations go first and the newest last, so a pass cut short never makes an older stop
   * current again. Within a generation the latch record goes first and each removal is awaited
   * before the next, so no instance removes a marker while its latch record is still stored. That
   * keeps every latch record with the lift or gaveup marker that ended it, and lets `status` tell a
   * stop whose records were removed while it read them from one that has no marker. A pass cut
   * short can leave markers whose latch record is gone, which a later pass removes. Removal is
   * idempotent and an ended stop never becomes active again, so instances can sweep at the same
   * time.
   */
  private async sweepSession(sessionID: SessionID): Promise<boolean> {
    const markerPages = await Promise.all(
      MARKER_KINDS.map((kind) => this.deps.store.scan(`${kind}/${sessionID}/`)),
    );
    const latchPage = await this.deps.store.scan(`latch/${sessionID}/`);
    const records = new Map<string, CurrentLatch>();
    /** Generations with a latch record in the latch read, readable or not. */
    const captured = new Set<string>();
    const keys = new Map<
      string | undefined,
      Array<{ readonly key: string; readonly rank: number }>
    >();
    const addKey = (
      generation: string | undefined,
      key: string,
      rank: number,
    ) => {
      const entries = keys.get(generation) ?? [];
      entries.push({ key, rank });
      keys.set(generation, entries);
    };
    for (const entry of latchPage) {
      const parsed = parseKey("latch", entry.key);
      if (parsed !== undefined && parsed.sessionID !== sessionID) continue;
      const generation = parsed?.generation;
      addKey(generation, entry.key, 0);
      if (generation === undefined) continue;
      captured.add(generation);
      const latch = toCurrentLatch(sessionID, generation, entry.value);
      if (latch !== undefined) records.set(generation, latch);
    }
    const markers = new Map<string, Json>();
    MARKER_KINDS.forEach((kind, index) => {
      for (const entry of markerPages[index] ?? []) {
        const parsed = parseKey(kind, entry.key);
        if (parsed !== undefined && parsed.sessionID !== sessionID) continue;
        const generation = parsed?.generation;
        // A key with no generation was written by no stop, so it decides nothing and belongs to
        // no stop being written.
        if (generation !== undefined && !captured.has(generation)) continue;
        addKey(generation, entry.key, index + 1);
        if (generation !== undefined && kind !== "note") {
          markers.set(`${kind}/${generation}`, entry.value);
        }
      }
    });
    let newest: CurrentLatch | undefined;
    for (const latch of records.values()) {
      if (newest === undefined || isNewer(latch, newest)) newest = latch;
    }
    if (newest === undefined) return false;
    const endedAt = Math.min(
      newest.expiresAt,
      markerAt(markers.get(`lift/${newest.generation}`)) ?? Infinity,
      markerAt(markers.get(`gaveup/${newest.generation}`)) ?? Infinity,
    );
    if (this.deps.clock.now() - endedAt <= this.sweepGraceMs) return false;
    const ordered = [...keys.entries()]
      .sort(([a], [b]) =>
        compareGenerations(
          a === undefined ? undefined : records.get(a),
          b === undefined ? undefined : records.get(b),
        ),
      )
      .flatMap(([, group]) =>
        [...group].sort((a, b) => a.rank - b.rank).map((entry) => entry.key),
      );
    for (const key of ordered) {
      if (this.disposed) return false;
      await this.deps.store.remove(key);
    }
    this.enforcements.delete(sessionID);
    return true;
  }

  /**
   * Counts one re-interrupt of the latch, dropping counts older than the window. Trips when the
   * window already holds `valveMax` of them. A latch of a new generation starts a new count.
   */
  private valveTrips(latch: CurrentLatch): boolean {
    const now = this.deps.clock.now();
    const previous = this.enforcements.get(latch.sessionID);
    const times =
      previous?.generation === latch.generation
        ? previous.times.filter((time) => now - time < this.valveWindowMs)
        : [];
    const trips = times.length >= this.valveMax;
    if (!trips) times.push(now);
    this.enforcements.set(latch.sessionID, {
      generation: latch.generation,
      times,
    });
    return trips;
  }

  /** Latches a new child of a session whose latch is active, with the parent's generation and `at`. */
  private async inherit(
    childID: SessionID,
    parentID: SessionID,
  ): Promise<void> {
    const parent = await this.current(parentID);
    if (parent === undefined || (await this.status(parent)) !== "active")
      return;
    await this.deps.store.set(key("latch", childID, parent.generation), {
      parentSessionID: parent.parentSessionID,
      reason: parent.reason,
      at: parent.at,
      expiresAt: parent.expiresAt,
    });
  }

  /**
   * Lifts the current latch for a lift event. An event older than the latch belongs to an earlier
   * stop, so it leaves a newer stop's latch alone.
   */
  private async liftOnEvent(
    sessionID: SessionID,
    created: number,
  ): Promise<void> {
    const current = await this.current(sessionID);
    if (current === undefined || created < current.at) return;
    await this.liftIfActive(current, created);
  }

  /** Writes the lift key when the latch is active. True if it did. */
  private async liftIfActive(
    latch: CurrentLatch,
    at: number,
  ): Promise<boolean> {
    if ((await this.status(latch)) !== "active") return false;
    await this.deps.store.set(key("lift", latch.sessionID, latch.generation), {
      at,
    });
    this.enforcements.delete(latch.sessionID);
    this.deps.logger.info("latch: lifted", {
      sessionID: latch.sessionID,
      generation: latch.generation,
    });
    return true;
  }

  /** Removes every key of a deleted session and its in-memory state. */
  private async forget(sessionID: SessionID): Promise<void> {
    this.exempt.delete(sessionID);
    this.enforcements.delete(sessionID);
    this.starts.get(sessionID)?.end();
    this.starts.delete(sessionID);
    this.releaseWaiters(sessionID);
    const pages = await Promise.all(
      KEY_KINDS.map(async (kind) => ({
        kind,
        entries: await this.deps.store.scan(`${kind}/${sessionID}/`),
      })),
    );
    const keysOf = (latchRecords: boolean) =>
      pages
        .filter((page) => (page.kind === "latch") === latchRecords)
        .flatMap((page) => page.entries.map((entry) => entry.key));
    // Latch records go before the markers, as with every remover, so a stop whose keys are being
    // removed never reads as active.
    await Promise.all(keysOf(true).map((key) => this.deps.store.remove(key)));
    await Promise.all(keysOf(false).map((key) => this.deps.store.remove(key)));
  }

  private async exemptIfRunning(
    latch: CurrentLatch,
    isRunning: (sessionID: SessionID) => Promise<boolean>,
    seen: ReadonlySet<SessionID>,
  ): Promise<void> {
    try {
      if ((await this.status(latch)) !== "active") return;
      if (!(await isRunning(latch.sessionID))) return;
      // An execution event since startup began means this instance saw the run start or end
      // itself, so the run the check found is not one it missed.
      if (seen.has(latch.sessionID)) return;
      this.exempt.add(latch.sessionID);
      this.deps.logger.info(
        "latch: left a stopped session's run alone; it was running at startup",
        { sessionID: latch.sessionID, generation: latch.generation },
      );
    } catch (error) {
      this.deps.logger.warn("latch: startup check failed", {
        sessionID: latch.sessionID,
        error: errorMessage(error),
      });
    }
  }

  private watchExecution(sessionID: SessionID): void {
    for (const seen of this.startupWatchers) seen.add(sessionID);
  }

  /** The session's latch record with the latest `at`. */
  private async current(
    sessionID: SessionID,
  ): Promise<CurrentLatch | undefined> {
    let best: CurrentLatch | undefined;
    for (const entry of await this.deps.store.scan(`latch/${sessionID}/`)) {
      const parsed = parseKey("latch", entry.key);
      if (parsed === undefined || parsed.sessionID !== sessionID) continue;
      const latch = toCurrentLatch(sessionID, parsed.generation, entry.value);
      if (latch === undefined) continue;
      if (best === undefined || isNewer(latch, best)) best = latch;
    }
    return best;
  }

  /**
   * A lift wins over a gaveup marker and expiry: it records that someone continued the session.
   *
   * `collected`: a sweep removed the stop's records after `latch` was read. Instances can have
   * different TTLs, so a sweep can collect a stop that was lifted or given up long ago while its
   * stored `expiresAt` is still ahead, and reading the markers after they were removed would make
   * that stop look active. Every instance removes a generation's latch record before any of its
   * markers, and only once the stop ended, after which nothing writes that latch record again. So
   * when the latch record is still stored after the markers were read, no marker had been removed
   * when they were read, and a missing marker means the stop has none. When it is gone, the stop
   * was collected and nothing keeps the session stopped. The extra read happens only for a stop
   * that would otherwise read as active.
   */
  private async status(latch: CurrentLatch): Promise<ReadStatus> {
    const [lifted, gaveUp] = await Promise.all([
      this.deps.store.get(key("lift", latch.sessionID, latch.generation)),
      this.deps.store.get(key("gaveup", latch.sessionID, latch.generation)),
    ]);
    if (lifted !== undefined) return "lifted";
    if (gaveUp !== undefined) return "gave_up";
    if (this.deps.clock.now() >= latch.expiresAt) return "expired";
    const stored = await this.deps.store.get(
      key("latch", latch.sessionID, latch.generation),
    );
    return stored === undefined ? "collected" : "active";
  }
}

type StoreEntry = { readonly key: string; readonly value: Json };

/** A latch's status as one read found it; see `Latch.status` for `collected`. */
type ReadStatus = LatchStatus | "collected";

/** A marker key a sweep pass found with no latch record of its generation in the pass's scan. */
type OrphanCandidate = { readonly key: string; readonly generation: string };

function key(kind: KeyKind, sessionID: SessionID, generation: string): string {
  return `${kind}/${sessionID}/${generation}`;
}

/**
 * The run the session records as open, or `undefined` when a host that records run starts
 * records none open.
 */
function runIdentity(info: SessionInfo): RunIdentity | undefined {
  const busy = busySince(info);
  if (busy === undefined) return { kind: "after", idleAt: info.time.idle };
  return recordsOpenRun(info) === true
    ? { kind: "busy", startedAt: busy }
    : undefined;
}

/** Whether the run that started at `startedAt` is the one `identity` describes. */
function startsRun(identity: RunIdentity, startedAt: number): boolean {
  if (identity.kind === "busy") return startedAt === identity.startedAt;
  return identity.idleAt === undefined || startedAt > identity.idleAt;
}

function handledStart(
  startedAt: number,
  enforcement: Promise<boolean>,
): HandledStart {
  let resolveEnded: () => void = () => {};
  const ended = new Promise<void>((resolve) => {
    resolveEnded = resolve;
  });
  const start: HandledStart = {
    startedAt,
    enforcement,
    ended,
    isEnded: false,
    end() {
      start.isEnded = true;
      resolveEnded();
    },
  };
  return start;
}

/** The `at` a lift or gaveup marker records, when it is readable. */
function markerAt(value: Json | undefined): number | undefined {
  if (value === undefined || !isRecord(value)) return undefined;
  const { at } = value;
  return typeof at === "number" && Number.isFinite(at) ? at : undefined;
}

/** Orders generations oldest first; one without a readable latch record comes before the rest. */
function compareGenerations(
  a: CurrentLatch | undefined,
  b: CurrentLatch | undefined,
): number {
  if (a === undefined || b === undefined) {
    return a === b ? 0 : a === undefined ? -1 : 1;
  }
  if (isNewer(a, b)) return 1;
  return isNewer(b, a) ? -1 : 0;
}

function parseKey(
  kind: KeyKind,
  stored: string,
): { sessionID: SessionID; generation: string } | undefined {
  const prefix = `${kind}/`;
  if (!stored.startsWith(prefix)) return undefined;
  const rest = stored.slice(prefix.length);
  const slash = rest.indexOf("/");
  if (slash <= 0 || slash === rest.length - 1) return undefined;
  return { sessionID: rest.slice(0, slash), generation: rest.slice(slash + 1) };
}

/** Ties on `at` go to the greater generation, so every instance picks the same latch. */
function isNewer(a: CurrentLatch, b: CurrentLatch): boolean {
  return a.at > b.at || (a.at === b.at && a.generation > b.generation);
}

function toCurrentLatch(
  sessionID: SessionID,
  generation: string,
  value: Json,
): CurrentLatch | undefined {
  if (!isRecord(value)) return undefined;
  const { parentSessionID, reason, at, expiresAt } = value;
  if (
    typeof parentSessionID !== "string" ||
    typeof reason !== "string" ||
    typeof at !== "number" ||
    typeof expiresAt !== "number"
  ) {
    return undefined;
  }
  return { sessionID, generation, parentSessionID, reason, at, expiresAt };
}

function isRecord(value: Json): value is { readonly [key: string]: Json } {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
