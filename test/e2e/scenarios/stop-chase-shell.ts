// The chase loop with OpenCode's own shell. A background child starts a real background command
// that waits for a release file, then blocks in a real foreground `sleep`. subagent_stop stops the
// child; the background command keeps running, as no plugin can cancel it. When the script
// releases it, its completion notice wakes the stopped child, and the latch interrupts that run
// within 500 ms: no child model request completes, nothing is persisted, and the parent gets no
// further notice.
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Effect, Stream } from "effect";
import { Llm, OpenCodeDriver } from "opencode-drive";
import {
  call,
  captureToolResults,
  capturedToolResult,
  childOf,
  events,
  finishScenario,
  forSession,
  instanceFor,
  notices,
  pluginConsole,
  probePlugin,
  REPO_ROOT,
  readLlm,
  readLog,
  recordRequest,
  runDir,
  toolCallResponse,
  until,
  waitEvent,
} from "../harness";

const dir = runDir("stop-chase-shell");
const REASON = "chasing a real shell";
const RELEASE_FILE = ".chase-release";

if (!existsSync(join(REPO_ROOT, "dist", "index.js")))
  throw new Error("dist/index.js is missing; run `bun run build` first");

export default OpenCodeDriver.use(
  {
    config: {
      plugins: [probePlugin(dir), { package: REPO_ROOT, options: {} }],
    },
  },
  ({ llm, directory, artifacts }) =>
    Effect.gen(function* () {
      let child = "";

      yield* llm.serve((request, index) => {
        const req = recordRequest(dir, request.body, index);
        captureToolResults(dir, request.body);
        const { last } = req;
        if (req.role === "parent") {
          if (last.role === "tool") {
            if (last.toolCallID === "p_sub")
              return Stream.make(Llm.text("Launched."));
            if (last.toolCallID === "p_stop")
              return Stream.make(Llm.text("STOP-DONE"));
          }
          if (last.text.includes("CMD-STOP"))
            return toolCallResponse("p_stop", "subagent_stop", {
              sessionIDs: [child],
              reason: REASON,
            });
          if (last.text.includes("<subagent"))
            return Stream.make(Llm.text("PARENT-NOTED"));
          if (last.text.includes("ROLE<parent>"))
            return toolCallResponse("p_sub", "subagent", {
              agent: "general",
              description: "shell child",
              prompt: "ROLE<child> CHILD-TASK",
              background: true,
            });
          return Stream.make(Llm.text("parent-other"));
        }
        if (req.role === "child") {
          if (last.role === "user" && last.text.includes("CHILD-TASK"))
            return Stream.make(
              Llm.toolCall({
                index: 0,
                id: "c_bg",
                name: "shell",
                input: {
                  command: `while [ ! -e ${RELEASE_FILE} ]; do sleep 0.05; done; echo chase-released`,
                  description: "wait for release",
                  background: true,
                },
              }),
              Llm.toolCall({
                index: 1,
                id: "c_fg",
                name: "shell",
                input: {
                  command: "sleep 60",
                  description: "foreground sleep",
                },
              }),
              Llm.finish("tool-calls"),
            );
          // A woken run answers slowly, so a reply can only be persisted if the latch misses it.
          return Stream.make(Llm.pause(1500), Llm.text("WOKEN-REPLY"));
        }
        return Stream.make(Llm.text("other"));
      });

      const instance = yield* Effect.promise(() => instanceFor(dir, directory));
      const ctl = <T = unknown>(
        op: string,
        args: Record<string, unknown> = {},
      ) => Effect.promise(() => call<T>(instance, op, args));
      const wait = (
        sessionID: string,
        type: string,
        since: number,
        timeoutMs = 20_000,
      ) =>
        Effect.promise(() =>
          waitEvent(dir, sessionID, type, { since, timeoutMs }),
        );
      const childAll = () => forSession(events(readLog(dir), "all"), child);

      // A background child with a real background command and a real foreground sleep.
      const parent = (yield* ctl<{ id: string }>("create", { title: "parent" }))
        .id;
      const launchAt = Date.now();
      yield* ctl("prompt", { sessionID: parent, text: "ROLE<parent> launch" });
      child = yield* Effect.promise(() =>
        until("child", () => childOf(dir, parent)),
      );
      yield* Effect.promise(() =>
        until("foreground sleep running", () =>
          childAll().find(
            (e) =>
              e.type === "session.tool.called" &&
              typeof e.data === "string" &&
              e.data.includes('"id":"c_fg"'),
          ),
        ),
      );
      yield* wait(parent, "session.execution.succeeded", launchAt);
      yield* Effect.sleep(500);

      const stopAt = Date.now();
      yield* ctl("prompt", { sessionID: parent, text: "CMD-STOP" });
      const stopText = yield* Effect.promise(() =>
        until("stop result", () => capturedToolResult(dir, "p_stop"), 30_000),
      );
      yield* Effect.promise(() =>
        until("cancelled notice", () =>
          notices(dir, parent).find((n) =>
            JSON.stringify(n.metadata).includes('"cancelled"'),
          ),
        ),
      );
      yield* Effect.sleep(2000);
      const childAfterStop = yield* ctl<Record<string, unknown>>("get", {
        sessionID: child,
      });
      const noticesAfterStop = notices(dir, parent);
      const startsBeforeRelease = forSession(
        events(readLog(dir)),
        child,
      ).filter(
        (e) => e.type === "session.execution.started" && e.at >= stopAt,
      ).length;

      // Release the background command; its completion notice wakes the stopped child.
      const releaseAt = Date.now();
      writeFileSync(join(directory, RELEASE_FILE), "release\n");
      const shellNotice = yield* Effect.promise(() =>
        until(
          "shell notice",
          () =>
            notices(dir, child).find(
              (n) =>
                n.at >= releaseAt &&
                JSON.stringify(n.metadata).includes('"shell"'),
            ),
          20_000,
        ),
      );
      const woken = yield* wait(
        child,
        "session.execution.started",
        shellNotice.at,
      );
      const reinterrupted = yield* wait(
        child,
        "session.execution.interrupted",
        woken.at,
      );
      yield* Effect.sleep(4000);
      const context = yield* ctl<ReadonlyArray<unknown>>("context", {
        sessionID: child,
      });

      const typed = forSession(events(readLog(dir)), child);
      const afterRelease = typed.filter((e) => e.at >= releaseAt);
      const stepsEndedAfterStop = childAll().filter(
        (e) => e.type === "session.step.ended" && e.at >= stopAt,
      );
      const childRequestsAfterRelease = readLlm(dir).filter(
        (r) => r.sessionID === child && r.at >= releaseAt,
      );
      const noticesNow = notices(dir, parent);
      const plugin = pluginConsole(artifacts);

      const evidence = {
        dir,
        parent,
        child,
        stopText,
        childOutcomeAfterStop: childAfterStop.outcome,
        parentNoticesAfterStop: noticesAfterStop.map((n) => n.metadata),
        shellNotice: {
          afterReleaseMs: shellNotice.at - releaseAt,
          metadata: shellNotice.metadata,
          text: shellNotice.text,
        },
        wake: {
          startedAfterNoticeMs: woken.at - shellNotice.at,
          interruptedAfterStartMs: reinterrupted.at - woken.at,
          interruptedAfterNoticeMs: reinterrupted.at - shellNotice.at,
          reason: reinterrupted.reason,
        },
        childEventsAfterRelease: afterRelease.map((e) => ({
          t: e.at - releaseAt,
          type: e.type,
          itemType: e.itemType,
          reason: e.reason,
        })),
        childRequestsAfterRelease: childRequestsAfterRelease.map((r) => ({
          t: r.at - releaseAt,
          last: r.last.text.slice(0, 160),
        })),
        parentNoticesNow: noticesNow.map((n) => n.metadata),
        plugin,
      };

      const checks = {
        stopResultStopped:
          stopText.includes(`- ${child}`) && /: stopped$/m.test(stopText),
        childOutcomeInterrupted: childAfterStop.outcome === "interrupted",
        foregroundShellStopped: childAll().some(
          (e) =>
            e.type === "session.tool.failed" &&
            e.at >= stopAt &&
            typeof e.data === "string" &&
            e.data.includes('"id":"c_fg"') &&
            e.data.includes('"aborted"'),
        ),
        exactlyOneCancelledNotice:
          noticesAfterStop.filter((n) =>
            JSON.stringify(n.metadata).includes('"cancelled"'),
          ).length === 1,
        stayedIdleUntilRelease: startsBeforeRelease === 0,
        shellNoticeWokeChild: woken.at >= shellNotice.at,
        reinterruptedWithin500ms: reinterrupted.at - shellNotice.at < 500,
        oneWakeOnly:
          afterRelease.filter((e) => e.type === "session.execution.started")
            .length === 1,
        noStepCompleted: stepsEndedAfterStop.length === 0,
        noWokenReply: !JSON.stringify(context).includes("WOKEN-REPLY"),
        noNewParentNotice: noticesNow.length === noticesAfterStop.length,
        latchLoggedInterrupt: plugin.some(
          (line) =>
            line.includes("latch: interrupted a run in a stopped session") &&
            line.includes(child),
        ),
        probeNeverEnforced: readLog(dir).every((r) => r.kind !== "enforce"),
      };

      yield* finishScenario(dir, "stop-chase-shell", evidence, checks);
    }),
);
