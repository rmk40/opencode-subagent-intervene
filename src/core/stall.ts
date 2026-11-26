// Tells a parent when its subagent appears stalled: it runs, has no tool call running, is waiting on
// no prompt or retry, and has shown no progress for a while. A run whose end core failed to record
// looks the same from events, so the session is probed before the notice is composed, and the
// notice then says the subagent is not running instead.
//
// Every instance sees every event and runs the same sweep, so the notice's inbox item ID is built
// only from data every instance shares: the session, its execution, its last stored progress and
// the event that showed its last progress. Core admits the first item with an ID and returns it for
// later posts of the same ID, but it wakes the parent on every admission attempt, so an instance
// never posts the same ID twice. An instance posts only once it has itself watched the whole
// silence: from the last progress it saw, or for a session it followed before a gap in the event
// stream, from the end of the gap. The last progress of such a session may have come during the
// gap, so its ID leaves the event out and can differ from the ID other instances post.
//
// A parent blocked in a foreground `subagent` call on the subagent would read the notice only once
// the call returns, so it is not told while the call runs, as with the prompt notices.

import { createHash } from "node:crypto";
import {
  type ActivityTracker,
  activityPhase,
  busySince,
  type SessionActivity,
  silentSince,
} from "@/core/activity";
import { ForegroundCalls } from "@/core/foreground";
import type { Latch } from "@/core/latch";
import { describeSubagent } from "@/core/notices";
import {
  type Clock,
  type Logger,
  type OpenCodeEvent,
  PLUGIN_ID,
  type Scheduler,
  type SessionID,
  type SessionInfo,
  type SessionMessageInfo,
  type SessionMessenger,
  type SessionReader,
} from "@/core/ports";
import type { RunStateTracker } from "@/core/run-state";
import { sanitizeText } from "@/core/sanitize";
import {
  activeToolTimes,
  formatDuration,
  sinceCompaction,
} from "@/core/summarize";

export const DEFAULT_STALL_NOTICE_MS = 10 * 60 * 1000;
/** Longest wait between sweeps; shorter thresholds sweep more often. */
export const MAX_SWEEP_MS = 30_000;
const MIN_SWEEP_MS = 1000;
/** Shown to people in OpenCode next to the notice. */
export const STALL_NOTICE_DESCRIPTION = "Subagent stalled";
/** `kind` in the metadata of a stall notice. */
export const STALL_NOTICE_KIND = "subagent-stalled";
/** Notice IDs this instance remembers having posted. */
const POSTED_LIMIT = 10_000;
const ID_MAX = 100;

/**
 * `no-progress`: it runs but shows no progress. `no-recorded-end`: OpenCode reports it idle, but
 * its last run recorded no end, so it is not running.
 */
export type StallKind = "no-progress" | "no-recorded-end";

/** The ID kind of each notice, so the two never share an ID. */
const ID_KINDS: Readonly<Record<StallKind, string>> = {
  "no-progress": "subagent-stalled",
  "no-recorded-end": "subagent-unended",
};

export interface StallNoticeDeps {
  readonly activity: Pick<
    ActivityTracker,
    | "all"
    | "get"
    | "carriedSessions"
    | "isCarried"
    | "resumedAfterGap"
    | "knowsEverythingRunning"
    | "lastProgressEventID"
  >;
  readonly runState: Pick<RunStateTracker, "confirm">;
  /**
   * `pendingPermissions` is read only for a session carried across a gap. It sees only the
   * instance's own location.
   */
  readonly reader: Pick<SessionReader, "get" | "context" | "pendingPermissions">;
  readonly messenger: SessionMessenger;
  /** Without it, stop latches are not checked. */
  readonly latch?: Pick<Latch, "isActive">;
  readonly scheduler: Scheduler;
  readonly clock: Pick<Clock, "now">;
  readonly logger: Logger;
}

export interface StallNoticeOptions {
  /** How long a running subagent may show no progress before its parent is told. Default 10 min. */
  readonly thresholdMs?: number;
}

/**
 * - `posted` and `skipped`: the episode is handled; nothing more is posted for it.
 * - `retry`: checked again at the next sweep, for what clears quickly, such as a parent's
 *   foreground call ending or a probe that failed.
 * - `later`: checked again no sooner than one threshold later, after a read or the post failed,
 *   or while storage shows the session busy.
 */
