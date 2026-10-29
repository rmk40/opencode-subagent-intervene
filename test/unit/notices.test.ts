import { describe, expect, test } from "bun:test";
import { Latch } from "@/core/latch";
import {
  noticeID,
  type PromptDetails,
  type PromptNoticeOptions,
  PromptNotices,
  RECHECK_DELAY_MS,
  renderWaitingNotice,
  type WaitingNotice,
} from "@/core/notices";
import type { OpenCodeEvent, SessionID } from "@/core/ports";
import {
  ClockScheduler,
  deferred,
  executionEnded,
  FakeClock,
  FakeControl,
  FakePermissions,
  FakeSessionReader,
  flush,
  formCancelled,
  formCreated,
  formReplied,
  MemoryStore,
  permissionAsked,
  permissionReplied,
  RecordingLogger,
  RecordingMessenger,
  sessionDeleted,
  sessionInfo,
  type TerminalEventType,
  toolEnded,
  toolProgress,
} from "./fixtures";

const ROOT = "root";
const PARENT = "parent";
const CHILD = "child";
const REQUEST = "per_1";
const FORM = "frm_1";
/** The parent's `subagent` call on the child. */
const CALL = "call_1";
/** When the prompt under test opened. */
const ASKED = 1_000_000;
const DELAY = 60_000;

/**
 * A root, the parent it launched, and the child that parent launched, which is the session that
 * waits. Timers run on a fake clock; the parent's stop latch goes through a real `Latch`.
 */
class World {
  readonly clock = new FakeClock(ASKED);
  readonly reader = new FakeSessionReader([
    sessionInfo(ROOT),
    sessionInfo(PARENT, ROOT),
    { ...sessionInfo(CHILD, PARENT), agent: "general", title: "Fix it" },
  ]);
  readonly permissions = new FakePermissions();
  readonly messenger = new RecordingMessenger();
  readonly logger = new RecordingLogger();
  readonly store = new MemoryStore();
  readonly latch = new Latch({
    store: this.store,
    control: new FakeControl(),
    clock: this.clock,
    logger: this.logger,
    renderNote: () => "",
  });
  readonly notices: PromptNotices;

  constructor(
    options: PromptNoticeOptions = {},
    deps: { readonly latch?: boolean } = {},
  ) {
    this.notices = new PromptNotices(
      {
        reader: this.reader,
        permissions: this.permissions,
        messenger: this.messenger,
        ...(deps.latch === false ? {} : { latch: this.latch }),
        scheduler: new ClockScheduler(this.clock),
        clock: this.clock,
        logger: this.logger,
      },
      options,
    );
  }

  /** The child asks for a permission that stays in the permission list. */
  askPermission(sessionID: SessionID = CHILD, requestID = REQUEST): void {
    this.permissions.pending.set(sessionID, [
      ...(this.permissions.pending.get(sessionID) ?? []),
      requestID,
    ]);
    this.notices.onEvent(
      permissionAsked(sessionID, requestID, { created: this.clock.now() }),
    );
  }

  askQuestion(sessionID: string = CHILD, formID = FORM): void {
    this.notices.onEvent(
      formCreated(sessionID, formID, { created: this.clock.now() }),
    );
  }

  async elapse(ms: number): Promise<void> {
    this.clock.advance(ms);
    await flush();
  }

  async stopParent(): Promise<void> {
    await this.latch.add(PARENT, {
      generation: "gen",
      parentSessionID: ROOT,
      reason: "off track",
      at: ASKED - 1000,
    });
  }
}

function permissionText(waiting: string): string {
  return `<subagent-waiting sessionID="${CHILD}" kind="permission">Your subagent ${CHILD} (general, "Fix it") ${waiting} on a permission prompt: shell for cargo test. Only a person can answer it, in OpenCode. Tell the user, or stop it with subagent_stop. It continues on its own once someone answers.</subagent-waiting>`;
}

