import { describe, expect, test } from "bun:test";
import type { Plugin } from "@opencode/plugin";
import {
  CallID,
  Error as ToolError,
  type ToolContext,
} from "@opencode/plugin/promise/tool";
import { Brand } from "effect";
import { ActivityTracker } from "@/core/activity";
import { formatCount } from "@/core/errors";
import { Latch } from "@/core/latch";
import type {
  CatalogAgent,
  CatalogModel,
  ModelRef,
  RunObservation,
  RunState,
  SessionID,
  SessionInfo,
  SessionMessageInfo,
} from "@/core/ports";
import { CONTINUE_NESTED_NOTE, CONTINUE_OWN_NOTE } from "@/core/stop";
import { createHost } from "@/host";
import {
  type SendOutput,
  type SubagentPermissionRequest,
  sendTool,
} from "@/tools/send";
import { retryScheduled } from "./activity-fixtures";
import {
  assistant,
  compaction,
  completed,
  FakeClock,
  FakeControl,
  FakeSessionReader,
  MemoryStore,
  RecordingLogger,
  RecordingMessenger,
  RecordingSwitcher,
  running,
  sessionInfo,
  synthetic,
  tool,
} from "./fixtures";

const CALLER = "caller";
/** The inbox item ID the messenger gives the first message a world posts. */
const POSTED = "msg_posted_1";
const NOW = 3_000_000;
const MAX = 8000;
const UNKNOWN_BEFORE = "Its run state could not be determined before sending.";

/** A run state, or `unended`: reported idle, although its last run recorded no end. */
type ScriptedState = RunState | "unended";

interface SessionSpec {
  /** Defaults to the caller. */
  readonly parentID?: SessionID;
  /**
   * Run states the target is observed in, one per observation; the last one repeats. The plugin
   * observes once before sending and once after, and a switch observes once more before its first
   * change. Defaults to running.
   */
  readonly states?: readonly ScriptedState[];
  readonly agent?: string;
  readonly model?: ModelRef;
  /** Defaults to the directory `sessionInfo` gives, which is the switcher's. */
  readonly directory?: string;
  readonly title?: string;
  readonly context?: readonly SessionMessageInfo[];
  /** Actions of permission prompts it is waiting on. */
  readonly pending?: readonly string[];
}

/** Run states from a script per session, standing in for the event fold and its probes. */
class ScriptedRunState {
  readonly scripts = new Map<SessionID, ScriptedState[]>();

  async observe(sessionID: SessionID): Promise<RunObservation> {
    const script = this.scripts.get(sessionID) ?? [];
    const state = (script.length > 1 ? script.shift() : script[0]) ?? "idle";
    return state === "unended"
      ? { state: "idle", source: "probe", noRecordedEnd: true }
      : { state, source: "event" };
  }

  async observeAll(
    sessionIDs: Iterable<SessionID>,
  ): Promise<Map<SessionID, RunObservation>> {
    const observed = new Map<SessionID, RunObservation>();
    for (const id of sessionIDs) observed.set(id, await this.observe(id));
    return observed;
  }
}

type SendInput = Parameters<ReturnType<typeof sendTool>["execute"]>[0];

/** Every field of a call but its sessionID. */
type Fields = Omit<SendInput, "sessionID">;

/** A message alone, or the fields of a call. */
type Request = string | Fields;

/**
 * The caller and the sessions below it. Stops go through a real `Latch` over an in-memory store.
 * Every `subagent` permission check is recorded and answered by `permission`, which allows.
 */
class World {
  readonly reader = new FakeSessionReader([sessionInfo(CALLER)]);
  readonly messenger = new RecordingMessenger();
  readonly switcher = new RecordingSwitcher();
  readonly runState = new ScriptedRunState();
  readonly activity = new ActivityTracker();
  readonly logger = new RecordingLogger();
  readonly clock = new FakeClock(NOW);
  readonly latch = new Latch({
    store: new MemoryStore(),
    control: new FakeControl(),
    clock: this.clock,
    logger: this.logger,
    renderNote: () => "",
  });
  readonly permissionChecks: SubagentPermissionRequest[] = [];
  permission: (request: SubagentPermissionRequest) => Promise<void> =
    async () => {};

  add(id: SessionID, spec: SessionSpec = {}): this {
    this.reader.put({
      ...sessionInfo(id, spec.parentID ?? CALLER),
      ...(spec.agent === undefined ? {} : { agent: spec.agent }),
      ...(spec.model === undefined ? {} : { model: spec.model }),
      ...(spec.directory === undefined
        ? {}
        : { location: { directory: spec.directory } }),
      ...(spec.title === undefined ? {} : { title: spec.title }),
    });
    this.runState.scripts.set(id, [...(spec.states ?? ["running"])]);
    if (spec.context !== undefined) this.reader.contexts.set(id, spec.context);
    if (spec.pending !== undefined) this.reader.pending.set(id, spec.pending);
    return this;
  }

  /** Changes the stored agent or model of a session added before, as a switch from elsewhere would. */
  async update(
    id: SessionID,
    change: Partial<Pick<SessionInfo, "agent" | "model">>,
  ): Promise<void> {
    const info = await this.reader.get(id);
    if (info === undefined) throw new Error(`no session ${id}`);
    this.reader.put({ ...info, ...change });
  }

  async stop(id: SessionID): Promise<void> {
    await this.latch.add(id, {
      generation: "gen",
      parentSessionID: CALLER,
      reason: "off track",
      at: NOW - 1000,
    });
  }

  async send(
    sessionID: SessionID,
    request: Request,
    options: { readonly latch?: boolean; readonly signal?: AbortSignal } = {},
  ): Promise<{ readonly output: SendOutput; readonly content: string }> {
    const tool = sendTool(
      {
        reader: this.reader,
        messenger: this.messenger,
        switcher: this.switcher,
        assertSubagent: async (check) => {
          this.permissionChecks.push(check);
          await this.permission(check);
        },
        latch: this.latch,
        runState: this.runState,
        clock: this.clock,
        activity: this.activity,
        logger: this.logger,
      },
      options.latch === undefined ? {} : { latch: options.latch },
    );
    const result = await tool.execute(
      typeof request === "string"
        ? { sessionID, message: request }
        : { sessionID, ...request },
      context(options.signal ?? new AbortController().signal),
    );
    if (result.output === undefined) throw new Error("expected an output");
    if (typeof result.content !== "string") {
      throw new Error("expected text content");
    }
    return { output: result.output, content: result.content };
  }

  /** The tool failure of a send that is expected to fail. */
  async refused(
    sessionID: SessionID,
    request: Request,
    options: { readonly latch?: boolean; readonly signal?: AbortSignal } = {},
  ): Promise<ToolError> {
    try {
      await this.send(sessionID, request, options);
    } catch (error) {
      if (error instanceof ToolError) return error;
      throw error;
    }
    throw new Error("expected the send to fail");
  }
}

