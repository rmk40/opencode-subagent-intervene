import { describe, expect, test } from "bun:test";
import {
  ActivityTracker,
  activityPhase,
  busySince,
  idleSince,
  recordsOpenRun,
  silentSince,
} from "@/core/activity";
import type { OpenCodeEvent, SessionInfo } from "@/core/ports";
import {
  reasoningDelta,
  reasoningEnded,
  reasoningStarted,
  retryScheduled,
  stepEnded,
  stepFailed,
  stepStarted,
  stepStreamed,
  textDelta,
  textEnded,
  textStarted,
  toolCalled,
  toolFinished,
  toolInputDelta,
  toolInputEnded,
  toolInputStarted,
  toolProgressed,
} from "./activity-fixtures";
import {
  executionEnded,
  executionStarted,
  formCancelled,
  formCreated,
  formReplied,
  inboxEnqueued,
  permissionAsked,
  permissionReplied,
  sessionDeleted,
  sessionInfo,
  type TerminalEventType,
} from "./fixtures";

const S = "ses_child";
const START = 1_000_000;
const LATER = START + 5_000;

const TERMINAL: readonly TerminalEventType[] = [
  "session.execution.succeeded",
  "session.execution.failed",
  "session.execution.interrupted",
];

/** A tracker that saw `S` start its execution at `START`. */
function started(): ActivityTracker {
  const tracker = new ActivityTracker();
  tracker.onEvent(executionStarted(S, START));
  return tracker;
}

/** `info` with a stored execution start, as hosts from OpenCode 2.2.2 record it. */
function withTimes(
  busy: number | undefined,
  idle: number | undefined,
): SessionInfo {
  const base = sessionInfo(S, "ses_parent");
  const time: SessionInfo["time"] & { busy?: number } = {
    ...base.time,
    ...(busy === undefined ? {} : { busy }),
    ...(idle === undefined ? {} : { idle }),
  };
  return { ...base, time };
}

describe("progress", () => {
  const PROGRESS: ReadonlyArray<readonly [string, (at: number) => OpenCodeEvent]> =
    [
      ["a step starting", (at) => stepStarted(S, at)],
      ["a step's stream ending", (at) => stepStreamed(S, at)],
      ["a step ending", (at) => stepEnded(S, at)],
      ["a step failing", (at) => stepFailed(S, at)],
      ["text starting", (at) => textStarted(S, at)],
      ["streamed text", (at) => textDelta(S, at)],
      ["text ending", (at) => textEnded(S, at)],
      ["reasoning starting", (at) => reasoningStarted(S, at)],
      ["streamed reasoning", (at) => reasoningDelta(S, at)],
      ["reasoning ending", (at) => reasoningEnded(S, at)],
      ["tool input starting", (at) => toolInputStarted(S, "call_1", at)],
      ["streamed tool input", (at) => toolInputDelta(S, "call_1", at)],
      ["tool input ending", (at) => toolInputEnded(S, "call_1", at)],
      ["a tool call starting to run", (at) => toolCalled(S, "call_1", at)],
      ["tool progress", (at) => toolProgressed(S, "call_1", at)],
      [
        "a tool call succeeding",
        (at) => toolFinished("session.tool.success", S, "call_1", at),
      ],
      [
        "a tool call failing",
        (at) => toolFinished("session.tool.failed", S, "call_1", at),
      ],
    ];

  test("starts with the execution's start", () => {
    expect(started().get(S)?.lastProgressAt).toBe(START);
  });

  test.each(PROGRESS)("is recorded for %s, at the event's creation time", (_, make) => {
    const tracker = started();
    tracker.onEvent(make(LATER));
    expect(tracker.get(S)?.lastProgressAt).toBe(LATER);
  });

  test.each(PROGRESS)(
    "from %s is recorded for a session whose start this tracker did not see",
    (_, make) => {
      const tracker = new ActivityTracker();
      tracker.onEvent(make(LATER));
      expect(tracker.get(S)?.lastProgressAt).toBe(LATER);
      expect(tracker.get(S)?.executionStartedAt).toBeUndefined();
    },
  );

  test("never moves back for an event created earlier than one already seen", () => {
    const tracker = started();
    tracker.onEvent(textDelta(S, LATER));
    tracker.onEvent(textDelta(S, LATER - 1000));
    expect(tracker.get(S)?.lastProgressAt).toBe(LATER);
  });

  const NOT_PROGRESS: ReadonlyArray<
    readonly [string, (at: number) => OpenCodeEvent]
  > = [
    ["a parent's message arriving", (at) => inboxEnqueued(S, "synthetic", at)],
    ["a permission prompt opening", (at) => permissionAsked(S, "per_1", { created: at })],
    ["a question opening", (at) => formCreated(S, "frm_1", { created: at })],
    ["a retry being scheduled", (at) => retryScheduled(S, at, at + 60_000)],
  ];

  test.each(NOT_PROGRESS)("is not recorded for %s", (_, make) => {
    const tracker = started();
    tracker.onEvent(make(LATER));
    expect(tracker.get(S)?.lastProgressAt).toBe(START);
  });
});

