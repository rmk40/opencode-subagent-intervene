import { describe, expect, test } from "bun:test";
import {
  MAX_SCAN_SESSIONS,
  MAX_SUBTREE_DEPTH,
  MAX_SUBTREE_SESSIONS,
  NotDescendantError,
  SelfTargetError,
  SubtreeTooLargeError,
} from "@/core/ancestry";
import { Latch } from "@/core/latch";
import type {
  Json,
  RunObservation,
  RunState,
  SessionID,
  SessionInfo,
} from "@/core/ports";
import { EmptyReasonError } from "@/core/sanitize";
import {
  MAX_TARGETS,
  type NodeResult,
  NOTHING_FOUND_RUNNING_NOTE,
  NOTHING_RUNNING_NOTE,
  PARTIAL_CHECK_NOTE,
  type StopCall,
  type StopDeps,
  StopInputError,
  type StopOptions,
  type StopOutput,
  STOPPED_NOTE,
  type StopRequest,
  stopSubagents,
} from "@/core/stop";
import {
  FakeClock,
  FakeControl,
  FakeSessionReader,
  flush,
  MemoryStore,
  RecordingLogger,
  sessionInfo,
} from "./fixtures";

const CALLER = "caller";
/** The generation of the stop under test. It names every key the stop writes. */
const GEN = "gen";
const START = 1_000_000;
const SETTLE_MS = 1_000;
const LATCH_TTL_MS = 60 * 60 * 1000;
const REASON = "off track";
const FOREVER = Number.POSITIVE_INFINITY;

type Outcome = NonNullable<SessionInfo["outcome"]>;

interface SessionSpec {
  /** Defaults to the caller. */
  readonly parentID?: SessionID;
  /** Defaults to idle. */
  readonly state?: RunState;
  readonly agent?: string;
  readonly title?: string;
  /** `time.idle` and `outcome` left by a run that ended before the stop. */
  readonly idle?: number;
  readonly outcome?: Outcome;
  /** Interrupts the run ignores before it ends; `FOREVER` for a run that never ends. */
  readonly resist?: number;
  /** How core records the run an interrupt ends. Defaults to interrupted. */
  readonly endsAs?: Outcome;
  /** The session is deleted just before its first interrupt reaches it. */
  readonly deleteOnInterrupt?: boolean;
}

type StoreOp = "set" | "scan";

/** A store that reports each write once it lands and each scan before it runs. */
class TracedStore extends MemoryStore {
  private readonly report: (op: StoreOp, key: string) => void;

  constructor(report: (op: StoreOp, key: string) => void) {
    super();
    this.report = report;
  }

  override async set(key: string, value: Json): Promise<void> {
    await super.set(key, value);
    this.report("set", key);
  }

  override async scan(
    prefix: string,
  ): Promise<ReadonlyArray<{ readonly key: string; readonly value: Json }>> {
    this.report("scan", prefix);
    return super.scan(prefix);
  }
}

type Settled<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: unknown };

/**
 * Runs `promise` to the end. Whenever nothing else can make progress, moves the fake clock to the
 * next pending sleep, so a settle wait that times out takes exactly its fake duration.
 */
async function drive<T>(clock: FakeClock, promise: Promise<T>): Promise<T> {
  const box: { settled?: Settled<T> } = {};
  void promise.then(
    (value) => {
      box.settled = { ok: true, value };
    },
    (error: unknown) => {
      box.settled = { ok: false, error };
    },
  );
  for (let step = 0; step < 100; step++) {
    await flush();
    const settled = box.settled;
    if (settled !== undefined) {
      if (settled.ok) return settled.value;
      throw settled.error;
    }
    const next = clock.nextTimerAt;
    if (next === undefined) {
      throw new Error("the stop waits on something that never settles");
    }
    clock.advance(next - clock.now());
  }
  throw new Error("the stop did not finish");
}

/**
 * Sessions that answer interrupts the way core does: an interrupt ends a running session's run,
 * advances `time.idle`, and records `outcome`. Latches go through a real `Latch` over a traced
 * store, so takeovers (continue, newer stop, expiry, safety valve) use the latch's own rules.
 */
class World {
  readonly reader = new FakeSessionReader();
  readonly control = new FakeControl();
  readonly clock = new FakeClock(START);
  readonly logger = new RecordingLogger();
  readonly controller = new AbortController();
  /** Every store write (`set <key>`) and interrupt (`interrupt <id>`), in order. */
  readonly trace: string[] = [];
  /** Agents the confirmation was asked about, in order. */
  readonly asked: string[] = [];
  readonly store = new TracedStore((op, key) => {
    if (op === "set") this.trace.push(`set ${key}`);
    this.onPoint(`${op} ${key}`);
  });
  readonly latch = new Latch(
    {
      store: this.store,
      control: this.control,
      clock: this.clock,
      logger: this.logger,
      renderNote: () => "",
    },
    { ttlMs: LATCH_TTL_MS },
  );
  readonly runState = {
    observeAll: (sessionIDs: Iterable<SessionID>) =>
      this.observeAll(sessionIDs),
  };
  /**
   * Called each time the stop reaches a fake: `set <key>` once a write lands, `scan <prefix>`,
   * `interrupt <id>` once it took effect, `wait <id>`, `observe #<n>` for the nth run-state
   * observation, and `confirm <agent>`.
   */
  onPoint: (point: string) => void = () => {};
  /** Runs once an interrupt took effect, before it returns; `count` includes this one. */
  onInterrupt: (sessionID: SessionID, count: number) => Promise<void> | void =
    () => {};
  /** Runs when a settle wait starts on the session, before it looks at the run state. */
  onWait: (sessionID: SessionID, count: number) => Promise<void> | void =
    () => {};

