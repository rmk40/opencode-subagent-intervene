import { describe, expect, test } from "bun:test";
import type { OpenCodeEvent } from "@/core/ports";
import {
  consume,
  type EventHandlers,
  RESUBSCRIBE_MAX_MS,
  RESUBSCRIBE_MIN_MS,
} from "@/events";
import {
  executionStarted,
  FakeClock,
  flush,
  RecordingLogger,
} from "./fixtures";

/** A subscription that yields the given events, then ends or throws. */
function stream(
  events: readonly OpenCodeEvent[],
  end: "end" | Error = "end",
): AsyncIterable<OpenCodeEvent> {
  return (async function* () {
    for (const event of events) yield event;
    if (end !== "end") throw end;
  })();
}

/** A subscription that stays open until `signal` aborts. */
function openUntil(signal: AbortSignal): AsyncIterable<OpenCodeEvent> {
  return (async function* () {
    await new Promise<void>((resolve) =>
      signal.addEventListener("abort", () => resolve(), { once: true }),
    );
  })();
}

interface Harness {
  readonly handlers: EventHandlers;
  readonly seen: string[];
  readonly resets: { count: number };
  readonly noticeResets: { count: number };
  readonly gaps: { count: number };
  readonly clock: FakeClock;
  readonly logger: RecordingLogger;
}

function harness(
  options: {
    latch?: boolean;
    notices?: boolean;
    failRunState?: boolean;
    failNotices?: boolean;
  } = {},
): Harness {
  const seen: string[] = [];
  const resets = { count: 0 };
  const noticeResets = { count: 0 };
  const gaps = { count: 0 };
  const clock = new FakeClock();
  const logger = new RecordingLogger();
  const handlers: EventHandlers = {
    runState: {
      onEvent: (event) => {
        if (options.failRunState === true) throw new Error("run state broke");
        seen.push(`run:${event.id}`);
      },
      reset: () => {
        resets.count++;
      },
    },
    latch:
      options.latch === false
        ? undefined
        : {
            onEvent: async (event) => {
              seen.push(`latch:${event.id}`);
            },
          },
    ...(options.notices === true
      ? {
          notices: {
            onEvent: (event: OpenCodeEvent) => {
              if (options.failNotices === true) {
                throw new Error("notices broke");
              }
              seen.push(`notices:${event.id}`);
            },
            reset: () => {
              noticeResets.count++;
            },
          },
        }
      : {}),
    logger,
    clock,
    afterGap: async () => {
      gaps.count++;
    },
  };
  return { handlers, seen, resets, noticeResets, gaps, clock, logger };
}

