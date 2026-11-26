import { describe, expect, test } from "bun:test";
import {
  DEFAULT_LATCH_TTL_MS,
  Latch,
  type LatchInput,
  type LatchOptions,
  type StopDescription,
} from "@/core/latch";
import type { Json, SessionInfo } from "@/core/ports";
import {
  ClockScheduler,
  deferred,
  executionStarted,
  FakeClock,
  FakeControl,
  FakeSessionReader,
  flush,
  inboxEnqueued,
  MemoryStore,
  RecordingLogger,
  sessionCreated,
  sessionInfo,
} from "./fixtures";
import { ToolWorld } from "./tool-world";

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
/** The grace period with the default 24-hour TTL. */
const WEEK = 7 * DAY;
/** When the oldest stop under test started. */
const T0 = 1_000_000_000_000;
/** An expiry written by a copy with a much longer TTL, so only its markers end such a stop. */
const FAR = T0 + 100 * DAY;

/**
 * Records removals in order, the prefix of every scan as it starts, and how many reads (gets and
 * scans) were made. `beforeRemove` runs first and can hold, fail or interleave one. `afterScan`
 * runs once a scan has read its keys, before the caller gets them, so writes it makes land between
 * that scan and the caller's next read.
 */
class RecordingStore extends MemoryStore {
  readonly removed: string[] = [];
  readonly scans: string[] = [];
  reads = 0;
  beforeRemove: ((key: string) => Promise<void> | void) | undefined;
  afterScan: ((prefix: string) => Promise<void> | void) | undefined;

  override async get(key: string): Promise<Json | undefined> {
    this.reads++;
    return super.get(key);
  }

  override async remove(key: string): Promise<void> {
    await this.beforeRemove?.(key);
    await super.remove(key);
    this.removed.push(key);
  }

  override async scan(
    prefix: string,
  ): Promise<ReadonlyArray<{ readonly key: string; readonly value: Json }>> {
    this.reads++;
    this.scans.push(prefix);
    const entries = await super.scan(prefix);
    await this.afterScan?.(prefix);
    return entries;
  }
}

/**
 * Runs `action` once, after the first scan of exactly `prefix` has read its keys and before its
 * caller gets them. Hooks installed earlier still run.
 */
function afterFirstScan(
  store: RecordingStore,
  prefix: string,
  action: () => Promise<void>,
): void {
  const earlier = store.afterScan;
  let ran = false;
  store.afterScan = async (scanned) => {
    await earlier?.(scanned);
    if (ran || scanned !== prefix) return;
    ran = true;
    await action();
  };
}

function setup(now: number, options?: LatchOptions) {
  const store = new RecordingStore();
  const clock = new FakeClock(now);
  const logger = new RecordingLogger();
  const latch = new Latch(
    {
      store,
      control: new FakeControl(),
      clock,
      logger,
      renderNote: () => "",
      scheduler: new ClockScheduler(clock),
    },
    options,
  );
  return { store, clock, logger, latch };
}

function stop(overrides: Partial<LatchInput> = {}): LatchInput {
  return {
    generation: "g1",
    parentSessionID: "parent",
    reason: "off track",
    at: T0,
    ...overrides,
  };
}

interface StoredStop {
  readonly at: number;
  /** Defaults to a day after `at`, as the default TTL sets it. */
  readonly expiresAt?: number;
  readonly lift?: number;
  readonly gaveup?: number;
  readonly note?: boolean;
  readonly reason?: string;
}

/** Writes one generation's keys as any copy of the plugin could have written them. */
async function write(
  store: MemoryStore,
  sessionID: string,
  generation: string,
  stored: StoredStop,
): Promise<void> {
  await store.set(`latch/${sessionID}/${generation}`, {
    parentSessionID: "parent",
    reason: stored.reason ?? generation,
    at: stored.at,
    expiresAt: stored.expiresAt ?? stored.at + DEFAULT_LATCH_TTL_MS,
  });
  if (stored.lift !== undefined) {
    await store.set(`lift/${sessionID}/${generation}`, { at: stored.lift });
  }
  if (stored.gaveup !== undefined) {
    await store.set(`gaveup/${sessionID}/${generation}`, { at: stored.gaveup });
  }
  if (stored.note === true) {
    await store.set(`note/${sessionID}/${generation}`, { at: stored.at });
  }
}