  private readonly infos = new Map<SessionID, SessionInfo>();
  private readonly states = new Map<SessionID, RunState>();
  private readonly specs = new Map<SessionID, SessionSpec>();
  private readonly interruptCounts = new Map<SessionID, number>();
  private readonly waitCounts = new Map<SessionID, number>();
  private readonly waiters = new Map<SessionID, Array<() => void>>();
  private observations = 0;
  private lastIdle = START;
  /** `time.updated` of the latest added session, so sessions added later are newer. */
  private lastUpdated = 0;

  constructor() {
    this.control.interruptImpl = (sessionID) => this.interrupt(sessionID);
    this.control.waitIdleImpl = (sessionID) => this.waitIdle(sessionID);
  }

  readonly confirm = async (agent: string): Promise<void> => {
    this.asked.push(agent);
    this.onPoint(`confirm ${agent}`);
  };

  /** Adds a session updated after every session added before it. */
  add(id: SessionID, spec: SessionSpec = {}): this {
    this.lastUpdated += 1;
    const base = sessionInfo(id, spec.parentID ?? CALLER, {
      updated: this.lastUpdated,
    });
    this.save({
      ...base,
      ...(spec.agent === undefined ? {} : { agent: spec.agent }),
      ...(spec.title === undefined ? {} : { title: spec.title }),
      ...(spec.outcome === undefined ? {} : { outcome: spec.outcome }),
      ...(spec.idle === undefined
        ? {}
        : { time: { ...base.time, idle: spec.idle } }),
    });
    this.states.set(id, spec.state ?? "idle");
    this.specs.set(id, spec);
    return this;
  }

  /** A prompt continues the session: the prompt hook lifts its latch and it runs the new work. */
  async continueSession(id: SessionID): Promise<void> {
    await this.latch.onPrompt(id, this.clock.now());
    this.states.set(id, "running");
  }

  /** The session's current run ends: `time.idle` advances and `outcome` records how. */
  endRun(id: SessionID, outcome: Outcome): void {
    const info = this.infos.get(id);
    if (info === undefined) return;
    this.lastIdle += 1;
    this.save({
      ...info,
      outcome,
      time: { ...info.time, idle: this.lastIdle },
    });
    this.states.set(id, "idle");
    this.wake(id);
  }

  deps(): StopDeps {
    return {
      reader: this.reader,
      control: this.control,
      latch: this.latch,
      runState: this.runState,
      clock: this.clock,
      logger: this.logger,
    };
  }

  call(confirm?: (agent: string) => Promise<void>): StopCall {
    return {
      callerID: CALLER,
      generation: GEN,
      signal: this.controller.signal,
      ...(confirm === undefined ? {} : { confirm }),
    };
  }

  /** Stops on behalf of the caller, with a 1 s settle wait unless `options` says otherwise. */
  run(
    request: Partial<StopRequest>,
    options: StopOptions = {},
    confirm?: (agent: string) => Promise<void>,
  ): Promise<StopOutput | undefined> {
    return drive(
      this.clock,
      stopSubagents(
        this.deps(),
        this.call(confirm),
        { reason: REASON, ...request },
        { settleMs: SETTLE_MS, ...options },
      ),
    );
  }

  /** Fake time spent since the stop started. */
  elapsed(): number {
    return this.clock.now() - START;
  }

  private save(info: SessionInfo): void {
    this.infos.set(info.id, info);
    this.reader.put(info);
  }

  private remove(id: SessionID): void {
    this.infos.delete(id);
    this.states.delete(id);
    this.reader.remove(id);
    this.wake(id);
  }

  private wake(id: SessionID): void {
    for (const resolve of this.waiters.get(id) ?? []) resolve();
    this.waiters.delete(id);
  }

  private async interrupt(id: SessionID): Promise<boolean> {
    this.trace.push(`interrupt ${id}`);
    const count = (this.interruptCounts.get(id) ?? 0) + 1;
    this.interruptCounts.set(id, count);
    const spec = this.specs.get(id) ?? {};
    if (spec.deleteOnInterrupt === true) this.remove(id);
    const running = this.infos.has(id) && this.states.get(id) !== "idle";
    const ends = running && count > (spec.resist ?? 0);
    if (ends) this.endRun(id, spec.endsAs ?? "interrupted");
    this.onPoint(`interrupt ${id}`);
    await this.onInterrupt(id, count);
    if (!this.infos.has(id)) throw new Error(`session ${id} not found`);
    return ends;
  }