type Checked = "posted" | "skipped" | "retry" | "later";

/**
 * A session silent past the threshold. `carried` when it is followed across a gap with no event
 * from it since; `afterGap` when its silence was watched from a point after a gap rather than from
 * a progress event, so no event identifies it.
 */
interface Due {
  readonly sessionID: SessionID;
  readonly since: number;
  readonly carried: boolean;
  readonly afterGap: boolean;
}

/** Per-session state kept for one silent episode, identified by when its silence began. */
interface EpisodeMark {
  readonly since: number;
}

interface Deferred extends EpisodeMark {
  /** The episode is not checked again before this time. */
  readonly until: number;
}


export class StallNotices {
  private readonly deps: StallNoticeDeps;
  private readonly thresholdMs: number;
  private readonly sweepMs: number;
  private readonly calls = new ForegroundCalls();
  /** Silent episodes already handled, by session: when the episode's silence began. */
  private readonly handled = new Map<SessionID, number>();
  /** Episodes put off for a threshold, by session. */
  private readonly deferred = new Map<SessionID, Deferred>();
  /** Episodes whose failed check was logged, by session, so each is logged once. */
  private readonly failureLogged = new Map<SessionID, EpisodeMark>();
  /** IDs this instance posted, oldest first. */
  private readonly posted = new Set<string>();
  /**
   * By session, the stored part of the ID this instance last posted with: the ID input without
   * the last progress event. After a gap the event is unknown, so the stored part alone tells
   * whether this instance already posted for the silence.
   */
  private readonly postedStored = new Map<SessionID, string>();
  /**
   * When this instance saw an answer to a prompt of a session whose first event after a gap
   * opened it, with no progress since. Such a session's silence is watched from the answer.
   */
  private readonly answeredAt = new Map<SessionID, number>();
  /** When the latest gap in the event stream ended, from which carried sessions are watched. */
  private watchingSince: number | undefined;
  private cancelSweep: (() => void) | undefined;
  private sweeping = false;
  private disposed = false;

  constructor(deps: StallNoticeDeps, options: StallNoticeOptions = {}) {
    this.deps = deps;
    this.thresholdMs = options.thresholdMs ?? DEFAULT_STALL_NOTICE_MS;
    this.sweepMs = Math.min(
      MAX_SWEEP_MS,
      Math.max(MIN_SWEEP_MS, Math.floor(this.thresholdMs / 10)),
    );
  }

  /** Starts the sweeps. One timer covers every session, and it never keeps the process alive. */
  start(): void {
    if (this.disposed || this.cancelSweep !== undefined) return;
    this.schedule();
  }

  /**
   * Follows the parents' foreground calls on their subagents, and answers to prompts of sessions
   * followed again after a gap. Runs after activity tracking has seen the event. Never throws.
   */
  onEvent(event: OpenCodeEvent): void {
    if (this.disposed) return;
    try {
      this.calls.onEvent(event);
      switch (event.type) {
        case "permission.replied":
        case "form.replied":
        case "form.cancelled":
          // The answer's own time is the server's; the silence is watched from when this instance
          // saw it, like the watch that starts when a gap ends.
          if (this.deps.activity.resumedAfterGap(event.data.sessionID)) {
            this.answeredAt.set(event.data.sessionID, this.deps.clock.now());
          }
          return;
        default:
          return;
      }
    } catch (error) {
      this.deps.logger.warn("stall notices: event handler failed", {
        type: event.type,
        error: errorMessage(error),
      });
    }
  }

  /**
   * Call when events may have been missed: a call's end may have been. The sessions carried across
   * the gap are watched from now. The event loop calls this before it waits to subscribe again,
   * which can start the watch up to that wait early, at most 30 s.
   */
  reset(): void {
    this.calls.clear();
    this.answeredAt.clear();
    this.watchingSince = this.deps.clock.now();
  }

  dispose(): void {
    this.disposed = true;
    this.cancelSweep?.();
    this.cancelSweep = undefined;
    this.handled.clear();
    this.deferred.clear();
    this.failureLogged.clear();
    this.postedStored.clear();
    this.answeredAt.clear();
  }

