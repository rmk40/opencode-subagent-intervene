// What each session is doing right now, from the events it produces itself: when its current
// execution and model response started, when it last made progress, and which tool calls, prompts
// and retry delays it is in. Only events this instance observed count, so every time here was seen
// and nothing is filled in: a value the instance did not observe, after it loaded or across a gap
// in the event stream, is absent. Streaming events are never stored, so storage cannot fill these
// in either.
//
// Progress is an execution or step event, streamed text, reasoning or tool input, and tool
// progress, success or failure. A message arriving in the session's inbox, a read of the session
// and a metadata change are not progress, so none of them is followed here.

import type { OpenCodeEvent, SessionID, SessionInfo } from "@/core/ports";

/** Sessions followed at once; the least recently started are dropped beyond it. */
export const MAX_TRACKED_SESSIONS = 5000;
/** The owner core gives forms that belong to no session. */
const GLOBAL_FORM_OWNER = "global";

/**
 * `prompt`: waiting on a permission prompt or a question. `tool`: running or streaming a tool
 * call. `retry`: waiting out a scheduled retry of a failed model request. `model`: a model
 * response is streaming. `between`: none of these, such as between two steps.
 */
export type ActivityPhase = "prompt" | "tool" | "retry" | "model" | "between";

export interface LiveTool {
  /** Absent when the instance did not see the call's input start. */
  readonly name?: string;
  /** When the call's input started streaming; absent when not seen. */
  readonly inputStartedAt?: number;
  /** When the call started running; absent until then or when not seen. */
  readonly ranAt?: number;
}

export interface SessionActivity {
  /** When the current execution started; absent when the instance did not see it start. */
  readonly executionStartedAt?: number;
  /** When the latest model response started; absent when not seen. */
  readonly responseStartedAt?: number;
  /** A model response is streaming: between its start and the end of its stream. */
  readonly responding: boolean;
  /** When the session last made progress, as the event's creation time. */
  readonly lastProgressAt?: number;
  /** Tool calls streaming or running, by `assistantMessageID/callID`. */
  readonly tools: ReadonlyMap<string, LiveTool>;
  /** Open permission prompts and questions. */
  readonly openPrompts: number;
  /** When a scheduled retry of a failed model request is due. */
  readonly retryAt?: number;
  /**
   * OpenCode reports the session idle, but no end of the execution was observed: its last run
   * recorded no end. Kept until the next execution starts or the session makes progress again.
   */
  readonly unended: boolean;
}

/**
 * A session the instance saw in an execution before a gap in the event stream and has seen no
 * event from since. Whether it still runs, and what it did during the gap, is unknown.
 */
export interface CarriedSession {
  /**
   * A question was open before the gap. Its answer may have come during the gap, but no later
   * event says so, and questions cannot be read from storage.
   */
  readonly questionOpen: boolean;
}

/**
 * Identifies the executions seen to start in a session up to some moment. When it is unchanged
 * after a probe, no execution started during the probe.
 */
export interface ExecutionMark {
  readonly epoch: number;
  readonly starts: number;
}

interface MutableActivity {
  executionStartedAt?: number;
  responseStartedAt?: number;
  responding: boolean;
  lastProgressAt?: number;
  lastProgressEventID?: string;
  readonly tools: Map<string, LiveTool>;
  readonly prompts: Set<string>;
  retryAt?: number;
  unended: boolean;
  /** The entry was made by the session's first event after a gap that carried it. */
  readonly afterGap: boolean;
  /**
   * `tools`, `prompts` and `retryAt` hold everything the session is doing: the instance saw its
   * execution start, or a step boundary since it began following the session. A tool event alone
   * doesn't count, because a parallel call that started before the instance followed the session
   * can still be running.
   */
  complete: boolean;
}

interface ExecutionRecord {
  starts: number;
  /** The latest execution event seen was a terminal one. */
  ended: boolean;
}

export class ActivityTracker {
  /** Sessions in an execution, by session ID, oldest start first. */
  private readonly sessions = new Map<SessionID, MutableActivity>();
  /** Execution starts and ends seen per session; kept after the execution ends. */
  private readonly executions = new Map<SessionID, ExecutionRecord>();
  /** Sessions in an execution before a gap, until their next event; oldest first. */
  private readonly carried = new Map<SessionID, CarriedSession>();
  /** Counts resets, so a mark taken before a gap never matches one after it. */
  private epoch = 0;