  private async waitIdle(id: SessionID): Promise<void> {
    const count = (this.waitCounts.get(id) ?? 0) + 1;
    this.waitCounts.set(id, count);
    this.onPoint(`wait ${id}`);
    await this.onWait(id, count);
    const state = this.infos.has(id) ? this.states.get(id) : undefined;
    if (state === undefined || state === "unknown") {
      throw new Error(`cannot wait on ${id}`);
    }
    if (state === "idle") return;
    await new Promise<void>((resolve) => {
      const list = this.waiters.get(id) ?? [];
      list.push(resolve);
      this.waiters.set(id, list);
    });
  }

  private async observeAll(
    sessionIDs: Iterable<SessionID>,
  ): Promise<Map<SessionID, RunObservation>> {
    this.observations += 1;
    this.onPoint(`observe #${this.observations}`);
    return new Map(
      [...new Set(sessionIDs)].map((id): [SessionID, RunObservation] => [
        id,
        { state: this.stateOf(id), source: "event" },
      ]),
    );
  }

  private stateOf(id: SessionID): RunState {
    // A probe of a deleted session fails, which the tracker reports as unknown.
    if (!this.infos.has(id)) return "unknown";
    return this.states.get(id) ?? "unknown";
  }
}

function results(
  output: StopOutput | undefined,
): Record<SessionID, NodeResult> {
  if (output === undefined) throw new Error("expected the stop to finish");
  return Object.fromEntries(
    output.nodes.map((node) => [node.sessionID, node.result]),
  );
}

function keysWith(world: World, prefix: string): string[] {
  return world.store.keys().filter((key) => key.startsWith(prefix));
}

/**
 * Adds `count` direct children named `c0000`, `c0001`, …, each updated after the one before, and
 * returns their IDs oldest first. `running(index)` picks the ones that are running.
 */
function addChildren(
  world: World,
  count: number,
  running: (index: number) => boolean = () => false,
): SessionID[] {
  const ids = Array.from(
    { length: count },
    (_, index) => `c${String(index).padStart(4, "0")}`,
  );
  ids.forEach((id, index) =>
    world.add(id, { state: running(index) ? "running" : "idle" }),
  );
  return ids;
}

/** Warnings that the selection for `all: true` did not check every session. */
function partialCheckWarnings(world: World): string[] {
  return world.logger
    .warnings()
    .filter((message) => message.includes("too many subagents"));
}

async function rejection(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof Error) return error;
    throw new Error(`rejected with a non-Error: ${String(error)}`);
  }
  throw new Error("expected the promise to reject");
}

/** Adds `count` idle sessions below `parentID`, each the child of the one before. */
function chainBelow(world: World, parentID: SessionID, count: number): void {
  let parent = parentID;
  for (let level = 1; level <= count; level++) {
    const id = `${parentID}-${level}`;
    world.add(id, { parentID: parent });
    parent = id;
  }
}

/**
 * c1 ignores its first interrupt, so the first settle round retries it. g1 is below c1 from the
 * start. g2 and g3 are launched below c1 as its first interrupt lands, so the first settle round
 * finds them.
 */
function busyTree(): World {
  const world = new World()
    .add("c1", { state: "running", resist: 1 })
    .add("g1", { parentID: "c1", state: "running" });
  world.onInterrupt = (id, count) => {
    if (id !== "c1" || count !== 1) return;
    world.add("g2", { parentID: "c1", state: "running" });
    world.add("g3", { parentID: "c1", state: "running" });
  };
  return world;
}

/** Every write and interrupt of an uncancelled stop of `busyTree`'s c1, in order. */
const BUSY_TREE_TRACE: readonly string[] = [
  "set latch/g1/gen",
  "set latch/c1/gen",
  "set note/c1/gen",
  "interrupt g1",
  "interrupt c1",
  "set latch/g2/gen",
  "set latch/g3/gen",
  "interrupt g2",
  "interrupt g3",
  "interrupt c1",
];