/** Whether `promise` settled once pending callbacks ran. */
async function settles(promise: Promise<unknown>): Promise<boolean> {
  let settled = false;
  void promise.then(() => {
    settled = true;
  });
  await flush();
  return settled;
}

describe("which sessions a sweep removes", () => {
  test.each([
    { label: "the default 24-hour TTL", ttlMs: undefined, grace: WEEK, days: 7 },
    { label: "a 3-day TTL", ttlMs: 3 * DAY, grace: WEEK, days: 7 },
    { label: "a 5-day TTL", ttlMs: 5 * DAY, grace: 10 * DAY, days: 10 },
  ])(
    "with $label, keeps a stop's records for $days days after it expired and removes them after",
    async ({ ttlMs, grace }) => {
      const ttl = ttlMs ?? DEFAULT_LATCH_TTL_MS;
      const { latch, store, clock } = setup(
        T0 + ttl + grace,
        ttlMs === undefined ? {} : { ttlMs },
      );
      await latch.add("s", stop());
      await latch.sweep();
      expect(store.keys()).toEqual(["latch/s/g1"]);

      clock.advance(1);
      await latch.sweep();
      expect(store.keys()).toEqual([]);
    },
  );

  test.each([
    ["its expiry", {}, T0 + DEFAULT_LATCH_TTL_MS],
    ["its lift", { lift: T0 + HOUR }, T0 + HOUR],
    ["its give-up", { gaveup: T0 + 2 * HOUR }, T0 + 2 * HOUR],
    [
      "a lift that came before its give-up",
      { lift: T0 + HOUR, gaveup: T0 + 2 * HOUR },
      T0 + HOUR,
    ],
    [
      "a give-up that came before its lift",
      { lift: T0 + 3 * HOUR, gaveup: T0 + 2 * HOUR },
      T0 + 2 * HOUR,
    ],
  ])("dates a stop's end from %s", async (_, markers, endedAt) => {
    const { latch, store, clock } = setup(endedAt + WEEK);
    await write(store, "s", "g1", { at: T0, ...markers });
    await latch.sweep();
    expect(store.data.has("latch/s/g1")).toBe(true);

    clock.advance(1);
    await latch.sweep();
    expect(store.keys()).toEqual([]);
  });

  test("keeps a session whose newest stop is still active, however long ago it started", async () => {
    const { latch, store } = setup(T0 + 30 * DAY);
    await write(store, "s", "g0", { at: T0, lift: T0 + HOUR });
    await write(store, "s", "g1", { at: T0 + 2 * HOUR, expiresAt: FAR });
    const before = store.keys();
    await latch.sweep();
    expect(store.keys()).toEqual(before);
    expect(await latch.isActive("s", "g1")).toBe(true);
  });

  test("keeps every generation while the newest one ended within the grace period", async () => {
    const now = T0 + 30 * DAY;
    const { latch, store } = setup(now);
    await write(store, "s", "g0", { at: T0, lift: T0 + HOUR, note: true });
    await write(store, "s", "g1", { at: now - 3 * DAY, lift: now - 2 * DAY });
    const before = store.keys();
    await latch.sweep();
    expect(store.keys()).toEqual(before);
  });

  test.each([
    ["sweeps the session when the greater generation ended long ago", "b", "a", []],
    [
      "keeps the session when the greater generation is still active",
      "a",
      "b",
      ["latch/s/a", "latch/s/b", "lift/s/a"],
    ],
  ] as const)(
    "with two stops at the same time, %s",
    async (_, ended, active, kept) => {
      const { latch, store } = setup(T0 + 30 * DAY);
      await write(store, "s", ended, { at: T0, lift: T0 + HOUR });
      await write(store, "s", active, { at: T0, expiresAt: FAR });
      await latch.sweep();
      expect(store.keys()).toEqual([...kept]);
    },
  );

  test("removes every latch, lift, gaveup and note key of a swept session and no other session's", async () => {
    const now = T0 + 30 * DAY;
    const { latch, store } = setup(now);
    await write(store, "s", "g1", { at: T0, lift: T0 + HOUR, note: true });
    await write(store, "s", "g2", { at: T0 + 2 * HOUR, gaveup: T0 + 3 * HOUR, note: true });
    // A marker whose latch record is gone, and a latch record nobody can read.
    await store.set("lift/s/g0", { at: T0 });
    await store.set("latch/s/bad", { at: T0, reason: 5 });
    // "s2" shares the prefix "s"; its stop is recent.
    await latch.add("s2", stop({ at: now - DAY }));
    await latch.owe("s2", "g1");
    // An old stop that is still active.
    await write(store, "other", "g1", { at: T0, expiresAt: FAR });

    await latch.sweep();
    expect(store.keys()).toEqual(["latch/other/g1", "latch/s2/g1", "note/s2/g1"]);
  });

  test("removes a swept session's keys that name no generation", async () => {
    const { latch, store } = setup(T0 + 30 * DAY);
    await write(store, "s", "g1", { at: T0, lift: T0 + HOUR });
    for (const kind of ["latch", "lift", "gaveup", "note"]) {
      await store.set(`${kind}/s/`, { at: T0 });
    }
    await latch.sweep();
    expect(store.keys()).toEqual([]);
  });
});

