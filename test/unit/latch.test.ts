import { describe, expect, test } from "bun:test";
import {
  DEFAULT_LATCH_TTL_MS,
  DEFAULT_VALVE_MAX,
  DEFAULT_VALVE_WINDOW_MS,
  Latch,
  type LatchInput,
  type LatchOptions,
} from "@/core/latch";
import type { OpenCodeEvent } from "@/core/ports";
import {
  deferred,
  deliveryChanged,
  executionEnded,
  executionStarted,
  FakeClock,
  FakeControl,
  inboxEnqueued,
  MemoryStore,
  RecordingLogger,
  revertCleared,
  sessionCreated,
  sessionDeleted,
  skillActivated,
} from "./fixtures";

/** When the stop under test started. */
const AT = 1_000_000;
const NOW = AT + 5_000;

function setup(options?: LatchOptions) {
  const store = new MemoryStore();
  const control = new FakeControl();
  const clock = new FakeClock(NOW);
  const logger = new RecordingLogger();
  const latch = new Latch(
    {
      store,
      control,
      clock,
      logger,
      renderNote: (note) => `[stopped at ${note.at}: ${note.reason}]`,
    },
    options,
  );
  return { store, control, clock, logger, latch };
}

function stop(overrides: Partial<LatchInput> = {}): LatchInput {
  return {
    generation: "g1",
    parentSessionID: "parent",
    reason: "off track",
    at: AT,
    ...overrides,
  };
}

async function wake(latch: Latch, times: number, sessionID = "s") {
  for (let index = 0; index < times; index++) {
    await latch.onEvent(executionStarted(sessionID));
  }
}

const LIFTS: ReadonlyArray<
  readonly [string, (created: number) => OpenCodeEvent]
> = [
  ["a user item is enqueued", (created) => inboxEnqueued("s", "user", created)],
  [
    "a compaction is enqueued",
    (created) => inboxEnqueued("s", "compaction", created),
  ],
  ["a move is enqueued", (created) => inboxEnqueued("s", "move", created)],
  [
    "a queued item is switched to steer",
    (created) => deliveryChanged("s", "steer", created),
  ],
  ["a skill is activated", (created) => skillActivated("s", created)],
  ["a staged revert is cleared", (created) => revertCleared("s", created)],
];

const NON_LIFTS: ReadonlyArray<
  readonly [string, (created: number) => OpenCodeEvent]
> = [
  [
    "a synthetic item is enqueued",
    (created) => inboxEnqueued("s", "synthetic", created),
  ],
  [
    // How the plugin's own parent messages and waiting notices arrive.
    "a synthetic item is enqueued to steer",
    (created) => inboxEnqueued("s", "synthetic", created, "steer"),
  ],
  [
    "an item is switched to queue",
    (created) => deliveryChanged("s", "queue", created),
  ],
];

describe("the key layout", () => {
  test("add writes one latch record that expires 24 hours after the stop", async () => {
    const { latch, store } = setup();
    await latch.add("s", stop());
    expect(store.keys()).toEqual(["latch/s/g1"]);
    expect(store.data.get("latch/s/g1")).toEqual({
      parentSessionID: "parent",
      reason: "off track",
      at: AT,
      expiresAt: AT + DEFAULT_LATCH_TTL_MS,
    });
  });

  test.each([
    ["the older is written first", ["old", "new"]],
    ["the newer is written first", ["new", "old"]],
  ] as const)(
    "takes the latch with the latest at as current when %s",
    async (_, order) => {
      const { latch } = setup();
      const inputs = {
        old: stop({ generation: "g-old", reason: "old", at: AT }),
        new: stop({ generation: "g-new", reason: "new", at: AT + 10 }),
      };
      for (const name of order) await latch.add("s", inputs[name]);
      expect(await latch.describe("s")).toEqual({
        at: AT + 10,
        reason: "new",
        latch: "active",
      });
      expect(await latch.isActive("s", "g-new")).toBe(true);
      expect(await latch.isActive("s", "g-old")).toBe(false);
    },
  );

  test("breaks a tie on at by the greater generation, whatever the write order", async () => {
    const { latch } = setup();
    await latch.add("s1", stop({ generation: "a" }));
    await latch.add("s1", stop({ generation: "b" }));
    await latch.add("s2", stop({ generation: "b" }));
    await latch.add("s2", stop({ generation: "a" }));
    expect(await latch.isActive("s1", "b")).toBe(true);
    expect(await latch.isActive("s2", "b")).toBe(true);
  });

  test("a late inherited latch does not outrank a newer explicit one", async () => {
    const { latch, store } = setup();
    await latch.add(
      "p",
      stop({ generation: "g-parent", reason: "parent stop" }),
    );
    await latch.add(
      "c",
      stop({ generation: "g-child", reason: "child stop", at: AT + 100 }),
    );
    await latch.onEvent(sessionCreated("c", "p", NOW));
    expect(store.data.has("latch/c/g-parent")).toBe(true);
    expect(await latch.describe("c")).toMatchObject({ reason: "child stop" });
    expect(await latch.isActive("c", "g-child")).toBe(true);
  });

  test("ignores latch records it cannot parse", async () => {
    const { latch, store } = setup();
    await latch.add("s", stop());
    await store.set("latch/s/bad", { at: AT + 10, reason: 5 });
    await store.set("latch/s/", {
      parentSessionID: "parent",
      reason: "no generation",
      at: AT + 20,
      expiresAt: AT + 20 + DEFAULT_LATCH_TTL_MS,
    });
    expect(await latch.describe("s")).toMatchObject({ reason: "off track" });
  });
});

