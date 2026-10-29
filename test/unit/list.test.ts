import { describe, expect, test } from "bun:test";
import { CallID, type ToolContext } from "@opencode/plugin/promise/tool";
import { Brand } from "effect";
import { MAX_SCAN_SESSIONS } from "@/core/ancestry";
import { Latch } from "@/core/latch";
import type { SessionID, SessionInfo } from "@/core/ports";
import { RunStateTracker } from "@/core/run-state";
import {
  type ListEntry,
  type ListToolOptions,
  listTool,
  MAX_ENTRIES,
} from "@/tools/list";
import {
  executionStarted,
  FakeClock,
  FakeControl,
  FakeSessionReader,
  MemoryStore,
  RecordingLogger,
  sessionInfo,
} from "./fixtures";

const CALLER = "caller";
const NOW = 2_000_000;
const PARTIAL_READ =
  "Your subagent tree is too large to read in full; only sessions under your most recently updated subagents were checked.";

type ListInput = Parameters<ReturnType<typeof listTool>["execute"]>[0];

interface ChildSpec {
  /** Defaults to the caller. */
  readonly parentID?: SessionID;
  /** Defaults to idle. */
  readonly state?: "running" | "idle" | "unknown";
  readonly cost?: number;
  readonly tokens?: {
    readonly input: number;
    readonly cacheRead: number;
    readonly output: number;
  };
  /** Defaults to the caller's directory, `/work`. */
  readonly directory?: string;
  /** Actions of permission prompts it is waiting on. */
  readonly pending?: readonly string[];
}

/** The executor context of a call from the caller's session. */
function context(): ToolContext {
  return {
    sessionID: Brand.nominal<ToolContext["sessionID"]>()(CALLER),
    agent: Brand.nominal<ToolContext["agent"]>()("build"),
    messageID: Brand.nominal<ToolContext["messageID"]>()("msg_list"),
    id: CallID.make("call_list"),
    signal: new AbortController().signal,
    progress: async () => {},
  };
}

/**
 * Sessions below the caller, with run state from a real tracker: running sessions have a
 * `session.execution.started` event, idle ones answer the probe at once, and unknown ones fail it.
 * Stop records go through a real `Latch` over an in-memory store.
 */
class World {
  readonly reader = new FakeSessionReader();
  readonly control = new FakeControl();
  readonly clock = new FakeClock(NOW);
  readonly logger = new RecordingLogger();
  readonly store = new MemoryStore();
  readonly runState = new RunStateTracker({
    control: this.control,
    clock: this.clock,
  });
  readonly latch = new Latch({
    store: this.store,
    control: this.control,
    clock: this.clock,
    logger: this.logger,
    renderNote: () => "",
  });
  private readonly unknown = new Set<SessionID>();
  /** `time.created` and `time.updated` of the latest session added. */
  private lastTime = 0;

  constructor() {
    // The caller works in the same directory as every session added, so no entry names it.
    this.reader.put(sessionInfo(CALLER));
    this.control.waitIdleImpl = async (sessionID) => {
      if (this.unknown.has(sessionID)) throw new Error("probe failed");
    };
  }

  /** Adds a session created and updated after every session added before it. */
  add(id: SessionID, spec: ChildSpec = {}): this {
    this.lastTime += 1;
    const base = sessionInfo(id, spec.parentID ?? CALLER, {
      created: this.lastTime,
      updated: this.lastTime,
    });
    const info: SessionInfo = {
      ...base,
      cost: spec.cost ?? base.cost,
      tokens:
        spec.tokens === undefined
          ? base.tokens
          : {
              ...base.tokens,
              input: spec.tokens.input,
              output: spec.tokens.output,
              cache: { read: spec.tokens.cacheRead, write: 0 },
            },
      location:
        spec.directory === undefined
          ? base.location
          : { directory: spec.directory },
    };
    this.reader.put(info);
    if (spec.pending !== undefined) this.reader.pending.set(id, spec.pending);
    if (spec.state === "running") this.runState.onEvent(executionStarted(id));
    if (spec.state === "unknown") this.unknown.add(id);
    return this;
  }