describe("a stop added while a sweep runs", () => {
  test("keeps a session that got a new stop after the pass read the stop records", async () => {
    const now = T0 + 30 * DAY;
    const { latch, store } = setup(now);
    // "a" is older, so the pass removes it before it reaches "s".
    await write(store, "a", "g1", { at: T0 });
    await write(store, "s", "g1", { at: T0 + HOUR });
    store.beforeRemove = async (key) => {
      if (key === "latch/a/g1") {
        await latch.add("s", stop({ generation: "g2", at: now, reason: "new" }));
      }
    };
    await latch.sweep();
    expect(store.keys()).toEqual(["latch/s/g1", "latch/s/g2"]);
    expect(await latch.describe("s")).toEqual({
      at: now,
      reason: "new",
      latch: "active",
    });
  });

  test("leaves a stop written while the session's old records are being removed", async () => {
    const now = T0 + 30 * DAY;
    const { latch, store } = setup(now);
    await write(store, "s", "g1", { at: T0, lift: T0 + HOUR, note: true });
    let added = false;
    store.beforeRemove = async () => {
      if (added) return;
      added = true;
      await latch.add("s", stop({ generation: "g2", at: now, reason: "new" }));
    };
    await latch.sweep();
    expect(store.keys()).toEqual(["latch/s/g2"]);
    expect(await latch.isActive("s", "g2")).toBe(true);
  });

  test.each(["lift", "gaveup", "note"])(
    "reads the session's latch records only once its %s keys have been read",
    async (kind) => {
      const { latch, store } = setup(T0 + 30 * DAY);
      await write(store, "s", "g1", { at: T0, lift: T0 + HOUR, note: true });
      const held = deferred<void>();
      store.afterScan = (prefix) =>
        prefix === `${kind}/s/` ? held.promise : undefined;
      const pass = latch.sweep();
      await flush();
      expect(store.scans).toContain(`${kind}/s/`);
      expect(store.scans).not.toContain("latch/s/");

      held.resolve();
      await pass;
      expect(store.scans).toContain("latch/s/");
      expect(store.keys()).toEqual([]);
    },
  );

  // Another copy writes stop g2 on "s", latch record first and then its markers, while a pass
  // sweeps g1, which ended long ago.
  const NOW = T0 + 30 * DAY;
  const UNLIFTED_G2: StoredStop = { at: NOW, note: true, reason: "new" };
  const G2: StoredStop = { ...UNLIFTED_G2, lift: NOW };
  const LIFTED_G2: StopDescription = { at: NOW, reason: "new", latch: "lifted" };
  const EVERY_KEY = [
    "latch/s/g1",
    "latch/s/g2",
    "lift/s/g1",
    "lift/s/g2",
    "note/s/g1",
    "note/s/g2",
  ];
  const WRITES: ReadonlyArray<
    readonly [string, (store: RecordingStore) => void, readonly string[]]
  > = [
    [
      "after the pass read every latch record and before it reads the session's markers",
      (store) =>
        afterFirstScan(store, "latch/", () => write(store, "s", "g2", G2)),
      EVERY_KEY,
    ],
    [
      "after the pass read the session's markers and before it reads its latch records",
      (store) =>
        afterFirstScan(store, "lift/s/", () => write(store, "s", "g2", G2)),
      EVERY_KEY,
    ],
    [
      "before the pass reads the session's markers, and is lifted after it read them",
      (store) => {
        afterFirstScan(store, "latch/", () =>
          write(store, "s", "g2", UNLIFTED_G2),
        );
        afterFirstScan(store, "lift/s/", () =>
          store.set("lift/s/g2", { at: NOW }),
        );
      },
      EVERY_KEY,
    ],
    [
      "after the pass read the session's latch records and before it removes anything",
      (store) =>
        afterFirstScan(store, "latch/s/", () => write(store, "s", "g2", G2)),
      ["latch/s/g2", "lift/s/g2", "note/s/g2"],
    ],
    [
      "after the pass read the session's latch records, while it removes g1",
      (store) => {
        let written = false;
        store.beforeRemove = async () => {
          if (written) return;
          written = true;
          await write(store, "s", "g2", G2);
        };
      },
      ["latch/s/g2", "lift/s/g2", "note/s/g2"],
    ],
  ];

  test.each(WRITES)(
    "keeps the latch record and every marker of a stop written %s",
    async (_, interleave, kept) => {
      const { latch, store } = setup(NOW);
      await write(store, "s", "g1", { at: T0, lift: T0 + HOUR, note: true });
      interleave(store);
      await latch.sweep();
      expect(store.keys()).toEqual([...kept]);
      expect(await latch.describe("s")).toEqual(LIFTED_G2);
    },
  );
});

