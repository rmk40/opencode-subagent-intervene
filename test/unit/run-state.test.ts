import { describe, expect, test } from "bun:test";
import { ActivityTracker } from "@/core/activity";
import {
  PROBE_CONCURRENCY,
  PROBE_TIMEOUT_MS,
  RECONCILE_GRACE_MS,
  type RunStateOptions,
  RunStateTracker,
  STALE_PROGRESS_MS,
} from "@/core/run-state";
import type {
  OpenCodeEvent,
  RunObservation,
  SessionID,
  SessionInfo,
} from "@/core/ports";
import { textDelta } from "./activity-fixtures";
import {
  type Deferred,
  deferred,
  executionEnded,
  executionStarted,
  FakeClock,
  FakeControl,
  FakeSessionReader,
  flush,
  inboxEnqueued,
  sessionDeleted,
  sessionInfo,
  type TerminalEventType,
} from "./fixtures";

const TERMINAL: readonly TerminalEventType[] = [
  "session.execution.succeeded",
  "session.execution.failed",
  "session.execution.interrupted",
];

const never = (): Promise<void> => new Promise(() => {});

function setup(probeConcurrency?: number) {
  const control = new FakeControl();
  const clock = new FakeClock();
  const tracker = new RunStateTracker(
    { control, clock },
    probeConcurrency === undefined ? {} : { probeConcurrency },
  );
  return { control, clock, tracker };
}

/**
 * Holds every `waitIdle` open until the test resolves it, and counts the waits in flight: a wait
 * counts from its call until it settles.
 */
function heldWaits(control: FakeControl) {
  const held = new Map<SessionID, Deferred<void>>();
  const counts = { inFlight: 0, max: 0 };
  control.waitIdleImpl = (sessionID) => {
    counts.inFlight++;
    counts.max = Math.max(counts.max, counts.inFlight);
    const wait = deferred<void>();
    held.set(sessionID, wait);
    return wait.promise.finally(() => {
      counts.inFlight--;
    });
  };
  /** Lets the wait for `sessionID` go idle, then lets the tracker move on. */
  const release = async (sessionID: SessionID): Promise<void> => {
    const wait = held.get(sessionID);
    if (wait === undefined) throw new Error(`no wait for ${sessionID}`);
    wait.resolve();
    await flush();
  };
  return { counts, release };
}

function names(prefix: string, count: number): SessionID[] {
  return Array.from({ length: count }, (_, index) => `${prefix}${index}`);
}

/** Starts an observation and records when it settles. */
function observing(tracker: RunStateTracker, sessionID: string) {
  const state = { settled: false };
  const promise = tracker.observe(sessionID).then((result: RunObservation) => {
    state.settled = true;
    return result;
  });
  return { promise, state };
}

describe("the event fold", () => {
  test("reports running after session.execution.started, without probing", async () => {
    const { control, tracker } = setup();
    tracker.onEvent(executionStarted("s"));
    expect(await tracker.observe("s")).toEqual({
      state: "running",
      source: "event",
    });
    expect(control.waits).toEqual([]);
  });

  test.each(TERMINAL)("reports idle after %s", async (type) => {
    const { tracker } = setup();
    tracker.onEvent(executionStarted("s"));
    tracker.onEvent(executionEnded(type, "s"));
    expect(await tracker.observe("s")).toEqual({
      state: "idle",
      source: "event",
    });
  });

  test("reports running again when a new run starts after an idle one", async () => {
    const { tracker } = setup();
    tracker.onEvent(executionEnded("session.execution.succeeded", "s"));
    tracker.onEvent(executionStarted("s"));
    expect(await tracker.observe("s")).toEqual({
      state: "running",
      source: "event",
    });
  });

  test("forgets a deleted session, so the next observation probes", async () => {
    const { control, tracker } = setup();
    control.waitIdleImpl = async () => {};
    tracker.onEvent(executionStarted("s"));
    tracker.onEvent(sessionDeleted("s"));
    expect(await tracker.observe("s")).toEqual({
      state: "idle",
      source: "probe",
    });
    expect(control.waits).toEqual(["s"]);
  });
});

