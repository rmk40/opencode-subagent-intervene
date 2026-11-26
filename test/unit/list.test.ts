import { describe, expect, test } from "bun:test";
import {
  CallID,
  Error as ToolError,
  type ToolContext,
} from "@opencode/plugin/promise/tool";
import { Brand, Schema } from "effect";
import { MAX_SCAN_SESSIONS } from "@/core/ancestry";
import { Latch } from "@/core/latch";
import type { SessionID, SessionInfo } from "@/core/ports";
import { RunStateTracker } from "@/core/run-state";
import {
  Input,
  type ListEntry,
  type ListToolOptions,
  listTool,
  MAX_ENTRIES,
} from "@/tools/list";
import {
  executionEnded,
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
const UNREAD =
  "Part of your subagent tree is not read yet; the pages after this one read it.";

function nextPageLine(cursor: string | undefined): string {
  return `For the next page, pass cursor: ${JSON.stringify(cursor)} with the same filters.`;
}

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
  /** Stored `time.idle`: when its last run ended. */
  readonly idle?: number;
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
  /** Every session added, as last stored. */
  private readonly infos = new Map<SessionID, SessionInfo>();
  /** `time.created` and `time.updated` of the latest session added. */
  private lastTime = 0;

  /** Updates the session, so it becomes the most recently updated one. */
  touch(id: SessionID): void {
    const info = this.infos.get(id);
    if (info === undefined) throw new Error(`no session ${id}`);
    this.lastTime += 1;
    const touched = { ...info, time: { ...info.time, updated: this.lastTime } };
    this.infos.set(id, touched);
    this.reader.put(touched);
  }

  /**
   * Pages the caller's children by `time.updated` with a keyset cursor, as core does, so a child
   * updated between pages moves to its new place in the order instead of keeping its old one.
   */
  useKeysetPaging(pageSize = 100): void {
    const key = (info: SessionInfo) => `${String(info.time.updated).padStart(12, "0")}|${info.id}`;
    this.reader.listings.set(CALLER, (cursor, order) => {
      const children = [...this.infos.values()]
        .filter((info) => info.parentID === CALLER)
        .toSorted((a, b) => key(a).localeCompare(key(b)));
      const ordered = order === "asc" ? children : children.toReversed();
      const after = ordered.filter(
        (info) =>
          cursor === undefined ||
          (order === "asc" ? key(info) > cursor : key(info) < cursor),
      );
      const data = after.slice(0, pageSize);
      const last = data.at(-1);
      return after.length > pageSize && last !== undefined
        ? { data, next: key(last) }
        : { data };
    });
  }

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
      time: spec.idle === undefined ? base.time : { ...base.time, idle: spec.idle },
    };
    this.reader.put(info);
    this.infos.set(id, info);
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
    return this.call(this.tool(options), input);
  }

  /** Lists through one tool instance kept across calls, as one loaded plugin copy does. */
  async page(input: ListInput = {}) {
    this.loaded ??= this.tool();
    return this.call(this.loaded, input);
  }

  /** Drops the kept tool instance, as a plugin reload does. */
  reload(): void {
    this.loaded = undefined;
  }

  /** The failure of a call through the kept tool instance that is expected to fail. */
  async pageFailure(input: ListInput): Promise<ToolError> {
    try {
      await this.page(input);
    } catch (error) {
      if (error instanceof ToolError) return error;
      throw error;
    }
    throw new Error("expected the listing to fail");
  }

  /** Follows `nextCursor` from a first call with `input` to the last page. */
  async pages(input: ListInput = {}) {
    const pages = [await this.page(input)];
    for (let next = pages.at(-1)?.output.nextCursor; next !== undefined; ) {
      const page = await this.page({ ...input, cursor: next });
      pages.push(page);
      next = page.output.nextCursor;
      if (pages.length > 200) throw new Error("the cursor never ended");
    }
    return pages;
  }

  private loaded: ReturnType<typeof listTool> | undefined;

  private tool(options: ListToolOptions = {}) {
    return listTool(
      {
        reader: this.reader,
        latch: this.latch,
        runState: this.runState,
        clock: this.clock,
        logger: this.logger,
      },
      options,
    );
  }

  private async call(tool: ReturnType<typeof listTool>, input: ListInput) {
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
    expect(lines).toHaveLength(MAX_ENTRIES + 2);
    expect(lines.slice(-2)).toEqual([
      `Showing ${MAX_ENTRIES} of ${MAX_ENTRIES + 1} found, running ones first. Pass state: "running" to list only the running ones.`,
      nextPageLine(output.nextCursor),
    ]);
  });

  test("ends a filtered list cut at the entry limit with the count only", async () => {
    const world = new World();
    world.addChildren(MAX_ENTRIES + 1);
    const { output, lines } = await world.list({ state: "idle" });
    expect(lines).toHaveLength(MAX_ENTRIES + 2);
    expect(lines.slice(-2)).toEqual([
      `Showing ${MAX_ENTRIES} of ${MAX_ENTRIES + 1} found.`,
      nextPageLine(output.nextCursor),
    ]);
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
      UNREAD,
      nextPageLine(output.nextCursor),
    ]);
  });

  test("puts the count before the partial-read line when a read is both cut and incomplete", async () => {
    const world = new World();
    world.addChildren(MAX_SCAN_SESSIONS + 1);
    const { output, lines } = await world.list();
    expect(lines).toHaveLength(MAX_ENTRIES + 3);
    expect(lines.slice(-3)).toEqual([
      `Showing ${MAX_ENTRIES} of ${MAX_SCAN_SESSIONS} found so far, running ones first. Pass state: "running" to list only the running ones.`,
      UNREAD,
      nextPageLine(output.nextCursor),
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
      nextCursor: expect.any(String),
    });
    expect(lines).toEqual([
      `No matching subagents on this page. ${UNREAD}`,
      nextPageLine(output.nextCursor),
    ]);
  });
});