describe("the order of removal", () => {
  test("removes older generations first and the newest last, each latch record before its markers", async () => {
    const { latch, store } = setup(T0 + 30 * DAY);
    // Written newest first, so the order cannot come from the order of writes.
    await write(store, "s", "g3", { at: T0 + 4 * HOUR, lift: T0 + 5 * HOUR, note: true });
    await write(store, "s", "g2", { at: T0 + 2 * HOUR, gaveup: T0 + 3 * HOUR, note: true });
    await write(store, "s", "g1", { at: T0, lift: T0 + HOUR, gaveup: T0 + HOUR, note: true });
    await latch.sweep();

    const removed = store.removed;
    expect(removed).toHaveLength(10);
    const generation = (key: string) => key.split("/")[2];
    // Generations appear in contiguous runs, oldest first.
    expect(
      removed.map(generation).filter((value, index, all) => all[index - 1] !== value),
    ).toEqual(["g1", "g2", "g3"]);
    for (const name of ["g1", "g2", "g3"]) {
      expect(removed.find((key) => generation(key) === name)).toBe(`latch/s/${name}`);
    }
  });

  // g1 and g2 were written by a copy with a long TTL, so each stays ended only through its marker.
  // Seven keys: g1's three, then g2's three, then the orphaned lift/s/g0, which the session's sweep
  // leaves to the orphan-marker phase because g0 has no latch record.
  const NEWEST: StopDescription = {
    at: T0 + 2 * HOUR,
    reason: "newest",
    latch: "gave_up",
  };
  async function longLivedStops(store: MemoryStore): Promise<void> {
    await store.set("lift/s/g0", { at: T0 });
    await write(store, "s", "g1", {
      at: T0,
      expiresAt: FAR,
      lift: T0 + HOUR,
      note: true,
      reason: "older",
    });
    await write(store, "s", "g2", {
      at: NEWEST.at,
      expiresAt: FAR,
      gaveup: T0 + 3 * HOUR,
      note: true,
      reason: NEWEST.reason,
    });
  }

  test.each([0, 1, 2, 3, 4, 5, 6])(
    "a sweep cut short after %i removals leaves the newest stop current, ended, or no stop at all",
    async (removals) => {
      const { latch, store, logger } = setup(T0 + 30 * DAY);
      await longLivedStops(store);
      store.beforeRemove = () => {
        if (store.removed.length >= removals) {
          throw new Error("storage went away");
        }
      };
      await latch.sweep();
      expect(store.removed).toHaveLength(removals);
      expect(logger.warnings()).toHaveLength(1);
      expect([undefined, NEWEST]).toContainEqual(await latch.describe("s"));
      expect(await latch.isActive("s")).toBe(false);
    },
  );

  test("disposal stops a sweep between removals, keeping the newest stop current", async () => {
    const { latch, store, clock } = setup(T0 + 30 * DAY);
    await longLivedStops(store);
    store.beforeRemove = () => {
      if (store.removed.length === 2) latch.dispose();
    };
    await latch.sweep();
    expect(store.removed).toHaveLength(3);
    expect(await latch.describe("s")).toEqual(NEWEST);
    expect(clock.pendingTimers).toBe(0);
  });

  test("removes a swept session's marker whose generation has no latch record only after every key of its stops", async () => {
    const { latch, store } = setup(T0 + 30 * DAY);
    await longLivedStops(store);
    await latch.sweep();
    expect(store.removed).toHaveLength(7);
    expect(store.removed.at(-1)).toBe("lift/s/g0");
  });
});

