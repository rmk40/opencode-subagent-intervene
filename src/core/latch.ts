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
// another instance may have written any of these keys. Only the safety-valve counters and the
// startup exemptions live in memory. Session IDs contain no `/`, so the first `/` after a kind
// prefix ends the session ID and the rest of the key is the generation.

import type {
  Clock,
  Json,
  Logger,
  OpenCodeEvent,
  SessionControl,
  SessionID,
  Store,
} from "@/core/ports";

export const DEFAULT_LATCH_TTL_MS = 24 * 60 * 60 * 1000;
export const DEFAULT_VALVE_MAX = 30;
export const DEFAULT_VALVE_WINDOW_MS = 10 * 60 * 1000;

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
}

export interface LatchOptions {
  readonly ttlMs?: number;
  /** Re-interrupts of one latch allowed within `valveWindowMs`; the next one trips the valve. */
  readonly valveMax?: number;
  readonly valveWindowMs?: number;
}

type KeyKind = "latch" | "lift" | "gaveup" | "note";

const KEY_KINDS: readonly KeyKind[] = ["latch", "lift", "gaveup", "note"];

type InboxItemType = Extract<
  OpenCodeEvent,
  { type: "session.inbox.enqueued" }
>["data"]["item"]["type"];

/**
 * Inbox items that only a deliberate request admits. Synthetic items are left out: core's notices,
 * the messages `subagent_send` steers into a subagent, and the waiting notices posted to a parent
 * are all synthetic, and none of them asks to continue a stopped session.
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

export class Latch {
  private readonly deps: LatchDeps;
  private readonly ttlMs: number;
  private readonly valveMax: number;
  private readonly valveWindowMs: number;
  /** Times this instance re-interrupted each session's current latch, within the valve window. */
  private readonly enforcements = new Map<
    SessionID,
    { readonly generation: string; readonly times: number[] }
  >();
  /** Sessions found running at startup, left alone until their next terminal event. */
  private readonly exempt = new Set<SessionID>();
  /** One set per startup pass in progress: sessions with an execution event since it began. */
  private readonly startupWatchers = new Set<Set<SessionID>>();

  constructor(deps: LatchDeps, options: LatchOptions = {}) {
    this.deps = deps;
    this.ttlMs = options.ttlMs ?? DEFAULT_LATCH_TTL_MS;
    this.valveMax = options.valveMax ?? DEFAULT_VALVE_MAX;
    this.valveWindowMs = options.valveWindowMs ?? DEFAULT_VALVE_WINDOW_MS;
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

  /** The session's current latch, or `undefined` when it was never stopped. */
  async describe(sessionID: SessionID): Promise<StopDescription | undefined> {
    const current = await this.current(sessionID);
    if (current === undefined) return undefined;
    return {
      at: current.at,
      reason: current.reason,
      latch: await this.status(current),
    };
  }

  /** Handles one event from the plugin's subscription. Never rejects; failures are logged. */
  async onEvent(event: OpenCodeEvent): Promise<void> {
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
   * Runs once when the instance loads. Writes nothing. A session with an active latch that is
   * already running is exempt from enforcement until its next terminal event: the instance cannot
   * tell whether a notice or a deliberate prompt it missed started that run. Never rejects.
   */
  async startup(
    isRunning: (sessionID: SessionID) => Promise<boolean>,
  ): Promise<void> {
    const seen = new Set<SessionID>();
    this.startupWatchers.add(seen);
    try {
      const latest = new Map<SessionID, CurrentLatch>();
      for (const entry of await this.deps.store.scan("latch/")) {
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
    }
  }

  private async handle(event: OpenCodeEvent): Promise<void> {
    switch (event.type) {
      case "session.execution.started":
        this.watchExecution(event.data.sessionID);
        return this.enforce(event.data.sessionID);
      case "session.execution.succeeded":
      case "session.execution.failed":
      case "session.execution.interrupted":
        this.watchExecution(event.data.sessionID);
        this.exempt.delete(event.data.sessionID);
        return;
      case "session.created":
        if (event.data.parentID === undefined) return;
        return this.inherit(event.data.sessionID, event.data.parentID);
      case "session.deleted":
        return this.forget(event.data.sessionID);
      case "session.inbox.enqueued":
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

  /** Interrupts a run that started under an active latch, unless the safety valve trips. */
  private async enforce(sessionID: SessionID): Promise<void> {
    if (this.exempt.has(sessionID)) return;
    const current = await this.current(sessionID);
    if (current === undefined) return;
    if ((await this.status(current)) !== "active") {
      this.enforcements.delete(sessionID);
      return;
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
      return;
    }
    const interrupted = await this.deps.control.interrupt(sessionID);
    this.deps.logger.info("latch: interrupted a run in a stopped session", {
      sessionID,
      generation: current.generation,
      interrupted,
    });
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
    const pages = await Promise.all(
      KEY_KINDS.map((kind) => this.deps.store.scan(`${kind}/${sessionID}/`)),
    );
    await Promise.all(
      pages.flat().map((entry) => this.deps.store.remove(entry.key)),
    );
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

  /** A lift wins over a gaveup marker and expiry: it records that someone continued the session. */
  private async status(latch: CurrentLatch): Promise<LatchStatus> {
    const [lifted, gaveUp] = await Promise.all([
      this.deps.store.get(key("lift", latch.sessionID, latch.generation)),
      this.deps.store.get(key("gaveup", latch.sessionID, latch.generation)),
    ]);
    if (lifted !== undefined) return "lifted";
    if (gaveUp !== undefined) return "gave_up";
    if (this.deps.clock.now() >= latch.expiresAt) return "expired";
    return "active";
  }
}

function key(kind: KeyKind, sessionID: SessionID, generation: string): string {
  return `${kind}/${sessionID}/${generation}`;
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
