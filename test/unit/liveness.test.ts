import { describe, expect, test } from "bun:test";
import type { Plugin } from "@opencode/plugin";
import type { SessionMessageInfo } from "@/core/ports";
import { createHost } from "@/host";
import {
  stepStarted,
  textDelta,
  toolCalled,
  toolInputStarted,
} from "./activity-fixtures";
import {
  assistant,
  RecordingLogger,
  running,
  streaming,
  tool,
} from "./fixtures";
import { NOW, ToolWorld } from "./tool-world";

const C1 = "ses_c1";
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const never = (): Promise<void> => new Promise(() => {});

/** An assistant message created at `created` that has not completed. */
function openMessage(
  created: number,
  content: Parameters<typeof assistant>[0] = [],
): SessionMessageInfo {
  return { ...assistant(content), time: { created } };
}

/** A child that ran from `NOW - 7h`, showed its last progress then, and whose end went unrecorded. */
function unended(): ToolWorld {
  return new ToolWorld().add(C1, {
    agent: "general",
    title: "Fix tokenizer bug",
    runningSince: NOW - 7 * HOUR,
  });
}

describe("subagents.list entries", () => {
  test("give a running subagent's last observed progress and render its age", async () => {
    const world = new ToolWorld().add(C1, { runningSince: NOW - HOUR });
    world.feed(textDelta(C1, NOW - 12_000));
    const { output, lines } = await world.list();
    expect(output.entries[0]).toMatchObject({
      state: "running",
      stateSource: "event",
      lastActivityAt: NOW - 12_000,
    });
    expect(output.entries[0]).not.toHaveProperty("noRecordedEnd");
    expect(lines[0]).toBe(
      `- ${C1}: running; last activity 12s ago; no cost reported; 0 in + 0 cached / 0 out tokens`,
    );
  });

  test("give an idle subagent's end as its last activity", async () => {
    const world = new ToolWorld().add(C1, {
      idle: NOW - 47 * MINUTE,
      outcome: "succeeded",
    });
    const { output, lines } = await world.list();
    expect(output.entries[0]).toMatchObject({
      state: "idle",
      stateSource: "probe",
      lastActivityAt: NOW - 47 * MINUTE,
      outcome: "succeeded",
    });
    expect(lines[0]).toContain("idle, last run succeeded; last activity 47m ago");
  });

  test("show a silent running subagent whose wait resolves as idle with no recorded end", async () => {
    const world = unended();
    const { output, lines } = await world.list();
    expect(output.entries[0]).toMatchObject({
      state: "idle",
      stateSource: "probe",
      noRecordedEnd: true,
      lastActivityAt: NOW - 7 * HOUR,
    });
    expect(output.entries[0]).not.toHaveProperty("outcome");
    expect(lines[0]).toBe(
      `- ${C1} (general, "Fix tokenizer bug"): idle, its last run recorded no end; last activity 7h ago; no cost reported; 0 in + 0 cached / 0 out tokens`,
    );
  });

  test("keep a silent running subagent running when its wait does not resolve", async () => {
    const world = new ToolWorld().add(C1, { runningSince: NOW - HOUR });
    world.control.waitIdleImpl = never;
    const { output } = await world.list();
    expect(output.entries[0]).toMatchObject({
      state: "running",
      stateSource: "probe",
    });
  });

  test("show the stored state, labelled as stored, when the probe fails on a host that records starts", async () => {
    const world = new ToolWorld()
      .add("ses_open", { busy: NOW - HOUR, idle: NOW - 2 * HOUR })
      .add("ses_ended", { busy: NOW - 2 * HOUR, idle: NOW - HOUR });
    world.control.waitIdleImpl = () => Promise.reject(new Error("no wait"));
    const { output, lines } = await world.list();
    expect(
      output.entries.map((entry) => [entry.sessionID, entry.state, entry.stateSource]),
    ).toEqual([
      ["ses_open", "running", "stored"],
      ["ses_ended", "idle", "stored"],
    ]);
    expect(lines[0]).toStartWith("- ses_open: running; state as stored, not confirmed;");
  });

  test("show the state unknown when the probe fails on a host that records no starts", async () => {
    const world = new ToolWorld().add(C1, { idle: NOW - HOUR });
    world.control.waitIdleImpl = () => Promise.reject(new Error("no wait"));
    const { output } = await world.list();
    expect(output.entries[0]).toMatchObject({
      state: "unknown",
      stateSource: "probe",
    });
  });

  test("claim no idle age for a session whose stored start is later than its stored end", async () => {
    // Storage still records the run open, and the run's end was never seen.
    const world = new ToolWorld().add(C1, { busy: NOW - HOUR, idle: NOW - 2 * HOUR });
    const { output } = await world.list();
    expect(output.entries[0]).toMatchObject({
      state: "idle",
      noRecordedEnd: true,
    });
    expect(output.entries[0]).not.toHaveProperty("lastActivityAt");
  });
});