describe("a permission prompt in a subagent", () => {
  test("is posted to the direct parent once the default 60 seconds pass", async () => {
    const world = new World();
    world.askPermission();
    await world.elapse(DELAY - 1);
    expect(world.messenger.posts).toEqual([]);
    await world.elapse(1);
    expect(world.messenger.posts).toEqual([
      {
        sessionID: PARENT,
        id: expect.stringMatching(/^msg_/),
        text: permissionText("has been waiting 1m"),
        description: "Subagent waiting",
        metadata: {
          plugin: "subagent-intervene",
          kind: "subagent-waiting",
          prompt: "permission",
          sessionID: CHILD,
          requestID: REQUEST,
        },
        delivery: "steer",
        resume: true,
      },
    ]);
  });

  test("waits for the configured delay", async () => {
    const world = new World({ delayMs: 5_000 });
    world.askPermission();
    await world.elapse(4_999);
    expect(world.messenger.posts).toEqual([]);
    await world.elapse(1);
    expect(world.messenger.posts).toHaveLength(1);
  });

  test("with no delay is posted at once, saying the subagent is waiting", async () => {
    const world = new World({ delayMs: 0 });
    world.askPermission();
    await world.elapse(0);
    expect(world.messenger.posts[0]?.text).toBe(permissionText("is waiting"));
  });

  test("in a subagent of a subagent goes to its own parent, not further up", async () => {
    const world = new World();
    world.reader.put(sessionInfo("grandchild", CHILD));
    world.askPermission("grandchild");
    await world.elapse(DELAY);
    expect(world.messenger.posts.map((post) => post.sessionID)).toEqual([
      CHILD,
    ]);
  });

  test("in a root session posts nothing", async () => {
    const world = new World();
    world.askPermission(ROOT);
    await world.elapse(DELAY);
    expect(world.messenger.posts).toEqual([]);
  });

  test("answered before the delay posts nothing", async () => {
    const world = new World();
    world.askPermission();
    world.notices.onEvent(permissionReplied(CHILD, REQUEST));
    await world.elapse(DELAY);
    expect(world.messenger.posts).toEqual([]);
  });

  test("followed with no events missed is posted without reading the permission list", async () => {
    const world = new World();
    world.askPermission();
    const lookups: SessionID[] = [];
    world.permissions.impl = async (sessionID) => {
      lookups.push(sessionID);
      return [];
    };
    await world.elapse(DELAY);
    expect(world.messenger.posts).toHaveLength(1);
    expect(lookups).toEqual([]);
  });

  test("answered while the checks run posts nothing", async () => {
    const world = new World();
    world.askPermission();
    // After a gap the checks read the permission list, which holds them open here.
    world.notices.reset();
    const lookup = deferred<readonly string[]>();
    const lookups: SessionID[] = [];
    world.permissions.impl = (sessionID) => {
      lookups.push(sessionID);
      return lookup.promise;
    };
    await world.elapse(DELAY);
    expect(lookups).toEqual([CHILD]);
    world.notices.onEvent(permissionReplied(CHILD, REQUEST));
    lookup.resolve([REQUEST]);
    await flush();
    expect(world.messenger.posts).toEqual([]);
  });
});

describe("a question in a subagent", () => {
  test("is posted with the form's title once the delay passes", async () => {
    const world = new World();
    world.askQuestion();
    await world.elapse(DELAY);
    expect(world.messenger.posts).toHaveLength(1);
    const post = world.messenger.posts[0];
    expect(post?.sessionID).toBe(PARENT);
    expect(post?.metadata).toEqual({
      plugin: "subagent-intervene",
      kind: "subagent-waiting",
      prompt: "question",
      sessionID: CHILD,
      requestID: FORM,
    });
    expect(post?.text).toBe(
      `<subagent-waiting sessionID="${CHILD}" kind="question">Your subagent ${CHILD} (general, "Fix it") has been waiting 1m on a question: "Pick a branch". Only a person can answer it, in OpenCode. Tell the user, or stop it with subagent_stop. It continues on its own once someone answers.</subagent-waiting>`,
    );
  });

  test.each([
    ["replied", formReplied(CHILD, FORM)],
    ["cancelled", formCancelled(CHILD, FORM)],
  ])("%s before the delay posts nothing", async (_, event) => {
    const world = new World();
    world.askQuestion();
    world.notices.onEvent(event);
    await world.elapse(DELAY);
    expect(world.messenger.posts).toEqual([]);
  });

  test("owned by no session posts nothing", async () => {
    const world = new World();
    world.askQuestion("global");
    await world.elapse(DELAY);
    expect(world.messenger.posts).toEqual([]);
  });
});

