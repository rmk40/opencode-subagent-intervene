// Whether sessions are running. Core publishes no busy state to plugins, so the state is folded
// from execution events, and a session with no observed event is probed by waiting for it to go
// idle against a short timer.

import type {
  Clock,
  OpenCodeEvent,
  RunObservation,
  RunState,
  SessionControl,
  SessionID,
} from "@/core/ports";

export const PROBE_TIMEOUT_MS = 150;
/** Observations `observeAll` runs at once. */
export const PROBE_CONCURRENCY = 32;

export interface RunStateDeps {
  readonly control: SessionControl;
  readonly clock: Clock;
}

export interface RunStateOptions {
  /** How long a probe waits for the session to go idle before calling it running. */
  readonly probeTimeoutMs?: number;
  /** Observations `observeAll` runs at once. Default 32. */
  readonly probeConcurrency?: number;
}

export class RunStateTracker {
  private readonly deps: RunStateDeps;
  private readonly probeTimeoutMs: number;
  private readonly probeConcurrency: number;
  /** State from the latest execution event seen for each session. */
  private readonly folded = new Map<SessionID, "running" | "idle">();

  constructor(deps: RunStateDeps, options: RunStateOptions = {}) {
    this.deps = deps;
    this.probeTimeoutMs = options.probeTimeoutMs ?? PROBE_TIMEOUT_MS;
    this.probeConcurrency = Math.max(
      1,
      options.probeConcurrency ?? PROBE_CONCURRENCY,
    );
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
   * The folded state when an execution event has been seen, otherwise a probe. Probe results are
   * not kept, because a timeout under load can report an idle session as running. Never rejects.
   */
  async observe(sessionID: SessionID): Promise<RunObservation> {
    const known = this.folded.get(sessionID);
    if (known !== undefined) return { state: known, source: "event" };
    const probed = await this.probe(sessionID);
    // Only events add entries, so an entry now means an event arrived while the probe ran, and
    // that event is newer than whatever the probe saw.
    const after = this.folded.get(sessionID);
    if (after !== undefined) return { state: after, source: "event" };
    return { state: probed, source: "probe" };
  }

  /**
   * `observe` for each distinct session, in input order. At most `probeConcurrency` run at once:
   * hundreds of probes started together slow the host enough that idle sessions miss the probe
   * timer and read as running. Each probe's timer starts when that probe starts. Never rejects.
   */
  async observeAll(
    sessionIDs: Iterable<SessionID>,
  ): Promise<Map<SessionID, RunObservation>> {
    const ids = [...new Set(sessionIDs)];
    const observed = new Map<SessionID, RunObservation>();
    let next = 0;
    const worker = async (): Promise<void> => {
      for (let id = ids[next++]; id !== undefined; id = ids[next++]) {
        observed.set(id, await this.observe(id));
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