function context(signal: AbortSignal): ToolContext {
  return {
    sessionID: Brand.nominal<ToolContext["sessionID"]>()(CALLER),
    agent: Brand.nominal<ToolContext["agent"]>()("build"),
    messageID: Brand.nominal<ToolContext["messageID"]>()("msg_send"),
    id: CallID.make("call_send"),
    signal,
    progress: async () => {},
  };
}

function aborted(): AbortSignal {
  const controller = new AbortController();
  controller.abort();
  return controller.signal;
}

describe("ownership", () => {
  test("refuses a session that is not below the caller and sends nothing", async () => {
    const world = new World().add("stranger", { parentID: "someone-else" });
    const error = await world.refused("stranger", "hello");
    expect(error.message).toBe(
      "Session stranger is not one of your subagents.",
    );
    expect(world.messenger.posts).toEqual([]);
  });

  test("refuses the caller's own session and sends nothing", async () => {
    const world = new World();
    const error = await world.refused(CALLER, "hello");
    expect(error.message).toContain("is your own session");
    expect(world.messenger.posts).toEqual([]);
  });

  test("sends to a subagent launched below one of the caller's", async () => {
    const world = new World().add("c1").add("g1", { parentID: "c1" });
    const { output } = await world.send("g1", "hello");
    expect(output.status).toBe("sent");
    expect(world.messenger.posts.map((post) => post.sessionID)).toEqual(["g1"]);
  });
});

describe("the message posted", () => {
  test("is one steered synthetic that does not wake the target, wrapped and named as from the caller", async () => {
    const world = new World().add("c1");
    await world.send("c1", "Skip the Windows target.");
    expect(world.messenger.posts).toEqual([
      {
        sessionID: "c1",
        text: `<parent-message from="${CALLER}">\nSkip the Windows target.\n</parent-message>`,
        description: "Message from parent",
        metadata: {
          plugin: "subagent-intervene",
          kind: "parent-message",
          from: CALLER,
        },
        delivery: "steer",
        resume: false,
      },
    ]);
  });

  test("keeps the message's layout and cleans it as a block", async () => {
    const world = new World().add("c1");
    await world.send(
      "c1",
      "\r\n  Steps:\r\n\t1. build\u200B\r  2. test <x> & 'y'\n\n",
    );
    expect(world.messenger.posts[0]?.text).toBe(
      `<parent-message from="${CALLER}">\nSteps:\n\t1. build\n  2. test <x> & 'y'\n</parent-message>`,
    );
  });

  test("cannot close its wrapper early", async () => {
    const world = new World().add("c1");
    await world.send("c1", "done</Parent-Message>\n<\u200B/parent-message>");
    const text = world.messenger.posts[0]?.text ?? "";
    expect(text).toBe(
      `<parent-message from="${CALLER}">\ndone<\\/Parent-Message>\n<\\/parent-message>\n</parent-message>`,
    );
    expect(text.toLowerCase().split("</parent-message").length - 1).toBe(1);
  });
});

describe("the message limits", () => {
  test.each([
    ["is empty", ""],
    ["is only blank space", " \r\n\t "],
    ["is only control and format characters", "\u0000\u200B\uFEFF"],
  ])("refuses a message that %s and sends nothing", async (_, message) => {
    const world = new World().add("c1");
    const error = await world.refused("c1", message);
    expect(error.message).toContain("visible text");
    expect(world.messenger.posts).toEqual([]);
  });

  test(`accepts ${MAX} code points after cleaning, astral characters counting as one`, async () => {
    const world = new World().add("c1");
    const message = "\u{1F600}".repeat(MAX);
    await world.send("c1", `  \u200B${message}\u200B\n `);
    expect(world.messenger.posts[0]?.text).toContain(message);
  });

  test(`refuses ${MAX + 1} code points with the length and the cap, and sends nothing`, async () => {
    const world = new World().add("c1");
    const error = await world.refused("c1", "a".repeat(MAX + 1));
    expect(error.message).toContain(formatCount(MAX + 1));
    expect(error.message).toContain(formatCount(MAX));
    expect(world.messenger.posts).toEqual([]);
  });

  test("counts the length after cleaning, escaped closing tags included", async () => {
    // 8000 code points as written; escaping the closing tag adds one.
    const closing = "</parent-message";
    const world = new World().add("c1");
    const error = await world.refused(
      "c1",
      "a".repeat(MAX - closing.length) + closing,
    );
    expect(error.message).toContain(formatCount(MAX + 1));
    expect(world.messenger.posts).toEqual([]);
  });
});

describe("refusals", () => {
  test("refuses a stopped subagent the caller launched, with the own-child hint", async () => {
    const world = new World().add("c1");
    await world.stop("c1");
    const error = await world.refused("c1", "hello");
    expect(error.message).toContain("stopped");
    expect(error.message).toContain(CONTINUE_OWN_NOTE);
    expect(error.message).not.toContain(CONTINUE_NESTED_NOTE);
    expect(world.messenger.posts).toEqual([]);
  });

  test("refuses a stopped nested subagent, naming the parent that can continue it", async () => {
    const world = new World().add("c1").add("g1", { parentID: "c1" });
    await world.stop("g1");
    const error = await world.refused("g1", "hello");
    expect(error.message).toContain("stopped");
    expect(error.message).toContain(CONTINUE_NESTED_NOTE);
    expect(error.message).toContain("launched by c1");
    expect(error.message).not.toContain(CONTINUE_OWN_NOTE);
    expect(world.messenger.posts).toEqual([]);
  });

  test("sends to a stopped subagent when stops are not kept", async () => {
    const world = new World().add("c1");
    await world.stop("c1");
    const { output } = await world.send("c1", "hello", { latch: false });
    expect(output.status).toBe("sent");
    expect(world.messenger.posts).toHaveLength(1);
  });

  test("refuses an idle subagent the caller launched, with the own-child hint", async () => {
    const world = new World().add("c1", { states: ["idle"] });
    const error = await world.refused("c1", "hello");
    expect(error.message).toContain("idle");
    expect(error.message).toContain("call subagent with its sessionID");
    expect(error.message).not.toContain(CONTINUE_NESTED_NOTE);
    expect(world.messenger.posts).toEqual([]);
  });

  test("refuses an idle nested subagent, naming the parent that can continue it", async () => {
    const world = new World()
      .add("c1")
      .add("g1", { parentID: "c1", states: ["idle"] });
    const error = await world.refused("g1", "hello");
    expect(error.message).toContain("idle");
    expect(error.message).toContain(CONTINUE_NESTED_NOTE);
    expect(error.message).toContain("launched by c1");
    expect(world.messenger.posts).toEqual([]);
  });

  test("fails a cancelled call and sends nothing", async () => {
    const world = new World().add("c1");
    const error = await world.refused("c1", "hello", { signal: aborted() });
    expect(error.message).toContain("cancelled");
    expect(world.messenger.posts).toEqual([]);
  });
});