describe("markers whose latch record is gone", () => {
  const NOW = T0 + 30 * DAY;

  test("are removed, whatever their kind, while every latch record stays, readable or not", async () => {
    const { latch, store } = setup(NOW);
    await store.set("lift/o/g1", { at: T0 });
    await store.set("gaveup/o/g1", { at: T0 });
    await store.set("note/o/g2", { at: T0 });
    // A latch record nobody can read is still a record, so its marker stays.
    await store.set("latch/u/bad", { at: T0, reason: 5 });
    await store.set("lift/u/bad", { at: T0 });
    await write(store, "s", "g1", { at: NOW - HOUR, note: true });
    await latch.sweep();
    expect(store.keys()).toEqual([
      "latch/s/g1",
      "latch/u/bad",
      "lift/u/bad",
      "note/s/g1",
    ]);
  });

  test("are removed beside an active stop, which keeps its own markers and stays active", async () => {
    const { latch, store } = setup(NOW);
    await write(store, "s", "g2", { at: NOW - HOUR, note: true });
    await store.set("lift/s/g1", { at: T0 });
    await store.set("gaveup/s/g0", { at: T0 });
    await latch.sweep();
    expect(store.keys()).toEqual(["latch/s/g2", "note/s/g2"]);
    expect(await latch.isActive("s", "g2")).toBe(true);
  });

  test("of a stop written after the pass read the latch records are all kept", async () => {
    const { latch, store } = setup(NOW);
    store.afterScan = async (prefix) => {
      if (prefix !== "latch/") return;
      store.afterScan = undefined;
      await write(store, "s", "g1", { at: NOW, lift: NOW, note: true });
    };
    await latch.sweep();
    expect(store.keys()).toEqual(["latch/s/g1", "lift/s/g1", "note/s/g1"]);
  });

  test("left by a pass that failed partway through a session are kept that pass, with one warning, and removed by the next", async () => {
    const { latch, store, logger } = setup(NOW);
    await write(store, "s", "g1", { at: T0, lift: T0 + HOUR, note: true });
    // The latch record goes first, then the lift marker's removal fails.
    store.beforeRemove = (key) => {
      if (key === "lift/s/g1") throw new Error("storage went away");
    };
    await latch.sweep();
    expect(store.keys()).toEqual(["lift/s/g1", "note/s/g1"]);
    expect(logger.warnings()).toHaveLength(1);

    store.beforeRemove = undefined;
    await latch.sweep();
    expect(store.keys()).toEqual([]);
    expect(logger.warnings()).toHaveLength(1);
  });

  test("of the other sessions are still removed when one session's cannot be, with one warning", async () => {
    const { latch, store, logger } = setup(NOW);
    await store.set("lift/a/g1", { at: T0 });
    await store.set("lift/b/g1", { at: T0 + 1 });
    store.beforeRemove = (key) => {
      if (key === "lift/a/g1") throw new Error("storage refused");
    };
    await latch.sweep();
    expect(store.keys()).toEqual(["lift/a/g1"]);
    expect(logger.warnings()).toHaveLength(1);
  });

  test("are removed for 100 sessions per pass, the session with the oldest marker first", async () => {
    const { latch, store } = setup(NOW);
    // Written newest first, so the order cannot come from the order of writes.
    for (let index = 100; index >= 1; index--) {
      await store.set(`lift/o${index}/g1`, { at: T0 + index });
    }
    // Its first marker found is newer than every other session's, but its note is the oldest.
    await store.set("lift/mixed/g1", { at: T0 + 1000 });
    await store.set("note/mixed/g1", { at: T0 - 1 });
    await latch.sweep();
    expect(store.keys()).toEqual(["lift/o100/g1"]);

    await latch.sweep();
    expect(store.keys()).toEqual([]);
  });

  test("are left alone once the latch is disposed during the pass", async () => {
    const { latch, store } = setup(NOW);
    await write(store, "a", "g1", { at: T0 });
    await store.set("lift/o/g1", { at: T0 });
    store.beforeRemove = (key) => {
      if (key === "latch/a/g1") latch.dispose();
    };
    await latch.sweep();
    expect(store.removed).toEqual(["latch/a/g1"]);
    expect(store.keys()).toEqual(["lift/o/g1"]);
  });
});