describe("the probe", () => {
  test("reports idle when waitIdle resolves first, and ends its timer", async () => {
    const { control, clock, tracker } = setup();
    control.waitIdleImpl = async () => {};
    expect(await tracker.observe("s")).toEqual({
      state: "idle",
      source: "probe",
    });
    expect(clock.pendingTimers).toBe(0);
  });

  test("reports running when waitIdle has not resolved after 150 ms", async () => {
    const { control, clock, tracker } = setup();
    control.waitIdleImpl = never;
    const { promise, state } = observing(tracker, "s");
    await flush();
    clock.advance(PROBE_TIMEOUT_MS - 1);
    await flush();
    expect(state.settled).toBe(false);
    clock.advance(1);
    expect(await promise).toEqual({ state: "running", source: "probe" });
  });

  test.each([
    ["rejects", () => Promise.reject(new Error("gone"))],
    [
      "throws",
      (): Promise<void> => {
        throw new Error("gone");
      },
    ],
  ])("reports unknown when waitIdle %s", async (_, waitIdle) => {
    const { control, tracker } = setup();
    control.waitIdleImpl = waitIdle;
    expect(await tracker.observe("s")).toEqual({
      state: "unknown",
      source: "probe",
    });
  });

  test("does not keep a probe result for the next observation", async () => {
    const { control, clock, tracker } = setup();
    control.waitIdleImpl = never;
    const first = tracker.observe("s");
    clock.advance(PROBE_TIMEOUT_MS);
    expect(await first).toEqual({ state: "running", source: "probe" });

    control.waitIdleImpl = async () => {};
    expect(await tracker.observe("s")).toEqual({
      state: "idle",
      source: "probe",
    });
  });
});

describe("an event that arrives during a probe", () => {
  test("wins over a probe that then finds the session idle", async () => {
    const { control, tracker } = setup();
    const wait = deferred<void>();
    control.waitIdleImpl = () => wait.promise;
    const { promise } = observing(tracker, "s");
    await flush();
    tracker.onEvent(executionStarted("s"));
    wait.resolve();
    expect(await promise).toEqual({ state: "running", source: "event" });
  });

  test("wins over a probe that then times out", async () => {
    const { control, clock, tracker } = setup();
    control.waitIdleImpl = never;
    const { promise } = observing(tracker, "s");
    await flush();
    tracker.onEvent(executionEnded("session.execution.interrupted", "s"));
    clock.advance(PROBE_TIMEOUT_MS);
    expect(await promise).toEqual({ state: "idle", source: "event" });
  });
});