describe("enforcement on session.execution.started", () => {
  test("interrupts a run that starts under an active latch", async () => {
    const { latch, control } = setup();
    await latch.add("s", stop());
    await latch.onEvent(executionStarted("s"));
    expect(control.interrupts).toEqual(["s"]);
  });

  test.each([
    ["has no latch", async () => {}],
    [
      "has a lifted latch",
      async (latch: Latch, store: MemoryStore) => {
        await latch.add("s", stop());
        await store.set("lift/s/g1", { at: NOW });
      },
    ],
    [
      "has a latch the safety valve gave up on",
      async (latch: Latch, store: MemoryStore) => {
        await latch.add("s", stop());
        await store.set("gaveup/s/g1", { at: NOW });
      },
    ],
    [
      "has an expired latch",
      async (latch: Latch) => {
        await latch.add("s", stop({ at: NOW - DEFAULT_LATCH_TTL_MS }));
      },
    ],
  ])("leaves a run alone when the session %s", async (_, arrange) => {
    const { latch, store, control } = setup();
    await arrange(latch, store);
    await latch.onEvent(executionStarted("s"));
    expect(control.interrupts).toEqual([]);
  });

  test.each([
    [
      "the interrupt rejects",
      (control: FakeControl) => {
        control.interruptImpl = () => Promise.reject(new Error("offline"));
      },
    ],
    [
      "the store fails",
      (_: FakeControl, store: MemoryStore) => {
        store.failing.add("scan");
      },
    ],
  ])("resolves and logs a warning when %s", async (_, arrange) => {
    const { latch, store, control, logger } = setup();
    await latch.add("s", stop());
    arrange(control, store);
    await latch.onEvent(executionStarted("s"));
    expect(logger.warnings()).toHaveLength(1);
  });
});

describe("the startup pass", () => {
  test("leaves alone a run already in progress at startup until that run ends", async () => {
    const { latch, control } = setup();
    await latch.add("s", stop());
    await latch.startup(async () => true);
    await latch.onEvent(executionStarted("s"));
    expect(control.interrupts).toEqual([]);

    await latch.onEvent(executionEnded("session.execution.succeeded", "s"));
    await latch.onEvent(executionStarted("s"));
    expect(control.interrupts).toEqual(["s"]);
  });

  test("enforces the next run of a session that was idle at startup", async () => {
    const { latch, control } = setup();
    await latch.add("s", stop());
    await latch.startup(async () => false);
    await latch.onEvent(executionStarted("s"));
    expect(control.interrupts).toEqual(["s"]);
  });

  test("does not exempt a session whose run it saw start while the pass ran", async () => {
    const { latch, control } = setup();
    await latch.add("s", stop());
    const asked = deferred<void>();
    const running = deferred<boolean>();
    const pass = latch.startup(() => {
      asked.resolve();
      return running.promise;
    });
    await asked.promise;
    await latch.onEvent(executionStarted("s"));
    running.resolve(true);
    await pass;
    await latch.onEvent(executionStarted("s"));
    expect(control.interrupts).toEqual(["s", "s"]);
  });

  test("still enforces a session whose running check failed, and exempts the others", async () => {
    const { latch, control, logger } = setup();
    await latch.add("a", stop());
    await latch.add("b", stop());
    await latch.startup(async (sessionID) => {
      if (sessionID === "a") throw new Error("probe failed");
      return true;
    });
    await latch.onEvent(executionStarted("a"));
    await latch.onEvent(executionStarted("b"));
    expect(control.interrupts).toEqual(["a"]);
    expect(logger.warnings()).toHaveLength(1);
  });

  test("writes nothing", async () => {
    const { latch, store } = setup();
    await latch.add("active", stop());
    await latch.add("lifted", stop());
    await store.set("lift/lifted/g1", { at: NOW });
    await latch.add("expired", stop({ at: NOW - DEFAULT_LATCH_TTL_MS }));
    await latch.owe("active", "g1");
    const before = new Map(store.data);
    const writes = store.writes;
    await latch.startup(async () => true);
    expect(store.writes).toBe(writes);
    expect(store.data).toEqual(before);
  });

  test("resolves and logs a warning when the store fails", async () => {
    const { latch, store, logger } = setup();
    store.failing.add("scan");
    await latch.startup(async () => true);
    expect(logger.warnings()).toHaveLength(1);
  });
});

