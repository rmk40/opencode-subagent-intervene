import { describe, expect, test } from "bun:test";
import { DEFAULT_LATCH_TTL_MS, Latch, type LatchOptions } from "@/core/latch";
import type { SessionInfo } from "@/core/ports";
import {
  deferred,
  executionEnded,
  executionStarted,
  FakeClock,
  FakeControl,
  FakeSessionReader,
  flush,
  inboxEnqueued,
  MemoryStore,
  RecordingLogger,
  sessionDeleted,
  sessionInfo,
} from "./fixtures";

const S = "ses_child";
/** When the parent stopped the subagent. */
const AT = 1_000_000;
/** When the run the stop ended went idle. */
const IDLE = AT + 1_000;
/** When the woken run started. */
const START = AT + 5_000;

interface StoredTimes {
  /** `time.busy`, which OpenCode records from 2.2.2. */
  readonly busy?: number;
  readonly idle?: number;
}

/** The woken run as OpenCode 2.2.2 and later store it: open since `START`. */
const OPEN: StoredTimes = { busy: START, idle: IDLE };

function stored(times: StoredTimes): SessionInfo {
  const base = sessionInfo(S, "ses_parent");
  const time: SessionInfo["time"] & { busy?: number } = {
    ...base.time,
    ...(times.busy === undefined ? {} : { busy: times.busy }),
    ...(times.idle === undefined ? {} : { idle: times.idle }),
  };
  return { ...base, time };
}

/** A subagent stopped at `AT`, stored with `times`, with the clock at `START`. */
async function setup(times: StoredTimes = OPEN, options: LatchOptions = {}) {
  const store = new MemoryStore();
  const control = new FakeControl();
  const clock = new FakeClock(START);
  const logger = new RecordingLogger();
  const reader = new FakeSessionReader([stored(times)]);
  const latch = new Latch(
    { store, control, clock, logger, renderNote: () => "", reader },
    options,
  );
  await latch.add(S, {
    generation: "g1",
    parentSessionID: "ses_parent",
    reason: "off track",
    at: AT,
  });
  return { store, control, clock, logger, reader, latch };
}

type World = Awaited<ReturnType<typeof setup>>;

/** Handles the background shell's notice that wakes the subagent; it does not lift the stop. */
async function notice(latch: Latch): Promise<void> {
  await latch.onEvent(inboxEnqueued(S, "synthetic", START - 1));
}

/** A hook call whose settling the test can observe. */
function call(latch: Latch, sessionID = S): { readonly done: boolean } {
  const state = { done: false };
  void latch.beforeRequest(sessionID).then(() => {
    state.done = true;
  });
  return state;
}

describe("letting the request go ahead at once", () => {
  test.each<readonly [string, (world: World) => Promise<void>]>([
    ["no event was handled since the latch loaded", async () => {}],
    [
      "the run was already going when the startup pass ran",
      async ({ latch }) => {
        await latch.startup(async () => true);
        await notice(latch);
      },
    ],
    [
      "the stop was lifted",
      async ({ latch }) => {
        await notice(latch);
        await latch.onEvent(inboxEnqueued(S, "user", START - 1));
      },
    ],
    [
      "the stop expired",
      async ({ latch, clock }) => {
        clock.advance(DEFAULT_LATCH_TTL_MS);
        await notice(latch);
      },
    ],
    [
      "the latch was disposed",
      async ({ latch }) => {
        await notice(latch);
        latch.dispose();
      },
    ],
    [
      "storage records no open run",
      async ({ latch, reader }) => {
        await notice(latch);
        reader.put(stored({ busy: START, idle: START + 10 }));
      },
    ],
    [
      "the session no longer exists",
      async ({ latch, reader }) => {
        await notice(latch);
        reader.remove(S);
      },
    ],
    [
      "the run's end was already handled",
      async ({ latch }) => {
        await notice(latch);
        await latch.onEvent(executionStarted(S, START));
        await latch.onEvent(
          executionEnded("session.execution.interrupted", S, START + 10),
        );
      },
    ],
  ])("when %s", async (_, arrange) => {
    const world = await setup();
    await arrange(world);
    const hook = call(world.latch);
    await flush();
    expect(hook.done).toBe(true);
    expect(world.clock.pendingTimers).toBe(0);
  });

  test("after a gap in the event stream, until the next event is handled", async () => {
    const { latch, clock } = await setup();
    await notice(latch);
    latch.reset();
    const during = call(latch);
    await flush();
    expect(during.done).toBe(true);
    expect(clock.pendingTimers).toBe(0);

    await notice(latch);
    const after = call(latch);
    await flush();
    expect(after.done).toBe(false);
  });
});