describe("observeAll", () => {
  test("observes each distinct session once", async () => {
    const { control, tracker } = setup();
    control.waitIdleImpl = async () => {};
    tracker.onEvent(executionStarted("a"));
    const result = await tracker.observeAll(["a", "b", "a", "b"]);
    expect([...result]).toEqual([
      ["a", { state: "running", source: "event" }],
      ["b", { state: "idle", source: "probe" }],
    ]);
    expect(control.waits).toEqual(["b"]);
  });

  test("probes sessions concurrently", async () => {
    const { control, clock, tracker } = setup();
    control.waitIdleImpl = never;
    let settled = false;
    const all = tracker.observeAll(["a", "b"]).then((result) => {
      settled = true;
      return result;
    });
    await flush();
    clock.advance(PROBE_TIMEOUT_MS);
    await flush();
    expect(settled).toBe(true);
    const result = await all;
    expect(result.get("a")).toEqual({ state: "running", source: "probe" });
    expect(result.get("b")).toEqual({ state: "running", source: "probe" });
  });

  test(`runs at most ${PROBE_CONCURRENCY} probes at once by default`, async () => {
    const { control, tracker } = setup();
    const { counts } = heldWaits(control);
    void tracker.observeAll(names("s", PROBE_CONCURRENCY + 8));
    await flush();
    expect(control.waits).toEqual(names("s", PROBE_CONCURRENCY));
    expect(counts.max).toBe(PROBE_CONCURRENCY);
  });

  test("starts a queued probe as each one finishes, never running more than probeConcurrency", async () => {
    const { control, tracker } = setup(3);
    const { counts, release } = heldWaits(control);
    const ids = names("s", 7);
    const all = tracker.observeAll(ids);
    await flush();
    expect(control.waits).toEqual(["s0", "s1", "s2"]);
    for (const id of ids) await release(id);
    expect(control.waits).toEqual(ids);
    expect(counts.max).toBe(3);
    expect([...(await all).values()]).toEqual(
      ids.map(() => ({ state: "idle", source: "probe" })),
    );
  });

  test("does not time out a queued probe for the time it waited for a slot", async () => {
    const { control, clock, tracker } = setup(1);
    const { release } = heldWaits(control);
    const all = tracker.observeAll(["first", "queued"]);
    await flush();
    expect(control.waits).toEqual(["first"]);
    // The first probe runs out its timer while the second waits for the slot.
    clock.advance(PROBE_TIMEOUT_MS);
    await flush();
    expect(control.waits).toEqual(["first", "queued"]);
    // The queued probe's own timer has not run out when its session goes idle.
    clock.advance(PROBE_TIMEOUT_MS - 1);
    await release("queued");
    expect([...(await all)]).toEqual([
      ["first", { state: "running", source: "probe" }],
      ["queued", { state: "idle", source: "probe" }],
    ]);
  });

  test("returns the observations in input order, whatever order they finish in", async () => {
    const { control, tracker } = setup(3);
    const { release } = heldWaits(control);
    tracker.onEvent(executionStarted("folded"));
    const all = tracker.observeAll(["slow", "folded", "fast"]);
    await flush();
    await release("fast");
    await release("slow");
    expect([...(await all).keys()]).toEqual(["slow", "folded", "fast"]);
  });

  test("does not hold a slot for a session whose state is folded from events", async () => {
    const { control, tracker } = setup(2);
    heldWaits(control);
    for (const id of ["f0", "f1", "f2"]) tracker.onEvent(executionStarted(id));
    void tracker.observeAll(["p0", "f0", "f1", "f2", "p1"]);
    await flush();
    // Both slots are probing even though three folded sessions came between the two probes.
    expect(control.waits).toEqual(["p0", "p1"]);
  });

  test("treats a probeConcurrency below 1 as 1", async () => {
    const { control, tracker } = setup(0);
    const { release } = heldWaits(control);
    const all = tracker.observeAll(["a", "b"]);
    await flush();
    expect(control.waits).toEqual(["a"]);
    await release("a");
    await release("b");
    expect([...(await all).keys()]).toEqual(["a", "b"]);
  });
});

const START = 10_000_000;
const UNENDED: RunObservation = {
  state: "idle",
  source: "probe",
  noRecordedEnd: true,
};

/**
 * A tracker with live activity and a session reader, the way the plugin builds it. `feed` gives an
 * event to both, as the event loop does once the latch has handled it.
 */
function reconciling(options: RunStateOptions = {}) {
  const control = new FakeControl();
  const clock = new FakeClock(START);
  const activity = new ActivityTracker();
  const reader = new FakeSessionReader();
  const tracker = new RunStateTracker(
    { control, clock, activity, reader },
    options,
  );
  const feed = (event: OpenCodeEvent): void => {
    activity.onEvent(event);
    tracker.onEvent(event);
  };
  return { control, clock, activity, reader, tracker, feed };
}

/** Runs `promise` to the end, moving the fake clock to each pending sleep when nothing else runs. */
async function driven<T>(clock: FakeClock, promise: Promise<T>): Promise<T> {
  let settled = false;
  const result = promise.finally(() => {
    settled = true;
  });
  for (let step = 0; step < 50 && !settled; step++) {
    await flush();
    if (settled) break;
    const next = clock.nextTimerAt;
    if (next !== undefined) clock.advance(next - clock.now());
  }
  return result;
}