describe("when sweeps run", () => {
  const SIX_HOURS = 6 * HOUR;
  const idle = async () => false;

  test("the startup pass returns without waiting for its sweep", async () => {
    const { latch, store } = setup(T0 + 30 * DAY);
    await latch.add("s", stop());
    const gate = deferred<void>();
    store.beforeRemove = () => gate.promise;
    expect(await settles(latch.startup(idle))).toBe(true);
    expect(store.keys()).toEqual(["latch/s/g1"]);

    gate.resolve();
    await flush();
    expect(store.keys()).toEqual([]);
  });

  test("sweeps again every six hours after the startup pass", async () => {
    const { latch, store, clock } = setup(T0 + 30 * DAY);
    await latch.startup(idle);
    await flush();
    await latch.add("s", stop());
    clock.advance(SIX_HOURS - 1);
    await flush();
    expect(store.keys()).toEqual(["latch/s/g1"]);

    clock.advance(1);
    await flush();
    expect(store.keys()).toEqual([]);

    await latch.add("t", stop());
    clock.advance(SIX_HOURS);
    await flush();
    expect(store.keys()).toEqual([]);
  });

  test("a startup pass after a gap in the event stream does not sweep", async () => {
    const { latch, store } = setup(T0 + 30 * DAY);
    await latch.startup(idle);
    await flush();
    await latch.add("s", stop());
    await latch.startup(idle);
    await flush();
    expect(store.keys()).toEqual(["latch/s/g1"]);
  });

  test("leaves the sweep to the timer when the startup scan fails", async () => {
    const { latch, store, clock, logger } = setup(T0 + 30 * DAY);
    await latch.add("s", stop());
    store.failing.add("scan");
    await latch.startup(idle);
    store.failing.clear();
    await flush();
    expect(logger.warnings()).toHaveLength(1);
    expect(store.keys()).toEqual(["latch/s/g1"]);

    clock.advance(SIX_HOURS);
    await flush();
    expect(store.keys()).toEqual([]);
  });

  test("keeps the timer going after a pass fails", async () => {
    const { latch, store, clock, logger } = setup(T0 + 30 * DAY);
    await latch.add("s", stop());
    store.failing.add("scan");
    await latch.sweep();
    expect(logger.warnings()).toHaveLength(1);

    store.failing.clear();
    clock.advance(SIX_HOURS);
    await flush();
    expect(store.keys()).toEqual([]);
  });

  test("disposal cancels the next pass", async () => {
    const { latch, store, clock } = setup(T0 + 30 * DAY);
    await latch.startup(idle);
    await flush();
    latch.dispose();
    await latch.add("s", stop());
    clock.advance(SIX_HOURS);
    await flush();
    expect(store.keys()).toEqual(["latch/s/g1"]);
  });

  test("one pass looks at 100 sessions, oldest stop first", async () => {
    const { latch, store } = setup(T0 + 30 * DAY);
    // Written newest first, so the order cannot come from the order of writes.
    for (let index = 100; index >= 0; index--) {
      await latch.add(`s${index}`, stop({ at: T0 + index }));
    }
    await latch.sweep();
    expect(store.keys()).toEqual(["latch/s100/g1"]);

    await latch.sweep();
    expect(store.keys()).toEqual([]);
  });

  test("goes on to the next session when one session's records cannot be removed", async () => {
    const { latch, store, logger } = setup(T0 + 30 * DAY);
    await latch.add("a", stop());
    await latch.add("b", stop({ at: T0 + 1 }));
    store.beforeRemove = (key) => {
      if (key === "latch/a/g1") throw new Error("storage refused");
    };
    await latch.sweep();
    expect(store.keys()).toEqual(["latch/a/g1"]);
    expect(logger.warnings()).toHaveLength(1);
  });
});