  /** Records one event. Cheap enough to run for every streaming event. Never throws. */
  onEvent(event: OpenCodeEvent): void {
    switch (event.type) {
      case "session.execution.started": {
        const sessionID = event.data.sessionID;
        const record = this.executions.get(sessionID);
        this.executions.delete(sessionID);
        this.executions.set(sessionID, {
          starts: (record?.starts ?? 0) + 1,
          ended: false,
        });
        this.bound(this.executions);
        this.carried.delete(sessionID);
        this.sessions.delete(sessionID);
        this.sessions.set(sessionID, {
          executionStartedAt: event.created,
          responding: false,
          lastProgressAt: event.created,
          lastProgressEventID: event.id,
          tools: new Map(),
          prompts: new Set(),
          unended: false,
          afterGap: false,
          complete: true,
        });
        this.bound(this.sessions);
        return;
      }
      case "session.execution.succeeded":
      case "session.execution.failed":
      case "session.execution.interrupted": {
        const record = this.executions.get(event.data.sessionID);
        if (record === undefined) {
          this.executions.set(event.data.sessionID, { starts: 0, ended: true });
          this.bound(this.executions);
        } else {
          record.ended = true;
        }
        this.sessions.delete(event.data.sessionID);
        this.carried.delete(event.data.sessionID);
        return;
      }
      case "session.deleted":
        this.sessions.delete(event.data.sessionID);
        this.executions.delete(event.data.sessionID);
        this.carried.delete(event.data.sessionID);
        return;
      case "session.step.started": {
        // A new step begins once every tool call and prompt of the previous one has settled.
        const entry = this.progress(event.data.sessionID, event, true);
        entry.responseStartedAt = event.data.started;
        entry.responding = true;
        entry.retryAt = undefined;
        return;
      }
      case "session.step.streamed":
        this.progress(event.data.sessionID, event).responding = false;
        return;
      case "session.step.ended":
      case "session.step.failed": {
        const entry = this.progress(event.data.sessionID, event, true);
        entry.responding = false;
        // A step ends after its tool calls settle, so any call of the step still listed is over.
        const prefix = `${event.data.assistantMessageID}/`;
        for (const key of entry.tools.keys()) {
          if (key.startsWith(prefix)) entry.tools.delete(key);
        }
        return;
      }
      case "session.text.started":
      case "session.text.delta":
      case "session.text.ended":
      case "session.reasoning.started":
      case "session.reasoning.delta":
      case "session.reasoning.ended":
        this.progress(event.data.sessionID, event);
        return;
      case "session.tool.input.started": {
        const entry = this.progress(event.data.sessionID, event);
        entry.tools.set(toolKey(event.data.assistantMessageID, event.data.id), {
          name: event.data.name,
          inputStartedAt: event.created,
        });
        return;
      }
      case "session.tool.input.delta":
      case "session.tool.input.ended":
      case "session.tool.progress": {
        const entry = this.progress(event.data.sessionID, event);
        const key = toolKey(event.data.assistantMessageID, event.data.id);
        if (!entry.tools.has(key)) entry.tools.set(key, {});
        return;
      }
      case "session.tool.called": {
        const entry = this.progress(event.data.sessionID, event);
        const key = toolKey(event.data.assistantMessageID, event.data.id);
        entry.tools.set(key, { ...entry.tools.get(key), ranAt: event.created });
        return;
      }
      case "session.tool.success":
      case "session.tool.failed":
        this.progress(event.data.sessionID, event).tools.delete(
          toolKey(event.data.assistantMessageID, event.data.id),
        );
        return;
      case "session.retry.scheduled": {
        // A retry delay is not progress, but the silence after it is counted from when it is due.
        const entry = this.entry(event.data.sessionID);
        entry.retryAt = event.data.at;
        entry.responding = false;
        return;
      }
      case "permission.asked":
        this.entry(event.data.sessionID).prompts.add(
          promptKey("permission", event.data.id),
        );
        return;
      case "permission.replied":
        return this.answered(
          event.data.sessionID,
          promptKey("permission", event.data.requestID),
        );
      case "form.created": {
        const form = event.data.form;
        if (form.sessionID === GLOBAL_FORM_OWNER) return;
        this.entry(form.sessionID).prompts.add(promptKey("question", form.id));
        return;
      }
      case "form.replied":
      case "form.cancelled":
        return this.answered(
          event.data.sessionID,
          promptKey("question", event.data.id),
        );
      default:
        return;
    }
  }

