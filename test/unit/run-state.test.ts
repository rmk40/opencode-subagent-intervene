import { describe, expect, test } from "bun:test";
import {
  PROBE_CONCURRENCY,
  PROBE_TIMEOUT_MS,
  RunStateTracker,
} from "@/core/run-state";
import type { RunObservation, SessionID } from "@/core/ports";
import {
  type Deferred,
  deferred,
  executionEnded,
  executionStarted,
  FakeClock,
  FakeControl,
  flush,
  sessionDeleted,
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