describe("no notice is posted", () => {
  const ENDS: ReadonlyArray<readonly [string, () => OpenCodeEvent]> = [
    ...(
      [
        "session.execution.succeeded",
        "session.execution.failed",
        "session.execution.interrupted",
      ] satisfies TerminalEventType[]
    ).map(
      (type) =>
        [
          `after ${type} in the subagent`,
          () => executionEnded(type, CHILD),
        ] as const,
    ),
    ["after the subagent is deleted", () => sessionDeleted(CHILD)],
  ];

  test.each(ENDS)("%s", async (_, end) => {
    const world = new World();
    world.askPermission();
    world.askQuestion();
    world.notices.onEvent(end());
    await world.elapse(DELAY);
    expect(world.messenger.posts).toEqual([]);
  });

  test("when the parent no longer exists", async () => {
    const world = new World();
    world.askPermission();
    world.reader.remove(PARENT);
    await world.elapse(DELAY);
    expect(world.messenger.posts).toEqual([]);
  });

  test("when the parent is stopped", async () => {
    const world = new World();
    await world.stopParent();
    world.askPermission();
    await world.elapse(DELAY);
    expect(world.messenger.posts).toEqual([]);
  });

  test("when the parent is waiting on the subagent in a foreground subagent call", async () => {
    const world = new World();
    world.notices.onEvent(
      toolProgress(PARENT, CALL, { sessionID: CHILD, status: "running" }),
    );
    world.askPermission();
    await world.elapse(DELAY);
    expect(world.messenger.posts).toEqual([]);
  });
});

describe("a notice is still posted", () => {
  test("when the parent's own run ends", async () => {
    const world = new World();
    world.askPermission();
    world.notices.onEvent(
      executionEnded("session.execution.succeeded", PARENT),
    );
    await world.elapse(DELAY);
    expect(world.messenger.posts).toHaveLength(1);
  });

  test("to a stopped parent when stops are not kept", async () => {
    const world = new World({}, { latch: false });
    await world.stopParent();
    world.askPermission();
    await world.elapse(DELAY);
    expect(world.messenger.posts).toHaveLength(1);
  });

  const started = () =>
    toolProgress(PARENT, CALL, { sessionID: CHILD, status: "running" });

  test.each([
    [
      "is running a subagent call on another subagent",
      [toolProgress(PARENT, CALL, { sessionID: "other", status: "running" })],
    ],
    [
      "has finished its subagent call on the subagent",
      [started(), toolEnded("session.tool.success", PARENT, CALL)],
    ],
    [
      "had its run end during its subagent call on the subagent",
      [started(), executionEnded("session.execution.interrupted", PARENT)],
    ],
  ])("when the parent %s", async (_, events) => {
    const world = new World();
    for (const event of events) world.notices.onEvent(event);
    world.askPermission();
    await world.elapse(DELAY);
    expect(world.messenger.posts).toHaveLength(1);
  });
});