describe("lifting", () => {
  test.each(LIFTS)("lifts the active latch when %s", async (_, make) => {
    const { latch, store, control } = setup();
    await latch.add("s", stop());
    await latch.onEvent(make(NOW));
    expect(store.data.has("lift/s/g1")).toBe(true);
    expect(await latch.describe("s")).toMatchObject({ latch: "lifted" });
    await latch.onEvent(executionStarted("s"));
    expect(control.interrupts).toEqual([]);
  });

  test.each(NON_LIFTS)("keeps the latch when %s", async (_, make) => {
    const { latch, control } = setup();
    await latch.add("s", stop());
    await latch.onEvent(make(NOW));
    expect(await latch.isActive("s")).toBe(true);
    await latch.onEvent(executionStarted("s"));
    expect(control.interrupts).toEqual(["s"]);
  });

  test("lifts for an event created at the same time as the latch", async () => {
    const { latch } = setup();
    await latch.add("s", stop());
    await latch.onEvent(inboxEnqueued("s", "user", AT));
    expect(await latch.describe("s")).toMatchObject({ latch: "lifted" });
  });

  test("leaves a newer latch alone when a lift event older than it is processed late", async () => {
    const { latch, store } = setup();
    await latch.add("s", stop({ generation: "g1", at: AT }));
    await latch.add("s", stop({ generation: "g2", at: AT + 100 }));
    await latch.onEvent(inboxEnqueued("s", "user", AT + 50));
    expect(await latch.isActive("s", "g2")).toBe(true);
    expect(store.keys().filter((key) => key.startsWith("lift/"))).toEqual([]);
  });
});

describe("isActive and isLifted", () => {
  test("report nothing for a session that was never stopped", async () => {
    const { latch } = setup();
    expect(await latch.isActive("s")).toBe(false);
    expect(await latch.isActive("s", "g1")).toBe(false);
    expect(await latch.describe("s")).toBeUndefined();
  });

  test("isActive with a generation holds only while that generation is the current, active latch", async () => {
    const { latch } = setup();
    await latch.add("s", stop({ generation: "g1", at: AT }));
    expect(await latch.isActive("s", "g1")).toBe(true);
    expect(await latch.isActive("s", "other")).toBe(false);

    await latch.add("s", stop({ generation: "g2", at: AT + 1 }));
    expect(await latch.isActive("s", "g1")).toBe(false);
    expect(await latch.isActive("s", "g2")).toBe(true);

    await latch.onEvent(inboxEnqueued("s", "user", NOW));
    expect(await latch.isActive("s", "g2")).toBe(false);
    expect(await latch.isActive("s")).toBe(false);
  });

  test("isLifted reports a generation's lift after a newer latch replaced it", async () => {
    const { latch } = setup();
    await latch.add("s", stop({ generation: "g1", at: AT }));
    await latch.onEvent(inboxEnqueued("s", "user", NOW));
    await latch.add("s", stop({ generation: "g2", at: NOW + 1 }));
    expect(await latch.isLifted("s", "g1")).toBe(true);
    expect(await latch.isLifted("s", "g2")).toBe(false);
    expect(await latch.isActive("s")).toBe(true);
  });
});