describe("the result", () => {
  test("names the tools in flight that finish before the subagent reads the message", async () => {
    const world = new World().add("c1", {
      agent: "general",
      title: "Add CSV export",
      context: [
        assistant([
          tool("read", completed()),
          tool("shell", running({ command: "bun test" })),
        ]),
      ],
    });
    const { output, content } = await world.send("c1", "hello");
    expect(output).toEqual({
      sessionID: "c1",
      title: "Add CSV export",
      agent: "general",
      status: "sent",
      state: "running",
      activeTools: ["shell"],
      waitingOnPermission: false,
      note: "It reads your message after its current tool calls finish: shell (running 49m 59s). Sending never interrupts; to redirect it right away, stop it with subagent_stop and continue it with subagent.",
    });
    expect(content).toBe(
      'Message sent to c1 (general, "Add CSV export"). It reads your message after its current tool calls finish: shell (running 49m 59s). Sending never interrupts; to redirect it right away, stop it with subagent_stop and continue it with subagent.',
    );
  });

  test("names every tool in flight, however long one tool's input is", async () => {
    const world = new World().add("c1", {
      context: [
        assistant([
          tool("read", running({ path: "a.ts" })),
          tool("shell", running({ command: "x".repeat(50_000) })),
        ]),
      ],
    });
    const { output } = await world.send("c1", "hello");
    expect(output.activeTools).toEqual(["read", "shell"]);
  });

  test("says it reads the message once its current model response finishes when no tool is in flight", async () => {
    const world = new World().add("c1");
    const { output } = await world.send("c1", "hello");
    expect(output.activeTools).toEqual([]);
    expect(output.note).toContain("once its current model response finishes");
  });

  test("says a subagent waiting on a permission prompt reads it only after someone answers", async () => {
    const world = new World().add("c1", { pending: ["shell"] });
    const { output } = await world.send("c1", "hello");
    expect(output.status).toBe("sent");
    expect(output.waitingOnPermission).toBe(true);
    expect(output.note).toContain("permission prompt");
    expect(output.note).toContain("only after someone answers");
  });

  test("lists no tools, with a warning, when the subagent's context cannot be read", async () => {
    const world = new World().add("c1");
    world.reader.failingContexts.add("c1");
    const { output } = await world.send("c1", "hello");
    expect(output.status).toBe("sent");
    expect(output.activeTools).toEqual([]);
    expect(world.logger.warnings()).toEqual([
      "send: could not read the subagent's context",
    ]);
  });

  test("is queued when the subagent is idle right after sending", async () => {
    const world = new World().add("c1", {
      states: ["running", "idle"],
      pending: ["shell"],
    });
    const { output, content } = await world.send("c1", "hello");
    expect(output).toMatchObject({
      status: "queued",
      state: "idle",
      activeTools: [],
      waitingOnPermission: false,
    });
    expect(output.note).toContain("call subagent with its sessionID");
    expect(content).toBe(`Message queued for c1. ${output.note}`);
    expect(world.messenger.posts).toHaveLength(1);
  });

  describe("a message already among the subagent's messages", () => {
    test("is delivered when the subagent is still running, with no tools or prompt to wait for", async () => {
      const world = new World().add("c1", {
        pending: ["shell"],
        context: [
          synthetic(POSTED),
          assistant([tool("shell", running({ command: "bun test" }))]),
        ],
      });
      const { output, content } = await world.send("c1", "hello");
      expect(output).toMatchObject({
        status: "delivered",
        state: "running",
        activeTools: [],
        waitingOnPermission: false,
        note: "It has already read your message.",
      });
      expect(content).toBe(
        "Message delivered to c1. It has already read your message.",
      );
    });

    test("is delivered, not queued, when the subagent read it and then finished", async () => {
      const world = new World().add("c1", {
        states: ["running", "idle"],
        context: [synthetic(POSTED)],
      });
      const { output } = await world.send("c1", "hello");
      expect(output).toMatchObject({
        status: "delivered",
        state: "idle",
        note: "It read your message, then finished its run.",
      });
    });

    test("is this message, not an earlier one from the parent", async () => {
      const world = new World().add("c1", {
        states: ["running", "idle"],
        context: [synthetic("msg_earlier")],
      });
      const { output } = await world.send("c1", "hello");
      expect(output.status).toBe("queued");
    });
  });

  describe("is unconfirmed when an idle subagent's delivery cannot be checked", () => {
    test("because its messages cannot be read", async () => {
      const world = new World().add("c1", { states: ["running", "idle"] });
      world.reader.failingContexts.add("c1");
      const { output, content } = await world.send("c1", "hello");
      expect(output.status).toBe("unconfirmed");
      expect(output.note).toContain("its messages could not be read");
      expect(output.note).toContain("If it did not, the message waits");
      expect(content).toStartWith("Message sent to c1.");
      expect(world.logger.warnings()).toEqual([
        "send: could not read the subagent's context",
      ]);
    });

    test("because its context was compacted after the message was admitted", async () => {
      const world = new World().add("c1", {
        states: ["running", "idle"],
        context: [compaction("completed")],
      });
      world.messenger.createdAt = 0;
      const { output } = await world.send("c1", "hello");
      expect(output.status).toBe("unconfirmed");
      expect(output.note).toContain("its context was compacted since");
    });
  });

  test("is queued when the only compaction completed before the message was admitted", async () => {
    const world = new World().add("c1", {
      states: ["running", "idle"],
      context: [compaction("completed")],
    });
    const { output } = await world.send("c1", "hello");
    expect(output.status).toBe("queued");
  });

  test("is queued when a compaction after the message was admitted did not complete", async () => {
    const world = new World().add("c1", {
      states: ["running", "idle"],
      context: [compaction("failed")],
    });
    world.messenger.createdAt = 0;
    const { output } = await world.send("c1", "hello");
    expect(output.status).toBe("queued");
  });

  test("tells how to continue a queued nested subagent through its own parent", async () => {
    const world = new World()
      .add("c1")
      .add("g1", { parentID: "c1", states: ["running", "idle"] });
    const { output } = await world.send("g1", "hello");
    expect(output.status).toBe("queued");
    expect(output.note).toContain(CONTINUE_NESTED_NOTE);
    expect(output.note).toContain("launched by c1");
  });

  describe("an unknown run state", () => {
    test("before sending still sends, and the note says so", async () => {
      const world = new World().add("c1", { states: ["unknown", "running"] });
      const { output } = await world.send("c1", "hello");
      expect(world.messenger.posts).toHaveLength(1);
      expect(output.status).toBe("sent");
      expect(output.state).toBe("running");
      expect(output.note.startsWith(UNKNOWN_BEFORE)).toBe(true);
    });

    test("before sending is stated in the note of a queued message", async () => {
      const world = new World().add("c1", { states: ["unknown", "idle"] });
      const { output } = await world.send("c1", "hello");
      expect(output.status).toBe("queued");
      expect(output.note.startsWith(UNKNOWN_BEFORE)).toBe(true);
    });

    test("after sending is stated in the note", async () => {
      const world = new World().add("c1", { states: ["running", "unknown"] });
      const { output } = await world.send("c1", "hello");
      expect(output).toMatchObject({ status: "sent", state: "unknown" });
      expect(output.note).toContain("could not be determined after sending");
    });

    test("both before and after sending is stated in the note", async () => {
      const world = new World().add("c1", { states: ["unknown"] });
      const { output } = await world.send("c1", "hello");
      expect(output).toMatchObject({ status: "sent", state: "unknown" });
      expect(output.note).toContain("could not be determined");
    });

    test("after sending is stated even when the subagent is waiting on a permission prompt", async () => {
      const world = new World().add("c1", {
        states: ["running", "unknown"],
        pending: ["shell"],
      });
      const { output } = await world.send("c1", "hello");
      expect(output.waitingOnPermission).toBe(true);
      expect(output.note).toContain("could not be determined");
    });
  });
});