describe("a prompt held back by the parent's foreground call", () => {
  const started = (callID = CALL) =>
    toolProgress(PARENT, callID, { sessionID: CHILD, status: "running" });

  /** The prompt's delay passes while the parent's call on the subagent runs. */
  async function held(): Promise<World> {
    const world = new World();
    world.notices.onEvent(started());
    world.askPermission();
    await world.elapse(DELAY);
    expect(world.messenger.posts).toEqual([]);
    return world;
  }

  test.each([
    [
      "the call is moved to the background",
      () => toolEnded("session.tool.success", PARENT, CALL),
    ],
    ["the call fails", () => toolEnded("session.tool.failed", PARENT, CALL)],
    [
      "the parent's run ends",
      () => executionEnded("session.execution.interrupted", PARENT),
    ],
  ])(
    "is posted a settling moment after %s, without waiting out the delay again",
    async (_, end) => {
      const world = await held();
      world.notices.onEvent(end());
      await world.elapse(RECHECK_DELAY_MS - 1);
      expect(world.messenger.posts).toEqual([]);
      await world.elapse(1);
      expect(world.messenger.posts).toHaveLength(1);
      expect(world.messenger.posts[0]?.text).toContain(
        "has been waiting 1m 1s",
      );
    },
  );

  test("is not posted when it was answered before the call returned", async () => {
    const world = await held();
    world.notices.onEvent(permissionReplied(CHILD, REQUEST));
    world.notices.onEvent(toolEnded("session.tool.success", PARENT, CALL));
    await world.elapse(DELAY + RECHECK_DELAY_MS);
    expect(world.messenger.posts).toEqual([]);
  });

  test("is not posted when the subagent's run ends within the settling moment", async () => {
    const world = await held();
    world.notices.onEvent(
      executionEnded("session.execution.interrupted", PARENT),
    );
    await world.elapse(RECHECK_DELAY_MS - 1);
    world.notices.onEvent(
      executionEnded("session.execution.interrupted", CHILD),
    );
    await world.elapse(DELAY);
    expect(world.messenger.posts).toEqual([]);
  });

  test("stays held when another call of the parent ends", async () => {
    const world = await held();
    world.notices.onEvent(
      toolEnded("session.tool.success", PARENT, "call_other"),
    );
    await world.elapse(DELAY);
    expect(world.messenger.posts).toEqual([]);
  });

  test("is held again when the parent calls the subagent in the foreground once more", async () => {
    const world = await held();
    world.notices.onEvent(toolEnded("session.tool.success", PARENT, CALL));
    world.notices.onEvent(started("call_2"));
    await world.elapse(RECHECK_DELAY_MS);
    expect(world.messenger.posts).toEqual([]);
    world.notices.onEvent(toolEnded("session.tool.success", PARENT, "call_2"));
    await world.elapse(RECHECK_DELAY_MS);
    expect(world.messenger.posts).toHaveLength(1);
  });

  test("is posted a settling moment after an event subscription gap, with no end event", async () => {
    const world = await held();
    world.notices.reset();
    await world.elapse(RECHECK_DELAY_MS - 1);
    expect(world.messenger.posts).toEqual([]);
    await world.elapse(1);
    expect(world.messenger.posts).toHaveLength(1);
  });

  test("is dropped after an event subscription gap when the prompt has closed meanwhile", async () => {
    const world = await held();
    world.notices.reset();
    world.permissions.pending.set(CHILD, []);
    await world.elapse(RECHECK_DELAY_MS);
    expect(world.messenger.posts).toEqual([]);
  });
});

describe("a check or post that fails", () => {
  const FAILURES: ReadonlyArray<readonly [string, (world: World) => void]> = [
    [
      "the subagent cannot be read",
      (world) => world.reader.failingGets.add(CHILD),
    ],
    [
      "the permission list cannot be read after a subscription gap",
      (world) => {
        world.notices.reset();
        world.permissions.impl = async () => {
          throw new Error("list failed");
        };
      },
    ],
    [
      "the parent cannot be read",
      (world) => world.reader.failingGets.add(PARENT),
    ],
    [
      "the parent's stop latch cannot be read",
      (world) => world.store.failing.add("scan"),
    ],
    [
      "the post is rejected",
      (world) => {
        world.messenger.failing = true;
      },
    ],
  ];

  test.each(FAILURES)(
    "posts nothing and logs a warning when %s",
    async (_, fail) => {
      const world = new World();
      world.askPermission();
      fail(world);
      await world.elapse(DELAY);
      expect(world.messenger.posts).toEqual([]);
      expect(world.logger.warnings()).toEqual([
        "notices: could not post a notice",
      ]);
    },
  );
});

