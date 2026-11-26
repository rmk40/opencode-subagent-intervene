// Whether sessions are running. Core publishes no busy state to plugins, so the state is folded
// from execution events, and a session with no observed event is probed by waiting for it to go
// idle against a short timer.
//
// The fold is a cache. Core can fail to record the end of an execution (a failed lifecycle publish
// is logged and swallowed), and then no terminal event ever arrives, so a session that showed no
// progress for a while is checked with a probe: `session.wait` resolves once core's run
// coordinator has no execution left, which is the authority on whether a session runs. A probe
// that resolves at once overrides a running fold, unless an execution started during the probe,
// and the session is then idle with no recorded end until its next execution starts.

import {
  type ActivityTracker,
  type ExecutionMark,
  recordsOpenRun,
} from "@/core/activity";
import type {
  Clock,
  OpenCodeEvent,
  RunObservation,
  RunState,
  SessionControl,
  SessionID,
  SessionInfo,
  SessionReader,
} from "@/core/ports";

export const PROBE_TIMEOUT_MS = 150;
/** Observations `observeAll` runs at once. */
export const PROBE_CONCURRENCY = 32;
/** How long a running session may show no progress before its folded state is checked. */
export const STALE_PROGRESS_MS = 2 * 60 * 1000;
export const RECONCILE_GRACE_MS = 1000;

export interface RunStateDeps {
  readonly control: SessionControl;
  readonly clock: Clock;
  /**
   * Live evidence for reconciliation. Without it, a running fold is never checked, and only a
   * session with no folded state can be found to have no recorded end, from storage.
   */
  readonly activity?: Pick<
    ActivityTracker,
    "get" | "inExecution" | "ended" | "mark" | "sameMark" | "markUnended"
  >;
  /** Re-reads a session whose storage records an open run. Without it that is not confirmed. */
  readonly reader?: Pick<SessionReader, "get">;
}

export interface RunStateOptions {
  /** How long a probe waits for the session to go idle before calling it running. */
  readonly probeTimeoutMs?: number;
  /** Observations `observeAll` runs at once. Default 32. */
  readonly probeConcurrency?: number;
  /** How long a running session may show no progress before it is probed. Default 2 minutes. */
  readonly staleAfterMs?: number;
  /**
   * How long a probe that found a running session idle waits for a terminal event before
   * concluding that its last run recorded no end. Default 1 s.
   */
  readonly graceMs?: number;
  /**
   * Whether probes can tell idle from running. False when the host has no `session.wait`: probes
   * then report unknown, so a running fold is trusted instead of probed. Default true.
   */
  readonly reconcile?: boolean;
}

/** Folded state; `unended` is idle with no recorded end, held until the next execution starts. */
type Folded = "running" | "idle" | "unended";

export class RunStateTracker {
  private readonly deps: RunStateDeps;
  private readonly probeTimeoutMs: number;
  private readonly probeConcurrency: number;
  private readonly staleAfterMs: number;
  private readonly graceMs: number;
  private readonly reconcile: boolean;
  /** State from the latest execution event seen for each session, or from reconciliation. */
  private readonly folded = new Map<SessionID, Folded>();

  constructor(deps: RunStateDeps, options: RunStateOptions = {}) {
    this.deps = deps;
    this.probeTimeoutMs = options.probeTimeoutMs ?? PROBE_TIMEOUT_MS;
    this.probeConcurrency = Math.max(
      1,
      options.probeConcurrency ?? PROBE_CONCURRENCY,
    );
    this.staleAfterMs = options.staleAfterMs ?? STALE_PROGRESS_MS;
    this.graceMs = options.graceMs ?? RECONCILE_GRACE_MS;
    this.reconcile = options.reconcile ?? true;
  }

  /**
   * Forgets every folded state. Call when events may have been missed, such as after the event
   * subscription ended: folded values are only current while every event arrives, and later
   * observations then fall back to probes.
   */
  reset(): void {
    this.folded.clear();
  }

