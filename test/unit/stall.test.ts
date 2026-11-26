import { describe, expect, test } from "bun:test";
import { ActivityTracker } from "@/core/activity";
import { Latch } from "@/core/latch";
import type {
  OpenCodeEvent,
  SessionInfo,
  SessionMessageInfo,
  SyntheticMessage,
} from "@/core/ports";
import { RunStateTracker } from "@/core/run-state";
import {
  DEFAULT_STALL_NOTICE_MS,
  type StallNoticeOptions,
  StallNotices,
  stallNoticeID,
} from "@/core/stall";
import {
  retryScheduled,
  stepStarted,
  textDelta,
  toolCalled,
  toolFinished,
  toolInputStarted,
  toolProgressed,
} from "./activity-fixtures";
import {
  assistant,
  ClockScheduler,
  completed,
  executionEnded,
  executionStarted,
  FakeClock,
  FakeControl,
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
  running,
  sessionInfo,
  text,
  tool,
} from "./fixtures";

const ROOT = "ses_root";
const PARENT = "ses_parent";
const CHILD = "ses_child";
const START = 50_000_000;
const MINUTE = 60_000;
const THRESHOLD = DEFAULT_STALL_NOTICE_MS;

const NO_PROGRESS_TEXT = (silence: string) =>
  `<subagent-stalled sessionID="${CHILD}" kind="no-progress">Your subagent ${CHILD} (general, "Write the docs") appears stalled: it is running but has shown no progress for ${silence}, with no tool call running and no prompt open. Look at it with subagents.inspect, or stop it with subagent_stop and continue it with subagent. Nothing was interrupted; it keeps running until you act.</subagent-stalled>`;

const NO_RECORDED_END_TEXT = (silence: string) =>
  `<subagent-stalled sessionID="${CHILD}" kind="no-recorded-end">Your subagent ${CHILD} (general, "Write the docs") appears stalled: it has shown no progress for ${silence}, and OpenCode reports it idle, but its last run recorded no end. It is not running, so messages sent to it are not read until it is continued: call subagent with its sessionID. Nothing was changed.</subagent-stalled>`;

/** The stalling child as stored, with `time.busy` and `time.idle` when given. */
function childInfo(
  times: { readonly busy?: number; readonly idle?: number } = {},
): SessionInfo {
  const base = sessionInfo(CHILD, PARENT);
  const time: SessionInfo["time"] & { busy?: number } = {
    ...base.time,
    ...(times.busy === undefined ? {} : { busy: times.busy }),
    ...(times.idle === undefined ? {} : { idle: times.idle }),
  };
  return { ...base, time, agent: "general", title: "Write the docs" };
}

/** Records every attempt to post, including the ones that fail. */
class AttemptLog extends RecordingMessenger {
  readonly attempts: SyntheticMessage[] = [];

  override async synthetic(
    message: SyntheticMessage,
  ): Promise<{ readonly id: string; readonly createdAt: number }> {
    this.attempts.push(message);
    return super.synthetic(message);
  }
}

/** What one plugin copy follows: its own activity, run state and stall notices. */
class Copy {
  readonly activity = new ActivityTracker();
  readonly runState: RunStateTracker;
  readonly notices: StallNotices;

  constructor(world: World, options: StallNoticeOptions, latched: boolean) {
    this.runState = new RunStateTracker({
      control: world.control,
      clock: world.clock,
      activity: this.activity,
      reader: world.reader,
    });
    this.notices = new StallNotices(
      {
        activity: this.activity,
        runState: this.runState,
        reader: world.reader,
        messenger: world.messenger,
        ...(latched ? { latch: world.latch } : {}),
        scheduler: new ClockScheduler(world.clock),
        clock: world.clock,
        logger: world.logger,
      },
      options,
    );
    this.notices.start();
  }

  feed(event: OpenCodeEvent): void {
    this.activity.onEvent(event);
    this.runState.onEvent(event);
    this.notices.onEvent(event);
  }

  /** What the event loop does across a gap in the event stream. */
  gap(): void {
    this.activity.reset();
    this.runState.reset();
    this.notices.reset();
  }
}

/**
 * A root, the parent it launched, and the child that parent launched, which is the session that
 * stalls. The child is running from `START`. Probes of the child never resolve unless a test says
 * otherwise, so the child reads as running. Timers run on a fake clock; latches go through a real
 * `Latch`.
 */