  private schedule(): void {
    this.cancelSweep = this.deps.scheduler.schedule(this.sweepMs, () => {
      void this.sweep();
    });
  }

  /** Checks every session silent past the threshold, one at a time. Never rejects. */
  private async sweep(): Promise<void> {
    if (this.disposed) return;
    if (!this.sweeping) {
      this.sweeping = true;
      try {
        for (const due of this.due()) {
          if (this.disposed) return;
          const checked = await this.check(due);
          if (checked === "later") {
            this.deferred.set(due.sessionID, {
              since: due.since,
              until: this.deps.clock.now() + this.thresholdMs,
            });
          } else if (checked !== "retry") {
            this.handled.set(due.sessionID, due.since);
          }
        }
      } catch (error) {
        this.deps.logger.warn("stall notices: sweep failed", {
          error: errorMessage(error),
        });
      } finally {
        this.sweeping = false;
      }
    }
    if (!this.disposed) this.schedule();
  }

  /**
   * Sessions whose silence reached the threshold in an episode not yet handled or put off. A
   * session followed since its last progress is silent from that progress. One carried across a
   * gap is silent at least from when the gap ended, the most this instance can tell, and one whose
   * first event after the gap opened a prompt is silent from the answer.
   */
  private due(): Due[] {
    const now = this.deps.clock.now();
    const due: Due[] = [];
    const followed = new Set<SessionID>();
    const pending = (sessionID: SessionID, since: number): boolean => {
      if (this.handled.get(sessionID) === since) return false;
      if (now - since < this.thresholdMs) return false;
      const deferred = this.deferred.get(sessionID);
      return deferred?.since !== since || now >= deferred.until;
    };
    for (const [sessionID, activity] of this.deps.activity.all()) {
      followed.add(sessionID);
      const progressed = silentSince(activity);
      const since = progressed ?? this.answeredAt.get(sessionID);
      if (since === undefined || !pending(sessionID, since)) continue;
      if (!activity.unended && !quietPhase(activity, now)) continue;
      due.push({
        sessionID,
        since,
        carried: false,
        afterGap: progressed === undefined,
      });
    }
    const since = this.watchingSince;
    for (const [sessionID, carried] of this.deps.activity.carriedSessions()) {
      followed.add(sessionID);
      if (since === undefined || carried.questionOpen) continue;
      if (!pending(sessionID, since)) continue;
      due.push({ sessionID, since, carried: true, afterGap: true });
    }
    for (const map of [
      this.handled,
      this.deferred,
      this.failureLogged,
      this.postedStored,
      this.answeredAt,
    ]) {
      for (const sessionID of map.keys()) {
        if (!followed.has(sessionID)) map.delete(sessionID);
      }
    }
    return due;
  }

  /**
   * Posts the notice when the session still qualifies. Every read before the post, and the post
   * itself, can fail for a moment, so a failure puts the episode off for a threshold instead of
   * dropping it, and is logged once per episode.
   */
  private async check(due: Due): Promise<Checked> {
    try {
      return await this.checkOrThrow(due);
    } catch (error) {
      const logged = this.failureLogged.get(due.sessionID);
      if (logged?.since !== due.since) {
        this.failureLogged.set(due.sessionID, { since: due.since });
        this.deps.logger.warn(
          "stall notices: could not check a subagent; trying again later",
          {
            sessionID: due.sessionID,
            error: errorMessage(error),
          },
        );
      }
      return "later";
    }
  }