  /** Folds `session.execution.*` into the session's state; forgets deleted sessions. */
  onEvent(event: OpenCodeEvent): void {
    switch (event.type) {
      case "session.execution.started":
        this.folded.set(event.data.sessionID, "running");
        return;
      case "session.execution.succeeded":
      case "session.execution.failed":
      case "session.execution.interrupted":
        this.folded.set(event.data.sessionID, "idle");
        return;
      case "session.deleted":
        this.folded.delete(event.data.sessionID);
        return;
      default:
        return;
    }
  }

  /**
   * The folded state when an execution event has been seen, otherwise a probe. A running fold
   * whose session showed no progress for a while is checked with a probe first. `info`, read
   * before the call, lets a probe that finds the session idle tell from storage whether its last
   * run recorded an end. Probe results are not kept, because a timeout under load can report an
   * idle session as running; only a confirmed missing end is. Never rejects.
   */
  async observe(
    sessionID: SessionID,
    info?: SessionInfo,
  ): Promise<RunObservation> {
    const known = this.folded.get(sessionID);
    // Progress since the session was found to have no recorded end shows it runs again, even when
    // the start of that run went unrecorded too, so it is probed again.
    if (
      known === "unended" &&
      this.deps.activity?.inExecution(sessionID) !== true
    ) {
      return UNENDED;
    }
    if (known === "idle") return { state: "idle", source: "event" };
    if (known === "running" && !this.isStale(sessionID)) {
      return { state: "running", source: "event" };
    }
    return this.probeAndReconcile(sessionID, info);
  }

  /**
   * Probes the session whatever its folded state, for a caller about to act on the state, and
   * reconciles the fold with the result. Never rejects.
   */
  async confirm(
    sessionID: SessionID,
    info?: SessionInfo,
  ): Promise<RunObservation> {
    return this.probeAndReconcile(sessionID, info);
  }

  /**
   * `observe` for each distinct session, in input order. At most `probeConcurrency` run at once:
   * hundreds of probes started together slow the host enough that idle sessions miss the probe
   * timer and read as running. Each probe's timer starts when that probe starts. Never rejects.
   */
  async observeAll(
    sessionIDs: Iterable<SessionID>,
    infos?: ReadonlyMap<SessionID, SessionInfo>,
  ): Promise<Map<SessionID, RunObservation>> {
    const ids = [...new Set(sessionIDs)];
    const observed = new Map<SessionID, RunObservation>();
    let next = 0;
    const worker = async (): Promise<void> => {
      for (let id = ids[next++]; id !== undefined; id = ids[next++]) {
        observed.set(id, await this.observe(id, infos?.get(id)));
      }
    };
    await Promise.all(
      Array.from(
        { length: Math.min(this.probeConcurrency, ids.length) },
        worker,
      ),
    );
    const ordered = new Map<SessionID, RunObservation>();
    for (const id of ids) {
      const observation = observed.get(id);
      if (observation !== undefined) ordered.set(id, observation);
    }
    return ordered;
  }

  /** What `settled` compares against: take it before waiting for the session to go idle. */
  mark(sessionID: SessionID): ExecutionMark | undefined {
    return this.deps.activity?.mark(sessionID);
  }

  /**
   * Evidence from a wait for the session to go idle that resolved, such as a stop's settle wait:
   * the session had no execution left. When no execution started since `mark`, no end was seen,
   * and the session showed no progress for a while, its last run recorded no end. The caller passes
   * only sessions it has no other sign of a run for, such as an interrupt that stopped one, since
   * the terminal event of a run that just ended can arrive after the wait resolves.
   */
  settled(sessionID: SessionID, mark: ExecutionMark | undefined): void {
    if (!this.reconcile || mark === undefined) return;
    if (this.folded.get(sessionID) === "unended") return;
    if (!this.isStale(sessionID)) return;
    if (this.deps.activity?.inExecution(sessionID) !== true) return;
    this.recordUnended(sessionID, mark);
  }

  /** Whether the session's folded run shows no progress for `staleAfterMs`, or none seen at all. */
  private isStale(sessionID: SessionID): boolean {
    if (!this.reconcile) return false;
    const activity = this.deps.activity;
    if (activity === undefined) return false;
    const last = activity.get(sessionID)?.lastProgressAt;
    return (
      last === undefined || this.deps.clock.now() - last >= this.staleAfterMs
    );
  }