describe("input validation", () => {
  const INVALID: ReadonlyArray<readonly [string, Partial<StopRequest>]> = [
    ["both sessionIDs and all: true", { sessionIDs: ["c1"], all: true }],
    ["neither sessionIDs nor all", {}],
    ["an empty sessionIDs list without all", { sessionIDs: [] }],
    ["all: false without sessionIDs", { all: false }],
    [
      `more than ${MAX_TARGETS} distinct sessionIDs`,
      {
        sessionIDs: Array.from(
          { length: MAX_TARGETS + 1 },
          (_, index) => `c${index}`,
        ),
      },
    ],
  ];

  test.each(INVALID)(
    "rejects %s before any side effect",
    async (_, request) => {
      const world = new World().add("c1", { state: "running" });
      await expect(
        world.run(request, {}, world.confirm),
      ).rejects.toBeInstanceOf(StopInputError);
      expect(world.trace).toEqual([]);
      expect(world.asked).toEqual([]);
    },
  );

  test("rejects a reason with no visible text before any side effect", async () => {
    const world = new World().add("c1", { state: "running" });
    await expect(
      world.run(
        { sessionIDs: ["c1"], reason: " \n\u200b\t" },
        {},
        world.confirm,
      ),
    ).rejects.toBeInstanceOf(EmptyReasonError);
    expect(world.trace).toEqual([]);
    expect(world.asked).toEqual([]);
  });

  test("treats an empty sessionIDs list next to all: true as all", async () => {
    const world = new World().add("c1", { state: "running" }).add("c2");
    const output = await world.run({ sessionIDs: [], all: true });
    expect(results(output)).toEqual({ c1: "stopped" });
  });

  test(`accepts ${MAX_TARGETS} distinct sessionIDs even when duplicates make the list longer`, async () => {
    const world = new World();
    const ids = Array.from({ length: MAX_TARGETS }, (_, index) => `c${index}`);
    for (const id of ids) world.add(id);
    const output = await world.run({
      sessionIDs: [...ids, ...ids.slice(0, 1)],
    });
    expect(Object.keys(results(output)).toSorted()).toEqual(ids.toSorted());
    expect(world.control.interrupts.toSorted()).toEqual(ids.toSorted());
  });

  test("stops each session once when a target is named twice or inside another target's subtree", async () => {
    const world = new World()
      .add("c1", { state: "running" })
      .add("g1", { parentID: "c1", state: "running" });
    const output = await world.run({ sessionIDs: ["g1", "c1", "c1"] });
    expect(world.control.interrupts).toEqual(["g1", "c1"]);
    expect(keysWith(world, "note/")).toEqual(["note/c1/gen"]);
    expect(results(output)).toEqual({ c1: "stopped", g1: "stopped" });
  });
});

describe("authorization", () => {
  const OUTSIDERS: ReadonlyArray<
    readonly [
      string,
      SessionID,
      typeof NotDescendantError | typeof SelfTargetError,
    ]
  > = [
    ["a sibling's subagent", "nephew", NotDescendantError],
    ["a session that does not exist", "missing", NotDescendantError],
    ["the caller itself", CALLER, SelfTargetError],
  ];

  test.each(OUTSIDERS)(
    "rejects %s and leaves the valid targets alone",
    async (_, target, error) => {
      const world = new World()
        .add("c1", { state: "running" })
        .add("sibling", { parentID: "top" })
        .add("nephew", { parentID: "sibling", state: "running" });
      await expect(
        world.run({ sessionIDs: ["c1", target] }, {}, world.confirm),
      ).rejects.toBeInstanceOf(error);
      expect(world.trace).toEqual([]);
      expect(world.asked).toEqual([]);
    },
  );

  test("rejects a subtree over the depth cap before asking or touching anything", async () => {
    const world = new World().add("c1", { state: "running" });
    chainBelow(world, "c1", MAX_SUBTREE_DEPTH);
    await expect(
      world.run({ sessionIDs: ["c1"] }, {}, world.confirm),
    ).rejects.toBeInstanceOf(SubtreeTooLargeError);
    expect(world.trace).toEqual([]);
    expect(world.asked).toEqual([]);
  });

  test("asks once per distinct root agent, as unknown for a root without one, before any write", async () => {
    const world = new World()
      .add("c1", { agent: "build" })
      .add("c2", { agent: "build" })
      .add("c3", { agent: "explore" })
      .add("c4")
      .add("g1", { parentID: "c1", agent: "review" });
    const tracedWhenAsked: number[] = [];
    world.onPoint = (point) => {
      if (point.startsWith("confirm ")) {
        tracedWhenAsked.push(world.trace.length);
      }
    };
    await world.run(
      { sessionIDs: ["c1", "c2", "c3", "c4"] },
      {},
      world.confirm,
    );
    expect(world.asked.toSorted()).toEqual(["build", "explore", "unknown"]);
    expect(tracedWhenAsked).toEqual([0, 0, 0]);
  });

  test("changes nothing when the confirmation is refused", async () => {
    const world = new World().add("c1", { state: "running" });
    const refused = new Error("permission denied");
    await expect(
      world.run({ sessionIDs: ["c1"] }, {}, async () => {
        throw refused;
      }),
    ).rejects.toBe(refused);
    expect(world.trace).toEqual([]);
  });
});