describe("holding an interrupted run before its model request", () => {
  const ORDERS = [
    ["before the hook is called", "before"],
    ["while the hook waits", "during"],
  ] as const;

  test.each(ORDERS)(
    "holds a run whose start was handled %s until the run goes idle, interrupting it once",
    async (_, order) => {
      const { latch, control } = await setup();
      const idle = deferred<void>();
      control.waitIdleImpl = () => idle.promise;
      await notice(latch);
      if (order === "before") await latch.onEvent(executionStarted(S, START));
      const hook = call(latch);
      await flush();
      if (order === "during") {
        expect(control.interrupts).toEqual([]);
        expect(hook.done).toBe(false);
        await latch.onEvent(executionStarted(S, START));
        await flush();
      }
      expect(control.interrupts).toEqual([S]);
      expect(hook.done).toBe(false);

      idle.resolve();
      await flush();
      expect(hook.done).toBe(true);
    },
  );

  test.each(ORDERS)(
    "lets the request go ahead at once when the interrupt found no run, with the start handled %s",
    async (_, order) => {
      const { latch, control, clock } = await setup();
      control.interruptImpl = async () => false;
      await notice(latch);
      if (order === "before") await latch.onEvent(executionStarted(S, START));
      const hook = call(latch);
      await flush();
      if (order === "during") await latch.onEvent(executionStarted(S, START));
      await flush();
      expect(control.interrupts).toEqual([S]);
      expect(hook.done).toBe(true);
      expect(clock.pendingTimers).toBe(0);
    },
  );

  test("releases a held run when its end event is handled", async () => {
    const { latch } = await setup();
    await notice(latch);
    const hook = call(latch);
    await flush();
    await latch.onEvent(executionStarted(S, START));
    await flush();
    expect(hook.done).toBe(false);

    await latch.onEvent(
      executionEnded("session.execution.interrupted", S, START + 10),
    );
    await flush();
    expect(hook.done).toBe(true);
  });

  test("holds an interrupted run for at most 5 seconds", async () => {
    const { latch, clock } = await setup();
    await notice(latch);
    await latch.onEvent(executionStarted(S, START));
    const hook = call(latch);
    await flush();
    clock.advance(4_999);
    await flush();
    expect(hook.done).toBe(false);

    clock.advance(1);
    await flush();
    expect(hook.done).toBe(true);
  });

  test("stops holding after 5 seconds when the interrupt never settles", async () => {
    const { latch, control, clock } = await setup();
    control.interruptImpl = () => new Promise(() => {});
    await notice(latch);
    const hook = call(latch);
    await flush();
    void latch.onEvent(executionStarted(S, START));
    await flush();
    clock.advance(4_999);
    await flush();
    expect(hook.done).toBe(false);

    clock.advance(1);
    await flush();
    expect(hook.done).toBe(true);
  });

  test("keeps holding when waiting for the run to go idle fails", async () => {
    const { latch, control } = await setup();
    control.waitIdleImpl = () => Promise.reject(new Error("no session.wait"));
    await notice(latch);
    await latch.onEvent(executionStarted(S, START));
    const hook = call(latch);
    await flush();
    expect(hook.done).toBe(false);

    await latch.onEvent(
      executionEnded("session.execution.interrupted", S, START + 10),
    );
    await flush();
    expect(hook.done).toBe(true);
  });
});

