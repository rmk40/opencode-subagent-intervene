import { describe, expect, test } from "bun:test";
import {
  CallID,
  Error as ToolError,
  type ToolContext,
} from "@opencode/plugin/promise/tool";
import { Brand } from "effect";
import { Latch } from "@/core/latch";
import type {
  RunObservation,
  RunState,
  SessionID,
  SessionMessageInfo,
} from "@/core/ports";
import { CONTINUE_NESTED_NOTE, CONTINUE_OWN_NOTE } from "@/core/stop";
import { type SendOutput, sendTool } from "@/tools/send";
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

interface SessionSpec {
  /** Defaults to the caller. */
  readonly parentID?: SessionID;
  /**
   * Run states the target is observed in, one per observation; the last one repeats. The plugin
   * observes once before sending and once after. Defaults to running.
   */
  readonly states?: readonly RunState[];
  readonly agent?: string;
  readonly title?: string;
  readonly context?: readonly SessionMessageInfo[];
  /** Actions of permission prompts it is waiting on. */
  readonly pending?: readonly string[];
}

/** Run states from a script per session, standing in for the event fold and its probes. */
class ScriptedRunState {
  readonly scripts = new Map<SessionID, RunState[]>();

  async observe(sessionID: SessionID): Promise<RunObservation> {
    const script = this.scripts.get(sessionID) ?? [];
    const state = (script.length > 1 ? script.shift() : script[0]) ?? "idle";
    return { state, source: "event" };
  }
}

/** The caller and the sessions below it. Stops go through a real `Latch` over an in-memory store. */
class World {
  readonly reader = new FakeSessionReader([sessionInfo(CALLER)]);
  readonly messenger = new RecordingMessenger();
  readonly runState = new ScriptedRunState();
  readonly logger = new RecordingLogger();
  readonly clock = new FakeClock(NOW);
  readonly latch = new Latch({
    store: new MemoryStore(),
    control: new FakeControl(),
    clock: this.clock,
    logger: this.logger,
    renderNote: () => "",
  });

  add(id: SessionID, spec: SessionSpec = {}): this {
    this.reader.put({
      ...sessionInfo(id, spec.parentID ?? CALLER),
      ...(spec.agent === undefined ? {} : { agent: spec.agent }),
      ...(spec.title === undefined ? {} : { title: spec.title }),
    });
    this.runState.scripts.set(id, [...(spec.states ?? ["running"])]);
    if (spec.context !== undefined) this.reader.contexts.set(id, spec.context);
    if (spec.pending !== undefined) this.reader.pending.set(id, spec.pending);
    return this;
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
    message: string,
    options: { readonly latch?: boolean; readonly signal?: AbortSignal } = {},
  ): Promise<{ readonly output: SendOutput; readonly content: string }> {
    const tool = sendTool(
      {
        reader: this.reader,
        messenger: this.messenger,
        latch: this.latch,
        runState: this.runState,
        logger: this.logger,
      },
      options.latch === undefined ? {} : { latch: options.latch },
    );
    const result = await tool.execute(
      { sessionID, message },
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
    message: string,
    options: { readonly latch?: boolean; readonly signal?: AbortSignal } = {},
  ): Promise<ToolError> {
    try {
      await this.send(sessionID, message, options);
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
    expect(error.message).toContain(String(MAX + 1));
    expect(error.message).toContain(String(MAX));
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
    expect(error.message).toContain(String(MAX + 1));
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
      note: "It reads your message after its current tool calls finish: shell. Sending never interrupts; to redirect it right away, stop it with subagent_stop and continue it with subagent.",
    });
    expect(content).toBe(
      'Message sent to c1 (general, "Add CSV export"). It reads your message after its current tool calls finish: shell. Sending never interrupts; to redirect it right away, stop it with subagent_stop and continue it with subagent.',
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