describe("consume", () => {
  test("feeds each event to run state, then the latch, in order", async () => {
    const h = harness();
    const controller = new AbortController();
    const first = executionStarted("s1");
    const second = executionStarted("s2");
    const subscriptions = [stream([first, second])];
    const done = consume(
      () => subscriptions.shift() ?? openUntil(controller.signal),
      h.handlers,
      controller.signal,
    );
    await flush();
    controller.abort();
    h.clock.advance(RESUBSCRIBE_MIN_MS);
    await done;
    expect(h.seen).toEqual([
      `run:${first.id}`,
      `latch:${first.id}`,
      `run:${second.id}`,
      `latch:${second.id}`,
    ]);
  });

  test("feeds each event to the notices after the latch", async () => {
    const h = harness({ notices: true });
    const controller = new AbortController();
    const event = executionStarted("s1");
    const subscriptions = [stream([event])];
    const done = consume(
      () => subscriptions.shift() ?? openUntil(controller.signal),
      h.handlers,
      controller.signal,
    );
    await flush();
    controller.abort();
    h.clock.advance(RESUBSCRIBE_MIN_MS);
    await done;
    expect(h.seen).toEqual([
      `run:${event.id}`,
      `latch:${event.id}`,
      `notices:${event.id}`,
    ]);
  });

  test("a failing notices handler is logged and the loop goes on to the next event", async () => {
    const h = harness({ notices: true, failNotices: true });
    const controller = new AbortController();
    const first = executionStarted("s1");
    const second = executionStarted("s2");
    const done = consume(
      () => stream([first, second]),
      h.handlers,
      controller.signal,
    );
    await flush();
    controller.abort();
    await done;
    expect(h.seen.slice(0, 4)).toEqual([
      `run:${first.id}`,
      `latch:${first.id}`,
      `run:${second.id}`,
      `latch:${second.id}`,
    ]);
    expect(h.logger.warnings()).toContain("notices: event handler failed");
  });

  test("resets the notices along with run state across a gap", async () => {
    const h = harness({ notices: true });
    const controller = new AbortController();
    let opened = 0;
    const done = consume(
      () => {
        opened++;
        return opened === 1 ? stream([]) : openUntil(controller.signal);
      },
      h.handlers,
      controller.signal,
    );
    await flush();
    expect(h.noticeResets.count).toBe(1);
    expect(h.resets.count).toBe(1);
    h.clock.advance(RESUBSCRIBE_MIN_MS);
    await flush();
    controller.abort();
    await done;
    expect(h.noticeResets.count).toBe(1);
  });

  test("a failing handler does not keep the event from the other handler or stop the loop", async () => {
    const h = harness({ failRunState: true });
    const controller = new AbortController();
    const first = executionStarted("s1");
    const second = executionStarted("s2");
    const done = consume(
      () => stream([first, second]),
      h.handlers,
      controller.signal,
    );
    await flush();
    controller.abort();
    await done;
    expect(h.seen.slice(0, 2)).toEqual([
      `latch:${first.id}`,
      `latch:${second.id}`,
    ]);
    expect(h.logger.warnings()).toContain("run state: event handler failed");
  });

  test("resubscribes after the stream ends, resetting run state and running afterGap", async () => {
    const h = harness();
    const controller = new AbortController();
    let opened = 0;
    const done = consume(
      () => {
        opened++;
        return opened === 1
          ? stream([], new Error("bus closed"))
          : openUntil(controller.signal);
      },
      h.handlers,
      controller.signal,
    );
    await flush();
    expect(h.resets.count).toBe(1);
    expect(opened).toBe(1);
    h.clock.advance(RESUBSCRIBE_MIN_MS - 1);
    await flush();
    expect(opened).toBe(1);
    h.clock.advance(1);
    await flush();
    expect(opened).toBe(2);
    expect(h.gaps.count).toBe(1);
    controller.abort();
    await done;
  });

  test("doubles the delay while subscriptions keep ending empty, up to the maximum", async () => {
    const h = harness();
    const controller = new AbortController();
    let opened = 0;
    const done = consume(
      () => {
        opened++;
        return stream([]);
      },
      h.handlers,
      controller.signal,
    );
    const delays: number[] = [];
    let delay = RESUBSCRIBE_MIN_MS;
    for (let gap = 0; gap < 8; gap++) {
      await flush();
      const before = opened;
      h.clock.advance(delay - 1);
      await flush();
      expect(opened).toBe(before);
      h.clock.advance(1);
      await flush();
      expect(opened).toBe(before + 1);
      delays.push(delay);
      delay = Math.min(delay * 2, RESUBSCRIBE_MAX_MS);
    }
    controller.abort();
    await done;
    expect(delays.at(-1)).toBe(RESUBSCRIBE_MAX_MS);
  });

  test("resets the delay once a subscription delivers an event", async () => {
    const h = harness();
    const controller = new AbortController();
    let opened = 0;
    const done = consume(
      () => {
        opened++;
        // Two empty subscriptions grow the delay; the third delivers an event, then ends.
        return opened === 3 ? stream([executionStarted("s1")]) : stream([]);
      },
      h.handlers,
      controller.signal,
    );
    await flush();
    h.clock.advance(RESUBSCRIBE_MIN_MS);
    await flush();
    h.clock.advance(RESUBSCRIBE_MIN_MS * 2);
    await flush();
    expect(opened).toBe(3);
    // The third subscription was healthy, so the fourth opens after the short delay again.
    h.clock.advance(RESUBSCRIBE_MIN_MS);
    await flush();
    expect(opened).toBe(4);
    controller.abort();
    await done;
  });

  test("retries a subscribe call that throws", async () => {
    const h = harness();
    const controller = new AbortController();
    let opened = 0;
    const done = consume(
      () => {
        opened++;
        if (opened === 1) throw new Error("not ready");
        return openUntil(controller.signal);
      },
      h.handlers,
      controller.signal,
    );
    await flush();
    expect(h.logger.warnings()).toContain("could not subscribe to events");
    h.clock.advance(RESUBSCRIBE_MIN_MS);
    await flush();
    expect(opened).toBe(2);
    controller.abort();
    await done;
  });

  test("stops without resubscribing once the signal aborts", async () => {
    const h = harness();
    const controller = new AbortController();
    let opened = 0;
    const done = consume(
      () => {
        opened++;
        return openUntil(controller.signal);
      },
      h.handlers,
      controller.signal,
    );
    await flush();
    controller.abort();
    await done;
    expect(opened).toBe(1);
    expect(h.resets.count).toBe(0);
    expect(h.logger.warnings()).toEqual([]);
  });
});