class World {
  readonly clock = new FakeClock(START);
  readonly control = new FakeControl();
  readonly reader = new FakeSessionReader([
    sessionInfo(ROOT),
    sessionInfo(PARENT, ROOT),
    childInfo(),
  ]);
  readonly messenger = new AttemptLog();
  readonly logger = new RecordingLogger();
  /** Holds the stop latches. */
  readonly store = new MemoryStore();
  readonly latch = new Latch({
    store: this.store,
    control: this.control,
    clock: this.clock,
    logger: this.logger,
    renderNote: () => "",
  });
  readonly copies: Copy[] = [];

  constructor(options: StallNoticeOptions = {}, latched = true) {
    this.copies.push(new Copy(this, options, latched));
    this.feed(executionStarted(CHILD, START));
  }

  addCopy(options: StallNoticeOptions = {}): Copy {
    const copy = new Copy(this, options, true);
    this.copies.push(copy);
    return copy;
  }

  feed(event: OpenCodeEvent): void {
    for (const copy of this.copies) copy.feed(event);
  }

  /** Moves the clock forward by `ms`, firing every timer due on the way. */
  async elapse(ms: number): Promise<void> {
    const end = this.clock.now() + ms;
    for (;;) {
      await flush();
      const next = this.clock.nextTimerAt;
      if (next === undefined || next > end) break;
      this.clock.advance(next - this.clock.now());
    }
    this.clock.advance(end - this.clock.now());
    await flush();
  }

  /** Lets `ms` pass, then gives the first copy a gap in its event stream. */
  async gapAfter(ms: number): Promise<void> {
    await this.elapse(ms);
    this.copies[0]?.gap();
  }

  /** Stall notices about the child. */
  notices() {
    return this.messenger.posts.filter(
      (post) => post.metadata["sessionID"] === CHILD,
    );
  }

  async stop(sessionID: string, parentID: string): Promise<void> {
    await this.latch.add(sessionID, {
      generation: "gen",
      parentSessionID: parentID,
      reason: "off track",
      at: this.clock.now(),
    });
  }
}

describe("a running subagent that shows no progress", () => {
  test("is reported to its direct parent once the default 10 minutes pass", async () => {
    const world = new World();
    await world.elapse(THRESHOLD - 1);
    expect(world.notices()).toEqual([]);
    await world.elapse(MINUTE);
    expect(world.notices()).toEqual([
      {
        sessionID: PARENT,
        id: expect.stringMatching(/^msg_subagent-intervene_[0-9a-f]{64}$/),
        text: NO_PROGRESS_TEXT("10m"),
        description: "Subagent stalled",
        metadata: {
          plugin: "subagent-intervene",
          kind: "subagent-stalled",
          stall: "no-progress",
          sessionID: CHILD,
        },
        delivery: "steer",
        resume: true,
      },
    ]);
  });

  test("waits for the configured threshold", async () => {
    const world = new World({ thresholdMs: 15 * MINUTE });
    await world.elapse(15 * MINUTE - 1);
    expect(world.notices()).toEqual([]);
    await world.elapse(MINUTE);
    expect(world.notices()).toHaveLength(1);
  });

  test("counts the silence from the last progress", async () => {
    const world = new World();
    await world.elapse(5 * MINUTE);
    world.feed(textDelta(CHILD, world.clock.now()));
    await world.elapse(THRESHOLD - 1);
    expect(world.notices()).toEqual([]);
    await world.elapse(MINUTE);
    expect(world.notices()).toHaveLength(1);
  });

  test("includes a model response that started and streamed nothing since", async () => {
    const world = new World();
    world.feed(stepStarted(CHILD, START));
    await world.elapse(THRESHOLD + MINUTE);
    expect(world.notices()).toHaveLength(1);
  });

  test("interrupts, stops and resumes nothing", async () => {
    const world = new World();
    await world.elapse(THRESHOLD + MINUTE);
    expect(world.notices()).toHaveLength(1);
    expect(world.control.interrupts).toEqual([]);
    expect(world.messenger.posts.map((post) => post.sessionID)).toEqual([PARENT]);
  });

  test("in a root session is reported to nobody", async () => {
    const world = new World();
    world.feed(executionStarted(ROOT, START));
    await world.elapse(THRESHOLD + MINUTE);
    expect(
      world.messenger.posts.filter((post) => post.metadata["sessionID"] === ROOT),
    ).toEqual([]);
  });
});