/** `info` with a stored execution start, as hosts from OpenCode 2.2.2 record it. */
function stored(
  id: SessionID,
  busy: number | undefined,
  idle: number | undefined,
): SessionInfo {
  const base = sessionInfo(id, "parent");
  const time: SessionInfo["time"] & { busy?: number } = {
    ...base.time,
    ...(busy === undefined ? {} : { busy }),
    ...(idle === undefined ? {} : { idle }),
  };
  return { ...base, time };
}

describe("reconciling a running fold with session.wait", () => {
  test("trusts the fold without asking while the session showed progress within 2 minutes", async () => {
    const { control, clock, tracker, feed } = reconciling();
    control.waitIdleImpl = async () => {};
    feed(executionStarted("s", START));
    clock.advance(STALE_PROGRESS_MS - 1);
    expect(await tracker.observe("s")).toEqual({
      state: "running",
      source: "event",
    });
    expect(control.waits).toEqual([]);
  });

  test("reports a session silent for 2 minutes whose wait resolves at once as idle with no recorded end", async () => {
    const { control, clock, tracker, feed } = reconciling();
    control.waitIdleImpl = async () => {};
    feed(executionStarted("s", START));
    clock.advance(STALE_PROGRESS_MS);
    expect(await driven(clock, tracker.observe("s"))).toEqual(UNENDED);
    expect(control.waits).toEqual(["s"]);
  });

  test("counts the silence from the last progress, not from the start", async () => {
    const { control, clock, tracker, feed } = reconciling();
    control.waitIdleImpl = async () => {};
    feed(executionStarted("s", START));
    clock.advance(STALE_PROGRESS_MS);
    feed(textDelta("s", clock.now() - 1000));
    expect(await tracker.observe("s")).toEqual({
      state: "running",
      source: "event",
    });
    expect(control.waits).toEqual([]);
  });

  test("does not count a parent's message arriving as progress", async () => {
    const { control, clock, tracker, feed } = reconciling();
    control.waitIdleImpl = async () => {};
    feed(executionStarted("s", START));
    clock.advance(STALE_PROGRESS_MS);
    feed(inboxEnqueued("s", "synthetic", clock.now()));
    expect(await driven(clock, tracker.observe("s"))).toEqual(UNENDED);
  });

  test("leaves the session running when the wait times out", async () => {
    const { control, clock, tracker, feed } = reconciling();
    control.waitIdleImpl = never;
    feed(executionStarted("s", START));
    clock.advance(STALE_PROGRESS_MS);
    expect(await driven(clock, tracker.observe("s"))).toEqual({
      state: "running",
      source: "probe",
    });
  });

  test("reports the state unknown when the wait fails", async () => {
    const { control, clock, tracker, feed } = reconciling();
    control.waitIdleImpl = () => Promise.reject(new Error("gone"));
    feed(executionStarted("s", START));
    clock.advance(STALE_PROGRESS_MS);
    expect(await driven(clock, tracker.observe("s"))).toEqual({
      state: "unknown",
      source: "probe",
    });
  });

  test("reports running when a newer execution starts while the wait is pending", async () => {
    const { control, clock, tracker, feed } = reconciling();
    const wait = deferred<void>();
    control.waitIdleImpl = () => wait.promise;
    feed(executionStarted("s", START));
    clock.advance(STALE_PROGRESS_MS);
    const observed = tracker.observe("s");
    await flush();
    feed(executionStarted("s", clock.now()));
    wait.resolve();
    expect(await driven(clock, observed)).toEqual({
      state: "running",
      source: "event",
    });
  });

  test("reports running when a newer execution starts in the moment after the wait resolved", async () => {
    const { control, clock, tracker, feed } = reconciling();
    control.waitIdleImpl = async () => {};
    feed(executionStarted("s", START));
    clock.advance(STALE_PROGRESS_MS);
    const observed = tracker.observe("s");
    await flush();
    // The wait resolved; the tracker gives the event stream a moment before concluding.
    feed(executionStarted("s", clock.now()));
    clock.advance(RECONCILE_GRACE_MS);
    expect(await observed).toEqual({ state: "running", source: "event" });
  });

  test.each(TERMINAL)(
    "reports a plain idle when %s arrives in the moment after the wait resolved",
    async (type) => {
      const { control, clock, tracker, feed } = reconciling();
      control.waitIdleImpl = async () => {};
      feed(executionStarted("s", START));
      clock.advance(STALE_PROGRESS_MS);
      const observed = tracker.observe("s");
      await flush();
      feed(executionEnded(type, "s", clock.now()));
      clock.advance(RECONCILE_GRACE_MS);
      expect(await observed).toEqual({ state: "idle", source: "event" });
    },
  );

  test("reports a plain idle when only the activity has seen the end so far", async () => {
    // Activity sees each event as it arrives; the fold sees it after the latch's storage work.
    const { control, clock, activity, tracker, feed } = reconciling();
    control.waitIdleImpl = async () => {};
    feed(executionStarted("s", START));
    clock.advance(STALE_PROGRESS_MS);
    activity.onEvent(
      executionEnded("session.execution.succeeded", "s", clock.now()),
    );
    expect(await driven(clock, tracker.observe("s"))).toEqual({
      state: "idle",
      source: "event",
    });
  });

  test("keeps a run with no recorded end without asking again", async () => {
    const { control, clock, tracker, feed } = reconciling();
    control.waitIdleImpl = async () => {};
    feed(executionStarted("s", START));
    clock.advance(STALE_PROGRESS_MS);
    await driven(clock, tracker.observe("s"));
    clock.advance(60 * 60 * 1000);
    expect(await tracker.observe("s")).toEqual(UNENDED);
    expect(control.waits).toEqual(["s"]);
  });

  test("clears a missing end on new progress, and asks again", async () => {
    const { control, clock, tracker, feed } = reconciling();
    control.waitIdleImpl = async () => {};
    feed(executionStarted("s", START));
    clock.advance(STALE_PROGRESS_MS);
    await driven(clock, tracker.observe("s"));
    feed(textDelta("s", clock.now()));
    control.waitIdleImpl = never;
    expect(await driven(clock, tracker.observe("s"))).toEqual({
      state: "running",
      source: "probe",
    });
  });

  test("clears a missing end when the next execution starts", async () => {
    const { control, clock, tracker, feed } = reconciling();
    control.waitIdleImpl = async () => {};
    feed(executionStarted("s", START));
    clock.advance(STALE_PROGRESS_MS);
    await driven(clock, tracker.observe("s"));
    feed(executionStarted("s", clock.now()));
    expect(await tracker.observe("s")).toEqual({
      state: "running",
      source: "event",
    });
  });

  test("confirm asks even while the fold is fresh", async () => {
    const { control, clock, tracker, feed } = reconciling();
    control.waitIdleImpl = never;
    feed(executionStarted("s", START));
    expect(await driven(clock, tracker.confirm("s"))).toEqual({
      state: "running",
      source: "probe",
    });
    expect(control.waits).toEqual(["s"]);
  });

  test("without session.wait, trusts a silent running fold instead of asking", async () => {
    const { control, clock, tracker, feed } = reconciling({ reconcile: false });
    control.waitIdleImpl = () => Promise.reject(new Error("no session.wait"));
    feed(executionStarted("s", START));
    clock.advance(STALE_PROGRESS_MS * 10);
    expect(await tracker.observe("s")).toEqual({
      state: "running",
      source: "event",
    });
    expect(control.waits).toEqual([]);
  });

  test("without session.wait, reports a session with no fold as unknown", async () => {
    const { control, clock, tracker } = reconciling({ reconcile: false });
    control.waitIdleImpl = () => Promise.reject(new Error("no session.wait"));
    expect(await driven(clock, tracker.observe("s"))).toEqual({
      state: "unknown",
      source: "probe",
    });
  });
});