  /**
   * Adds `count` direct children named `c0000`, `c0001`, …, each created and updated after the one
   * before, and returns their IDs oldest first. `running(index)` picks the ones that are running.
   */
  addChildren(
    count: number,
    running: (index: number) => boolean = () => false,
  ): SessionID[] {
    const ids = Array.from(
      { length: count },
      (_, index) => `c${String(index).padStart(4, "0")}`,
    );
    ids.forEach((id, index) =>
      this.add(id, { state: running(index) ? "running" : "idle" }),
    );
    return ids;
  }

  async list(input: ListInput = {}, options: ListToolOptions = {}) {
    const tool = listTool(
      {
        reader: this.reader,
        latch: this.latch,
        runState: this.runState,
        logger: this.logger,
      },
      options,
    );
    const result = await tool.execute(input, context());
    if (result.output === undefined) throw new Error("expected an output");
    if (typeof result.content !== "string") {
      throw new Error("expected text content");
    }
    return { output: result.output, lines: result.content.split("\n") };
  }
}

function ids(entries: readonly ListEntry[]): string[] {
  return entries.map((entry) => entry.sessionID);
}

describe("a caller with 299 children, the newest 6 running", () => {
  function world() {
    const world = new World();
    const children = world.addChildren(299, (index) => index >= 293);
    return { world, running: children.slice(293).toReversed() };
  }

  test('state "all" lists the running ones first, counts every child, and reports the cut', async () => {
    const { world: w, running } = world();
    const { output } = await w.list({ state: "all" });
    expect(output.entries).toHaveLength(MAX_ENTRIES);
    expect(ids(output.entries.slice(0, 6))).toEqual(running);
    expect(output.entries.slice(0, 6).map((entry) => entry.state)).toEqual(
      running.map(() => "running"),
    );
    // The rest are idle, newest first.
    expect(output.entries[6]).toMatchObject({
      sessionID: "c0292",
      state: "idle",
    });
    expect(output.total).toBe(299);
    expect(output.truncated).toBe(true);
    expect(output.complete).toBe(true);
  });

  test('state "running" lists exactly the 6, with no cut', async () => {
    const { world: w, running } = world();
    const { output } = await w.list({ state: "running" });
    expect(ids(output.entries)).toEqual(running);
    expect(output.total).toBe(6);
    expect(output.truncated).toBe(false);
    expect(output.complete).toBe(true);
  });
});

describe("a read past the scan limit", () => {
  test(`counts only the ${MAX_SCAN_SESSIONS} most recently updated of ${MAX_SCAN_SESSIONS + 1} children and reports the read incomplete`, async () => {
    const world = new World();
    world.addChildren(MAX_SCAN_SESSIONS + 1);
    const { output } = await world.list();
    expect(output.total).toBe(MAX_SCAN_SESSIONS);
    expect(output.entries[0]?.sessionID).toBe(`c${MAX_SCAN_SESSIONS}`);
    expect(output.entries.map((entry) => entry.sessionID)).not.toContain(
      "c0000",
    );
    expect(output).toMatchObject({ truncated: true, complete: false });
  });

  test("is reported incomplete when the levels below the children pass the limit, only at a depth that reads them", async () => {
    // One child with 2000 grandchildren: 2001 sessions, past the limit only when read at depth 2.
    const world = new World().add("c1");
    for (let index = 0; index < MAX_SCAN_SESSIONS; index++) {
      world.add(`g${index}`, { parentID: "c1" });
    }
    expect((await world.list()).output.complete).toBe(true);
    expect((await world.list({ depth: 2 })).output.complete).toBe(false);
  });
});

describe("the state filter", () => {
  // Created oldest to newest in the reverse of the state order, so newest-first alone would not
  // produce it.
  function world() {
    return new World()
      .add("running", { state: "running" })
      .add("unknown", { state: "unknown" })
      .add("idle");
  }

  test('"all" puts running before unknown before idle', async () => {
    const { output } = await world().list();
    expect(ids(output.entries)).toEqual(["running", "unknown", "idle"]);
  });

  test('"running" includes the sessions whose state is unknown', async () => {
    const { output } = await world().list({ state: "running" });
    expect(ids(output.entries)).toEqual(["running", "unknown"]);
    expect(output.total).toBe(2);
  });

  test('"idle" lists only the idle ones', async () => {
    const { output } = await world().list({ state: "idle" });
    expect(ids(output.entries)).toEqual(["idle"]);
  });
});