describe("the notice ID", () => {
  test("is the same in every plugin instance, so the parent gets one notice", async () => {
    const first = new World();
    const second = new World();
    for (const world of [first, second]) world.askPermission();
    await Promise.all([first.elapse(DELAY), second.elapse(DELAY)]);
    const ids = [first, second].map((world) => world.messenger.posts[0]?.id);
    expect(ids[0]).toBeDefined();
    expect(ids[1]).toBe(ids[0]);
  });

  const PERMISSION: PromptDetails = {
    kind: "permission",
    action: "shell",
    resources: [],
  };
  const QUESTION: PromptDetails = { kind: "question", title: "" };
  const id = (
    sessionID: SessionID,
    requestID: string,
    details: PromptDetails = PERMISSION,
  ) => noticeID(sessionID, { requestID, details });

  test("differs between requests, subagents, and kinds of prompt", () => {
    const ids = [
      id(CHILD, "per_1"),
      id(CHILD, "per_2"),
      id("other", "per_1"),
      id(CHILD, "per_1", QUESTION),
    ];
    expect(new Set(ids).size).toBe(4);
  });

  test("differs between request IDs that differ only in characters unsafe in a URL path", () => {
    expect(id(CHILD, "per_a/b")).not.toBe(id(CHILD, "per_a-b"));
    expect(id(CHILD, "per_a b")).not.toBe(id(CHILD, "per_a-b"));
  });

  test("differs when characters move between the session ID and the request ID", () => {
    expect(id("ses_a", "b_c")).not.toBe(id("ses_a_b", "c"));
  });

  test("ignores what the prompt asks, so every instance derives it from the same IDs", () => {
    expect(id(CHILD, "per_1")).toBe(
      id(CHILD, "per_1", {
        kind: "permission",
        action: "edit",
        resources: ["x"],
      }),
    );
  });

  test("is msg_ and the plugin id, then hex, whatever characters the IDs hold", () => {
    expect(id("ses/1 ?", "per_../x#y\u200B", QUESTION)).toMatch(
      /^msg_subagent-intervene_[0-9a-f]{64}$/,
    );
  });
});

describe("after an event subscription gap", () => {
  test("drops tracked questions and keeps permission prompts", async () => {
    const world = new World();
    world.askPermission();
    world.askQuestion();
    world.notices.reset();
    await world.elapse(DELAY);
    expect(
      world.messenger.posts.map((post) => post.metadata["prompt"]),
    ).toEqual(["permission"]);
  });

  test("looks a permission prompt up again before posting", async () => {
    const world = new World();
    world.askPermission();
    world.notices.reset();
    // Answered during the gap, so no reply event arrives.
    world.permissions.pending.set(CHILD, []);
    await world.elapse(DELAY);
    expect(world.messenger.posts).toEqual([]);
  });
});

describe("dispose", () => {
  test("clears every pending timer and ignores later prompts", async () => {
    const world = new World();
    world.askPermission();
    world.askQuestion();
    world.notices.dispose();
    expect(world.clock.pendingTimers).toBe(0);
    world.askPermission(CHILD, "per_2");
    expect(world.clock.pendingTimers).toBe(0);
    await world.elapse(DELAY);
    expect(world.messenger.posts).toEqual([]);
  });

  test("drops a notice whose checks are still running", async () => {
    const world = new World();
    world.askPermission();
    // After a gap the checks read the permission list, which holds them open here.
    world.notices.reset();
    const lookup = deferred<readonly string[]>();
    const lookups: SessionID[] = [];
    world.permissions.impl = (sessionID) => {
      lookups.push(sessionID);
      return lookup.promise;
    };
    await world.elapse(DELAY);
    expect(lookups).toEqual([CHILD]);
    world.notices.dispose();
    lookup.resolve([REQUEST]);
    await flush();
    expect(world.messenger.posts).toEqual([]);
  });
});