  /**
   * Forgets every session's activity. Call when events may have been missed: a missed end or start
   * would leave an entry describing a run that is over, or a time that is not the latest. Sessions
   * that were in an execution are carried, with nothing known about them, until their next event.
   */
  reset(): void {
    for (const [sessionID, entry] of this.sessions) {
      const before = this.carried.get(sessionID)?.questionOpen === true;
      this.carried.delete(sessionID);
      this.carried.set(sessionID, {
        questionOpen:
          before ||
          [...entry.prompts].some((key) => key.startsWith("question/")),
      });
    }
    this.bound(this.carried);
    this.sessions.clear();
    this.executions.clear();
    this.epoch++;
  }

  /**
   * Sessions the instance saw in an execution before a gap in the event stream, with no event from
   * them since. They have no live activity: `get` and `inExecution` do not report them.
   */
  *carriedSessions(): IterableIterator<readonly [SessionID, CarriedSession]> {
    for (const [sessionID, carried] of this.carried) {
      yield [sessionID, carried];
    }
  }

  /** Whether the session is carried across a gap with no event from it since. */
  isCarried(sessionID: SessionID): boolean {
    return this.carried.has(sessionID);
  }

  /**
   * Whether the session's live entry was made by its first event after a gap that carried it, and
   * the session has shown no progress since. Its silence has no start the instance saw.
   */
  resumedAfterGap(sessionID: SessionID): boolean {
    const entry = this.sessions.get(sessionID);
    return entry?.afterGap === true && entry.lastProgressAt === undefined;
  }

  /**
   * Whether the session's live tool calls, prompts and retry delay are all known: the instance saw
   * its execution start, or a step boundary since it began following it. False for a session
   * carried across a gap, and for one first seen in the middle of its execution, such as after a
   * gap or after the plugin loaded, until then.
   */
  knowsEverythingRunning(sessionID: SessionID): boolean {
    return this.sessions.get(sessionID)?.complete === true;
  }

  /**
   * The ID of the event that showed the session's last progress, as the subscription delivered
   * it. Every plugin instance receives the same event with the same ID. Undefined when the
   * instance has seen no progress from the session since loading or since the last gap.
   */
  lastProgressEventID(sessionID: SessionID): string | undefined {
    return this.sessions.get(sessionID)?.lastProgressEventID;
  }

  /** The session's live activity, when the instance has seen it in an execution since loading. */
  get(sessionID: SessionID): SessionActivity | undefined {
    const entry = this.sessions.get(sessionID);
    return entry === undefined ? undefined : view(entry);
  }

  /** Every followed session's activity. */
  *all(): IterableIterator<readonly [SessionID, SessionActivity]> {
    for (const [sessionID, entry] of this.sessions) {
      yield [sessionID, view(entry)];
    }
  }

  /** Whether the instance saw the session in an execution that has not been seen to end. */
  inExecution(sessionID: SessionID): boolean {
    const entry = this.sessions.get(sessionID);
    return entry !== undefined && !entry.unended;
  }

  /** Whether the latest execution event seen for the session was its end. */
  ended(sessionID: SessionID): boolean {
    return this.executions.get(sessionID)?.ended === true;
  }

  mark(sessionID: SessionID): ExecutionMark {
    return {
      epoch: this.epoch,
      starts: this.executions.get(sessionID)?.starts ?? 0,
    };
  }

  sameMark(sessionID: SessionID, mark: ExecutionMark): boolean {
    const now = this.mark(sessionID);
    return now.epoch === mark.epoch && now.starts === mark.starts;
  }

  /**
   * Records that OpenCode reported the session idle with no end of its execution observed, unless
   * an execution started since `mark`. What it was doing is over, so only its last progress is kept.
   * True if recorded.
   */
  markUnended(sessionID: SessionID, mark: ExecutionMark): boolean {
    if (!this.sameMark(sessionID, mark)) return false;
    const entry = this.sessions.get(sessionID);
    if (entry === undefined) return false;
    entry.unended = true;
    entry.responding = false;
    entry.retryAt = undefined;
    entry.tools.clear();
    entry.prompts.clear();
    return true;
  }