describe("the depth limit", () => {
  // caller ─┬─ c1 ── g1 ── gg1
  //         └─ c2
  function world() {
    return new World()
      .add("c1")
      .add("g1", { parentID: "c1" })
      .add("gg1", { parentID: "g1" })
      .add("c2");
  }

  test("lists only the caller's direct children by default", async () => {
    const { output } = await world().list();
    expect(ids(output.entries).toSorted()).toEqual(["c1", "c2"]);
  });

  test("includes the levels down to depth and none below it", async () => {
    const { output } = await world().list({ depth: 2 });
    expect(ids(output.entries).toSorted()).toEqual(["c1", "c2", "g1"]);
    expect(
      output.entries.find((entry) => entry.sessionID === "g1"),
    ).toMatchObject({ parentID: "c1", depth: 2 });
    expect(output.truncated).toBe(false);
  });
});

describe("the latch option", () => {
  async function stoppedWorld() {
    const world = new World().add("c1");
    await world.latch.add("c1", {
      generation: "gen",
      parentSessionID: CALLER,
      reason: "off track",
      at: NOW - 1000,
    });
    return world;
  }

  test("reports a stop record by default", async () => {
    const world = await stoppedWorld();
    const { output, lines } = await world.list();
    expect(output.entries[0]?.stopped).toEqual({
      at: NOW - 1000,
      reason: "off track",
      latch: "active",
    });
    expect(lines[0]).toContain("stopped by parent");
  });

  test("leaves out stop records with latch: false", async () => {
    const world = await stoppedWorld();
    const { output, lines } = await world.list({}, { latch: false });
    expect(output.entries).toHaveLength(1);
    expect(output.entries[0]).not.toHaveProperty("stopped");
    expect(lines[0]).not.toContain("stopped by parent");
  });
});

describe("entries", () => {
  test("report input, cache-read, and output tokens", async () => {
    const world = new World().add("c1", {
      tokens: { input: 1200, cacheRead: 5000, output: 340 },
    });
    const { output } = await world.list();
    expect(output.entries[0]?.tokens).toEqual({
      input: 1200,
      cacheRead: 5000,
      output: 340,
    });
  });

  test("render a reported cost in dollars to four places, with the cached tokens", async () => {
    const world = new World().add("c1", {
      cost: 0.012345,
      tokens: { input: 1200, cacheRead: 5000, output: 340 },
    });
    const { lines } = await world.list();
    expect(lines).toEqual([
      "- c1: idle; $0.0123; 1200 in + 5000 cached / 340 out tokens",
    ]);
  });

  test("name their directory, and render it only when it differs from the caller's", async () => {
    const world = new World()
      .add("here")
      .add("there", { directory: "/work-feature" });
    const { output, lines } = await world.list();
    expect(
      output.entries.map((entry) => [entry.sessionID, entry.directory]),
    ).toEqual([
      ["there", "/work-feature"],
      ["here", "/work"],
    ]);
    expect(lines).toEqual([
      "- there: idle; no cost reported; 0 in + 0 cached / 0 out tokens; directory /work-feature",
      "- here: idle; no cost reported; 0 in + 0 cached / 0 out tokens",
    ]);
  });

  test("render the directory before the permission prompt and the stop", async () => {
    const world = new World().add("c1", {
      directory: "/work-feature",
      pending: ["shell"],
    });
    await world.latch.add("c1", {
      generation: "gen",
      parentSessionID: CALLER,
      reason: "off track",
      at: NOW - 1000,
    });
    const { lines } = await world.list();
    expect(lines).toEqual([
      `- c1: idle; no cost reported; 0 in + 0 cached / 0 out tokens; directory /work-feature; waiting on a permission prompt; stopped by parent at ${new Date(NOW - 1000).toISOString()} (kept stopped): off track`,
    ]);
  });

  test("render every directory, with a warning, when the caller's session cannot be read", async () => {
    const world = new World()
      .add("here")
      .add("there", { directory: "/work-feature" });
    world.reader.failingGets.add(CALLER);
    const { lines } = await world.list();
    expect(lines).toEqual([
      "- there: idle; no cost reported; 0 in + 0 cached / 0 out tokens; directory /work-feature",
      "- here: idle; no cost reported; 0 in + 0 cached / 0 out tokens; directory /work",
    ]);
    expect(world.logger.warnings()).toEqual([
      "could not read the session's directory",
    ]);
  });

  test("render a cost of 0 as no cost reported", async () => {
    const world = new World().add("c1", { cost: 0 });
    const { output, lines } = await world.list();
    expect(output.entries[0]?.cost).toBe(0);
    expect(lines).toEqual([
      "- c1: idle; no cost reported; 0 in + 0 cached / 0 out tokens",
    ]);
  });
});