describe("expiry", () => {
  test("reports a latch past its TTL as expired and stops enforcing it", async () => {
    const { latch, clock, control } = setup({ ttlMs: 1_000 });
    await latch.add("s", stop({ at: NOW - 999 }));
    await latch.onEvent(executionStarted("s"));
    expect(control.interrupts).toEqual(["s"]);

    clock.advance(1);
    expect(await latch.describe("s")).toMatchObject({ latch: "expired" });
    expect(await latch.isActive("s")).toBe(false);
    await latch.onEvent(executionStarted("s"));
    expect(control.interrupts).toEqual(["s"]);
  });

  test("reports a lift over a gaveup marker and expiry, and a gaveup marker over expiry", async () => {
    const { latch, store } = setup();
    const expired = stop({ at: NOW - DEFAULT_LATCH_TTL_MS });
    await latch.add("lifted", expired);
    await store.set("lift/lifted/g1", { at: NOW });
    await store.set("gaveup/lifted/g1", { at: NOW });
    await latch.add("gaveup", expired);
    await store.set("gaveup/gaveup/g1", { at: NOW });
    expect(await latch.describe("lifted")).toMatchObject({ latch: "lifted" });
    expect(await latch.describe("gaveup")).toMatchObject({ latch: "gave_up" });
  });
});

describe("the safety valve", () => {
  test("allows 30 re-interrupts, then gives up, writes a gaveup marker, and warns", async () => {
    const { latch, store, control, logger } = setup();
    await latch.add("s", stop());
    await wake(latch, DEFAULT_VALVE_MAX);
    expect(control.interrupts).toHaveLength(30);
    expect(store.data.has("gaveup/s/g1")).toBe(false);

    await wake(latch, 1);
    expect(control.interrupts).toHaveLength(30);
    expect(store.data.has("gaveup/s/g1")).toBe(true);
    expect(await latch.describe("s")).toMatchObject({ latch: "gave_up" });
    expect(logger.warnings()).toHaveLength(1);

    await wake(latch, 1);
    expect(control.interrupts).toHaveLength(30);
  });

  test.each([
    ["trips", DEFAULT_VALVE_WINDOW_MS - 1, 30, true],
    ["does not trip", DEFAULT_VALVE_WINDOW_MS, 31, false],
  ])(
    "%s when the 31st wake comes %p ms after the first 30",
    async (_, later, interrupts, gaveUp) => {
      const { latch, clock, store, control } = setup();
      await latch.add("s", stop());
      await wake(latch, DEFAULT_VALVE_MAX);
      clock.advance(later);
      await wake(latch, 1);
      expect(control.interrupts).toHaveLength(interrupts);
      expect(store.data.has("gaveup/s/g1")).toBe(gaveUp);
    },
  );

  test("starts a fresh count for a new stop after a lift", async () => {
    const { latch, clock, store, control } = setup();
    await latch.add("s", stop({ generation: "g1" }));
    await wake(latch, DEFAULT_VALVE_MAX);
    await latch.onEvent(inboxEnqueued("s", "user", clock.now()));
    clock.advance(1);
    await latch.add("s", stop({ generation: "g2", at: clock.now() }));

    await wake(latch, DEFAULT_VALVE_MAX);
    expect(control.interrupts).toHaveLength(60);
    await wake(latch, 1);
    expect(control.interrupts).toHaveLength(60);
    expect(store.data.has("gaveup/s/g2")).toBe(true);
    expect(store.data.has("gaveup/s/g1")).toBe(false);
  });

  test("gives up again on the next wake when the gaveup marker could not be written", async () => {
    const { latch, store, control } = setup();
    await latch.add("s", stop());
    await wake(latch, DEFAULT_VALVE_MAX);
    store.failSet = (key) => key.startsWith("gaveup/");
    await wake(latch, 1);
    expect(store.data.has("gaveup/s/g1")).toBe(false);

    store.failSet = undefined;
    await wake(latch, 1);
    expect(control.interrupts).toHaveLength(30);
    expect(store.data.has("gaveup/s/g1")).toBe(true);
  });
});

