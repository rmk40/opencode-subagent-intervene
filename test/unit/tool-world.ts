// The four subagent tools wired the way the plugin wires them: real activity tracking, run state and
// latch over in-memory fakes, with events fed to activity and run state together.

import {
  CallID,
  Error as ToolError,
  type ToolContext,
} from "@opencode/plugin/promise/tool";
import { Brand } from "effect";
import { ActivityTracker } from "@/core/activity";
import { Latch } from "@/core/latch";
import type {
  OpenCodeEvent,
  SessionID,
  SessionInfo,
  SessionMessageInfo,
} from "@/core/ports";
import { RunStateTracker } from "@/core/run-state";
import { inspectTool } from "@/tools/inspect";
import { listTool } from "@/tools/list";
import { sendTool } from "@/tools/send";
import { stopTool } from "@/tools/stop";
import {
  executionStarted,
  FakeClock,
  FakeControl,
  FakeSessionReader,
  flush,
  MemoryStore,
  RecordingLogger,
  RecordingMessenger,
  sessionInfo,
} from "./fixtures";

export const CALLER = "ses_caller";
export const NOW = 40_000_000;

export interface SessionSpec {
  /** Defaults to the caller. */
  readonly parentID?: SessionID;
  readonly agent?: string;
  readonly title?: string;
  /** Running from the given time, as a `session.execution.started` event shows. */
  readonly runningSince?: number;
  /** Stored `time.idle`. */
  readonly idle?: number;
  /** Stored `time.busy`, which hosts from OpenCode 2.2.2 record. */
  readonly busy?: number;
  readonly outcome?: SessionInfo["outcome"];
  readonly context?: readonly SessionMessageInfo[];
}

type ListInput = Parameters<ReturnType<typeof listTool>["execute"]>[0];
type StopInput = Parameters<ReturnType<typeof stopTool>["execute"]>[0];

/** The context OpenCode passes a tool call named `name` made in session `callerID`. */
export function toolContext(
  name: string,
  signal: AbortSignal,
  callerID: SessionID = CALLER,
): ToolContext {
  return {
    sessionID: Brand.nominal<ToolContext["sessionID"]>()(callerID),
    agent: Brand.nominal<ToolContext["agent"]>()("build"),
    messageID: Brand.nominal<ToolContext["messageID"]>()(`msg_${name}`),
    id: CallID.make(`call_${name}`),
    signal,
    progress: async () => {},
  };
}

/**
 * The caller and the sessions added below it. Waits resolve at once unless a test changes
 * `control.waitIdleImpl`, and interrupts report no run to end unless it changes `interruptImpl`.
 */
export class ToolWorld {
  readonly clock = new FakeClock(NOW);
  readonly control = new FakeControl();
  readonly reader = new FakeSessionReader([sessionInfo(CALLER)]);
  readonly logger = new RecordingLogger();
  readonly store: MemoryStore;
  readonly messenger = new RecordingMessenger();
  readonly activity = new ActivityTracker();
  readonly runState: RunStateTracker;
  readonly latch: Latch;
  private updated = 0;

  /** `store` holds the stop records, so a test can share it with another latch. */
  constructor(
    options: { readonly reconcile?: boolean; readonly store?: MemoryStore } = {},
  ) {
    this.store = options.store ?? new MemoryStore();
    this.control.waitIdleImpl = async () => {};
    this.control.interruptImpl = async () => false;
    this.runState = new RunStateTracker(
      {
        control: this.control,
        clock: this.clock,
        activity: this.activity,
        reader: this.reader,
      },
      options.reconcile === undefined ? {} : { reconcile: options.reconcile },
    );
    this.latch = new Latch({
      store: this.store,
      control: this.control,
      clock: this.clock,
      logger: this.logger,
      renderNote: () => "",
    });
  }