describe("a subagent that is not silent", () => {
  const BUSY: ReadonlyArray<readonly [string, (world: World) => void]> = [
    ["has a tool call running", (world) => world.feed(toolCalled(CHILD, "call_1", START))],
    [
      "is streaming a tool call's input",
      (world) => world.feed(toolInputStarted(CHILD, "call_1", START)),
    ],
    ["has a permission prompt open", (world) => world.feed(permissionAsked(CHILD, "per_1"))],
    ["has a question open", (world) => world.feed(formCreated(CHILD, "frm_1"))],
  ];

  test.each(BUSY)("gets no notice while it %s", async (_, busy) => {
    const world = new World();
    busy(world);
    await world.elapse(3 * THRESHOLD);
    expect(world.notices()).toEqual([]);
  });

  test("is noticed once the threshold passes after its tool call ends", async () => {
    const world = new World();
    world.feed(toolCalled(CHILD, "call_1", START));
    await world.elapse(THRESHOLD * 2);
    world.feed(toolFinished("session.tool.success", CHILD, "call_1", world.clock.now()));
    await world.elapse(THRESHOLD - 1);
    expect(world.notices()).toEqual([]);
    await world.elapse(MINUTE);
    expect(world.notices()).toHaveLength(1);
  });

  test("in a retry delay counts its silence from when the retry is due", async () => {
    const world = new World();
    // A retry scheduled a minute in, due four minutes after that.
    world.feed(retryScheduled(CHILD, START + MINUTE, START + 5 * MINUTE));
    await world.elapse(5 * MINUTE + THRESHOLD - 1);
    expect(world.notices()).toEqual([]);
    await world.elapse(MINUTE);
    expect(world.notices()).toHaveLength(1);
  });
});

describe("one notice per silent episode", () => {
  test("is all a long silence gets", async () => {
    const world = new World();
    await world.elapse(THRESHOLD * 5);
    expect(world.notices()).toHaveLength(1);
  });

  test("starts over after new progress that changes the stored messages", async () => {
    const world = new World();
    await world.elapse(THRESHOLD + MINUTE);
    world.reader.contexts.set(CHILD, [assistant([text("More work.")])]);
    world.feed(textDelta(CHILD, world.clock.now()));
    await world.elapse(THRESHOLD + MINUTE);
    const notices = world.notices();
    expect(notices).toHaveLength(2);
    expect(notices[0]?.id).not.toBe(notices[1]?.id);
  });

  test("starts over after new progress that only streamed", async () => {
    // Streamed text is not stored, so the stored messages read the same in both episodes.
    const world = new World();
    await world.elapse(THRESHOLD + MINUTE);
    world.feed(textDelta(CHILD, world.clock.now()));
    await world.elapse(THRESHOLD + MINUTE);
    expect(world.notices()).toHaveLength(2);
  });

  test("starts over after the execution ends and a new one starts", async () => {
    const world = new World();
    await world.elapse(THRESHOLD + MINUTE);
    world.feed(
      executionEnded("session.execution.succeeded", CHILD, world.clock.now()),
    );
    world.reader.contexts.set(CHILD, [assistant([tool("read", completed())])]);
    world.feed(executionStarted(CHILD, world.clock.now()));
    await world.elapse(THRESHOLD + MINUTE);
    expect(world.notices()).toHaveLength(2);
  });
});

describe("the check before posting", () => {
  test("posts the no-recorded-end notice when OpenCode reports the subagent idle with no end recorded", async () => {
    const world = new World();
    world.control.waitIdleImpl = async () => {};
    await world.elapse(THRESHOLD + MINUTE);
    const notices = world.notices();
    expect(notices).toHaveLength(1);
    expect(notices[0]?.text).toBe(NO_RECORDED_END_TEXT("10m 1s"));
    expect(notices[0]?.metadata).toEqual({
      plugin: "subagent-intervene",
      kind: "subagent-stalled",
      stall: "no-recorded-end",
      sessionID: CHILD,
    });
  });

  test("posts nothing when the subagent's run ended", async () => {
    const world = new World();
    world.control.waitIdleImpl = async () => {
      world.feed(
        executionEnded("session.execution.succeeded", CHILD, world.clock.now()),
      );
    };
    await world.elapse(THRESHOLD * 3);
    expect(world.notices()).toEqual([]);
  });

  test("tries again on a later sweep when the probe fails", async () => {
    const world = new World();
    world.control.waitIdleImpl = () => Promise.reject(new Error("unavailable"));
    await world.elapse(THRESHOLD + MINUTE);
    expect(world.notices()).toEqual([]);
    world.control.waitIdleImpl = () => new Promise(() => {});
    await world.elapse(MINUTE);
    expect(world.notices()).toHaveLength(1);
  });

  test("posts nothing when progress arrives while it checks", async () => {
    const world = new World();
    world.control.waitIdleImpl = () => {
      world.feed(textDelta(CHILD, world.clock.now()));
      return new Promise(() => {});
    };
    await world.elapse(THRESHOLD + 10_000);
    expect(world.notices()).toEqual([]);
  });

  test("posts nothing when a tool call starts while it checks", async () => {
    const world = new World();
    world.control.waitIdleImpl = () => {
      world.control.waitIdleImpl = () => new Promise(() => {});
      world.feed(toolCalled(CHILD, "call_1", START));
      return new Promise(() => {});
    };
    await world.elapse(THRESHOLD * 3);
    expect(world.notices()).toEqual([]);
  });

  test("posts nothing for a stopped subagent", async () => {
    const world = new World();
    await world.stop(CHILD, PARENT);
    await world.elapse(THRESHOLD * 3);
    expect(world.notices()).toEqual([]);
  });

  test("posts nothing when the subagent's parent is stopped", async () => {
    const world = new World();
    await world.stop(PARENT, ROOT);
    await world.elapse(THRESHOLD * 3);
    expect(world.notices()).toEqual([]);
  });

  test("tells the parent at the next sweep once a foreground call that began during the check ends", async () => {
    const world = new World();
    world.control.waitIdleImpl = () => {
      world.control.waitIdleImpl = () => new Promise(() => {});
      world.feed(
        toolProgressed(PARENT, "call_1", world.clock.now(), { sessionID: CHILD }),
      );
      return new Promise(() => {});
    };
    await world.elapse(THRESHOLD + 1000);
    expect(world.notices()).toEqual([]);
    world.feed(
      toolFinished("session.tool.success", PARENT, "call_1", world.clock.now()),
    );
    await world.elapse(MINUTE);
    expect(world.notices()).toHaveLength(1);
  });
});