describe("waiting for the run's start", () => {
  test("lets the request go ahead after 500 ms without the start, which still interrupts the run", async () => {
    const { latch, control, clock } = await setup();
    await notice(latch);
    const hook = call(latch);
    await flush();
    clock.advance(499);
    await flush();
    expect(hook.done).toBe(false);

    clock.advance(1);
    await flush();
    expect(hook.done).toBe(true);
    expect(control.interrupts).toEqual([]);

    await latch.onEvent(executionStarted(S, START));
    expect(control.interrupts).toEqual([S]);
  });

  test.each<readonly [string, (world: World) => Promise<void> | void]>([
    ["a gap in the event stream", ({ latch }) => latch.reset()],
    ["disposal", ({ latch }) => latch.dispose()],
    [
      "the session's deletion",
      ({ latch }) => latch.onEvent(sessionDeleted(S, START)),
    ],
  ])("%s releases a waiting hook without an interrupt", async (_, release) => {
    const world = await setup();
    await notice(world.latch);
    const hook = call(world.latch);
    await flush();
    expect(hook.done).toBe(false);

    await release(world);
    await flush();
    expect(hook.done).toBe(true);
    expect(world.control.interrupts).toEqual([]);
    expect(world.clock.pendingTimers).toBe(0);
  });

  test("a lift handled just before the start lets the run go ahead", async () => {
    const { latch, control, clock } = await setup();
    await notice(latch);
    const hook = call(latch);
    await flush();
    await latch.onEvent(inboxEnqueued(S, "user", START - 1));
    await latch.onEvent(executionStarted(S, START));
    await flush();
    expect(hook.done).toBe(true);
    expect(control.interrupts).toEqual([]);
    expect(clock.pendingTimers).toBe(0);
    expect(await latch.describe(S)).toMatchObject({ latch: "lifted" });
  });
});

describe("checking a held run again before interrupting it", () => {
  test.each<readonly [string, StoredTimes, StoredTimes | undefined]>([
    ["the run ended", OPEN, { busy: START, idle: START + 10 }],
    ["a later run started", OPEN, { busy: START + 20, idle: START + 10 }],
    ["the session is gone", OPEN, undefined],
    [
      "the run ended, as OpenCode before 2.2.2 stores it",
      { idle: IDLE },
      { idle: START + 10 },
    ],
  ])(
    "leaves the run alone when storage shows %s by the time its start is handled",
    async (_, before, after) => {
      const { latch, control, reader } = await setup(before);
      await notice(latch);
      const hook = call(latch);
      await flush();
      if (after === undefined) reader.remove(S);
      else reader.put(stored(after));
      await latch.onEvent(executionStarted(S, START));
      await flush();
      expect(control.interrupts).toEqual([]);
      expect(hook.done).toBe(true);
    },
  );

  test("a delayed hook never stops a later run, which that run's own start still stops", async () => {
    const { latch, control, reader } = await setup();
    await notice(latch);
    call(latch);
    await flush();
    reader.put(stored({ busy: START + 20, idle: START + 10 }));
    await latch.onEvent(executionStarted(S, START));
    await latch.onEvent(
      executionEnded("session.execution.succeeded", S, START + 10),
    );
    expect(control.interrupts).toEqual([]);

    await latch.onEvent(executionStarted(S, START + 20));
    expect(control.interrupts).toEqual([S]);
  });

  test("interrupts the held run when the session cannot be read again", async () => {
    const { latch, control, reader, logger } = await setup();
    await notice(latch);
    const hook = call(latch);
    await flush();
    reader.failingGets.add(S);
    await latch.onEvent(executionStarted(S, START));
    await flush();
    expect(control.interrupts).toEqual([S]);
    expect(logger.warnings()).toHaveLength(1);
    expect(hook.done).toBe(false);
  });
});