  private async probeAndReconcile(
    sessionID: SessionID,
    info: SessionInfo | undefined,
  ): Promise<RunObservation> {
    const before = this.folded.get(sessionID);
    const mark = this.deps.activity?.mark(sessionID);
    const probed = await this.probe(sessionID);
    if (probed === "idle" && mark !== undefined && this.reconcile) {
      const live = this.deps.activity?.inExecution(sessionID) === true;
      const stored =
        !live &&
        !this.folded.has(sessionID) &&
        info !== undefined &&
        recordsOpenRun(info) === true;
      if (live || stored) {
        // The wait and the event stream are separate channels, so the terminal event of a run that
        // just ended can arrive after the wait resolved. It gets a moment to arrive.
        await this.deps.clock.sleep(this.graceMs);
        if (
          (!stored || (await this.stillRecordsOpenRun(sessionID))) &&
          this.recordUnended(sessionID, mark)
        ) {
          return UNENDED;
        }
      }
    }
    return this.afterProbe(sessionID, probed, before, mark);
  }

  /**
   * The state to report once a probe settled. An event that arrived while the probe ran is newer
   * than whatever the probe saw. Otherwise the probe decides, except that a running fold the probe
   * found idle reads as idle from events when the session's end was seen and its terminal event is
   * still on its way to the fold, and a session folded as having no recorded end stays so unless
   * the probe finds it running again. A probe that timed out is provisional, and one that failed
   * leaves the state unknown.
   */
  private afterProbe(
    sessionID: SessionID,
    probed: RunState,
    before: Folded | undefined,
    mark: ExecutionMark | undefined,
  ): RunObservation {
    const after = this.folded.get(sessionID);
    const changed =
      after !== before ||
      (mark !== undefined &&
        this.deps.activity?.sameMark(sessionID, mark) === false);
    if (changed && after !== undefined) {
      return after === "unended" ? UNENDED : { state: after, source: "event" };
    }
    if (after === "unended") {
      return probed === "running" ? { state: probed, source: "probe" } : UNENDED;
    }
    if (
      after === "running" &&
      probed === "idle" &&
      this.deps.activity?.ended(sessionID) === true
    ) {
      return { state: "idle", source: "event" };
    }
    if (after === "idle" && probed !== "running") {
      return { state: "idle", source: "event" };
    }
    return { state: probed, source: "probe" };
  }

  /** Re-reads the session after a probe, so an end recorded during the probe is seen. */
  private async stillRecordsOpenRun(sessionID: SessionID): Promise<boolean> {
    if (this.deps.reader === undefined) return false;
    try {
      const fresh = await this.deps.reader.get(sessionID);
      return fresh !== undefined && recordsOpenRun(fresh) === true;
    } catch {
      return false;
    }
  }

  /** Folds the session as idle with no recorded end unless an execution started since `mark`. */
  private recordUnended(sessionID: SessionID, mark: ExecutionMark): boolean {
    const activity = this.deps.activity;
    if (activity === undefined || !activity.sameMark(sessionID, mark)) {
      return false;
    }
    // A terminal event seen since the mark means the end was recorded after all.
    if (activity.ended(sessionID)) return false;
    activity.markUnended(sessionID, mark);
    this.folded.set(sessionID, "unended");
    return true;
  }

  /** Idle when `waitIdle` resolves first, running when the timer does, unknown on an error. */
  private async probe(sessionID: SessionID): Promise<RunState> {
    const timer = new AbortController();
    try {
      return await Promise.race([
        Promise.resolve()
          .then(() => this.deps.control.waitIdle(sessionID))
          .then(
            () => "idle" as const,
            () => "unknown" as const,
          ),
        this.deps.clock
          .sleep(this.probeTimeoutMs, timer.signal)
          .then(() => "running" as const),
      ]);
    } catch {
      return "unknown";
    } finally {
      // Ends the timer early when `waitIdle` settled first; the race has already been decided.
      timer.abort();
    }
  }
}

const UNENDED: RunObservation = {
  state: "idle",
  source: "probe",
  noRecordedEnd: true,
};