describe("all: true", () => {
  test("selects each direct child whose subtree has a running or unknown session", async () => {
    const world = new World()
      .add("running", { state: "running" })
      .add("idle")
      .add("idle-parent")
      .add("busy-grandchild", { parentID: "idle-parent", state: "running" })
      .add("unobservable", { state: "unknown" })
      .add("quiet-parent")
      .add("quiet-grandchild", { parentID: "quiet-parent" });
    const output = await world.run({ all: true });
    const selected = [
      "busy-grandchild",
      "idle-parent",
      "running",
      "unobservable",
    ];
    expect(Object.keys(results(output)).toSorted()).toEqual(selected);
    expect(world.control.interrupts.toSorted()).toEqual(selected);
  });

  test("stops nothing and says so when no subagent is running", async () => {
    const world = new World()
      .add("idle")
      .add("idle-parent")
      .add("idle-child", { parentID: "idle-parent" });
    expect(await world.run({ all: true }, {}, world.confirm)).toEqual({
      nodes: [],
      note: NOTHING_RUNNING_NOTE,
    });
    expect(world.trace).toEqual([]);
    expect(world.asked).toEqual([]);
  });

  describe("for a caller with hundreds of children", () => {
    test("stops exactly the running ones among 299 children, the newest 6, without failing", async () => {
      const world = new World();
      const ids = addChildren(world, 299, (index) => index >= 293);
      const running = ids.slice(293).toSorted();
      const output = await world.run({ all: true });
      expect(Object.keys(results(output)).toSorted()).toEqual(running);
      expect(Object.values(results(output))).toEqual(
        running.map(() => "stopped"),
      );
      expect(world.control.interrupts.toSorted()).toEqual(running);
      expect(output?.note).toBe(STOPPED_NOTE);
      expect(partialCheckWarnings(world)).toEqual([]);
    });

    test("finds a running grandchild under the least recently updated of 299 idle children", async () => {
      const world = new World();
      const [oldest] = addChildren(world, 299);
      if (oldest === undefined) throw new Error("no children added");
      world.add("grandchild", { parentID: oldest, state: "running" });
      const output = await world.run({ all: true });
      expect(results(output)).toEqual({
        [oldest]: "already_idle",
        grandchild: "stopped",
      });
    });

    test("rejects a selected child whose subtree has more than 200 sessions before any side effect", async () => {
      const world = new World();
      addChildren(world, 299);
      world.add("big", { state: "running" });
      for (let index = 0; index < MAX_SUBTREE_SESSIONS; index++) {
        world.add(`big-${index}`, { parentID: "big" });
      }
      const error = await rejection(
        world.run({ all: true }, {}, world.confirm),
      );
      expect(error).toBeInstanceOf(SubtreeTooLargeError);
      expect(error.message).toBe(
        "The subagent tree has more than 200 sessions; nothing was changed.",
      );
      expect(world.trace).toEqual([]);
      expect(world.asked).toEqual([]);
    });

    test(`checks the ${MAX_SCAN_SESSIONS} most recently updated of ${MAX_SCAN_SESSIONS + 1} children and says the check was partial`, async () => {
      const world = new World();
      const ids = addChildren(
        world,
        MAX_SCAN_SESSIONS + 1,
        (index) => index === MAX_SCAN_SESSIONS,
      );
      const newest = ids.at(-1);
      if (newest === undefined) throw new Error("no children added");
      const output = await world.run({ all: true });
      expect(results(output)).toEqual({ [newest]: "stopped" });
      expect(output?.note).toBe(`${STOPPED_NOTE} ${PARTIAL_CHECK_NOTE}`);
      expect(partialCheckWarnings(world)).toHaveLength(1);
    });

    test(`says nothing was found running, not that nothing is running, when ${MAX_SCAN_SESSIONS} idle children fill the check`, async () => {
      // The 2000 children fill the walk, so no grandchild is checked, the running one included.
      const world = new World();
      const newest = addChildren(world, MAX_SCAN_SESSIONS).at(-1);
      if (newest === undefined) throw new Error("no children added");
      world.add("grandchild", { parentID: newest, state: "running" });
      expect(await world.run({ all: true }, {}, world.confirm)).toEqual({
        nodes: [],
        note: `${NOTHING_FOUND_RUNNING_NOTE} ${PARTIAL_CHECK_NOTE}`,
      });
      expect(world.trace).toEqual([]);
      expect(world.asked).toEqual([]);
      expect(partialCheckWarnings(world)).toHaveLength(1);
    });

    test(`walks the most recently updated children first when their subtrees pass ${MAX_SCAN_SESSIONS} sessions, and says the check was partial`, async () => {
      // 20 children with 100 grandchildren each. The walk stops at 2000 sessions, so the last
      // grandchildren of whichever child it walks last are never checked; the running one is the
      // last grandchild of the most recently updated child.
      const world = new World();
      for (let child = 0; child < 20; child++) {
        world.add(`c${child}`);
        for (let grandchild = 0; grandchild < 100; grandchild++) {
          world.add(`c${child}-${grandchild}`, { parentID: `c${child}` });
        }
      }
      world.add("c19-last", { parentID: "c19", state: "running" });
      const output = await world.run({ all: true });
      const stopped = results(output);
      expect(stopped["c19-last"]).toBe("stopped");
      expect(
        output?.nodes.every((node) => node.sessionID.startsWith("c19")),
      ).toBe(true);
      expect(output?.note).toBe(`${STOPPED_NOTE} ${PARTIAL_CHECK_NOTE}`);
      expect(partialCheckWarnings(world)).toHaveLength(1);
    });

    test("rejects instead of reporting nothing running when the only running session is below the depth cap", async () => {
      const world = new World().add("c1");
      let parent = "c1";
      for (let depth = 2; depth <= MAX_SUBTREE_DEPTH + 1; depth++) {
        const id = `c1-${depth}`;
        world.add(id, {
          parentID: parent,
          state: depth === MAX_SUBTREE_DEPTH + 1 ? "running" : "idle",
        });
        parent = id;
      }
      const error = await rejection(
        world.run({ all: true }, {}, world.confirm),
      );
      expect(error).toBeInstanceOf(SubtreeTooLargeError);
      expect(world.trace).toEqual([]);
    });
  });
});