const MINUTE = 60_000;
const NOTHING = "Nothing was switched or sent.";
const SONNET: ModelRef = { providerID: "anthropic", id: "claude-sonnet-4-5" };
const GPT5_LOW: ModelRef = { providerID: "openai", id: "gpt-5", variant: "low" };
const GPT5_HIGH: ModelRef = {
  providerID: "openai",
  id: "gpt-5",
  variant: "high",
};
/** The agents of `switching()`'s catalog that can run as subagents. */
const SUBAGENTS =
  "Agents that can run as subagents: explore, general, legacy, reviewer, scout.";

function catalogAgent(
  id: string,
  mode: CatalogAgent["mode"] = "subagent",
  model?: ModelRef,
): CatalogAgent {
  return { id, mode, hidden: false, ...(model === undefined ? {} : { model }) };
}

function catalogModel(
  ref: ModelRef,
  options: { readonly type?: string; readonly variants?: readonly string[] } = {},
): CatalogModel {
  return {
    providerID: ref.providerID,
    id: ref.id,
    ...(options.type === undefined ? {} : { type: options.type }),
    variants: (options.variants ?? []).map((variant) => ({ id: variant })),
  };
}

/**
 * A world whose project has agents and models to switch to, with `c1`: a running `general` subagent
 * of the caller on Sonnet, in the switcher's own directory. `spec` overrides c1's defaults.
 */
function switching(spec: SessionSpec = {}): World {
  const world = new World();
  world.switcher.agentCatalog = [
    catalogAgent("build", "primary"),
    catalogAgent("explore"),
    catalogAgent("general"),
    catalogAgent("legacy", "subagent", {
      providerID: "retired",
      id: "old-model",
    }),
    catalogAgent("reviewer", "subagent", GPT5_HIGH),
    catalogAgent("scout", "all"),
  ];
  world.switcher.chatModels = [
    catalogModel(SONNET),
    catalogModel(GPT5_HIGH, { variants: ["low", "medium", "high"] }),
  ];
  world.switcher.otherModels = [
    catalogModel({ providerID: "openai", id: "gpt-image-1" }, { type: "image" }),
    catalogModel({ providerID: "openai", id: "sora-2" }, { type: "video" }),
    catalogModel({ providerID: "openai", id: "router" }, { type: "decision" }),
  ];
  return world.add("c1", {
    agent: "general",
    model: SONNET,
    title: "Add CSV export",
    ...spec,
  });
}

/** Neither the agent nor the model was switched, and no message was posted. */
function expectUnchanged(world: World): void {
  expect(world.switcher.switches).toEqual([]);
  expect(world.messenger.posts).toEqual([]);
}

/** A shell call that has been running for 47 minutes. */
function runningShell(): SessionMessageInfo[] {
  return [
    assistant([
      tool("shell", running({ command: "bun test" }), {
        ran: NOW - 47 * MINUTE,
      }),
    ]),
  ];
}

describe("switching: the inputs", () => {
  test.each<[string, Fields]>([
    ["no message, model or agent", {}],
    ["only a blank model and agent", { model: " ", agent: "" }],
  ])("refuse a call with %s, and change nothing", async (_, fields) => {
    const world = switching();
    const error = await world.refused("c1", fields);
    expect(error.message).toBe(
      "Nothing was sent: give a message, a model or an agent.",
    );
    expectUnchanged(world);
  });

  test.each<[string, Fields]>([
    ["a message alone", { message: "hello" }],
    [
      "a message with a blank model and agent",
      { message: "hello", model: "  ", agent: "" },
    ],
  ])("switch nothing for %s, which is sent as before", async (_, fields) => {
    const world = switching();
    const { output, content } = await world.send("c1", fields);
    expect(world.switcher.switches).toEqual([]);
    expect(world.permissionChecks).toEqual([]);
    expect(world.messenger.posts).toHaveLength(1);
    expect(output.status).toBe("sent");
    expect(output).not.toHaveProperty("switched");
    expect(content).toStartWith(
      'Message sent to c1 (general, "Add CSV export"). It reads your message',
    );
  });

  test("treat a message with no visible text as absent when the call switches", async () => {
    const world = switching();
    const { output } = await world.send("c1", {
      message: " \n\u200B",
      model: "openai/gpt-5#high",
    });
    expect(world.switcher.switches).toEqual([
      { sessionID: "c1", model: GPT5_HIGH },
    ]);
    expect(world.messenger.posts).toEqual([]);
    expect(output).not.toHaveProperty("status");
  });

  test("treat a blank model as absent, so a new agent brings its configured model", async () => {
    const world = switching();
    await world.send("c1", { agent: "reviewer", model: "  " });
    expect(world.switcher.switches).toEqual([
      { sessionID: "c1", agent: "reviewer" },
      { sessionID: "c1", model: GPT5_HIGH },
    ]);
  });
});

describe("switching the agent", () => {
  test("moves the subagent to the new agent's configured model", async () => {
    const world = switching();
    const { output, content } = await world.send("c1", { agent: "reviewer" });
    expect(world.switcher.switches).toEqual([
      { sessionID: "c1", agent: "reviewer" },
      { sessionID: "c1", model: GPT5_HIGH },
    ]);
    expect(output).toMatchObject({
      agent: "reviewer",
      switched: {
        agent: { from: "general", to: "reviewer" },
        model: { from: "anthropic/claude-sonnet-4-5", to: "openai/gpt-5#high" },
      },
    });
    expect(output.note).toContain(
      "openai/gpt-5#high is the configured model of agent reviewer.",
    );
    expect(content).toStartWith(
      'Switched c1 (reviewer, "Add CSV export") from agent general to reviewer and from model anthropic/claude-sonnet-4-5 to openai/gpt-5#high.',
    );
  });

  test("keeps the model when the new agent has none configured", async () => {
    const world = switching();
    const { output } = await world.send("c1", { agent: "explore" });
    expect(world.switcher.switches).toEqual([
      { sessionID: "c1", agent: "explore" },
    ]);
    expect(output.switched).toEqual({
      agent: { from: "general", to: "explore" },
    });
    expect(output.note).toContain(
      "It keeps model anthropic/claude-sonnet-4-5, since agent explore has no configured model.",
    );
  });

  test("lists only the agent when the new agent's configured model is already in use", async () => {
    const world = switching({ model: GPT5_HIGH });
    const { output } = await world.send("c1", { agent: "reviewer" });
    expect(world.switcher.switches).toEqual([
      { sessionID: "c1", agent: "reviewer" },
    ]);
    expect(output.switched).toEqual({
      agent: { from: "general", to: "reviewer" },
    });
    expect(output.note).toContain(
      "It keeps model openai/gpt-5#high, the configured model of agent reviewer.",
    );
  });

  test("lets an explicit model win over the new agent's configured model, which then needs no check", async () => {
    // legacy's configured model is not available, which would refuse the switch without a model.
    const world = switching();
    await world.send("c1", { agent: "legacy", model: "openai/gpt-5#low" });
    expect(world.switcher.switches).toEqual([
      { sessionID: "c1", agent: "legacy" },
      { sessionID: "c1", model: GPT5_LOW },
    ]);
  });

  test("reaches an agent that can run both as a primary agent and as a subagent", async () => {
    const world = switching();
    await world.send("c1", { agent: "scout" });
    expect(world.switcher.switches).toEqual([
      { sessionID: "c1", agent: "scout" },
    ]);
  });

  test("switches nothing for the agent it already runs, though that agent configures another model", async () => {
    const world = switching({ agent: "reviewer" });
    const { output, content } = await world.send("c1", { agent: "reviewer" });
    expect(world.switcher.switches).toEqual([]);
    expect(output).not.toHaveProperty("switched");
    expect(output).not.toHaveProperty("status");
    expect(content).toBe(
      'c1 (reviewer, "Add CSV export"): Nothing was switched. It already runs agent reviewer.',
    );
  });
});