describe("a session with no fold whose storage records an open run", () => {
  test("is idle with no recorded end when the wait resolves and storage still records it open", async () => {
    const { control, clock, reader, tracker } = reconciling();
    control.waitIdleImpl = async () => {};
    const info = stored("s", START - 10, START - 20);
    reader.put(info);
    expect(await driven(clock, tracker.observe("s", info))).toEqual(UNENDED);
  });

  test("is a plain idle when storage records the end by the time it is read again", async () => {
    const { control, clock, reader, tracker } = reconciling();
    control.waitIdleImpl = async () => {};
    const info = stored("s", START - 10, START - 20);
    reader.put(stored("s", START - 10, START));
    expect(await driven(clock, tracker.observe("s", info))).toEqual({
      state: "idle",
      source: "probe",
    });
  });

  test("is a plain idle on a host that records no execution start", async () => {
    const { control, clock, reader, tracker } = reconciling();
    control.waitIdleImpl = async () => {};
    const info = stored("s", undefined, START - 20);
    reader.put(info);
    expect(await driven(clock, tracker.observe("s", info))).toEqual({
      state: "idle",
      source: "probe",
    });
  });

  test("is a plain idle when storage records the end", async () => {
    const { control, clock, reader, tracker } = reconciling();
    control.waitIdleImpl = async () => {};
    const info = stored("s", START - 20, START - 10);
    reader.put(info);
    expect(await driven(clock, tracker.observe("s", info))).toEqual({
      state: "idle",
      source: "probe",
    });
  });
});