describe("a check that fails", () => {
  const FAILURES: ReadonlyArray<
    readonly [string, (world: World) => void, (world: World) => void, boolean]
  > = [
    [
      "reading the subagent",
      (world) => world.reader.failingGets.add(CHILD),
      (world) => world.reader.failingGets.delete(CHILD),
      false,
    ],
    [
      "reading its parent",
      (world) => world.reader.failingGets.add(PARENT),
      (world) => world.reader.failingGets.delete(PARENT),
      false,
    ],
    [
      "reading the stop latches",
      (world) => world.store.failing.add("scan"),
      (world) => world.store.failing.delete("scan"),
      false,
    ],
    [
      "reading its stored messages",
      (world) => world.reader.failingContexts.add(CHILD),
      (world) => world.reader.failingContexts.delete(CHILD),
      false,
    ],
    // Open permission prompts are read only for a subagent carried across a gap.
    [
      "reading its permission prompts",
      (world) => world.reader.failingPermissions.add(CHILD),
      (world) => world.reader.failingPermissions.delete(CHILD),
      true,
    ],
  ];

  test.each(FAILURES)(
    "at %s keeps the episode, logs once, and posts once storage recovers",
    async (_, fail, recover, carried) => {
      const world = new World();
      fail(world);
      if (carried) await world.gapAfter(5 * MINUTE);
      await world.elapse(3 * THRESHOLD);
      expect(world.notices()).toEqual([]);
      expect(world.logger.warnings()).toHaveLength(1);

      recover(world);
      await world.elapse(THRESHOLD + MINUTE);
      expect(world.notices()).toHaveLength(1);
      expect(world.logger.warnings()).toHaveLength(1);
    },
  );

  test("is checked again no sooner than one threshold later", async () => {
    const world = new World();
    world.reader.failingGets.add(CHILD);
    // The first check, at the threshold, fails.
    await world.elapse(THRESHOLD);
    world.reader.failingGets.delete(CHILD);
    await world.elapse(THRESHOLD - 1);
    expect(world.notices()).toEqual([]);
    await world.elapse(MINUTE);
    expect(world.notices()).toHaveLength(1);
  });

  test("at the send is tried again with the same ID, which posts once", async () => {
    const world = new World();
    world.messenger.failing = true;
    await world.elapse(THRESHOLD + MINUTE);
    expect(world.messenger.attempts).toHaveLength(1);
    expect(world.notices()).toEqual([]);

    world.messenger.failing = false;
    await world.elapse(THRESHOLD + MINUTE);
    await world.elapse(3 * THRESHOLD);
    const notices = world.notices();
    expect(notices).toHaveLength(1);
    const posted = notices[0]?.id;
    expect(world.messenger.attempts.map((attempt) => attempt.id)).toEqual([
      posted,
      posted,
    ]);
    expect(world.logger.warnings()).toHaveLength(1);
  });
});