describe("switching the model", () => {
  test.each<[string, ModelRef, string, ModelRef, string]>([
    [
      "only its variant",
      GPT5_LOW,
      "openai/gpt-5#high",
      GPT5_HIGH,
      "openai/gpt-5#low",
    ],
    [
      "to no variant",
      GPT5_HIGH,
      "openai/gpt-5",
      { providerID: "openai", id: "gpt-5" },
      "openai/gpt-5#high",
    ],
  ])("switches %s", async (_, current, asked, to, from) => {
    const world = switching({ model: current });
    const { output } = await world.send("c1", { model: asked });
    expect(world.switcher.switches).toEqual([{ sessionID: "c1", model: to }]);
    expect(output.switched).toEqual({ model: { from, to: asked } });
  });

  test("switches nothing for the model it already uses, and still sends the message", async () => {
    const world = switching({ model: GPT5_HIGH });
    const { output, content } = await world.send("c1", {
      model: "openai/gpt-5#high",
      message: "hello",
    });
    expect(world.switcher.switches).toEqual([]);
    expect(world.messenger.posts).toHaveLength(1);
    expect(output.status).toBe("sent");
    expect(output).not.toHaveProperty("switched");
    expect(content).toStartWith(
      'Message sent to c1 (general, "Add CSV export"). Nothing was switched. It already uses model openai/gpt-5#high. It reads your message',
    );
  });

  test("leaves out from when the subagent recorded no model of its own", async () => {
    const world = switching({ model: undefined });
    const { output, content } = await world.send("c1", {
      model: "openai/gpt-5",
    });
    expect(output.switched).toEqual({ model: { to: "openai/gpt-5" } });
    expect(content).toStartWith(
      'Switched c1 (general, "Add CSV export") from its default model to openai/gpt-5.',
    );
  });
});

describe("switching: a request that fails a check", () => {
  test.each<[string, Fields, string]>([
    [
      "a malformed model",
      { model: "gpt-5" },
      `Invalid model "gpt-5". Use "providerID/modelID" or "providerID/modelID#variant". ${NOTHING}`,
    ],
    [
      "an unknown model",
      { model: "openai/gpt-9" },
      `Model "openai/gpt-9" is not available. Use the models tool to see what is available. ${NOTHING}`,
    ],
    [
      "an image model",
      { model: "openai/gpt-image-1" },
      `Model "openai/gpt-image-1" is an image model; subagents need a chat model. Use the models tool to find one. ${NOTHING}`,
    ],
    [
      "a video model",
      { model: "openai/sora-2" },
      `Model "openai/sora-2" is a video model; subagents need a chat model. Use the models tool to find one. ${NOTHING}`,
    ],
    [
      "a decision model",
      { model: "openai/router" },
      `Model "openai/router" is a decision model; subagents need a chat model. Use the models tool to find one. ${NOTHING}`,
    ],
    [
      "a variant the model does not have",
      { model: "openai/gpt-5#ultra" },
      `Variant "ultra" is not available for "openai/gpt-5". Available: low, medium, high. ${NOTHING}`,
    ],
    [
      "a variant of a model that has none",
      { model: "anthropic/claude-sonnet-4-5#high" },
      `Model "anthropic/claude-sonnet-4-5" has no variants. Omit the variant. ${NOTHING}`,
    ],
    [
      "an unknown agent",
      { agent: "reviewr" },
      `Unknown agent "reviewr". ${SUBAGENTS} ${NOTHING}`,
    ],
    [
      "a primary-only agent",
      { agent: "build" },
      `Agent build cannot run as a subagent. ${SUBAGENTS} ${NOTHING}`,
    ],
    [
      "a new agent whose configured model is not available",
      { agent: "legacy" },
      `Model "retired/old-model" is not available. Use the models tool to see what is available. It is the configured model of agent legacy; pass model to choose another. ${NOTHING}`,
    ],
    [
      "a valid agent with a model that is not available",
      { agent: "explore", model: "openai/gpt-9" },
      `Model "openai/gpt-9" is not available. Use the models tool to see what is available. ${NOTHING}`,
    ],
  ])("refuses %s and changes nothing", async (_, fields, message) => {
    const world = switching();
    const error = await world.refused("c1", { ...fields, message: "hello" });
    expect(error.message).toBe(message);
    expectUnchanged(world);
  });

  test("refuses a call whose catalog cannot be read, and changes nothing", async () => {
    const world = switching();
    world.switcher.failing.add("models");
    const error = await world.refused("c1", {
      model: "openai/gpt-5",
      message: "hello",
    });
    expect(error.message).toBe(
      `The models available to the subagent could not be read: models failed. ${NOTHING}`,
    );
    expectUnchanged(world);
  });
});