describe("the phase", () => {
  test("is model while a response streams, and between once its stream ends", () => {
    const tracker = started();
    tracker.onEvent(stepStarted(S, LATER, { started: LATER - 10 }));
    const streaming = tracker.get(S);
    expect(streaming?.responseStartedAt).toBe(LATER - 10);
    expect(streaming && activityPhase(streaming, LATER)).toBe("model");
    tracker.onEvent(stepStreamed(S, LATER + 1));
    const after = tracker.get(S);
    expect(after && activityPhase(after, LATER + 1)).toBe("between");
  });

  test("is tool from a call's input starting until the call ends", () => {
    const tracker = started();
    tracker.onEvent(stepStarted(S, LATER));
    tracker.onEvent(toolInputStarted(S, "call_1", LATER + 1));
    const input = tracker.get(S);
    expect(input && activityPhase(input, LATER + 1)).toBe("tool");
    tracker.onEvent(toolCalled(S, "call_1", LATER + 2));
    tracker.onEvent(toolFinished("session.tool.success", S, "call_1", LATER + 3));
    const done = tracker.get(S);
    expect(done?.tools.size).toBe(0);
  });

  test("records a call's name and when its input started, then when it started running", () => {
    const tracker = started();
    tracker.onEvent(toolInputStarted(S, "call_1", LATER, { name: "shell" }));
    expect([...(tracker.get(S)?.tools.values() ?? [])]).toEqual([
      { name: "shell", inputStartedAt: LATER },
    ]);
    tracker.onEvent(toolCalled(S, "call_1", LATER + 100));
    expect([...(tracker.get(S)?.tools.values() ?? [])]).toEqual([
      { name: "shell", inputStartedAt: LATER, ranAt: LATER + 100 },
    ]);
  });

  test("forgets the calls of a step once the step ends, but not the calls of another message", () => {
    const tracker = started();
    tracker.onEvent(toolCalled(S, "call_1", LATER, "msg_a"));
    tracker.onEvent(toolCalled(S, "call_1", LATER + 5, "msg_b"));
    tracker.onEvent(stepEnded(S, LATER + 10, "msg_a"));
    expect([...(tracker.get(S)?.tools.values() ?? [])]).toEqual([
      { ranAt: LATER + 5 },
    ]);
  });

  test("is prompt while a permission prompt or a question is open, ahead of a running tool", () => {
    const tracker = started();
    tracker.onEvent(toolCalled(S, "call_1", LATER));
    tracker.onEvent(permissionAsked(S, "per_1"));
    tracker.onEvent(formCreated(S, "frm_1"));
    const open = tracker.get(S);
    expect(open && activityPhase(open, LATER)).toBe("prompt");
    tracker.onEvent(permissionReplied(S, "per_1"));
    const question = tracker.get(S);
    expect(question && activityPhase(question, LATER)).toBe("prompt");
    tracker.onEvent(formReplied(S, "frm_1"));
    const answered = tracker.get(S);
    expect(answered && activityPhase(answered, LATER)).toBe("tool");
  });

  test("leaves prompt once a question is cancelled", () => {
    const tracker = started();
    tracker.onEvent(formCreated(S, "frm_1"));
    tracker.onEvent(formCancelled(S, "frm_1"));
    expect(tracker.get(S)?.openPrompts).toBe(0);
  });

  test("ignores a question that belongs to no session", () => {
    const tracker = new ActivityTracker();
    tracker.onEvent(formCreated("global", "frm_1"));
    expect([...tracker.all()]).toEqual([]);
  });

  test("is retry until a scheduled retry is due, then between", () => {
    const tracker = started();
    tracker.onEvent(stepStarted(S, LATER));
    tracker.onEvent(retryScheduled(S, LATER + 1, LATER + 60_000));
    const waiting = tracker.get(S);
    expect(waiting && activityPhase(waiting, LATER + 59_999)).toBe("retry");
    expect(waiting && activityPhase(waiting, LATER + 60_000)).toBe("between");
  });

  test("leaves retry when the next step starts", () => {
    const tracker = started();
    tracker.onEvent(retryScheduled(S, LATER, LATER + 60_000));
    tracker.onEvent(stepStarted(S, LATER + 100));
    const resumed = tracker.get(S);
    expect(resumed && activityPhase(resumed, LATER + 100)).toBe("model");
  });
});