describe("subagents.inspect times", () => {
  test("come from live events, with the phase, while the plugin watched the run", async () => {
    const world = new ToolWorld().add(C1, { runningSince: NOW - 9 * MINUTE });
    world.feed(stepStarted(C1, NOW - 5 * MINUTE, { started: NOW - 5 * MINUTE }));
    world.feed(textDelta(C1, NOW - 4 * MINUTE - 12_000));
    // Silent for over 2 minutes, so it is probed; a running session's wait does not resolve.
    world.control.waitIdleImpl = never;
    const { output, lines } = await world.inspect(C1);
    const now = world.clock.now();
    expect(output).toMatchObject({
      state: "running",
      phase: "model",
      executionStarted: { at: NOW - 9 * MINUTE, ageMs: now - (NOW - 9 * MINUTE), source: "live" },
      responseStarted: { at: NOW - 5 * MINUTE, ageMs: now - (NOW - 5 * MINUTE), source: "live" },
      lastActivity: {
        at: NOW - 4 * MINUTE - 12_000,
        ageMs: now - (NOW - 4 * MINUTE - 12_000),
        source: "live",
      },
    });
    expect(lines.slice(2, 7)).toEqual([
      "State: running",
      "Phase: a model response is streaming",
      "Run started: 9m ago (live)",
      "Model response started: 5m ago (live)",
      "Last activity: 4m 12s ago (live)",
    ]);
  });

  test("give the phase of a subagent running tool calls", async () => {
    const world = new ToolWorld().add(C1, { runningSince: NOW - MINUTE });
    world.feed(toolCalled(C1, "call_1", NOW - 30_000));
    const { output } = await world.inspect(C1);
    expect(output.phase).toBe("tool");
    expect(output).not.toHaveProperty("responseStarted");
  });

  test("fall back to stored times after a reload", async () => {
    const world = new ToolWorld().add(C1, {
      busy: NOW - 9 * MINUTE,
      idle: NOW - HOUR,
      context: [
        openMessage(NOW - 5 * MINUTE, [
          tool("read", running({ path: "a.ts" }), { ran: NOW - 4 * MINUTE }),
        ]),
      ],
    });
    // No event was seen, and the probe finds it running.
    world.control.waitIdleImpl = never;
    const { output } = await world.inspect(C1);
    expect(output).toMatchObject({
      state: "running",
      stateSource: "probe",
      executionStarted: { at: NOW - 9 * MINUTE, source: "stored" },
      responseStarted: { at: NOW - 5 * MINUTE, source: "stored" },
      lastActivity: { at: NOW - 4 * MINUTE, source: "stored" },
    });
    expect(output).not.toHaveProperty("phase");
  });

  test("give an idle subagent's end as its last activity, and no run or response start", async () => {
    const world = new ToolWorld().add(C1, {
      busy: NOW - 2 * HOUR,
      idle: NOW - HOUR,
      outcome: "succeeded",
    });
    const { output } = await world.inspect(C1);
    expect(output).toMatchObject({
      state: "idle",
      outcome: "succeeded",
      lastActivity: { at: NOW - HOUR, ageMs: HOUR, source: "stored" },
    });
    expect(output).not.toHaveProperty("executionStarted");
    expect(output).not.toHaveProperty("responseStarted");
    expect(output).not.toHaveProperty("phase");
  });

  test("show a run with no recorded end as idle, keeping when that run started", async () => {
    const world = unended();
    const { output, lines } = await world.inspect(C1);
    expect(output).toMatchObject({
      state: "idle",
      stateSource: "probe",
      noRecordedEnd: true,
      executionStarted: { at: NOW - 7 * HOUR, source: "live" },
      lastActivity: { at: NOW - 7 * HOUR, source: "live" },
    });
    expect(output).not.toHaveProperty("outcome");
    expect(lines[2]).toBe("State: idle, its last run recorded no end");
  });

  test("label a state read from storage", async () => {
    const world = new ToolWorld().add(C1, { busy: NOW - HOUR, idle: NOW - 2 * HOUR });
    world.control.waitIdleImpl = () => Promise.reject(new Error("no wait"));
    const { output, lines } = await world.inspect(C1);
    expect(output).toMatchObject({ state: "running", stateSource: "stored" });
    expect(lines[2]).toBe("State: running (as stored; a probe could not confirm it)");
  });
});