const MINUTE_MS = 60_000;

/** Every entry's session ID across the pages, in page order. */
function allIDs(
  pages: ReadonlyArray<{ readonly output: { readonly entries: readonly ListEntry[] } }>,
): string[] {
  return pages.flatMap((page) => ids(page.output.entries));
}

describe("the input limits", () => {
  const accepts = Schema.is(Input);

  test("accept up to 50 sessionIDs and refuse 51", () => {
    expect(accepts({ sessionIDs: Array.from({ length: 50 }, (_, i) => `c${i}`) })).toBe(true);
    expect(accepts({ sessionIDs: Array.from({ length: 51 }, (_, i) => `c${i}`) })).toBe(false);
  });

  test.each([
    [1, true],
    [10_080, true],
    [0, false],
    [10_081, false],
    [1.5, false],
  ])("take activeWithinMinutes %p: %p", (minutes, ok) => {
    expect(accepts({ activeWithinMinutes: minutes })).toBe(ok);
  });
});

describe("looking subagents up by sessionIDs", () => {
  test("returns exactly those subagents, in the order given", async () => {
    const world = new World().add("c1").add("c2").add("c3");
    const { output } = await world.list({ sessionIDs: ["c3", "c1"] });
    expect(ids(output.entries)).toEqual(["c3", "c1"]);
    expect(output).toMatchObject({ total: 2, truncated: false, complete: true });
    expect(output).not.toHaveProperty("nextCursor");
  });

  test("finds a subagent at any depth below the caller, whatever depth says", async () => {
    const world = new World()
      .add("c1")
      .add("g1", { parentID: "c1" })
      .add("gg1", { parentID: "g1" });
    const { output } = await world.list({ sessionIDs: ["gg1"], depth: 1 });
    expect(output.entries).toEqual([
      expect.objectContaining({ sessionID: "gg1", parentID: "g1", depth: 3 }),
    ]);
  });

  test("finds a subagent the first page's scan does not reach", async () => {
    const world = new World();
    world.addChildren(MAX_SCAN_SESSIONS + 1);
    const oldest = "c0000";
    const { output } = await world.list({ sessionIDs: [oldest] });
    expect(ids(output.entries)).toEqual([oldest]);
    expect(output.complete).toBe(true);
  });

  test("returns the IDs that are not the caller's subagents in errors, alongside the found entries", async () => {
    const world = new World()
      .add("c1")
      .add("stranger", { parentID: "someone-else" });
    const { output, lines } = await world.list({
      sessionIDs: ["stranger", "c1", "missing"],
    });
    expect(ids(output.entries)).toEqual(["c1"]);
    expect(output.errors).toEqual([
      {
        sessionID: "stranger",
        error: "Session stranger is not one of your subagents.",
        suggestions: [],
      },
      {
        sessionID: "missing",
        error: "Session missing is not one of your subagents.",
        suggestions: [],
      },
    ]);
    expect(lines).toEqual([
      "- c1: idle; no cost reported; 0 in + 0 cached / 0 out tokens",
      "- Session stranger is not one of your subagents.",
      "- Session missing is not one of your subagents.",
    ]);
  });

  test("still applies the state filter", async () => {
    const world = new World().add("c1", { state: "running" }).add("c2");
    const { output } = await world.list({
      sessionIDs: ["c1", "c2"],
      state: "idle",
    });
    expect(ids(output.entries)).toEqual(["c2"]);
  });

  test("still applies activeWithinMinutes", async () => {
    const world = new World()
      .add("recent", { idle: NOW - 5 * MINUTE_MS })
      .add("old", { idle: NOW - 50 * MINUTE_MS });
    const { output } = await world.list({
      sessionIDs: ["old", "recent"],
      activeWithinMinutes: 10,
    });
    expect(ids(output.entries)).toEqual(["recent"]);
  });

  test("is refused with a cursor", async () => {
    const world = new World().add("c1");
    const error = await world.pageFailure({ sessionIDs: ["c1"], cursor: "x" });
    expect(error.message).toContain("Pass cursor without sessionIDs");
  });
});