describe("a parent waiting on the subagent in the foreground", () => {
  test("is not told while its subagent call runs, and is told once the call ends", async () => {
    const world = new World();
    world.feed(toolProgressed(PARENT, "call_1", START, { sessionID: CHILD }));
    await world.elapse(THRESHOLD * 2);
    expect(world.notices()).toEqual([]);
    world.feed(toolFinished("session.tool.success", PARENT, "call_1", world.clock.now()));
    await world.elapse(MINUTE);
    expect(world.notices()).toHaveLength(1);
  });

  test("blocks only notices about the subagent its call runs", async () => {
    const world = new World();
    world.reader.put(sessionInfo("ses_other", PARENT));
    world.feed(executionStarted("ses_other", START));
    world.feed(toolProgressed(PARENT, "call_1", START, { sessionID: "ses_other" }));
    await world.elapse(THRESHOLD + MINUTE);
    expect(world.notices()).toHaveLength(1);
  });
});

describe("gaps in the event stream", () => {
  test("a silence that started before a gap is reported once a full threshold passes after it, with an ID that leaves out the unseen last progress", async () => {
    const world = new World();
    await world.elapse(5 * MINUTE);
    world.copies[0]?.gap();
    await world.elapse(THRESHOLD - 1);
    expect(world.notices()).toEqual([]);
    await world.elapse(THRESHOLD * 2);
    const notices = world.notices();
    expect(notices).toHaveLength(1);
    const child = await world.reader.get(CHILD);
    if (child === undefined) throw new Error("expected the child");
    expect(notices[0]?.id).toBe(stallNoticeID("no-progress", child, []));
  });

  test("after a gap, a full threshold is watched again from the next progress", async () => {
    const world = new World();
    await world.elapse(5 * MINUTE);
    world.copies[0]?.gap();
    world.feed(textDelta(CHILD, world.clock.now()));
    await world.elapse(THRESHOLD - 1);
    expect(world.notices()).toEqual([]);
    await world.elapse(MINUTE);
    expect(world.notices()).toHaveLength(1);
  });

  test("a second gap starts the watch over from its end", async () => {
    const world = new World();
    await world.gapAfter(5 * MINUTE);
    await world.gapAfter(5 * MINUTE);
    await world.elapse(THRESHOLD - 1);
    expect(world.notices()).toEqual([]);
    await world.elapse(MINUTE);
    expect(world.notices()).toHaveLength(1);
  });

  test("a copy posts one notice for a subagent it carried across several gaps while storage shows nothing new", async () => {
    const world = new World();
    await world.gapAfter(5 * MINUTE);
    await world.elapse(THRESHOLD + MINUTE);
    expect(world.notices()).toHaveLength(1);
    await world.gapAfter(0);
    await world.elapse(THRESHOLD * 2);
    expect(world.notices()).toHaveLength(1);
  });

  test("a copy that posted for a silence it watched live posts nothing more for it after a gap while storage shows nothing new", async () => {
    const world = new World();
    await world.elapse(THRESHOLD + MINUTE);
    expect(world.notices()).toHaveLength(1);
    await world.gapAfter(0);
    await world.elapse(THRESHOLD * 3);
    expect(world.notices()).toHaveLength(1);
  });

  // Each change below moves one part of what is stored: the latest assistant message, its part
  // count, its last part's time, or the run's recorded start.
  const latest = assistant([text("Working.")]);
  const call = tool("shell", completed());
  /** One assistant message whose last part, a tool call, completed at `at`. */
  const completedAt = (at: number): SessionMessageInfo[] => [
    { ...latest, content: [{ ...call, time: { ...call.time, completed: at } }] },
  ];
  const STORED_PROGRESS: ReadonlyArray<
    readonly [string, (world: World) => void, (world: World) => void]
  > = [
    [
      // The host records the run's start, so the run is identified by it and not by this message.
      "a new assistant message",
      (world) => {
        world.reader.put(childInfo({ busy: START }));
        world.reader.contexts.set(CHILD, [latest]);
      },
      (world) => world.reader.contexts.set(CHILD, [latest, assistant([text("More.")])]),
    ],
    [
      "a part added to the latest message",
      (world) => world.reader.contexts.set(CHILD, [latest]),
      (world) =>
        world.reader.contexts.set(CHILD, [
          { ...latest, content: [...latest.content, text("More.")] },
        ]),
    ],
    [
      "a later time on the latest message's last part",
      (world) => world.reader.contexts.set(CHILD, completedAt(START + 1)),
      (world) => world.reader.contexts.set(CHILD, completedAt(START + 12 * MINUTE)),
    ],
    [
      "a new run's recorded start",
      (world) => world.reader.put(childInfo({ busy: START })),
      (world) => world.reader.put(childInfo({ busy: START + 12 * MINUTE })),
    ],
  ];

  test("a copy that posted no progress before a gap posts again after it once OpenCode reports the subagent idle with no recorded end", async () => {
    const world = new World();
    world.reader.put(childInfo({ busy: START }));
    await world.elapse(THRESHOLD + MINUTE);
    await world.gapAfter(0);
    world.control.waitIdleImpl = async () => {};
    await world.elapse(THRESHOLD + MINUTE);
    expect(world.notices().map((notice) => notice.metadata["stall"])).toEqual([
      "no-progress",
      "no-recorded-end",
    ]);
  });

  test.each(STORED_PROGRESS)(
    "a copy that posted before a gap posts again after it when storage shows %s from the gap",
    async (_, before, during) => {
      const world = new World();
      before(world);
      await world.elapse(THRESHOLD + MINUTE);
      expect(world.notices()).toHaveLength(1);
      await world.gapAfter(0);
      during(world);
      await world.elapse(THRESHOLD + MINUTE);
      expect(world.notices()).toHaveLength(2);
    },
  );
});