  /** Adds a session updated after every session added before it. */
  add(id: SessionID, spec: SessionSpec = {}): this {
    this.updated += 1;
    const base = sessionInfo(id, spec.parentID ?? CALLER, {
      created: this.updated,
      updated: this.updated,
    });
    const time: SessionInfo["time"] & { busy?: number } = {
      ...base.time,
      ...(spec.idle === undefined ? {} : { idle: spec.idle }),
      ...(spec.busy === undefined ? {} : { busy: spec.busy }),
    };
    this.reader.put({
      ...base,
      time,
      ...(spec.agent === undefined ? {} : { agent: spec.agent }),
      ...(spec.title === undefined ? {} : { title: spec.title }),
      ...(spec.outcome === undefined ? {} : { outcome: spec.outcome }),
    });
    if (spec.context !== undefined) this.reader.contexts.set(id, spec.context);
    if (spec.runningSince !== undefined) {
      this.feed(executionStarted(id, spec.runningSince));
    }
    return this;
  }

  feed(event: OpenCodeEvent): void {
    this.activity.onEvent(event);
    this.runState.onEvent(event);
  }

  async list(input: ListInput = {}) {
    const result = await this.drive(
      listTool({
        reader: this.reader,
        latch: this.latch,
        runState: this.runState,
        clock: this.clock,
        activity: this.activity,
        logger: this.logger,
      }).execute(input, toolContext("list", new AbortController().signal)),
    );
    if (result.output === undefined || typeof result.content !== "string") {
      throw new Error("expected an output and text content");
    }
    return { output: result.output, lines: result.content.split("\n") };
  }

  async inspect(sessionID: string) {
    const result = await this.drive(
      inspectTool({
        reader: this.reader,
        latch: this.latch,
        runState: this.runState,
        clock: this.clock,
        activity: this.activity,
        logger: this.logger,
      }).execute({ sessionID }, toolContext("inspect", new AbortController().signal)),
    );
    if (result.output === undefined || typeof result.content !== "string") {
      throw new Error("expected an output and text content");
    }
    return { output: result.output, lines: result.content.split("\n") };
  }

  async send(sessionID: string, message = "hello") {
    const result = await this.drive(
      sendTool({
        reader: this.reader,
        messenger: this.messenger,
        latch: this.latch,
        runState: this.runState,
        clock: this.clock,
        activity: this.activity,
        logger: this.logger,
      }).execute(
        { sessionID, message },
        toolContext("send", new AbortController().signal),
      ),
    );
    if (result.output === undefined || typeof result.content !== "string") {
      throw new Error("expected an output and text content");
    }
    return { output: result.output, content: result.content };
  }

  async stop(input: Omit<StopInput, "reason"> & { readonly reason?: string }) {
    const result = await this.drive(
      stopTool(
        {
          reader: this.reader,
          control: this.control,
          latch: this.latch,
          runState: this.runState,
          clock: this.clock,
          logger: this.logger,
        },
        { settleMs: 1000 },
      ).execute(
        { reason: "off track", ...input },
        toolContext("stop", new AbortController().signal),
      ),
    );
    if (result.output === undefined || typeof result.content !== "string") {
      throw new Error("expected an output and text content");
    }
    return { output: result.output, content: result.content };
  }

  /** The tool failure of a call that is expected to fail. */
  async failure(call: () => Promise<unknown>): Promise<ToolError> {
    try {
      await call();
    } catch (error) {
      if (error instanceof ToolError) return error;
      throw error;
    }
    throw new Error("expected the call to fail");
  }

  /** Runs `promise` to the end, moving the fake clock to each pending sleep when nothing else runs. */
  private async drive<T>(promise: Promise<T>): Promise<T> {
    let settled = false;
    const result = promise.finally(() => {
      settled = true;
    });
    // The caller handles a rejection once this returns; until then it is not unhandled.
    result.catch(() => undefined);
    for (let step = 0; step < 200 && !settled; step++) {
      await flush();
      if (settled) break;
      const next = this.clock.nextTimerAt;
      if (next !== undefined) this.clock.advance(next - this.clock.now());
    }
    return result;
  }
}