describe("activeWithinMinutes", () => {
  test("keeps running subagents and those that went idle within the window", async () => {
    const world = new World()
      .add("running", { state: "running" })
      .add("recent", { idle: NOW - 9 * MINUTE_MS })
      .add("edge", { idle: NOW - 10 * MINUTE_MS })
      .add("old", { idle: NOW - 10 * MINUTE_MS - 1 })
      .add("never-ended");
    const { output } = await world.list({ activeWithinMinutes: 10 });
    expect(ids(output.entries)).toEqual(["running", "edge", "recent"]);
    expect(output.total).toBe(3);
  });

  test("is applied before the page limit", async () => {
    const world = new World();
    for (let index = 0; index < 60; index++) {
      world.add(`old${index}`, { idle: NOW - 2 * 60 * MINUTE_MS });
    }
    for (let index = 0; index < 55; index++) {
      world.add(`recent${index}`, { idle: NOW - MINUTE_MS });
    }
    const pages = await world.pages({ activeWithinMinutes: 30 });
    expect(pages.map((page) => page.output.entries.length)).toEqual([50, 5]);
    expect(allIDs(pages).every((id) => id.startsWith("recent"))).toBe(true);
    expect(pages[0]?.output.total).toBe(55);
  });

  test("does not say the caller has no subagents when none was active within the window", async () => {
    const world = new World().add("old", { idle: NOW - 2 * 60 * MINUTE_MS });
    const { output, lines } = await world.list({ activeWithinMinutes: 10 });
    expect(output.entries).toEqual([]);
    expect(lines.join("\n")).not.toContain("You have no subagents.");
  });
});