describe("switching: the subagent permission", () => {
  test("is checked for the new agent, as the caller's call, before anything is switched", async () => {
    const world = switching();
    let switchedWhenChecked: unknown[] | undefined;
    world.permission = async () => {
      switchedWhenChecked = [...world.switcher.switches];
    };
    await world.send("c1", { agent: "explore", model: "openai/gpt-5#high" });
    expect(world.permissionChecks).toEqual([
      {
        sessionID: CALLER,
        agent: "build",
        messageID: "msg_send",
        callID: "call_send",
        subagent: "explore",
      },
    ]);
    expect(switchedWhenChecked).toEqual([]);
    expect(world.switcher.switches).toHaveLength(2);
  });

  test.each<[string, Fields]>([
    ["a model alone", { model: "openai/gpt-5#high" }],
    ["the agent it already runs", { agent: "general" }],
  ])("is not checked for %s", async (_, fields) => {
    const world = switching();
    await world.send("c1", fields);
    expect(world.permissionChecks).toEqual([]);
  });

  test.each<[string, unknown, string]>([
    [
      "a Tool.Error",
      new ToolError({ message: "Permission denied: subagent" }),
      "Permission denied: subagent.",
    ],
    [
      "a Tool.Error of another copy of its class",
      { _tag: "Tool.Error", message: "Not for this task!" },
      "Not for this task!",
    ],
    [
      "a Tool.Error with no message",
      new ToolError({ message: " " }),
      "no reason was given.",
    ],
  ])("refuses the call on %s, and changes nothing", async (_, rejection, reason) => {
    const world = switching();
    world.permission = () => Promise.reject(rejection);
    const error = await world.refused("c1", {
      agent: "explore",
      message: "hello",
    });
    expect(error.message).toBe(
      `Running agent explore as a subagent was refused: ${reason} ${NOTHING}`,
    );
    expectUnchanged(world);
  });

  test("lets a person's plain decline end the caller's step unchanged, and changes nothing", async () => {
    class DeclinedError extends Error {}
    const declined = new DeclinedError("declined");
    const world = switching();
    world.permission = () => Promise.reject(declined);
    await expect(
      world.send("c1", { agent: "explore", message: "hello" }),
    ).rejects.toBe(declined);
    expectUnchanged(world);
  });
});

describe("switching: while the call is checked", () => {
  test("a subagent that finishes its run is refused as idle, with nothing switched", async () => {
    const world = switching();
    world.permission = async () => {
      world.runState.scripts.set("c1", ["idle"]);
    };
    const error = await world.refused("c1", {
      agent: "explore",
      message: "hello",
    });
    expect(error.message).toStartWith(
      "Subagent c1 is idle, so nothing was switched or sent",
    );
    expectUnchanged(world);
  });

  test("a subagent that is stopped is refused as stopped, with nothing switched, even without a permission prompt", async () => {
    const world = switching();
    const models = world.switcher.models.bind(world.switcher);
    world.switcher.models = async (types) => {
      await world.stop("c1");
      return models(types);
    };
    const error = await world.refused("c1", {
      model: "openai/gpt-5#high",
      message: "hello",
    });
    expect(error.message).toStartWith(
      "Subagent c1 is stopped, so nothing was switched or sent.",
    );
    expect(world.permissionChecks).toEqual([]);
    expectUnchanged(world);
  });

  test("a subagent that is deleted is refused, with nothing switched", async () => {
    const world = switching();
    world.permission = async () => {
      world.reader.remove("c1");
    };
    const error = await world.refused("c1", {
      agent: "explore",
      message: "hello",
    });
    expect(error.message).toBe(
      `Subagent c1 was deleted while this call was checked. ${NOTHING}`,
    );
    expectUnchanged(world);
  });

  test("a subagent switched away from the agent asked for is refused, with nothing switched", async () => {
    const world = switching();
    const models = world.switcher.models.bind(world.switcher);
    world.switcher.models = async (types) => {
      await world.update("c1", { agent: "explore" });
      return models(types);
    };
    const error = await world.refused("c1", {
      agent: "general",
      model: "openai/gpt-5#high",
      message: "hello",
    });
    expect(error.message).toBe(
      `Subagent c1 was switched to agent explore while this call was checked. ${NOTHING} To switch it to general, call subagent_send again.`,
    );
    expectUnchanged(world);
  });

  test("a model switched meanwhile is what the result reports switching from", async () => {
    const world = switching();
    world.permission = () => world.update("c1", { model: GPT5_LOW });
    const { output } = await world.send("c1", { agent: "reviewer" });
    expect(world.switcher.switches).toEqual([
      { sessionID: "c1", agent: "reviewer" },
      { sessionID: "c1", model: GPT5_HIGH },
    ]);
    expect(output.switched?.model).toEqual({
      from: "openai/gpt-5#low",
      to: "openai/gpt-5#high",
    });
  });

  test("a model switched meanwhile is the one the note says it keeps", async () => {
    const world = switching();
    world.permission = () => world.update("c1", { model: GPT5_HIGH });
    const { output } = await world.send("c1", { agent: "explore" });
    expect(output.note).toContain(
      "It keeps model openai/gpt-5#high, since agent explore has no configured model.",
    );
  });

  test("a subagent that keeps being switched by someone else is refused, with nothing switched", async () => {
    // Every catalog read sees its model switched again, so no fresh read matches the one before it.
    const world = switching();
    const models = world.switcher.models.bind(world.switcher);
    let reads = 0;
    world.switcher.models = async (types) => {
      reads += 1;
      await world.update("c1", { model: reads % 2 === 1 ? GPT5_LOW : SONNET });
      return models(types);
    };
    const error = await world.refused("c1", {
      model: "openai/gpt-5#high",
      message: "hello",
    });
    expect(error.message).toBe(
      `Subagent c1 kept being switched by someone else while this call was checked. ${NOTHING}`,
    );
    expectUnchanged(world);
  });

  test("an agent switched meanwhile is the agent the result reports it runs", async () => {
    const world = switching();
    const models = world.switcher.models.bind(world.switcher);
    world.switcher.models = async (types) => {
      await world.update("c1", { agent: "explore" });
      return models(types);
    };
    const { output, content } = await world.send("c1", {
      model: "openai/gpt-5#high",
    });
    expect(world.switcher.switches).toEqual([
      { sessionID: "c1", model: GPT5_HIGH },
    ]);
    expect(output.agent).toBe("explore");
    expect(content).toStartWith('Switched c1 (explore, "Add CSV export")');
  });
});