describe("the stop note", () => {
  test("is delivered once, by the prompt that lifts the latch, and then removed", async () => {
    const { latch, store } = setup();
    await latch.add("s", stop());
    await latch.owe("s", "g1");
    expect(store.data.has("note/s/g1")).toBe(true);

    expect(await latch.onPrompt("s", NOW)).toBe(
      `[stopped at ${AT}: off track]`,
    );
    expect(store.data.has("note/s/g1")).toBe(false);
    expect(store.data.has("lift/s/g1")).toBe(true);
    expect(await latch.onPrompt("s", NOW + 1)).toBeUndefined();
  });

  test("is not added when none is owed, though the prompt still lifts the latch", async () => {
    const { latch } = setup();
    await latch.add("s", stop());
    expect(await latch.onPrompt("s", NOW)).toBeUndefined();
    expect(await latch.describe("s")).toMatchObject({ latch: "lifted" });
  });

  test("is not added, and the latch stays, for a prompt older than the latch", async () => {
    const { latch } = setup();
    await latch.add("s", stop());
    await latch.owe("s", "g1");
    expect(await latch.onPrompt("s", AT - 1)).toBeUndefined();
    expect(await latch.isActive("s")).toBe(true);
  });

  test("is not added when an event already lifted the latch", async () => {
    const { latch } = setup();
    await latch.add("s", stop());
    await latch.owe("s", "g1");
    await latch.onEvent(inboxEnqueued("s", "user", NOW));
    expect(await latch.onPrompt("s", NOW + 1)).toBeUndefined();
  });

  test("is still returned when its key cannot be removed", async () => {
    const { latch, store, logger } = setup();
    await latch.add("s", stop());
    await latch.owe("s", "g1");
    store.failing.add("remove");
    expect(await latch.onPrompt("s", NOW)).toBe(
      `[stopped at ${AT}: off track]`,
    );
    expect(logger.warnings()).toHaveLength(1);
  });

  test.each(["scan", "get", "set"] as const)(
    "is skipped, and the prompt left alone, when the store's %s throws",
    async (method) => {
      const { latch, store, logger } = setup();
      await latch.add("s", stop());
      await latch.owe("s", "g1");
      store.failing.add(method);
      expect(await latch.onPrompt("s", NOW)).toBeUndefined();
      expect(logger.warnings()).toHaveLength(1);

      store.failing.clear();
      expect(await latch.isActive("s")).toBe(true);
    },
  );
});

describe("inheritance on session.created", () => {
  test("latches a new child of a stopped session with the parent's generation and times", async () => {
    const { latch, store, clock, control } = setup();
    await latch.add("p", stop({ generation: "gp", parentSessionID: "caller" }));
    clock.advance(60_000);
    await latch.onEvent(sessionCreated("c", "p", clock.now()));
    expect(store.data.get("latch/c/gp")).toEqual({
      parentSessionID: "caller",
      reason: "off track",
      at: AT,
      expiresAt: AT + DEFAULT_LATCH_TTL_MS,
    });
    await latch.onEvent(executionStarted("c"));
    expect(control.interrupts).toEqual(["c"]);
  });

  test.each([
    ["has no latch", async () => {}],
    [
      "has a lifted latch",
      async (latch: Latch, store: MemoryStore) => {
        await latch.add("p", stop());
        await store.set("lift/p/g1", { at: NOW });
      },
    ],
    [
      "has an expired latch",
      async (latch: Latch) => {
        await latch.add("p", stop({ at: NOW - DEFAULT_LATCH_TTL_MS }));
      },
    ],
  ])("leaves a new child alone when its parent %s", async (_, arrange) => {
    const { latch, store } = setup();
    await arrange(latch, store);
    await latch.onEvent(sessionCreated("c", "p", NOW));
    expect(store.keys().filter((key) => key.startsWith("latch/c/"))).toEqual(
      [],
    );
  });
});

describe("deletion", () => {
  test("removes every key of the deleted session and no other session's", async () => {
    const { latch, store } = setup();
    await latch.add("s", stop({ generation: "g1" }));
    await latch.add("s", stop({ generation: "g2", at: AT + 1 }));
    await store.set("lift/s/g1", { at: NOW });
    await store.set("gaveup/s/g2", { at: NOW });
    await latch.owe("s", "g2");
    // "s2" shares the prefix "s" and must survive.
    await latch.add("s2", stop());
    await latch.owe("s2", "g1");
    await latch.add("other", stop());

    await latch.onEvent(sessionDeleted("s", NOW));
    expect(store.keys()).toEqual([
      "latch/other/g1",
      "latch/s2/g1",
      "note/s2/g1",
    ]);
  });
});