describe("writes and interrupts", () => {
  test("latches every session and owes every root a note before the first interrupt, then interrupts deepest first", async () => {
    const depth: Readonly<Record<SessionID, number>> = {
      c1: 1,
      c2: 1,
      g1: 2,
      g2: 2,
      gg1: 3,
    };
    const world = new World()
      .add("c1", { state: "running" })
      .add("g1", { parentID: "c1", state: "running" })
      .add("gg1", { parentID: "g1", state: "running" })
      .add("c2", { state: "running" })
      .add("g2", { parentID: "c2", state: "running" });
    await world.run({ sessionIDs: ["c1", "c2"] });
    const firstInterrupt = world.trace.findIndex((entry) =>
      entry.startsWith("interrupt "),
    );
    expect(world.trace.slice(0, firstInterrupt).toSorted()).toEqual([
      "set latch/c1/gen",
      "set latch/c2/gen",
      "set latch/g1/gen",
      "set latch/g2/gen",
      "set latch/gg1/gen",
      "set note/c1/gen",
      "set note/c2/gen",
    ]);
    expect(
      world.trace
        .slice(firstInterrupt)
        .every((entry) => entry.startsWith("interrupt ")),
    ).toBe(true);
    expect(world.control.interrupts.map((id) => depth[id])).toEqual([
      3, 2, 2, 1, 1,
    ]);
    expect(world.control.interrupts.toSorted()).toEqual([
      "c1",
      "c2",
      "g1",
      "g2",
      "gg1",
    ]);
  });

  test("records the caller, the sanitized reason, and the stop's start in each latch", async () => {
    const world = new World().add("c1", { state: "running" });
    await world.run({ sessionIDs: ["c1"], reason: "  off\n<track>  " });
    expect(world.store.data.get("latch/c1/gen")).toEqual({
      parentSessionID: CALLER,
      reason: "off &lt;track&gt;",
      at: START,
      expiresAt: START + LATCH_TTL_MS,
    });
  });

  test("latches an idle target, owes it a note, and reports it already idle with the stopped note", async () => {
    const world = new World().add("c1");
    const output = await world.run({ sessionIDs: ["c1"] });
    expect(world.store.keys()).toEqual(["latch/c1/gen", "note/c1/gen"]);
    expect(output).toEqual({
      nodes: [
        { sessionID: "c1", parentID: CALLER, depth: 1, result: "already_idle" },
      ],
      note: STOPPED_NOTE,
    });
  });

  test("owes no note with notifyChild off, and still latches every session", async () => {
    const world = new World()
      .add("c1", { state: "running" })
      .add("g1", { parentID: "c1", state: "running" });
    await world.run({ sessionIDs: ["c1"] }, { notifyChild: false });
    expect(world.store.keys()).toEqual(["latch/c1/gen", "latch/g1/gen"]);
  });

  test("with latch: false, writes nothing and still interrupts the subtree, retries, and new sessions", async () => {
    const world = busyTree();
    const output = await world.run({ sessionIDs: ["c1"] }, { latch: false });
    expect(world.store.writes).toBe(0);
    expect(world.trace).toEqual([
      "interrupt g1",
      "interrupt c1",
      "interrupt g2",
      "interrupt g3",
      "interrupt c1",
    ]);
    expect(results(output)).toEqual({
      c1: "stopped",
      g1: "stopped",
      g2: "stopped",
      g3: "stopped",
    });
  });
});

type Takeover = (world: World, sessionID: SessionID) => Promise<void>;

/** Ways a session is taken over from this stop while it runs, and the result it then reports. */
const TAKEOVERS: ReadonlyArray<readonly [string, Takeover, NodeResult]> = [
  ["continued", (world, id) => world.continueSession(id), "continued"],
  [
    "stopped again by a newer stop",
    async (world, id) => {
      await world.latch.add(id, {
        generation: "newer",
        parentSessionID: CALLER,
        reason: "again",
        at: world.clock.now() + 1,
      });
    },
    "stopping",
  ],
  [
    "whose latch expired",
    async (world) => {
      world.clock.advance(LATCH_TTL_MS);
    },
    "stopping",
  ],
  [
    "given up on by the safety valve",
    (world, id) =>
      world.store.set(`gaveup/${id}/${GEN}`, { at: world.clock.now() }),
    "stopping",
  ],
];

describe("sessions someone else took over", () => {
  test.each(TAKEOVERS)(
    "a session %s before its turn is not interrupted",
    async (_, takeOver, result) => {
      const world = new World()
        .add("c1", { state: "running" })
        .add("g1", { parentID: "c1", state: "running" });
      world.onInterrupt = (id) =>
        id === "g1" ? takeOver(world, "c1") : undefined;
      const output = await world.run({ sessionIDs: ["c1"] });
      expect(world.control.interrupts).toEqual(["g1"]);
      expect(results(output)).toEqual({ c1: result, g1: "stopped" });
    },
  );

  test.each(TAKEOVERS)(
    "a session %s after its interrupt is no longer waited on or retried",
    async (_, takeOver, result) => {
      const world = new World().add("c1", {
        state: "running",
        resist: FOREVER,
      });
      world.onInterrupt = (_id, count) =>
        count === 1 ? takeOver(world, "c1") : undefined;
      const output = await world.run({ sessionIDs: ["c1"] });
      expect(world.control.interrupts).toEqual(["c1"]);
      expect(world.control.waits).toEqual(["c1"]);
      expect(results(output)).toEqual({ c1: result });
    },
  );
});