describe("renderWaitingNotice", () => {
  function notice(overrides: Partial<WaitingNotice> = {}): WaitingNotice {
    return {
      sessionID: CHILD,
      agent: "general",
      title: "Fix it",
      waitedMs: 60_000,
      prompt: { kind: "permission", action: "shell", resources: ["a"] },
      ...overrides,
    };
  }

  test("names at most three resources and counts the rest", () => {
    const text = renderWaitingNotice(
      notice({
        prompt: {
          kind: "permission",
          action: "edit",
          resources: ["a.ts", "b.ts", "c.ts", "d.ts", "e.ts"],
        },
      }),
    );
    expect(text).toContain(
      "on a permission prompt: edit for a.ts, b.ts, c.ts, and 2 more.",
    );
  });

  test("names exactly three resources without a count", () => {
    const text = renderWaitingNotice(
      notice({
        prompt: {
          kind: "permission",
          action: "edit",
          resources: ["a.ts", "b.ts", "c.ts"],
        },
      }),
    );
    expect(text).toContain(
      "on a permission prompt: edit for a.ts, b.ts, c.ts.",
    );
  });

  test("leaves out the resources when there are none and names a blank action as unnamed", () => {
    const text = renderWaitingNotice(
      notice({
        prompt: { kind: "permission", action: " \u200B ", resources: [] },
      }),
    );
    expect(text).toContain("on a permission prompt: an unnamed action.");
  });

  test("names a question with a blank title as a question", () => {
    const text = renderWaitingNotice(
      notice({ prompt: { kind: "question", title: "  " } }),
    );
    expect(text).toContain("has been waiting 1m on a question.");
  });

  test("leaves out the label of a subagent with no agent or title", () => {
    const { agent: _agent, title: _title, ...bare } = notice();
    expect(renderWaitingNotice(bare)).toContain(
      `>Your subagent ${CHILD} has been waiting 1m on`,
    );
  });

  test.each([
    [999, "is waiting"],
    [1000, "has been waiting 1s"],
    [59_999, "has been waiting 59s"],
    [240_999, "has been waiting 4m"],
    [252_000, "has been waiting 4m 12s"],
    [7_500_000, "has been waiting 2h 5m"],
  ])("after %p ms says the subagent %s", (waitedMs, waiting) => {
    expect(renderWaitingNotice(notice({ waitedMs }))).toContain(
      `(general, "Fix it") ${waiting} on`,
    );
  });

  test("escapes every value it quotes", () => {
    const text = renderWaitingNotice({
      sessionID: 'c"1',
      agent: "<agent>",
      title: "Fix 'it' & ship",
      waitedMs: 60_000,
      prompt: {
        kind: "permission",
        action: "a\nb",
        resources: ["</subagent-waiting>"],
      },
    });
    expect(text).toBe(
      `<subagent-waiting sessionID="c&quot;1" kind="permission">Your subagent c&quot;1 (&lt;agent&gt;, "Fix &#39;it&#39; &amp; ship") has been waiting 1m on a permission prompt: a b for &lt;/subagent-waiting&gt;. Only a person can answer it, in OpenCode. Tell the user, or stop it with subagent_stop. It continues on its own once someone answers.</subagent-waiting>`,
    );
  });

  test("caps every value it quotes", () => {
    const long = (char: string) => char.repeat(10_000);
    const permission = renderWaitingNotice({
      sessionID: long("i"),
      agent: long("a"),
      title: long("t"),
      waitedMs: 60_000,
      prompt: {
        kind: "permission",
        action: long("x"),
        resources: [long("r"), long("s"), long("u")],
      },
    });
    const question = renderWaitingNotice(
      notice({ prompt: { kind: "question", title: long("q") } }),
    );
    for (const char of ["i", "a", "t", "x", "r", "s", "u"]) {
      expect(permission).not.toContain(char.repeat(1000));
    }
    expect(question).not.toContain("q".repeat(1000));
  });
});