describe("what a subagent carried across a gap is checked for before its notice", () => {
  const RETRY_ERROR = { type: "ProviderError", message: "rate limited" };

  /** The latest assistant message waits on a retry of a failed model request due at `at`. */
  const retrying = (at: number): SessionMessageInfo => ({
    ...assistant([text("Working.")]),
    retry: { attempt: 1, at, error: RETRY_ERROR },
  });

  const HELD: ReadonlyArray<
    readonly [string, (world: World) => void, (world: World) => void]
  > = [
    [
      "a tool call running",
      (world) => world.reader.contexts.set(CHILD, [assistant([tool("shell", running())])]),
      (world) => world.reader.contexts.set(CHILD, [assistant([tool("shell", completed())])]),
    ],
    [
      "a retry pending",
      (world) => world.reader.contexts.set(CHILD, [retrying(START + 10 * THRESHOLD)]),
      (world) => world.reader.contexts.set(CHILD, [assistant([text("Working.")])]),
    ],
    [
      "a permission prompt open in this project",
      (world) => world.reader.pending.set(CHILD, ["shell"]),
      (world) => world.reader.pending.delete(CHILD),
    ],
  ];

  test.each(HELD)(
    "storage showing %s holds the notice back, and it follows once storage clears",
    async (_, hold, release) => {
      const world = new World();
      hold(world);
      await world.gapAfter(5 * MINUTE);
      await world.elapse(3 * THRESHOLD);
      expect(world.notices()).toEqual([]);
      release(world);
      await world.elapse(MINUTE);
      expect(world.notices().map((notice) => notice.metadata["stall"])).toEqual([
        "no-progress",
      ]);
    },
  );

  test("storage showing it busy is checked again no sooner than one threshold later", async () => {
    const world = new World();
    world.reader.contexts.set(CHILD, [assistant([tool("shell", running())])]);
    await world.gapAfter(5 * MINUTE);
    // The first check, a threshold after the gap, finds the tool call still running.
    await world.elapse(THRESHOLD + 1000);
    world.reader.contexts.set(CHILD, [assistant([tool("shell", completed())])]);
    await world.elapse(THRESHOLD - 2000);
    expect(world.notices()).toEqual([]);
    await world.elapse(MINUTE);
    expect(world.notices()).toHaveLength(1);
  });

  test("a retry that was due before the gap ended does not hold it back", async () => {
    const world = new World();
    world.reader.contexts.set(CHILD, [retrying(START + MINUTE)]);
    await world.gapAfter(5 * MINUTE);
    await world.elapse(THRESHOLD + MINUTE);
    expect(world.notices()).toHaveLength(1);
  });

  test("a question open before the gap holds it back until the subagent shows an event, which it is then watched from", async () => {
    const world = new World();
    world.feed(formCreated(CHILD, "frm_1"));
    await world.gapAfter(5 * MINUTE);
    await world.elapse(3 * THRESHOLD);
    expect(world.notices()).toEqual([]);
    world.feed(textDelta(CHILD, world.clock.now()));
    await world.elapse(THRESHOLD - 1);
    expect(world.notices()).toEqual([]);
    await world.elapse(MINUTE);
    expect(world.notices()).toHaveLength(1);
  });

  const REPLIES: ReadonlyArray<
    readonly [string, (world: World) => void, (world: World) => void]
  > = [
    [
      "an answer to its question",
      (world) => world.feed(formCreated(CHILD, "frm_1")),
      (world) => world.feed(formReplied(CHILD, "frm_1")),
    ],
    [
      "the cancellation of its question",
      (world) => world.feed(formCreated(CHILD, "frm_1")),
      (world) => world.feed(formCancelled(CHILD, "frm_1")),
    ],
    [
      "an answer to its permission prompt",
      (world) => {
        world.feed(permissionAsked(CHILD, "per_1"));
        world.reader.pending.set(CHILD, ["shell"]);
      },
      (world) => {
        world.reader.pending.delete(CHILD);
        world.feed(permissionReplied(CHILD, "per_1"));
      },
    ],
  ];

  test.each(REPLIES)(
    "%s after the gap is an event from the subagent, so its notice comes a threshold after it",
    async (_, ask, answer) => {
      const world = new World();
      ask(world);
      await world.gapAfter(5 * MINUTE);
      await world.elapse(2 * THRESHOLD);
      expect(world.notices()).toEqual([]);
      answer(world);
      await world.elapse(THRESHOLD - 1);
      expect(world.notices()).toEqual([]);
      await world.elapse(MINUTE);
      expect(world.notices()).toHaveLength(1);
    },
  );

  test("an answer after the gap leaves a tool call storage still records as running to hold the notice back, which follows once storage shows it finished", async () => {
    const world = new World();
    // A long shell call runs while the question is open, and both outlast the gap.
    world.feed(toolCalled(CHILD, "call_1", START));
    world.feed(formCreated(CHILD, "frm_1"));
    world.reader.contexts.set(CHILD, [assistant([tool("shell", running())])]);
    await world.gapAfter(5 * MINUTE);
    await world.elapse(THRESHOLD);
    world.feed(formReplied(CHILD, "frm_1"));
    await world.elapse(3 * THRESHOLD);
    expect(world.notices()).toEqual([]);
    world.reader.contexts.set(CHILD, [assistant([tool("shell", completed())])]);
    await world.elapse(THRESHOLD + MINUTE);
    expect(world.notices().map((notice) => notice.metadata["stall"])).toEqual([
      "no-progress",
    ]);
  });

  const PROMPTS: ReadonlyArray<
    readonly [string, (world: World) => void, (world: World) => void]
  > = [
    [
      "a question",
      (world) => world.feed(formCreated(CHILD, "frm_1")),
      (world) => world.feed(formReplied(CHILD, "frm_1")),
    ],
    [
      "a permission prompt",
      (world) => world.feed(permissionAsked(CHILD, "per_1")),
      (world) => world.feed(permissionReplied(CHILD, "per_1")),
    ],
  ];

  test.each(PROMPTS)(
    "one whose first event after the gap opens %s is watched from when the answer came",
    async (_, ask, answer) => {
      const world = new World();
      await world.gapAfter(5 * MINUTE);
      await world.elapse(MINUTE);
      ask(world);
      await world.elapse(2 * THRESHOLD);
      expect(world.notices()).toEqual([]);
      answer(world);
      await world.elapse(THRESHOLD - 1);
      expect(world.notices()).toEqual([]);
      await world.elapse(MINUTE);
      expect(world.notices()).toHaveLength(1);
    },
  );
});