describe("a session seen running before a gap in the event stream", () => {
  test.each([
    ["storage records the run's start and end", START, START + 1000],
    ["the host records no run start", undefined, START + 1000],
  ] as const)(
    "is a plain idle once its run ended during the gap, when %s",
    async (_, busy, idle) => {
      const { control, clock, activity, reader, tracker, feed } = reconciling();
      control.waitIdleImpl = async () => {};
      feed(executionStarted("s", START));
      clock.advance(STALE_PROGRESS_MS);
      activity.reset();
      tracker.reset();
      const info = stored("s", busy, idle);
      reader.put(info);
      const expected: RunObservation = { state: "idle", source: "probe" };
      expect(await driven(clock, tracker.observe("s", info))).toEqual(expected);
      expect(await driven(clock, tracker.confirm("s", info))).toEqual(expected);
    },
  );
});

describe("settled, for a wait that resolved during a stop", () => {
  test("records a silent running session as having no recorded end", async () => {
    const { clock, tracker, feed } = reconciling();
    feed(executionStarted("s", START));
    clock.advance(STALE_PROGRESS_MS);
    tracker.settled("s", tracker.mark("s"));
    expect(await tracker.observe("s")).toEqual(UNENDED);
  });

  test("does nothing for a session that showed progress within 2 minutes", async () => {
    const { clock, tracker, feed } = reconciling();
    feed(executionStarted("s", START));
    clock.advance(STALE_PROGRESS_MS - 1);
    tracker.settled("s", tracker.mark("s"));
    expect(await tracker.observe("s")).toEqual({
      state: "running",
      source: "event",
    });
  });

  test("does nothing when an execution started since the mark", async () => {
    const { clock, tracker, feed } = reconciling();
    feed(executionStarted("s", START));
    const mark = tracker.mark("s");
    // The newer execution is silent too, so only the mark tells the two apart.
    feed(executionStarted("s", START));
    clock.advance(STALE_PROGRESS_MS);
    tracker.settled("s", mark);
    expect(await driven(clock, tracker.observe("s"))).toEqual({
      state: "running",
      source: "probe",
    });
  });

  test("does nothing without session.wait", async () => {
    const { clock, tracker, feed } = reconciling({ reconcile: false });
    feed(executionStarted("s", START));
    clock.advance(STALE_PROGRESS_MS);
    tracker.settled("s", tracker.mark("s"));
    expect(await tracker.observe("s")).toEqual({
      state: "running",
      source: "event",
    });
  });
});