describe("paging with nextCursor", () => {
  test("returns every subagent exactly once, 50 per page", async () => {
    const world = new World();
    const children = world.addChildren(120);
    const pages = await world.pages();
    expect(pages.map((page) => page.output.entries.length)).toEqual([50, 50, 20]);
    expect(allIDs(pages).toSorted()).toEqual(children.toSorted());
    expect(pages.at(-1)?.output).not.toHaveProperty("nextCursor");
    expect(
      pages.map(({ output }) => [output.total, output.truncated, output.complete]),
    ).toEqual([
      [120, true, true],
      [120, true, true],
      [120, true, true],
    ]);
  });

  test("returns the matches of a filter exactly once, running ones first on the first page", async () => {
    const world = new World();
    const children = world.addChildren(130, (index) => index % 2 === 0);
    const pages = await world.pages({ state: "running" });
    const running = children.filter((_, index) => index % 2 === 0);
    expect(allIDs(pages).toSorted()).toEqual(running.toSorted());
    expect(pages.map((page) => page.output.entries.length)).toEqual([50, 15]);
  });

  test("reaches the subagents past the first page's scan, and is complete once it read them", async () => {
    const world = new World();
    const children = world.addChildren(MAX_SCAN_SESSIONS + 1);
    const pages = await world.pages();
    const listed = allIDs(pages);
    expect(listed).toHaveLength(children.length);
    expect(new Set(listed).size).toBe(children.length);
    expect(pages[0]?.output).toMatchObject({
      total: MAX_SCAN_SESSIONS,
      complete: false,
    });
    expect(pages.at(-1)?.output).toMatchObject({
      total: MAX_SCAN_SESSIONS + 1,
      truncated: true,
      complete: true,
    });
  });

  test("returns every subagent exactly once when sessions are updated between calls", async () => {
    const world = new World();
    world.useKeysetPaging();
    const children = world.addChildren(MAX_SCAN_SESSIONS + 1);
    const first = await world.page();
    // The oldest child, which the first page's scan did not read, and one it did read are
    // updated before the next pages are read.
    world.touch(children[0] ?? "");
    world.touch(children[1500] ?? "");
    const pages = [first];
    for (let next = first.output.nextCursor; next !== undefined; ) {
      const page = await world.page({ cursor: next });
      pages.push(page);
      next = page.output.nextCursor;
    }
    const listed = allIDs(pages);
    expect(listed.toSorted()).toEqual(children.toSorted());
  });

  test("fills the pages after the first with the matches past the first page's scan", async () => {
    const world = new World();
    // The oldest 60 are running, past the scan of the 2000 most recently updated.
    world.addChildren(MAX_SCAN_SESSIONS + 60, (index) => index < 60);
    const pages = await world.pages({ state: "running" });
    expect(allIDs(pages)).toHaveLength(60);
    expect(pages.map((page) => page.output.entries.length)).toEqual([0, 50, 10]);
  });
});