  /**
   * `check` without the failure handling. `retry` leaves the episode for the next sweep: the
   * parent is blocked on it, the probe failed, or the session moved on while it was checked.
   */
  private async checkOrThrow(due: Due): Promise<Checked> {
    const { sessionID, since } = due;
    const child = await this.deps.reader.get(sessionID);
    if (child?.parentID === undefined) return "skipped";
    const parentID = child.parentID;
    if (this.calls.blocking(child.id, parentID) !== undefined) return "retry";
    const observed = await this.deps.runState.confirm(sessionID, child);
    if (observed.state === "unknown") return "retry";
    if (observed.state === "idle" && observed.noRecordedEnd !== true) {
      return "skipped";
    }
    const kind: StallKind =
      observed.state === "idle" ? "no-recorded-end" : "no-progress";
    if (!this.stillSilent(due, kind)) return "retry";
    const latch = this.deps.latch;
    if (latch !== undefined) {
      const [childStopped, parentStopped] = await Promise.all([
        latch.isActive(sessionID),
        latch.isActive(parentID),
      ]);
      if (childStopped || parentStopped) return "skipped";
    }
    const [parent, messages] = await Promise.all([
      this.deps.reader.get(parentID),
      this.deps.reader.context(sessionID),
    ]);
    if (parent === undefined) return "skipped";
    // Live activity shows no tool call, prompt or retry, but that holds only when the instance
    // followed every one of them. Otherwise storage decides, as after a gap: a tool call that
    // survived it, or a prompt answered after it, leaves the live view of the session incomplete.
    if (
      kind === "no-progress" &&
      (due.carried ||
        !this.deps.activity.knowsEverythingRunning(sessionID)) &&
      (await this.busyAsStored(sessionID, since, messages))
    ) {
      return "later";
    }
    // After a gap the silence's last progress may have come during the gap, so this instance has
    // no event that identifies it, and its ID can differ from that of an instance with no gap.
    const input = stallNoticeIDInput(
      kind,
      child,
      messages,
      due.afterGap ? undefined : this.deps.activity.lastProgressEventID(sessionID),
    );
    const id = idFromInput(input);
    const stored = storedPart(input);
    if (this.posted.has(id)) return "skipped";
    // Without the event, an unchanged stored part is taken to mean this instance already posted for
    // this silence, before the gap. A subagent that only streamed during the gap and stored nothing
    // new then gets no notice for a new silence: after a gap, missing a repeated notice is
    // preferred over posting one twice. Instances that had no gap still post it.
    if (due.afterGap && this.postedStored.get(sessionID) === stored) {
      return "skipped";
    }
    // The reads above took a while; the session or its parent may have moved on meanwhile.
    if (
      !this.stillSilent(due, kind) ||
      this.calls.blocking(child.id, parentID) !== undefined
    ) {
      return "retry";
    }
    if (this.disposed) return "skipped";
    // Every attempt posts the same ID, so a send retried after a failure adds no second message.
    await this.deps.messenger.synthetic({
      sessionID: parentID,
      id,
      text: renderStallNotice({
        sessionID,
        ...(child.agent === undefined ? {} : { agent: child.agent }),
        ...(child.title === undefined ? {} : { title: child.title }),
        silentMs: Math.max(0, this.deps.clock.now() - since),
        kind,
      }),
      description: STALL_NOTICE_DESCRIPTION,
      metadata: {
        plugin: PLUGIN_ID,
        kind: STALL_NOTICE_KIND,
        stall: kind,
        sessionID,
      },
      delivery: "steer",
      resume: true,
    });
    this.remember(id);
    this.postedStored.set(sessionID, stored);
    this.deps.logger.info(
      "stall notices: told a parent its subagent appears stalled",
      { sessionID, parentID, stall: kind },
    );
    return "posted";
  }

  /**
   * The session still shows the same silence and, unless it is not running, waits on nothing. A
   * carried session qualifies while no event came from it and no newer gap began.
   */
  private stillSilent(due: Due, kind: StallKind): boolean {
    if (due.carried) {
      return (
        this.deps.activity.isCarried(due.sessionID) &&
        this.watchingSince === due.since
      );
    }
    const activity = this.deps.activity.get(due.sessionID);
    if (activity === undefined) return false;
    const since = silentSince(activity) ?? this.answeredAt.get(due.sessionID);
    if (since !== due.since) return false;
    if (kind === "no-recorded-end") return activity.unended;
    return quietPhase(activity, this.deps.clock.now());
  }

  /**
   * For a session whose tool calls, prompts and retries the instance did not all follow: whether
   * storage shows it busy, with a tool call still running, a permission prompt open, or a retry of
   * a failed model request due less than the threshold ago. Storage shows no questions.
   */
  private async busyAsStored(
    sessionID: SessionID,
    since: number,
    messages: readonly SessionMessageInfo[],
  ): Promise<boolean> {
    if (activeToolTimes(messages).length > 0) return true;
    const retryAt = sinceCompaction(messages).assistants.at(-1)?.retry?.at;
    if (
      retryAt !== undefined &&
      retryAt > since &&
      this.deps.clock.now() - retryAt < this.thresholdMs
    ) {
      return true;
    }
    return (await this.deps.reader.pendingPermissions(sessionID)).length > 0;
  }