describe("a child launched during settlement", () => {
  test("is left alone when its parent was continued while running", async () => {
    // A ignores its interrupt; during the settle wait it is continued and launches B.
    const world = new World().add("A", { state: "running", resist: FOREVER });
    world.onWait = async (id, count) => {
      if (id !== "A" || count !== 1) return;
      await world.continueSession("A");
      world.add("B", { parentID: "A", state: "running" });
    };
    const output = await world.run({ sessionIDs: ["A"] });
    expect(world.trace).toEqual([
      "set latch/A/gen",
      "set note/A/gen",
      "interrupt A",
      "set lift/A/gen",
    ]);
    expect(results(output)).toEqual({ A: "continued" });
  });

  test("is left alone when its parent was continued while idle", async () => {
    // A stops at its interrupt. During the settle wait it is continued while idle, launches B in
    // the background, and ends its turn, so it is idle again when the round looks at it.
    const world = new World().add("A", { state: "running" });
    world.onWait = async (id, count) => {
      if (id !== "A" || count !== 1) return;
      await world.continueSession("A");
      world.add("B", { parentID: "A", state: "running" });
      world.endRun("A", "succeeded");
    };
    const output = await world.run({ sessionIDs: ["A"] });
    expect(world.trace).toEqual([
      "set latch/A/gen",
      "set note/A/gen",
      "interrupt A",
      "set lift/A/gen",
    ]);
    expect(results(output)).toEqual({ A: "continued" });
  });

  test("is latched and interrupted when its parent was not continued", async () => {
    const world = new World().add("A", { state: "running" });
    world.onWait = (id, count) => {
      if (id === "A" && count === 1) {
        world.add("B", { parentID: "A", state: "running" });
      }
    };
    const output = await world.run({ sessionIDs: ["A"] });
    expect(world.trace).toEqual([
      "set latch/A/gen",
      "set note/A/gen",
      "interrupt A",
      "set latch/B/gen",
      "interrupt B",
    ]);
    expect(results(output)).toEqual({ A: "stopped", B: "stopped" });
  });
});

describe("settle rounds", () => {
  test("retry a session still running after the wait", async () => {
    const world = new World().add("c1", { state: "running", resist: 1 });
    const output = await world.run({ sessionIDs: ["c1"] });
    expect(world.control.interrupts).toEqual(["c1", "c1"]);
    expect(world.elapsed()).toBe(SETTLE_MS);
    expect(results(output)).toEqual({ c1: "stopped" });
  });

  test("latch and interrupt sessions launched during the stop, dated from the stop's start", async () => {
    const world = busyTree();
    const output = await world.run({ sessionIDs: ["c1"] });
    expect(world.trace).toEqual([...BUSY_TREE_TRACE]);
    // Found after a settle wait timed out, so the clock had moved past the start.
    expect(world.store.data.get("latch/g2/gen")).toMatchObject({ at: START });
    expect(keysWith(world, "note/")).toEqual(["note/c1/gen"]);
    expect(results(output)).toEqual({
      c1: "stopped",
      g1: "stopped",
      g2: "stopped",
      g3: "stopped",
    });
  });

  test("end after the first round when nothing new appeared and nothing is running", async () => {
    const world = new World()
      .add("c1", { state: "running" })
      .add("g1", { parentID: "c1", state: "running" });
    await world.run({ sessionIDs: ["c1"] });
    expect(world.control.waits.toSorted()).toEqual(["c1", "g1"]);
    expect(world.control.interrupts).toEqual(["g1", "c1"]);
    expect(world.elapsed()).toBe(0);
  });

  test("give up after three rounds of 4000 ms by default", async () => {
    const world = new World().add("c1", { state: "running", resist: FOREVER });
    const output = await drive(
      world.clock,
      stopSubagents(world.deps(), world.call(), {
        sessionIDs: ["c1"],
        reason: REASON,
      }),
    );
    // The first interrupt, then one retry per round.
    expect(world.control.interrupts).toHaveLength(4);
    expect(world.elapsed()).toBe(3 * 4000);
    expect(results(output)).toEqual({ c1: "stopping" });
  });

  test("keep the sessions already found when the subtree can no longer be walked", async () => {
    const world = new World().add("c1", { state: "running" });
    world.onInterrupt = (_id, count) => {
      if (count === 1) chainBelow(world, "c1", MAX_SUBTREE_DEPTH);
    };
    const output = await world.run({ sessionIDs: ["c1"] });
    expect(world.trace).toEqual([
      "set latch/c1/gen",
      "set note/c1/gen",
      "interrupt c1",
    ]);
    expect(results(output)).toEqual({ c1: "stopped" });
  });
});