describe("which notice a subagent carried across a gap gets", () => {
  test.each([
    ["storage records its run's start and end", { busy: START, idle: START + 6 * MINUTE }],
    ["the host records no run start and storage records its end", { idle: START + 6 * MINUTE }],
  ] as const)(
    "none when OpenCode reports it idle and %s",
    async (_, times) => {
      const world = new World();
      world.control.waitIdleImpl = async () => {};
      world.reader.put(childInfo(times));
      await world.gapAfter(5 * MINUTE);
      await world.elapse(3 * THRESHOLD);
      expect(world.notices()).toEqual([]);
    },
  );

  test("no-recorded-end when storage records a start later than its last end and OpenCode reports it idle", async () => {
    const world = new World();
    world.control.waitIdleImpl = async () => {};
    world.reader.put(childInfo({ busy: START, idle: START - MINUTE }));
    await world.gapAfter(5 * MINUTE);
    await world.elapse(THRESHOLD - 1);
    expect(world.notices()).toEqual([]);
    await world.elapse(MINUTE);
    const notices = world.notices();
    expect(notices).toHaveLength(1);
    // The silence counts from the end of the gap.
    expect(notices[0]?.text).toBe(NO_RECORDED_END_TEXT("10m 1s"));
    expect(notices[0]?.metadata["stall"]).toBe("no-recorded-end");
  });

  test("no-recorded-end even when storage still shows a tool call running, since that call can never finish", async () => {
    const world = new World();
    world.control.waitIdleImpl = async () => {};
    world.reader.put(childInfo({ busy: START, idle: START - MINUTE }));
    world.reader.contexts.set(CHILD, [assistant([tool("shell", running())])]);
    await world.gapAfter(5 * MINUTE);
    await world.elapse(THRESHOLD + MINUTE);
    expect(world.notices().map((notice) => notice.metadata["stall"])).toEqual([
      "no-recorded-end",
    ]);
  });

  test("an ID without the last progress event, which differs from the ID a copy with no gap posts", async () => {
    const world = new World();
    world.addCopy();
    // The second copy loaded after the start, so it watches from this progress.
    const progress = textDelta(CHILD, START);
    world.feed(progress);
    await world.gapAfter(5 * MINUTE);
    await world.elapse(THRESHOLD + MINUTE);
    const child = await world.reader.get(CHILD);
    if (child === undefined) throw new Error("expected the child");
    // The copy with no gap posts first, at the threshold after the progress.
    expect(world.notices().map((notice) => notice.id)).toEqual([
      stallNoticeID("no-progress", child, [], progress.id),
      stallNoticeID("no-progress", child, []),
    ]);
  });
});