describe("silence", () => {
  test("counts from the last progress", () => {
    const tracker = started();
    tracker.onEvent(textDelta(S, LATER));
    const activity = tracker.get(S);
    expect(activity && silentSince(activity)).toBe(LATER);
  });

  test("counts from a scheduled retry's due time when that comes after the last progress", () => {
    const tracker = started();
    tracker.onEvent(retryScheduled(S, LATER, LATER + 60_000));
    const activity = tracker.get(S);
    expect(activity && silentSince(activity)).toBe(LATER + 60_000);
  });

  test("is unknown when no progress was seen", () => {
    const tracker = new ActivityTracker();
    tracker.onEvent(permissionAsked(S, "per_1"));
    const activity = tracker.get(S);
    expect(activity).toBeDefined();
    expect(activity && silentSince(activity)).toBeUndefined();
  });
});

describe("executions", () => {
  test("a new execution starts from nothing: no calls, prompts or retry, and a fresh start", () => {
    const tracker = started();
    tracker.onEvent(toolCalled(S, "call_1", LATER));
    tracker.onEvent(permissionAsked(S, "per_1"));
    tracker.onEvent(retryScheduled(S, LATER, LATER + 60_000));
    tracker.onEvent(executionStarted(S, LATER + 10));
    expect(tracker.get(S)).toEqual({
      executionStartedAt: LATER + 10,
      responding: false,
      lastProgressAt: LATER + 10,
      tools: new Map(),
      openPrompts: 0,
      unended: false,
    });
  });

  test.each(TERMINAL)("%s ends what the tracker follows and is remembered as the end", (type) => {
    const tracker = started();
    tracker.onEvent(executionEnded(type, S, LATER));
    expect(tracker.get(S)).toBeUndefined();
    expect(tracker.inExecution(S)).toBe(false);
    expect(tracker.ended(S)).toBe(true);
  });

  test("a deleted session is forgotten entirely", () => {
    const tracker = started();
    tracker.onEvent(executionEnded("session.execution.succeeded", S, LATER));
    tracker.onEvent(sessionDeleted(S));
    expect(tracker.ended(S)).toBe(false);
    expect(tracker.get(S)).toBeUndefined();
  });

  test("a mark changes when an execution starts and when the tracker resets", () => {
    const tracker = started();
    const mark = tracker.mark(S);
    expect(tracker.sameMark(S, mark)).toBe(true);
    tracker.onEvent(executionEnded("session.execution.succeeded", S, LATER));
    expect(tracker.sameMark(S, mark)).toBe(true);
    tracker.onEvent(executionStarted(S, LATER + 1));
    expect(tracker.sameMark(S, mark)).toBe(false);
    const again = tracker.mark(S);
    tracker.reset();
    expect(tracker.sameMark(S, again)).toBe(false);
  });

  test("reset forgets every session", () => {
    const tracker = started();
    tracker.reset();
    expect(tracker.get(S)).toBeUndefined();
    expect(tracker.inExecution(S)).toBe(false);
  });
});