describe("a page after the first", () => {
  /** c0009 to c0000, which the second page lists when 60 children all run. */
  const SECOND_PAGE = Array.from(
    { length: 10 },
    (_, index) => `c${String(9 - index).padStart(4, "0")}`,
  );

  /**
   * 60 running children, so the first page lists c0059 to c0010 and the second c0009 to c0000.
   * `between` runs after the first page is read.
   */
  async function secondPage(
    between: (world: World) => Promise<void> | void,
    input: ListInput = {},
  ) {
    const world = new World();
    world.addChildren(60, () => true);
    const first = await world.page(input);
    await between(world);
    const second = await world.page({
      ...input,
      cursor: first.output.nextCursor ?? "",
    });
    return { world, second: second.output };
  }

  /** Records that c0005 finished: its run's end event, and its session as stored after it. */
  async function finish(world: World): Promise<void> {
    world.runState.onEvent(
      executionEnded("session.execution.succeeded", "c0005"),
    );
    const info = await world.reader.get("c0005");
    if (info === undefined) throw new Error("expected c0005");
    world.reader.put({
      ...info,
      title: "Wrote the docs",
      cost: 0.25,
      tokens: { ...info.tokens, input: 900, output: 120, cache: { read: 4000, write: 0 } },
      location: { directory: "/work-feature" },
      time: { ...info.time, idle: NOW - 1000 },
      outcome: "succeeded",
    });
  }

  test("shows the current record of a subagent that finished since the first page, in its place", async () => {
    const { second } = await secondPage(finish);
    expect(ids(second.entries)).toEqual(SECOND_PAGE);
    expect(second.entries[4]).toMatchObject({
      sessionID: "c0005",
      title: "Wrote the docs",
      directory: "/work-feature",
      state: "idle",
      outcome: "succeeded",
      lastIdleAt: NOW - 1000,
      lastActivityAt: NOW - 1000,
      cost: 0.25,
      tokens: { input: 900, cacheRead: 4000, output: 120 },
    });
  });

  test("keeps a subagent the first page's filter matched, though it no longer matches", async () => {
    const { second } = await secondPage(finish, { state: "running" });
    expect(ids(second.entries)).toEqual(SECOND_PAGE);
    expect(second.entries[4]).toMatchObject({ sessionID: "c0005", state: "idle" });
  });

  test("leaves out a subagent deleted since the first page, which total still counts", async () => {
    const { second } = await secondPage((world) => world.reader.remove("c0005"));
    expect(ids(second.entries)).toEqual(
      SECOND_PAGE.filter((id) => id !== "c0005"),
    );
    expect(second.total).toBe(60);
  });

  test("keeps the earlier record, with a warning, of a subagent that cannot be read again", async () => {
    const { world, second } = await secondPage(async (world) => {
      await finish(world);
      world.reader.failingGets.add("c0005");
    });
    expect(ids(second.entries)).toEqual(SECOND_PAGE);
    const entry = second.entries[4];
    expect(entry).toMatchObject({ sessionID: "c0005", directory: "/work", cost: 0 });
    expect(entry).not.toHaveProperty("title");
    expect(world.logger.warnings()).toEqual([
      "list: could not read a subagent again; showing what was read before",
    ]);
  });
});

describe("a cursor the plugin cannot resolve", () => {
  async function firstCursor(world: World): Promise<string> {
    world.addChildren(60);
    const { output } = await world.page();
    if (output.nextCursor === undefined) throw new Error("expected a cursor");
    return output.nextCursor;
  }

  const LIST_AGAIN = /list again without cursor/i;

  test("fails when it is malformed, saying to list again", async () => {
    const world = new World();
    await firstCursor(world);
    for (const cursor of ["", "garbage", "lc1.", "lc1.abc", "lc1.abc.x", "lc1.abc.1.2"]) {
      const error = await world.pageFailure({ cursor });
      expect(error.message).toMatch(LIST_AGAIN);
    }
  });

  test("fails after a reload, saying to list again", async () => {
    const world = new World();
    const cursor = await firstCursor(world);
    world.reload();
    const error = await world.pageFailure({ cursor });
    expect(error.message).toMatch(LIST_AGAIN);
  });

  test("fails once the listing went unread for 30 minutes, saying to list again", async () => {
    const world = new World();
    const cursor = await firstCursor(world);
    world.clock.advance(30 * MINUTE_MS);
    const error = await world.pageFailure({ cursor });
    expect(error.message).toMatch(LIST_AGAIN);
  });

  test("keeps working while each page is read within 30 minutes of the one before", async () => {
    const world = new World();
    world.addChildren(160);
    const first = await world.page();
    world.clock.advance(29 * MINUTE_MS);
    const second = await world.page({ cursor: first.output.nextCursor ?? "" });
    world.clock.advance(29 * MINUTE_MS);
    const third = await world.page({ cursor: second.output.nextCursor ?? "" });
    expect(third.output.entries).toHaveLength(50);
  });

  test("fails with other filters than the listing it came from, saying to list again", async () => {
    const world = new World();
    const cursor = await firstCursor(world);
    const error = await world.pageFailure({ cursor, state: "idle" });
    expect(error.message).toMatch(LIST_AGAIN);
  });
});