  private remember(id: string): void {
    this.posted.add(id);
    while (this.posted.size > POSTED_LIMIT) {
      const oldest = this.posted.values().next();
      if (oldest.done === true) return;
      this.posted.delete(oldest.value);
    }
  }
}

/** No tool call, prompt or retry delay accounts for the silence. */
function quietPhase(activity: SessionActivity, now: number): boolean {
  const phase = activityPhase(activity, now);
  return phase === "model" || phase === "between";
}

/**
 * The notice's inbox item ID: the same in every instance for one silent episode, whatever its
 * threshold. It hashes `stallNoticeIDInput`.
 */
export function stallNoticeID(
  kind: StallKind,
  info: SessionInfo,
  messages: readonly SessionMessageInfo[],
  lastProgressEventID?: string,
): string {
  return idFromInput(
    stallNoticeIDInput(kind, info, messages, lastProgressEventID),
  );
}

type StallNoticeIDInput = readonly (string | number | null)[];

function idFromInput(input: StallNoticeIDInput): string {
  const digest = createHash("sha256")
    .update(JSON.stringify(input))
    .digest("hex");
  return `msg_${PLUGIN_ID}_${digest}`;
}

/**
 * The part of the ID input that comes from the kind and stored data: everything but the last
 * progress event, which is the input's last element.
 */
function storedPart(input: StallNoticeIDInput): string {
  return JSON.stringify(input.slice(0, -1));
}

/**
 * What identifies a silent episode: the ID kind, the session, the execution (its stored start
 * where the host records one, else the latest assistant message), the last stored progress (the
 * latest assistant message, its part count, and its last part's completion or start time), and
 * the event that showed the last progress, or null when the instance did not see it. Streamed
 * output is never stored, so only the event tells two stretches apart that only streaming came
 * between. Every instance receives that event with the same ID.
 */
export function stallNoticeIDInput(
  kind: StallKind,
  info: SessionInfo,
  messages: readonly SessionMessageInfo[],
  lastProgressEventID?: string,
): StallNoticeIDInput {
  const latest = sinceCompaction(messages).assistants.at(-1);
  const parts = latest?.content ?? [];
  const last = parts.at(-1);
  return [
    ID_KINDS[kind],
    info.id,
    busySince(info) ?? latest?.id ?? null,
    latest?.id ?? null,
    parts.length,
    last === undefined ? null : partTime(last),
    lastProgressEventID ?? null,
  ];
}

type AssistantPart = Extract<
  SessionMessageInfo,
  { type: "assistant" }
>["content"][number];

function partTime(part: AssistantPart): number | null {
  switch (part.type) {
    case "tool":
      return part.time.completed ?? part.time.ran ?? part.time.created;
    case "reasoning":
      return part.time?.completed ?? part.time?.created ?? null;
    default:
      return null;
  }
}

export interface StallNotice {
  /** The stalled subagent. */
  readonly sessionID: SessionID;
  readonly agent?: string;
  readonly title?: string;
  /** How long it has shown no progress. */
  readonly silentMs: number;
  readonly kind: StallKind;
}

/** The text the parent reads. Every quoted value is escaped and capped. */
export function renderStallNotice(notice: StallNotice): string {
  const idAttribute = sanitizeText(notice.sessionID, ID_MAX, "attribute").text;
  const who = describeSubagent(notice);
  const silence = formatDuration(notice.silentMs);
  const body =
    notice.kind === "no-progress"
      ? `${who} appears stalled: it is running but has shown no progress for ${silence}, with no tool call running and no prompt open. Look at it with subagents.inspect, or stop it with subagent_stop and continue it with subagent. Nothing was interrupted; it keeps running until you act.`
      : `${who} appears stalled: it has shown no progress for ${silence}, and OpenCode reports it idle, but its last run recorded no end. It is not running, so messages sent to it are not read until it is continued: call subagent with its sessionID. Nothing was changed.`;
  return `<subagent-stalled sessionID="${idAttribute}" kind="${notice.kind}">${body}</subagent-stalled>`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