describe("a stop another copy collects while this copy reads it", () => {
  const NOW = T0 + 30 * DAY;

  /** `sessionID` as OpenCode 2.2.2 and later store a session whose run started at NOW. */
  function openRun(sessionID: string): SessionInfo {
    const base = sessionInfo(sessionID, "parent");
    const time: SessionInfo["time"] & { busy?: number } = {
      ...base.time,
      busy: NOW,
    };
    return { ...base, time };
  }

  /**
   * Two copies over one store. `latch` keeps stops for 100 days: it stopped `sessionID` at T0 and
   * the stop was lifted an hour later, so its stored expiry is still 70 days ahead. `other` has the
   * default TTL, so its sweep collects that stop a week after the lift. `collectWhenRead` runs that
   * sweep once `latch` has read the stop's latch record and before it reads the markers.
   */
  async function copies(sessionID = "s") {
    const store = new RecordingStore();
    const clock = new FakeClock(NOW);
    const control = new FakeControl();
    const logger = new RecordingLogger();
    const latch = new Latch(
      {
        store,
        control,
        clock,
        logger,
        renderNote: () => "note",
        reader: new FakeSessionReader([openRun(sessionID)]),
      },
      { ttlMs: 100 * DAY },
    );
    const other = new Latch({
      store,
      control,
      clock,
      logger,
      renderNote: () => "note",
    });
    await latch.add(sessionID, stop());
    await store.set(`lift/${sessionID}/g1`, { at: T0 + HOUR });
    const collectWhenRead = (prefix = `latch/${sessionID}/`) =>
      afterFirstScan(store, prefix, () => other.sweep());
    return { store, clock, control, latch, collectWhenRead };
  }

  test.each([
    ["isActive", (latch: Latch) => latch.isActive("s"), false],
    ["isActive for its generation", (latch: Latch) => latch.isActive("s", "g1"), false],
    ["describe", (latch: Latch) => latch.describe("s"), undefined],
  ] as const)("%s reports no stop", async (_, read, expected) => {
    const { latch, store, collectWhenRead } = await copies();
    collectWhenRead();
    expect(await read(latch)).toBe(expected);
    expect(store.keys()).toEqual([]);
  });

  test("the context hook lets the run's model request go ahead at once", async () => {
    const { latch, store, clock, control, collectWhenRead } = await copies();
    // A notice that wakes the subagent; it lifts no stop.
    await latch.onEvent(inboxEnqueued("s", "synthetic", NOW));
    collectWhenRead();
    expect(await settles(latch.beforeRequest("s"))).toBe(true);
    expect(clock.pendingTimers).toBe(0);
    expect(control.interrupts).toEqual([]);
    expect(store.keys()).toEqual([]);
  });

  test("a run that starts is not interrupted", async () => {
    const { latch, store, control, collectWhenRead } = await copies();
    collectWhenRead();
    await latch.onEvent(executionStarted("s", NOW));
    expect(control.interrupts).toEqual([]);
    expect(store.keys()).toEqual([]);
  });

  test.each([
    ["a prompt", (latch: Latch) => latch.onPrompt("s", NOW)],
    [
      "a person's message",
      (latch: Latch) => latch.onEvent(inboxEnqueued("s", "user", NOW)),
    ],
  ] as const)("%s writes no lift for it", async (_, lift) => {
    const { latch, store, collectWhenRead } = await copies();
    collectWhenRead();
    expect(await lift(latch)).toBeUndefined();
    expect(store.keys()).toEqual([]);
  });

  test("a child created under it inherits no stop", async () => {
    const { latch, store, collectWhenRead } = await copies("p");
    collectWhenRead();
    await latch.onEvent(sessionCreated("c", "p", NOW));
    expect(store.keys()).toEqual([]);
  });

  test("the startup pass leaves its running session unexempted, so a later stop holds the next run", async () => {
    const { latch, store, control, collectWhenRead } = await copies();
    collectWhenRead("latch/");
    await latch.startup(async () => true);
    await flush();
    expect(store.keys()).toEqual([]);

    await latch.add("s", stop({ generation: "g2", at: NOW }));
    await latch.onEvent(executionStarted("s", NOW));
    expect(control.interrupts).toEqual(["s"]);
  });

  test("telling it from an active stop costs one more storage read, only for a stop that would read as active", async () => {
    const { latch, store } = setup(T0);
    await write(store, "lifted", "g1", { at: T0, lift: T0 });
    await write(store, "gaveup", "g1", { at: T0, gaveup: T0 });
    await write(store, "expired", "g1", { at: T0 - DEFAULT_LATCH_TTL_MS });
    await write(store, "active", "g1", { at: T0 });
    const reads = async (sessionID: string): Promise<number> => {
      const before = store.reads;
      await latch.isActive(sessionID);
      return store.reads - before;
    };
    const ended = await reads("lifted");
    expect(await reads("gaveup")).toBe(ended);
    expect(await reads("expired")).toBe(ended);
    expect(await reads("active")).toBe(ended + 1);
  });
});