  /**
   * The session's entry, created without any progress when it has none. A carried session's first
   * event after a gap makes it live again.
   */
  private entry(sessionID: SessionID): MutableActivity {
    const existing = this.sessions.get(sessionID);
    if (existing !== undefined) return existing;
    const afterGap = this.carried.delete(sessionID);
    const created: MutableActivity = {
      responding: false,
      tools: new Map(),
      prompts: new Set(),
      unended: false,
      afterGap,
      complete: false,
    };
    this.sessions.set(sessionID, created);
    this.bound(this.sessions);
    return created;
  }

  /**
   * Closes a prompt. An answer is not progress, but it is an event from the session, so it ends
   * the session's carry across a gap like any other event.
   */
  private answered(sessionID: SessionID, key: string): void {
    const entry = this.carried.has(sessionID)
      ? this.entry(sessionID)
      : this.sessions.get(sessionID);
    entry?.prompts.delete(key);
  }

  /** Records progress, which also shows that a session marked as having no recorded end runs. */
  private progress(
    sessionID: SessionID,
    event: { readonly id: string; readonly created: number },
    completes = false,
  ): MutableActivity {
    const entry = this.entry(sessionID);
    if (entry.lastProgressAt === undefined || event.created >= entry.lastProgressAt) {
      entry.lastProgressAt = event.created;
      entry.lastProgressEventID = event.id;
    }
    entry.unended = false;
    if (completes) entry.complete = true;
    return entry;
  }

  private bound(map: Map<SessionID, unknown>): void {
    while (map.size > MAX_TRACKED_SESSIONS) {
      const oldest = map.keys().next();
      if (oldest.done === true) return;
      map.delete(oldest.value);
    }
  }
}

/** The phase a session's activity is in at `now`. */
export function activityPhase(
  activity: SessionActivity,
  now: number,
): ActivityPhase {
  if (activity.openPrompts > 0) return "prompt";
  if (activity.tools.size > 0) return "tool";
  if (activity.retryAt !== undefined && now < activity.retryAt) return "retry";
  if (activity.responding) return "model";
  return "between";
}

/**
 * Since when the session has made no progress: its last progress, or when a retry delay that came
 * after it ended. Undefined when no progress was seen.
 */
export function silentSince(activity: SessionActivity): number | undefined {
  if (activity.lastProgressAt === undefined) return undefined;
  return Math.max(activity.lastProgressAt, activity.retryAt ?? 0);
}

/**
 * `time.busy`, the start of the session's latest execution as stored. Hosts before OpenCode 2.2.2
 * do not record it, and it is absent from their types, so it is read defensively.
 */
export function busySince(info: SessionInfo): number | undefined {
  const time: { readonly [key: string]: unknown } = info.time;
  const busy = time["busy"];
  return typeof busy === "number" && Number.isFinite(busy) ? busy : undefined;
}

/**
 * Whether storage records the latest execution as still open: a start later than the latest end.
 * Undefined on hosts that do not record starts. A lost end leaves this true as well, so it is the
 * recorded state, not a reading of whether the session runs.
 */
export function recordsOpenRun(info: SessionInfo): boolean | undefined {
  const busy = busySince(info);
  if (busy === undefined) return undefined;
  return info.time.idle === undefined || busy > info.time.idle;
}

/**
 * When the session went idle, from `time.idle`, only when no later start is recorded. Undefined
 * when its last run recorded no end, since its end time is then unknown.
 */
export function idleSince(
  info: SessionInfo,
  noRecordedEnd: boolean,
): number | undefined {
  if (noRecordedEnd) return undefined;
  const idle = info.time.idle;
  if (idle === undefined) return undefined;
  const busy = busySince(info);
  return busy !== undefined && idle < busy ? undefined : idle;
}

function view(entry: MutableActivity): SessionActivity {
  return {
    ...(entry.executionStartedAt === undefined
      ? {}
      : { executionStartedAt: entry.executionStartedAt }),
    ...(entry.responseStartedAt === undefined
      ? {}
      : { responseStartedAt: entry.responseStartedAt }),
    responding: entry.responding,
    ...(entry.lastProgressAt === undefined
      ? {}
      : { lastProgressAt: entry.lastProgressAt }),
    tools: new Map(entry.tools),
    openPrompts: entry.prompts.size,
    ...(entry.retryAt === undefined ? {} : { retryAt: entry.retryAt }),
    unended: entry.unended,
  };
}

function toolKey(assistantMessageID: string, callID: string): string {
  return `${assistantMessageID}/${callID}`;
}

function promptKey(kind: "permission" | "question", requestID: string): string {
  return `${kind}/${requestID}`;
}