describe("across a gap in the event stream", () => {
  test("a session in an execution is carried, with no live activity and not in an execution", () => {
    const tracker = started();
    tracker.onEvent(textDelta(S, LATER));
    tracker.reset();
    expect(tracker.isCarried(S)).toBe(true);
    expect(tracker.get(S)).toBeUndefined();
    expect([...tracker.all()]).toEqual([]);
    expect(tracker.inExecution(S)).toBe(false);
    expect(tracker.lastProgressEventID(S)).toBeUndefined();
  });

  test("a carried session remembers a question that was open, but not a permission prompt", () => {
    const tracker = new ActivityTracker();
    tracker.onEvent(executionStarted("ses_asking", START));
    tracker.onEvent(formCreated("ses_asking", "frm_1"));
    tracker.onEvent(executionStarted("ses_waiting", START));
    tracker.onEvent(permissionAsked("ses_waiting", "per_1"));
    tracker.reset();
    expect([...tracker.carriedSessions()]).toEqual([
      ["ses_asking", { questionOpen: true }],
      ["ses_waiting", { questionOpen: false }],
    ]);
  });

  test("a session whose run ended before the gap is not carried", () => {
    const tracker = started();
    tracker.onEvent(executionEnded("session.execution.succeeded", S, LATER));
    tracker.reset();
    expect(tracker.isCarried(S)).toBe(false);
    expect([...tracker.carriedSessions()]).toEqual([]);
  });

  const LIVE_AGAIN: ReadonlyArray<readonly [string, OpenCodeEvent]> = [
    ["streamed text", textDelta(S, LATER)],
    ["a tool call starting to run", toolCalled(S, "call_1", LATER)],
    ["a retry being scheduled", retryScheduled(S, LATER, LATER + 60_000)],
    ["a permission prompt opening", permissionAsked(S, "per_1")],
    ["a question opening", formCreated(S, "frm_1")],
    ["a new execution starting", executionStarted(S, LATER)],
  ];

  test.each(LIVE_AGAIN)("a carried session is followed live again from %s", (_, event) => {
    const tracker = started();
    tracker.reset();
    tracker.onEvent(event);
    expect(tracker.isCarried(S)).toBe(false);
    expect(tracker.get(S)).toBeDefined();
  });

  const REPLIES: ReadonlyArray<readonly [string, OpenCodeEvent]> = [
    ["an answer to a question", formReplied(S, "frm_1")],
    ["a question's cancellation", formCancelled(S, "frm_1")],
    ["an answer to a permission prompt", permissionReplied(S, "per_1")],
  ];

  test.each(REPLIES)(
    "a carried session is followed live again from %s, as resumed after the gap with no progress seen",
    (_, event) => {
      const tracker = started();
      tracker.onEvent(formCreated(S, "frm_1"));
      tracker.onEvent(permissionAsked(S, "per_1"));
      tracker.reset();
      tracker.onEvent(event);
      expect(tracker.isCarried(S)).toBe(false);
      expect(tracker.get(S)).toBeDefined();
      expect(tracker.resumedAfterGap(S)).toBe(true);
    },
  );

  const GONE: ReadonlyArray<readonly [string, OpenCodeEvent]> = [
    ...TERMINAL.map((type): [string, OpenCodeEvent] => [type, executionEnded(type, S, LATER)]),
    ["its deletion", sessionDeleted(S)],
  ];

  test.each(GONE)("a carried session stops being carried at %s, with nothing to follow", (_, event) => {
    const tracker = started();
    tracker.reset();
    tracker.onEvent(event);
    expect(tracker.isCarried(S)).toBe(false);
    expect(tracker.get(S)).toBeUndefined();
    expect(tracker.inExecution(S)).toBe(false);
  });
});