describe("subagents.inspect active tools", () => {
  test("time a tool whose input is still streaming from when its input started", async () => {
    const world = new ToolWorld().add(C1, {
      runningSince: NOW - MINUTE,
      context: [
        openMessage(NOW - MINUTE, [
          { ...tool("shell", streaming('{"command":"bun')), time: { created: NOW - 5000 } },
        ]),
      ],
    });
    world.feed(toolInputStarted(C1, "call_1", NOW - 5000));
    const { output, lines } = await world.inspect(C1);
    expect(output.activeTools).toEqual([
      {
        name: "shell",
        status: "streaming",
        input: '{"command":"bun',
        streamingForMs: 5000,
      },
    ]);
    expect(lines).toContain('- shell (streaming, 5s): {"command":"bun');
  });

  test("give a running tool an age even when its stored start of running is missing", async () => {
    const world = new ToolWorld().add(C1, {
      runningSince: NOW - MINUTE,
      context: [
        openMessage(NOW - MINUTE, [
          { ...tool("shell", running({ command: "make" })), time: { created: NOW - 30_000 } },
        ]),
      ],
    });
    const { output } = await world.inspect(C1);
    const [shell] = output.activeTools;
    expect(shell).toMatchObject({ name: "shell", status: "running" });
    expect(typeof (shell?.runningForMs ?? shell?.streamingForMs)).toBe("number");
  });
});

describe("subagent_send", () => {
  test("gives how long each tool call it waits on has been running", async () => {
    const world = new ToolWorld().add(C1, {
      agent: "general",
      title: "Add CSV export",
      runningSince: NOW - HOUR,
      context: [
        openMessage(NOW - HOUR, [
          tool("shell", running({ command: "bun test" }), { ran: NOW - 47 * MINUTE }),
        ]),
      ],
    });
    world.feed(toolCalled(C1, "call_1", NOW - 47 * MINUTE));
    // Silent for over 2 minutes, so it is probed; a running session's wait does not resolve.
    world.control.waitIdleImpl = never;
    const { output, content } = await world.send(C1);
    expect(content).toBe(
      `Message sent to ${C1} (general, "Add CSV export"). It reads your message after its current tool calls finish: shell (running 47m). Sending never interrupts; to redirect it right away, stop it with subagent_stop and continue it with subagent.`,
    );
    expect(output.lastActivityAt).toBe(NOW - 47 * MINUTE);
  });

  test("gives how long a tool call whose input is still streaming has been going", async () => {
    const world = new ToolWorld().add(C1, {
      runningSince: NOW - MINUTE,
      context: [
        openMessage(NOW - MINUTE, [
          { ...tool("shell", streaming("{")), time: { created: NOW - 5000 } },
        ]),
      ],
    });
    const { output } = await world.send(C1);
    expect(output.note).toContain("after its current tool calls finish: shell (streaming 5s)");
  });

  test("gives when the current model response started and last produced output", async () => {
    const world = new ToolWorld().add(C1, {
      agent: "general",
      title: "Plan the migration",
      runningSince: NOW - 10 * MINUTE,
    });
    world.feed(stepStarted(C1, NOW - 4 * MINUTE, { started: NOW - 4 * MINUTE }));
    world.feed(textDelta(C1, NOW - 5000));
    const { output, content } = await world.send(C1);
    expect(content).toBe(
      `Message sent to ${C1} (general, "Plan the migration"). It reads your message once its current model response finishes; the response started 4m ago and last produced output 5s ago. Sending never interrupts; to redirect it right away, stop it with subagent_stop and continue it with subagent.`,
    );
    expect(output.lastActivityAt).toBe(NOW - 5000);
  });

  test("gives only the stored start of the model response when it saw no events", async () => {
    const world = new ToolWorld().add(C1, { context: [openMessage(NOW - 4 * MINUTE)] });
    world.control.waitIdleImpl = never;
    const { output } = await world.send(C1);
    expect(output.note).toContain(
      "once its current model response finishes; the response started 4m ago.",
    );
    expect(output).not.toHaveProperty("lastActivityAt");
  });

  test("refuses a subagent whose last run recorded no end and sends nothing", async () => {
    const world = unended();
    const error = await world.failure(() => world.send(C1));
    expect(error.message).toBe(
      `Subagent ${C1} is not running, so nothing was sent: OpenCode reports it idle, but its last run recorded no end, so the message would not be read until it is continued with subagent. When it stopped running is unknown; its last activity was 7h ago. To give it your message, continue it: call subagent with its sessionID and the message.`,
    );
    expect(world.messenger.posts).toEqual([]);
  });

  test("says when an idle subagent went idle", async () => {
    const world = new ToolWorld().add(C1, { idle: NOW - 5 * MINUTE });
    const error = await world.failure(() => world.send(C1));
    expect(error.message).toContain("It went idle 5m ago.");
    expect(world.messenger.posts).toEqual([]);
  });

  test("says when an idle subagent went idle is unknown when it was not recorded", async () => {
    const world = new ToolWorld().add(C1);
    const error = await world.failure(() => world.send(C1));
    expect(error.message).toContain("When it went idle was not recorded.");
  });

  test("acts on what session.wait says, not on the stored state, when it has no event record", async () => {
    // Storage records the run as ended, but the probe cannot tell, so the message is sent.
    const world = new ToolWorld().add(C1, { busy: NOW - 2 * HOUR, idle: NOW - HOUR });
    world.control.waitIdleImpl = () => Promise.reject(new Error("unavailable"));
    const { output } = await world.send(C1);
    expect(output).toMatchObject({ status: "sent", state: "unknown" });
    expect(world.messenger.posts).toHaveLength(1);
  });

  test("refuses an over-long message with its length, the limit and the overage", async () => {
    const world = new ToolWorld().add(C1, { runningSince: NOW });
    const error = await world.failure(() => world.send(C1, "a".repeat(8412)));
    expect(error.message).toBe(
      "message is 8,412 characters; the limit is 8,000 (412 over). Nothing was sent.",
    );
    expect(world.messenger.posts).toEqual([]);
  });
});