describe("which run a hook belongs to", () => {
  test("from OpenCode 2.2.2, the run whose start time equals time.busy", async () => {
    const { latch, control } = await setup(OPEN);
    control.interruptImpl = async () => false;
    await notice(latch);
    // Starts at other times, one handled before the hook and one while it waits, are other runs,
    // though both came after time.idle.
    await latch.onEvent(executionStarted(S, START - 1));
    const hook = call(latch);
    await flush();
    expect(hook.done).toBe(false);

    await latch.onEvent(executionStarted(S, START + 1));
    await flush();
    expect(hook.done).toBe(false);

    await latch.onEvent(executionStarted(S, START));
    await flush();
    expect(hook.done).toBe(true);
  });

  test("before OpenCode 2.2.2, the first run that started after time.idle", async () => {
    const { latch, control } = await setup({ idle: IDLE });
    control.interruptImpl = async () => false;
    await notice(latch);
    await latch.onEvent(executionStarted(S, IDLE));
    const hook = call(latch);
    await flush();
    expect(hook.done).toBe(false);

    await latch.onEvent(executionStarted(S, IDLE + 1));
    await flush();
    expect(hook.done).toBe(true);
  });

  test("before OpenCode 2.2.2, a session that never went idle takes its first start", async () => {
    const { latch, control } = await setup({});
    control.interruptImpl = async () => false;
    await notice(latch);
    const hook = call(latch);
    await flush();
    await latch.onEvent(executionStarted(S, START));
    await flush();
    expect(hook.done).toBe(true);
  });
});

describe("deciding once per run", () => {
  test("counts a run once toward the safety valve, however many hooks hold it", async () => {
    const { latch, control, store, reader } = await setup(OPEN, { valveMax: 1 });
    await notice(latch);
    const first = call(latch);
    const second = call(latch);
    await flush();
    await latch.onEvent(executionStarted(S, START));
    await flush();
    expect(control.interrupts).toEqual([S]);
    expect(store.data.has(`gaveup/${S}/g1`)).toBe(false);
    await latch.onEvent(
      executionEnded("session.execution.interrupted", S, START + 10),
    );
    await flush();
    expect(first.done).toBe(true);
    expect(second.done).toBe(true);

    // The next wake is the valve's second: it gives up and lets the run go ahead.
    reader.put(stored({ busy: START + 20, idle: START + 10 }));
    const next = call(latch);
    await flush();
    await latch.onEvent(executionStarted(S, START + 20));
    await flush();
    expect(control.interrupts).toEqual([S]);
    expect(store.data.has(`gaveup/${S}/g1`)).toBe(true);
    expect(next.done).toBe(true);
  });
});

describe("never rejecting", () => {
  test.each<readonly [string, (world: World) => void]>([
    ["the store's scan fails", ({ store }) => store.failing.add("scan")],
    ["the store's get fails", ({ store }) => store.failing.add("get")],
    ["reading the session fails", ({ reader }) => reader.failingGets.add(S)],
  ])("resolves and logs a warning when %s", async (_, arrange) => {
    const world = await setup();
    await notice(world.latch);
    arrange(world);
    await expect(world.latch.beforeRequest(S)).resolves.toBeUndefined();
    expect(world.logger.warnings()).toHaveLength(1);
  });

  test("lets the request go ahead when the interrupt rejects", async () => {
    const { latch, control, clock } = await setup();
    control.interruptImpl = () => Promise.reject(new Error("offline"));
    await notice(latch);
    const hook = call(latch);
    await flush();
    await latch.onEvent(executionStarted(S, START));
    await flush();
    expect(hook.done).toBe(true);
    expect(clock.pendingTimers).toBe(0);
  });
});