describe("several plugin copies", () => {
  test("post the same notice ID, even with different thresholds", async () => {
    const world = new World({ thresholdMs: 10 * MINUTE });
    world.addCopy({ thresholdMs: 15 * MINUTE });
    // The second copy loaded after the start, so it watches from the next progress.
    world.feed(textDelta(CHILD, START));
    await world.elapse(16 * MINUTE);
    const notices = world.notices();
    expect(notices).toHaveLength(2);
    expect(new Set(notices.map((notice) => notice.id)).size).toBe(1);
  });

  test("a copy that loaded during the silence posts nothing for it", async () => {
    const world = new World();
    await world.elapse(5 * MINUTE);
    world.addCopy({ thresholdMs: MINUTE });
    await world.elapse(THRESHOLD);
    // Only the copy that watched the whole silence posts.
    expect(world.notices()).toHaveLength(1);
  });
});

describe("stallNoticeID", () => {
  const info = { ...sessionInfo(CHILD, PARENT) };
  const messages: SessionMessageInfo[] = [assistant([text("Working.")])];

  test("is the same for the same session and stored data", () => {
    expect(stallNoticeID("no-progress", info, messages)).toBe(
      stallNoticeID("no-progress", { ...info }, [...messages]),
    );
  });

  test("differs between the two kinds", () => {
    expect(stallNoticeID("no-progress", info, messages)).not.toBe(
      stallNoticeID("no-recorded-end", info, messages),
    );
  });

  test("differs once the stored messages show more progress", () => {
    expect(stallNoticeID("no-progress", info, messages)).not.toBe(
      stallNoticeID("no-progress", info, [
        ...messages,
        assistant([tool("read", completed())]),
      ]),
    );
  });

  test("differs between two executions with the same stored messages, by their stored start", () => {
    expect(stallNoticeID("no-progress", childInfo({ busy: 10 }), messages)).not.toBe(
      stallNoticeID("no-progress", childInfo({ busy: 20 }), messages),
    );
  });

  test("differs once the latest assistant message gains a part", () => {
    const latest = assistant([text("Working.")]);
    expect(stallNoticeID("no-progress", info, [latest])).not.toBe(
      stallNoticeID("no-progress", info, [
        { ...latest, content: [...latest.content, text("More.")] },
      ]),
    );
  });

  test("differs once the latest part's time moves, with the same parts", () => {
    const call = tool("shell", completed());
    const latest = assistant([call]);
    const completedAt = (at: number): SessionMessageInfo[] => [
      { ...latest, content: [{ ...call, time: { ...call.time, completed: at } }] },
    ];
    expect(stallNoticeID("no-progress", info, completedAt(100))).not.toBe(
      stallNoticeID("no-progress", info, completedAt(200)),
    );
  });

  test("differs by the event that showed the last progress, and without one", () => {
    const ids = [
      stallNoticeID("no-progress", info, messages, "evt_1"),
      stallNoticeID("no-progress", info, messages, "evt_2"),
      stallNoticeID("no-progress", info, messages),
    ];
    expect(new Set(ids).size).toBe(3);
  });

  test("is the same for copies that read the session at different moments", () => {
    const earlier = childInfo({ busy: 10 });
    const later: SessionInfo = {
      ...earlier,
      title: "Renamed",
      cost: 1.5,
      time: { ...earlier.time, updated: 999 },
    };
    expect(stallNoticeID("no-progress", earlier, messages, "evt_1")).toBe(
      stallNoticeID("no-progress", later, messages, "evt_1"),
    );
  });
});