describe("a run with no recorded end", () => {
  test("is marked when no execution started since the mark, keeping only the last progress", () => {
    const tracker = started();
    tracker.onEvent(stepStarted(S, LATER));
    tracker.onEvent(toolCalled(S, "call_1", LATER + 1));
    tracker.onEvent(permissionAsked(S, "per_1"));
    tracker.onEvent(retryScheduled(S, LATER + 2, LATER + 60_000));
    expect(tracker.markUnended(S, tracker.mark(S))).toBe(true);
    expect(tracker.get(S)).toEqual({
      executionStartedAt: START,
      responseStartedAt: LATER,
      responding: false,
      lastProgressAt: LATER + 1,
      tools: new Map(),
      openPrompts: 0,
      unended: true,
    });
    expect(tracker.inExecution(S)).toBe(false);
  });

  test("is not marked when an execution started since the mark", () => {
    const tracker = started();
    const mark = tracker.mark(S);
    tracker.onEvent(executionStarted(S, LATER));
    expect(tracker.markUnended(S, mark)).toBe(false);
    expect(tracker.get(S)?.unended).toBe(false);
  });

  test("is cleared by new progress", () => {
    const tracker = started();
    tracker.markUnended(S, tracker.mark(S));
    tracker.onEvent(textDelta(S, LATER));
    expect(tracker.get(S)?.unended).toBe(false);
    expect(tracker.inExecution(S)).toBe(true);
  });

  test("is cleared by the next execution start", () => {
    const tracker = started();
    tracker.markUnended(S, tracker.mark(S));
    tracker.onEvent(executionStarted(S, LATER));
    expect(tracker.get(S)?.unended).toBe(false);
  });

  test("is not cleared by a parent's message arriving", () => {
    const tracker = started();
    tracker.markUnended(S, tracker.mark(S));
    tracker.onEvent(inboxEnqueued(S, "synthetic", LATER));
    expect(tracker.get(S)?.unended).toBe(true);
  });
});

describe("stored times", () => {
  test("busySince reads time.busy when the host records it", () => {
    expect(busySince(withTimes(10, undefined))).toBe(10);
    expect(busySince(withTimes(undefined, 20))).toBeUndefined();
  });

  test("busySince ignores a time.busy that is not a finite number", () => {
    const base = sessionInfo(S);
    const time: SessionInfo["time"] & { busy: unknown } = {
      ...base.time,
      busy: Number.NaN,
    };
    expect(busySince({ ...base, time })).toBeUndefined();
  });

  test.each([
    ["no recorded start", undefined, 20, undefined],
    ["a start and no end", 10, undefined, true],
    ["a start after the latest end", 30, 20, true],
    ["a start before the latest end", 10, 20, false],
  ] as const)(
    "recordsOpenRun with %s is %p",
    (_, busy, idle, expected) => {
      expect(recordsOpenRun(withTimes(busy, idle))).toBe(expected);
    },
  );

  test.each([
    ["no time.idle", undefined, undefined, false, undefined],
    ["time.idle on a host that records no start", undefined, 20, false, 20],
    ["time.idle after the recorded start", 10, 20, false, 20],
    ["time.idle equal to the recorded start", 20, 20, false, 20],
    ["time.idle older than the recorded start", 30, 20, false, undefined],
    ["a run with no recorded end", 10, 20, true, undefined],
  ] as const)(
    "idleSince with %s is %p",
    (_, busy, idle, noRecordedEnd, expected) => {
      expect(idleSince(withTimes(busy, idle), noRecordedEnd)).toBe(expected);
    },
  );
});