describe("what the tools show after a sweep", () => {
  test.each([
    [
      "subagents.list",
      async (world: ToolWorld) => (await world.list()).output.entries[0],
    ],
    [
      "subagents.inspect",
      async (world: ToolWorld) => (await world.inspect("ses_child")).output,
    ],
  ] as const)(
    "%s shows no stop that another copy collects while it reads it",
    async (_, read) => {
      const store = new RecordingStore();
      const world = new ToolWorld({ store }).add("ses_child");
      const at = world.clock.now();
      world.clock.advance(30 * DAY);
      // Written by a copy with a long TTL and lifted an hour later, so its stored expiry is ahead.
      await write(store, "ses_child", "g1", {
        at,
        expiresAt: at + 100 * DAY,
        lift: at + HOUR,
      });
      const other = new Latch({
        store,
        control: world.control,
        clock: world.clock,
        logger: world.logger,
        renderNote: () => "",
      });
      afterFirstScan(store, "latch/ses_child/", () => other.sweep());
      const shown = await read(world);
      expect(shown).toMatchObject({ sessionID: "ses_child" });
      expect(shown).not.toHaveProperty("stopped");
      expect(store.keys()).toEqual([]);
    },
  );

  test("subagents.list and subagents.inspect no longer show a swept stop", async () => {
    const world = new ToolWorld().add("ses_child");
    const at = world.clock.now();
    await world.latch.add("ses_child", stop({ at }));
    await world.latch.onEvent(inboxEnqueued("ses_child", "user", at + 1));
    const stopped: StopDescription = { at, reason: "off track", latch: "lifted" };
    expect((await world.list()).output.entries[0]?.stopped).toEqual(stopped);
    expect((await world.inspect("ses_child")).output.stopped).toEqual(stopped);

    world.clock.advance(WEEK + 2);
    await world.latch.sweep();
    expect((await world.list()).output.entries[0]).not.toHaveProperty("stopped");
    expect((await world.inspect("ses_child")).output).not.toHaveProperty("stopped");
  });
});