describe("subagent_stop", () => {
  test("reports a subagent that settles idle with no recorded end, and still keeps it stopped", async () => {
    const world = unended();
    const { output, content } = await world.stop({ sessionIDs: [C1] });
    expect(output.nodes.map((node) => [node.sessionID, node.result])).toEqual([
      [C1, "no_recorded_end"],
    ]);
    expect(content.split("\n")[0]).toBe(
      `- ${C1} (general, "Fix tokenizer bug"): not running; its last run recorded no end`,
    );
    expect(await world.latch.isActive(C1)).toBe(true);
  });

  test("reports a subagent that showed progress within 2 minutes as stopping, not as having no recorded end", async () => {
    // Its interrupt finds no run and its wait resolves, but it is not silent long enough to
    // conclude that the end went unrecorded.
    const world = new ToolWorld().add(C1, { runningSince: NOW });
    const { output } = await world.stop({ sessionIDs: [C1] });
    expect(output.nodes.map((node) => node.result)).not.toContain("no_recorded_end");
  });
});

describe("a host without session.wait", () => {
  function hostWithoutWait() {
    const logger = new RecordingLogger();
    // Only `session.wait` is read when the host is created; the rest is read on use.
    const ctx = { session: {} } as unknown as Plugin.Context;
    return { host: createHost(ctx, logger), logger };
  }

  test("logs one warning and reports no wait", () => {
    const { host, logger } = hostWithoutWait();
    expect(host.waitAvailable).toBe(false);
    expect(logger.warnings()).toHaveLength(1);
    expect(logger.warnings()[0]).toContain("no session.wait");
  });

  test("rejects waits, so probes report the state unknown", async () => {
    const { host } = hostWithoutWait();
    await expect(host.control.waitIdle(C1)).rejects.toThrow();
    const world = new ToolWorld({ reconcile: false }).add(C1);
    world.control.waitIdleImpl = (sessionID) => host.control.waitIdle(sessionID);
    const { output } = await world.list();
    expect(output.entries[0]).toMatchObject({ state: "unknown", stateSource: "probe" });
  });

  test("trusts a silent running fold instead of reconciling it", async () => {
    const world = new ToolWorld({ reconcile: false }).add(C1, {
      runningSince: NOW - 7 * HOUR,
    });
    world.control.waitIdleImpl = () => Promise.reject(new Error("no wait"));
    const { output } = await world.list();
    expect(output.entries[0]).toMatchObject({ state: "running", stateSource: "event" });
    expect(output.entries[0]).not.toHaveProperty("noRecordedEnd");
  });
});