describe("switching: the target", () => {
  test("can be launched below one of the caller's subagents", async () => {
    const world = switching().add("g1", {
      parentID: "c1",
      agent: "general",
      model: SONNET,
    });
    await world.send("g1", { agent: "explore", model: "openai/gpt-5#high" });
    expect(world.switcher.switches).toEqual([
      { sessionID: "g1", agent: "explore" },
      { sessionID: "g1", model: GPT5_HIGH },
    ]);
  });

  test.each<[string, (world: World) => Promise<unknown>, string]>([
    [
      "not one of the caller's",
      async (world) => world.add("t", { parentID: "someone-else" }),
      "Session t is not one of your subagents.",
    ],
    [
      "stopped",
      async (world) => world.add("t").stop("t"),
      "Subagent t is stopped, so nothing was switched or sent.",
    ],
    [
      "idle",
      async (world) => world.add("t", { states: ["idle"] }),
      "Subagent t is idle, so nothing was switched or sent:",
    ],
    [
      "idle although its last run recorded no end",
      async (world) => world.add("t", { states: ["unended"] }),
      "Subagent t is not running, so nothing was switched or sent:",
    ],
  ])("is refused when %s, with nothing switched or asked", async (_, setup, start) => {
    const world = switching();
    await setup(world);
    const error = await world.refused("t", {
      agent: "explore",
      model: "openai/gpt-5#high",
      message: "hello",
    });
    expect(error.message).toStartWith(start);
    expect(world.permissionChecks).toEqual([]);
    expectUnchanged(world);
  });

  test.each<[string, ScriptedState]>([
    ["idle", "idle"],
    ["idle although its last run recorded no end", "unended"],
  ])("tells how to continue a direct child that is %s under another model or agent", async (_, state) => {
    const world = switching({ states: [state] });
    const error = await world.refused("c1", { model: "openai/gpt-5#high" });
    expect(error.message).toEndWith(
      "To continue it with a different model or agent, call subagent with its sessionID, a prompt, model, and agent: its current agent, general, to keep that agent, or another agent to switch to it.",
    );
  });

  test("tells how to continue an idle grandchild only through its own parent", async () => {
    const world = switching().add("g1", { parentID: "c1", states: ["idle"] });
    const error = await world.refused("g1", { model: "openai/gpt-5#high" });
    expect(error.message).toContain(CONTINUE_NESTED_NOTE);
    expect(error.message).toContain("launched by c1");
    expect(error.message).not.toContain("a prompt, model, and agent");
  });

  describe("in another directory than the plugin instance's", () => {
    test("is refused for a switch, with nothing switched or asked, and told how to switch a direct child", async () => {
      const world = switching({ directory: "/elsewhere" });
      const error = await world.refused("c1", {
        agent: "explore",
        message: "hello",
      });
      expect(error.message).toStartWith("Subagent c1 runs in /elsewhere");
      expect(error.message).toContain(NOTHING);
      expect(error.message).toContain(
        "call subagent_send from a session in that directory, or continue it with subagent",
      );
      expect(world.permissionChecks).toEqual([]);
      expectUnchanged(world);
    });

    test("is not told to continue a grandchild with subagent", async () => {
      const world = switching().add("g1", {
        parentID: "c1",
        directory: "/elsewhere",
      });
      const error = await world.refused("g1", { model: "openai/gpt-5#high" });
      expect(error.message).toStartWith("Subagent g1 runs in /elsewhere");
      expect(error.message).toContain(
        "call subagent_send from a session in that directory",
      );
      expect(error.message).not.toContain("continue it with subagent");
      expectUnchanged(world);
    });

    test("is refused when it moved there while the call was checked", async () => {
      const world = switching();
      world.permission = async () => {
        const info = await world.reader.get("c1");
        if (info !== undefined) {
          world.reader.put({ ...info, location: { directory: "/elsewhere" } });
        }
      };
      const error = await world.refused("c1", {
        agent: "explore",
        message: "hello",
      });
      expect(error.message).toStartWith("Subagent c1 runs in /elsewhere");
      expectUnchanged(world);
    });

    test("still gets a message without a switch", async () => {
      const world = switching({ directory: "/elsewhere" });
      const { output } = await world.send("c1", {
        message: "hello",
        model: "",
        agent: "",
      });
      expect(output.status).toBe("sent");
      expect(world.messenger.posts).toHaveLength(1);
    });
  });
});

describe("switching: the order of changes", () => {
  test("is the agent, then the model, then the message", async () => {
    const world = switching();
    const switchedWhenPosted: unknown[] = [];
    const post = world.messenger.synthetic.bind(world.messenger);
    world.messenger.synthetic = async (message) => {
      switchedWhenPosted.push(...world.switcher.switches);
      return post(message);
    };
    await world.send("c1", {
      agent: "explore",
      model: "openai/gpt-5#high",
      message: "hello",
    });
    const both = [
      { sessionID: "c1", agent: "explore" },
      { sessionID: "c1", model: GPT5_HIGH },
    ];
    expect(world.switcher.switches).toEqual(both);
    expect(switchedWhenPosted).toEqual(both);
  });

  test("reports the agent switched, and what the subagent now runs, when the model switch fails after it", async () => {
    const world = switching();
    world.switcher.failing.add("switchModel");
    const error = await world.refused("c1", {
      agent: "explore",
      model: "openai/gpt-5#high",
      message: "hello",
    });
    expect(error.message).toBe(
      "Switched c1 from agent general to explore, but could not switch its model to openai/gpt-5#high: switchModel failed. Nothing was sent. It runs agent explore with model anthropic/claude-sonnet-4-5 from its next model request.",
    );
    expect(world.switcher.switches).toEqual([
      { sessionID: "c1", agent: "explore" },
    ]);
    expect(world.messenger.posts).toEqual([]);
  });

  test.each<[string, "switchAgent" | "switchModel", Fields, string]>([
    [
      "the agent switch",
      "switchAgent",
      { agent: "explore", model: "openai/gpt-5#high" },
      `Could not switch c1 to agent explore: switchAgent failed. ${NOTHING}`,
    ],
    [
      "a model switch alone",
      "switchModel",
      { model: "openai/gpt-5#high" },
      `Could not switch c1 to model openai/gpt-5#high: switchModel failed. ${NOTHING}`,
    ],
  ])("goes no further when %s fails", async (_, failing, fields, message) => {
    const world = switching();
    world.switcher.failing.add(failing);
    const error = await world.refused("c1", { ...fields, message: "hello" });
    expect(error.message).toBe(message);
    expectUnchanged(world);
  });

  test("reports what was switched when the message cannot be queued after the switch", async () => {
    const world = switching();
    world.messenger.failing = true;
    const error = await world.refused("c1", {
      model: "openai/gpt-5#high",
      message: "hello",
    });
    expect(error.message).toBe(
      "Switched c1 from model anthropic/claude-sonnet-4-5 to openai/gpt-5#high, but your message could not be sent: synthetic failed. The switch stays in effect from its next model request. To deliver the message, call subagent_send again without model or agent.",
    );
    expect(world.switcher.switches).toEqual([
      { sessionID: "c1", model: GPT5_HIGH },
    ]);
  });

  test("switches nothing when the call is cancelled before the switch", async () => {
    const world = switching();
    const error = await world.refused(
      "c1",
      { agent: "explore", message: "hello" },
      { signal: aborted() },
    );
    expect(error.message).toBe(
      "The call was cancelled; nothing was switched or sent.",
    );
    expectUnchanged(world);
  });

  test("reports what was switched when the call is cancelled between the switch and the message", async () => {
    const world = switching();
    const controller = new AbortController();
    const switchModel = world.switcher.switchModel.bind(world.switcher);
    world.switcher.switchModel = async (sessionID, model) => {
      await switchModel(sessionID, model);
      controller.abort();
    };
    const error = await world.refused(
      "c1",
      { model: "openai/gpt-5#high", message: "hello" },
      { signal: controller.signal },
    );
    expect(error.message).toBe(
      "The call was cancelled after it switched c1 from model anthropic/claude-sonnet-4-5 to openai/gpt-5#high, so your message was not sent. The switch stays in effect from its next model request.",
    );
    expect(world.messenger.posts).toEqual([]);
  });
});