describe("the rendered content", () => {
  test('ends a list of every state cut at the entry limit with the count and a hint to pass state: "running"', async () => {
    const world = new World();
    world.addChildren(MAX_ENTRIES + 1);
    const { output, lines } = await world.list();
    expect(output).toMatchObject({ truncated: true, complete: true });
    expect(lines).toHaveLength(MAX_ENTRIES + 1);
    expect(lines.at(-1)).toBe(
      `Showing ${MAX_ENTRIES} of ${MAX_ENTRIES + 1} found, running ones first. Pass state: "running" to list only the running ones.`,
    );
  });

  test("ends a filtered list cut at the entry limit with the count only", async () => {
    const world = new World();
    world.addChildren(MAX_ENTRIES + 1);
    const { lines } = await world.list({ state: "idle" });
    expect(lines).toHaveLength(MAX_ENTRIES + 1);
    expect(lines.at(-1)).toBe(
      `Showing ${MAX_ENTRIES} of ${MAX_ENTRIES + 1} found.`,
    );
  });

  test("ends an incomplete read with the partial-read line and no count when every match is shown", async () => {
    const world = new World();
    world.addChildren(
      MAX_SCAN_SESSIONS + 1,
      (index) => index === MAX_SCAN_SESSIONS,
    );
    const { output, lines } = await world.list({ state: "running" });
    expect(output).toMatchObject({
      total: 1,
      truncated: false,
      complete: false,
    });
    expect(lines).toEqual([
      `- c${MAX_SCAN_SESSIONS}: running; no cost reported; 0 in + 0 cached / 0 out tokens`,
      PARTIAL_READ,
    ]);
  });

  test("puts the count before the partial-read line when a read is both cut and incomplete", async () => {
    const world = new World();
    world.addChildren(MAX_SCAN_SESSIONS + 1);
    const { lines } = await world.list();
    expect(lines).toHaveLength(MAX_ENTRIES + 2);
    expect(lines.slice(-2)).toEqual([
      `Showing ${MAX_ENTRIES} of ${MAX_SCAN_SESSIONS} found, running ones first. Pass state: "running" to list only the running ones.`,
      PARTIAL_READ,
    ]);
  });

  test("says the caller has no subagents when it has none", async () => {
    const { output, lines } = await new World().list();
    expect(output).toEqual({
      entries: [],
      total: 0,
      truncated: false,
      complete: true,
    });
    expect(lines).toEqual(["You have no subagents."]);
  });

  test("names the filter when no subagent matches it", async () => {
    const world = new World().add("c1", { state: "running" });
    const { lines } = await world.list({ state: "idle" });
    expect(lines).toEqual(["None of your subagents is idle."]);
  });

  test("says the read was partial when nothing matches in a tree past the scan limit", async () => {
    const world = new World();
    world.addChildren(MAX_SCAN_SESSIONS + 1);
    const { output, lines } = await world.list({ state: "running" });
    expect(output).toEqual({
      entries: [],
      total: 0,
      truncated: false,
      complete: false,
    });
    expect(lines).toEqual([
      `None of your subagents is running. ${PARTIAL_READ}`,
    ]);
  });
});
