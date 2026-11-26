// A stopped subagent woken by its own background shell sends no model request. A background child
// starts a real background command that waits for a release file, then blocks in a real
// foreground `sleep`. subagent_stop stops the child; the background command keeps running. When
// the script releases it, its completion notice wakes the child, and the plugin holds that run in
// the `context` hook until the interrupt lands: the run ends interrupted with reason `user`, and the
// simulated model receives no request for it. The parent then continues the child with `subagent`
// and its session ID, and that run reaches the model and succeeds.
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

const dir = runDir("stop-woken-no-request");
const REASON = "woken by its own shell";
const RELEASE_FILE = ".woken-release";
const CONTINUED = "CONTINUED-REPLY";

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
            if (last.toolCallID === "p_cont")
              return Stream.make(Llm.text("Continued."));
          }
          if (last.text.includes("CMD-STOP"))
            return toolCallResponse("p_stop", "subagent_stop", {
              sessionIDs: [child],
              reason: REASON,
            });
          if (last.text.includes("CMD-CONTINUE"))
            return toolCallResponse("p_cont", "subagent", {
              agent: "general",
              description: "woken child",
              sessionID: child,
              prompt: "CONT-TASK reply and finish",
              background: true,
            });
          if (last.text.includes("<subagent"))
            return Stream.make(Llm.text("PARENT-NOTED"));
          if (last.text.includes("ROLE<parent>"))
            return toolCallResponse("p_sub", "subagent", {
              agent: "general",
              description: "woken child",
              prompt: "ROLE<child> CHILD-TASK",
              background: true,
            });
          return Stream.make(Llm.text("parent-other"));
        }
        if (req.role === "child") {
          if (last.role === "user" && last.text.includes("CONT-TASK"))
            return Stream.make(Llm.text(CONTINUED));
          if (last.role === "user" && last.text.includes("CHILD-TASK"))
            return Stream.make(
              Llm.toolCall({
                index: 0,
                id: "c_bg",
                name: "shell",
                input: {
                  command: `while [ ! -e ${RELEASE_FILE} ]; do sleep 0.05; done; echo woken-released`,
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
          // Any request from the woken run is recorded above, before this reply streams.
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
      const childRequests = (from: number, to = Number.POSITIVE_INFINITY) =>
        readLlm(dir).filter(
          (r) => r.sessionID === child && r.at >= from && r.at < to,
        );

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
          notices(dir, parent).find(
            (n) =>
              n.at >= stopAt &&
              JSON.stringify(n.metadata).includes('"cancelled"'),
          ),
        ),
      );
      yield* wait(parent, "session.execution.succeeded", stopAt, 30_000);
      yield* Effect.sleep(1500);

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
      const ended = yield* wait(
        child,
        "session.execution.interrupted",
        woken.at,
      );
      // Long enough for a request that slipped through, and its reply, to be recorded.
      yield* Effect.sleep(3000);

      // The parent continues the child: the stop lifts and the run reaches the model.
      const continueAt = Date.now();
      const wokenRequests = childRequests(releaseAt, continueAt);
      const wokenSteps = childAll().filter(
        (e) =>
          e.type === "session.step.started" &&
          e.at >= releaseAt &&
          e.at < continueAt,
      );
      const startsWhileStopped = forSession(events(readLog(dir)), child).filter(
        (e) =>
          e.type === "session.execution.started" &&
          e.at >= releaseAt &&
          e.at < continueAt,
      );
      yield* ctl("prompt", { sessionID: parent, text: "CMD-CONTINUE" });
      const continued = yield* wait(
        child,
        "session.execution.succeeded",
        continueAt,
        30_000,
      );
      yield* Effect.sleep(1000);
      const continuedRequests = childRequests(continueAt);
      const childAfterContinue = forSession(events(readLog(dir)), child).filter(
        (e) => e.at >= continueAt,
      );
      const context = yield* ctl<ReadonlyArray<unknown>>("context", {
        sessionID: child,
      });
      const plugin = pluginConsole(artifacts);

      const evidence = {
        dir,
        parent,
        child,
        stopText,
        wake: {
          startedAfterNoticeMs: woken.at - shellNotice.at,
          interruptedAfterStartMs: ended.at - woken.at,
          reason: ended.reason,
        },
        wokenRequests: wokenRequests.map((r) => ({
          t: r.at - releaseAt,
          last: r.last.text.slice(0, 160),
        })),
        wokenSteps: wokenSteps.length,
        continuation: {
          runMs: continued.at - continueAt,
          requests: continuedRequests.map((r) => ({
            t: r.at - continueAt,
            last: r.last.text.slice(0, 200),
          })),
          events: childAfterContinue.map((e) => ({
            t: e.at - continueAt,
            type: e.type,
            reason: e.reason,
          })),
        },
        plugin,
      };

      const checks = {
        stopResultStopped:
          stopText.includes(`- ${child}`) && /: stopped$/m.test(stopText),
        shellNoticeWokeChild: woken.at >= shellNotice.at,
        oneWakeOnly: startsWhileStopped.length === 1,
        wokenRunInterruptedByUser: ended.reason === "user",
        noModelRequestFromWokenRun: wokenRequests.length === 0,
        noStepFromWokenRun: wokenSteps.length === 0,
        noWokenReply: !JSON.stringify(context).includes("WOKEN-REPLY"),
        continuedRunSentRequest: continuedRequests.some((r) =>
          r.last.text.includes("CONT-TASK"),
        ),
        continuedRunNotInterrupted: !childAfterContinue.some(
          (e) => e.type === "session.execution.interrupted",
        ),
        continuedReplyPersisted: JSON.stringify(context).includes(CONTINUED),
        latchLoggedInterrupt: plugin.some(
          (line) =>
            line.includes("latch: interrupted a run in a stopped session") &&
            line.includes(child),
        ),
        probeNeverEnforced: readLog(dir).every((r) => r.kind !== "enforce"),
      };

      yield* finishScenario(dir, "stop-woken-no-request", evidence, checks);
    }),
);