describe("switching: the result", () => {
  test("of a model switch with a message says what switched, when the message is read and when the switch applies", async () => {
    const world = switching({ context: runningShell() });
    const { output, content } = await world.send("c1", {
      model: "openai/gpt-5#high",
      message: "Keep going at the higher effort.",
    });
    expect(output).toEqual({
      sessionID: "c1",
      title: "Add CSV export",
      agent: "general",
      status: "sent",
      switched: {
        model: { from: "anthropic/claude-sonnet-4-5", to: "openai/gpt-5#high" },
      },
      state: "running",
      activeTools: ["shell"],
      waitingOnPermission: false,
      note: "It reads your message after its current tool calls finish: shell (running 47m). It uses the new model from its next model request. Sending never interrupts; to redirect it right away, stop it with subagent_stop and continue it with subagent.",
    });
    expect(content).toBe(
      `Switched c1 (general, "Add CSV export") from model anthropic/claude-sonnet-4-5 to openai/gpt-5#high. Message sent. ${output.note}`,
    );
  });

  test("of an agent switch without a message has no status, says when the switch applies, and how to keep the agent", async () => {
    const world = switching({ model: GPT5_HIGH, context: runningShell() });
    const { output, content } = await world.send("c1", { agent: "explore" });
    expect(output).toEqual({
      sessionID: "c1",
      title: "Add CSV export",
      agent: "explore",
      switched: { agent: { from: "general", to: "explore" } },
      state: "running",
      activeTools: ["shell"],
      waitingOnPermission: false,
      note: "It keeps model openai/gpt-5#high, since agent explore has no configured model. It uses the new agent from its next model request, which starts after its current tool calls finish: shell (running 47m). Switching never interrupts; to redirect it right away, stop it with subagent_stop and continue it with subagent. If you continue it later with subagent, pass agent explore: any other agent name switches its agent again.",
    });
    expect(content).toBe(
      `Switched c1 (explore, "Add CSV export") from agent general to explore. ${output.note}`,
    );
  });

  test("of an agent switch tells no grandchild how to continue it with subagent", async () => {
    const world = switching().add("g1", { parentID: "c1", agent: "general" });
    const { output } = await world.send("g1", { agent: "explore" });
    expect(output.switched).toEqual({
      agent: { from: "general", to: "explore" },
    });
    expect(output.note).not.toContain("continue it later with subagent");
  });

  describe("of a switch without a message", () => {
    test("says its next model request waits for someone to answer the prompt it waits on", async () => {
      const world = switching({ pending: ["shell"] });
      const { output } = await world.send("c1", { model: "openai/gpt-5#high" });
      expect(output.waitingOnPermission).toBe(true);
      expect(output.note).toBe(
        "It is waiting on a permission prompt (shell), so its next model request, the first with the new model, starts only after someone answers it. Only a person can answer it, in OpenCode.",
      );
    });

    test("says its next model request is the retry it is waiting for", async () => {
      const world = switching();
      world.activity.onEvent(retryScheduled("c1", NOW - 1000, NOW + 30_000));
      const { output } = await world.send("c1", { model: "openai/gpt-5#high" });
      expect(output.note).toStartWith(
        "It uses the new model from its next model request, which starts when it retries a failed model request, due in 30s. Switching never interrupts;",
      );
    });

    test("says it runs with the switch once continued when it finished its run right after", async () => {
      const world = switching({ states: ["running", "running", "idle"] });
      const { output, content } = await world.send("c1", {
        model: "openai/gpt-5#high",
      });
      expect(output).not.toHaveProperty("status");
      expect(output.state).toBe("idle");
      expect(output.note).toBe(
        "It finished its run; when it is next continued, it runs with the new model. To continue it now, call subagent with its sessionID.",
      );
      expect(content).toBe(
        `Switched c1 (general, "Add CSV export") from model anthropic/claude-sonnet-4-5 to openai/gpt-5#high. ${output.note}`,
      );
    });

    test("says when its run state could not be determined before the switch", async () => {
      const world = switching({ states: ["unknown", "unknown", "running"] });
      const { output } = await world.send("c1", { model: "openai/gpt-5#high" });
      expect(output.note).toStartWith(
        "Its run state could not be determined before switching. It uses the new model from its next model request,",
      );
    });

    test("says when its run state could not be determined after the switch", async () => {
      const world = switching({ states: ["running", "running", "unknown"] });
      const { output } = await world.send("c1", { model: "openai/gpt-5#high" });
      expect(output.note).toBe(
        "Its run state could not be determined after switching. If it is running, it uses the new model from its next model request, which starts once its current model response finishes; if it is idle, from its next run.",
      );
    });
  });

  describe("of a switch with a message", () => {
    test("is queued, and says it runs with the switch once continued, when it finished without reading the message", async () => {
      const world = switching({ states: ["running", "running", "idle"] });
      const { output, content } = await world.send("c1", {
        model: "openai/gpt-5#high",
        message: "hello",
      });
      expect(output.status).toBe("queued");
      expect(output.note).toContain(
        "When it is next continued, it runs with the new model.",
      );
      expect(content).toBe(
        `Switched c1 (general, "Add CSV export") from model anthropic/claude-sonnet-4-5 to openai/gpt-5#high. Message queued. ${output.note}`,
      );
    });

    test("is delivered, and says its later model requests use the switch, when it already read the message", async () => {
      const world = switching({ context: [synthetic(POSTED)] });
      const { output, content } = await world.send("c1", {
        model: "openai/gpt-5#high",
        message: "hello",
      });
      expect(output.status).toBe("delivered");
      expect(output.note).toBe(
        "It has already read your message. Every model request it starts after the switch uses the new model.",
      );
      expect(content).toStartWith(
        'Switched c1 (general, "Add CSV export") from model anthropic/claude-sonnet-4-5 to openai/gpt-5#high. Message delivered.',
      );
    });
  });

  test(`refuses a message over ${MAX} code points with its length and the limit, and changes nothing`, async () => {
    const world = switching();
    const error = await world.refused("c1", {
      model: "openai/gpt-5#high",
      message: "a".repeat(MAX + 1),
    });
    expect(error.message).toBe(
      `message is ${formatCount(MAX + 1)} characters; the limit is ${formatCount(MAX)} (1 over). ${NOTHING}`,
    );
    expectUnchanged(world);
  });
});

describe("the host's subagent permission check", () => {
  test("asserts the subagent permission with the new agent as the resource, and saves an always answer for it", async () => {
    const asserted: unknown[] = [];
    const ctx = {
      session: { wait: async () => {} },
      permission: {
        assert: async (input: unknown) => {
          asserted.push(input);
        },
      },
    } as unknown as Plugin.Context;
    await createHost(ctx, new RecordingLogger()).assertSubagent({
      sessionID: CALLER,
      agent: "build",
      messageID: "msg_send",
      callID: "call_send",
      subagent: "explore",
    });
    expect(asserted).toEqual([
      {
        action: "subagent",
        resources: ["explore"],
        save: ["explore"],
        sessionID: CALLER,
        agent: "build",
        source: { type: "tool", messageID: "msg_send", id: "call_send" },
      },
    ]);
  });
});