describe("classification", () => {
  const CASES: ReadonlyArray<readonly [string, SessionSpec, NodeResult]> = [
    ["stopped for a run the interrupt ended", { state: "running" }, "stopped"],
    [
      "finished for a run that succeeded as the interrupt landed",
      { state: "running", endsAs: "succeeded" },
      "finished",
    ],
    [
      "finished for a run that failed as the interrupt landed",
      { state: "running", endsAs: "failed" },
      "finished",
    ],
    [
      "stopping for a run still going after the last round",
      { state: "running", resist: FOREVER },
      "stopping",
    ],
    [
      "stopping for a session whose state cannot be observed at the end",
      { state: "unknown", resist: FOREVER },
      "stopping",
    ],
    ["already_idle for a session that never ran", {}, "already_idle"],
    [
      "already_idle for an idle session whose last run was interrupted before the stop",
      { idle: 500, outcome: "interrupted" },
      "already_idle",
    ],
    [
      "already_idle for an idle session whose last run succeeded before the stop",
      { idle: 500, outcome: "succeeded" },
      "already_idle",
    ],
  ];

  test.each(CASES)("reports %s", async (_, spec, result) => {
    const world = new World().add("c1", spec);
    expect(results(await world.run({ sessionIDs: ["c1"] }))).toEqual({
      c1: result,
    });
  });

  test("reports finished for a session launched during the stop that had finished when found", async () => {
    const world = new World().add("c1", { state: "running" });
    world.onInterrupt = (id, count) => {
      if (id === "c1" && count === 1) {
        world.add("g1", { parentID: "c1", idle: 500, outcome: "succeeded" });
      }
    };
    expect(results(await world.run({ sessionIDs: ["c1"] }))).toEqual({
      c1: "stopped",
      g1: "finished",
    });
  });

  test("reports a session deleted mid-stop as deleted, with what the walk knew of it, and still stops the rest", async () => {
    const world = new World().add("c1", { state: "running" }).add("g1", {
      parentID: "c1",
      state: "running",
      title: "Scratch",
      deleteOnInterrupt: true,
    });
    const output = await world.run({ sessionIDs: ["c1"] });
    expect(world.control.interrupts).toContain("c1");
    expect(output?.nodes).toEqual([
      { sessionID: "c1", parentID: CALLER, depth: 1, result: "stopped" },
      {
        sessionID: "g1",
        parentID: "c1",
        depth: 2,
        title: "Scratch",
        result: "deleted",
      },
    ]);
  });

  test("reports every session shallowest first with its parent, depth, title, and agent", async () => {
    const world = new World()
      .add("c1", { state: "running", title: "Research", agent: "explore" })
      .add("g1", { parentID: "c1", state: "running" })
      .add("gg1", { parentID: "g1", state: "running", agent: "general" });
    expect(await world.run({ sessionIDs: ["c1"] })).toStrictEqual({
      nodes: [
        {
          sessionID: "c1",
          parentID: CALLER,
          depth: 1,
          title: "Research",
          agent: "explore",
          result: "stopped",
        },
        { sessionID: "g1", parentID: "c1", depth: 2, result: "stopped" },
        {
          sessionID: "gg1",
          parentID: "g1",
          depth: 3,
          agent: "general",
          result: "stopped",
        },
      ],
      note: STOPPED_NOTE,
    });
  });
});

describe("cancellation", () => {
  // Each point, the number of `BUSY_TREE_TRACE` entries done by the time it is reached.
  const POINTS: ReadonlyArray<readonly [string, string, number]> = [
    ["while the confirmation is pending", "confirm unknown", 0],
    ["after a latch, before the next", "set latch/g1/gen", 1],
    ["after a root's latch, before its note", "set latch/c1/gen", 2],
    ["after the note, before the first interrupt", "set note/c1/gen", 3],
    ["between a latch check and its interrupt", "scan latch/g1/", 3],
    ["between two interrupts", "interrupt g1", 4],
    ["after the first interrupts, before settling", "interrupt c1", 5],
    ["during the settle wait", "wait c1", 5],
    ["between latches of sessions found mid-stop", "set latch/g2/gen", 6],
    ["between retry interrupts", "interrupt g2", 8],
    ["at the last probe, before classifying", "observe #2", 10],
  ];

  test.each(POINTS)(
    "%s resolves undefined, issues nothing more, and keeps every latch",
    async (_, point, done) => {
      const world = busyTree();
      world.onPoint = (reached) => {
        if (reached === point) world.controller.abort();
      };
      const output = await world.run({ sessionIDs: ["c1"] }, {}, world.confirm);
      expect(output).toBeUndefined();
      expect(world.trace).toEqual(BUSY_TREE_TRACE.slice(0, done));
      // Nothing was lifted or removed: the store holds exactly what the stop wrote.
      expect(world.store.keys()).toEqual(
        world.trace
          .filter((entry) => entry.startsWith("set "))
          .map((entry) => entry.slice("set ".length))
          .toSorted(),
      );
    },
  );

  test("ends the settle wait at once instead of running out its timer", async () => {
    const world = busyTree();
    world.onPoint = (reached) => {
      if (reached === "wait c1") world.controller.abort();
    };
    await world.run({ sessionIDs: ["c1"] });
    expect(world.elapsed()).toBe(0);
    expect(world.clock.pendingTimers).toBe(0);
  });
});
