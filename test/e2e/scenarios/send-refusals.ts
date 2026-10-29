// subagent_send refuses a subagent that is not running. An idle child, one that finished its run,
// is refused as idle; a child stopped with subagent_stop is refused as stopped. Nothing reaches
// either: no inbox item, no run, no model request. The refused send leaves the stop latch active.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { Effect, Option, Stream } from "effect";
import { Llm, OpenCodeDriver } from "opencode-drive";
import {
  call,
  captureToolResults,
  capturedToolResult,
  childOf,
  codeModeValue,
  completionNotices,
  events,
  finishScenario,
  forSession,
  instanceFor,
  isBusy,
  LIST_SUBTREE_CODE,
  listedLatches,
  noticeState,
  pluginConsole,
  probePlugin,
  REPO_ROOT,
  readLlm,
  readLog,
  recordRequest,
  runDir,
  takeCall,
  toolCallResponse,
  until,
  waitIdle,
} from "../harness";

const dir = runDir("send-refusals");
const REASON = "refusal check";
const MESSAGE = "REFUSED-MESSAGE: this must not arrive";

if (!existsSync(join(REPO_ROOT, "dist", "index.js")))
  throw new Error("dist/index.js is missing; run `bun run build` first");

export default OpenCodeDriver.use(
  {
    tools: ["shell"],
    config: {
      permissions: [],
      plugins: [probePlugin(dir), { package: REPO_ROOT, options: {} }],
    },
  },
  ({ llm, tools, directory, artifacts }) =>
    Effect.gen(function* () {
      const shells = yield* tools.control("shell");
      let idleChild = "";
      let stoppedChild = "";

      yield* llm.serve((request, index) => {
        const req = recordRequest(dir, request.body, index);
        captureToolResults(dir, request.body);
        const { last } = req;
        if (req.role === "parent") {
          if (last.role === "tool") {
            switch (last.toolCallID) {
              case "p_sub_idle":
              case "p_sub_stop":
                return Stream.make(Llm.text("Launched."));
              case "p_send_idle":
              case "p_send_stopped":
                return Stream.make(Llm.text("SEND-REPLIED"));
              case "p_stop":
                return Stream.make(Llm.text("STOP-DONE"));
              case "p_list":
                return Stream.make(Llm.text("LISTED"));
            }
          }
          if (last.text.includes("CMD-LAUNCH-IDLE"))
            return toolCallResponse("p_sub_idle", "subagent", {
              agent: "general",
              description: "idle child",
              prompt: "ROLE<idle> IDLE-TASK",
              background: true,
            });
          if (last.text.includes("CMD-LAUNCH-STOP"))
            return toolCallResponse("p_sub_stop", "subagent", {
              agent: "general",
              description: "stopped child",
              prompt: "ROLE<stopped> STOP-TASK",
              background: true,
            });
          if (last.text.includes("CMD-SEND-IDLE"))
            return toolCallResponse("p_send_idle", "subagent_send", {
              sessionID: idleChild,
              message: MESSAGE,
            });
          if (last.text.includes("CMD-SEND-STOPPED"))
            return toolCallResponse("p_send_stopped", "subagent_send", {
              sessionID: stoppedChild,
              message: MESSAGE,
            });
          if (last.text.includes("CMD-STOP"))
            return toolCallResponse("p_stop", "subagent_stop", {
              sessionIDs: [stoppedChild],
              reason: REASON,
            });
          if (last.text.includes("CMD-LIST"))
            return toolCallResponse("p_list", "execute", {
              code: LIST_SUBTREE_CODE,
            });
          if (last.text.includes("<subagent"))
            return Stream.make(Llm.text("PARENT-NOTED"));
          return Stream.make(Llm.text("parent-other"));
        }
        if (req.role === "idle")
          return Stream.make(Llm.text("IDLE-CHILD-DONE"));
        if (req.role === "stopped") {
          if (last.role === "user" && last.text.includes("STOP-TASK"))
            return toolCallResponse("s_hold", "shell", {
              command: "hold",
              description: "hold",
            });
          return Stream.make(Llm.pause(1500), Llm.text("STOPPED-WOKEN-REPLY"));
        }
        return Stream.make(Llm.text("other"));
      });

      const instance = yield* Effect.promise(() => instanceFor(dir, directory));
      const ctl = <T = unknown>(
        op: string,
        args: Record<string, unknown> = {},
      ) => Effect.promise(() => call<T>(instance, op, args));
      const toolText = (id: string) =>
        Effect.promise(() =>
          until(`${id} result`, () => capturedToolResult(dir, id), 30_000),
        );
      const prompt = (sessionID: string, text: string) =>
        Effect.gen(function* () {
          yield* ctl("prompt", { sessionID, text });
          yield* Effect.sleep(200);
        });
      const settle = (...ids: string[]) =>
        Effect.promise(async () => {
          for (const id of ids) await waitIdle(instance, id);
        });
      /** Everything that would show the message reached `sessionID` after `since`. */
      const traces = (sessionID: string, since: number) => {
        const typed = forSession(events(readLog(dir)), sessionID).filter(
          (e) => e.at >= since,
        );
        return {
          enqueued: typed
            .filter((e) => e.type === "session.inbox.enqueued")
            .map((e) => e.itemText),
          runs: typed.filter((e) => e.type === "session.execution.started")
            .length,
          requests: readLlm(dir).filter(
            (r) => r.sessionID === sessionID && r.at >= since,
          ).length,
        };
      };

      const parent = (yield* ctl<{ id: string }>("create", { title: "parent" }))
        .id;

      // An idle child: it answers and its run ends.
      yield* prompt(parent, "ROLE<parent> CMD-LAUNCH-IDLE");
      idleChild = yield* Effect.promise(() =>
        until("idle child", () => childOf(dir, parent, 0)),
      );
      yield* Effect.promise(() =>
        until(
          "idle child's completion notice",
          () => completionNotices(dir, parent, idleChild)[0],
        ),
      );
      yield* Effect.sleep(300);
      yield* settle(parent, idleChild);

      const idleSendAt = Date.now();
      yield* prompt(parent, "CMD-SEND-IDLE");
      const idleText = yield* toolText("p_send_idle");
      yield* settle(parent);
      yield* Effect.sleep(1500);
      const idleBusy = yield* Effect.promise(() => isBusy(instance, idleChild));
      const idleTraces = traces(idleChild, idleSendAt);

      // A stopped child: it held a shell when subagent_stop stopped it.
      yield* prompt(parent, "CMD-LAUNCH-STOP");
      stoppedChild = yield* Effect.promise(() =>
        until("stopped child", () => childOf(dir, parent, 1)),
      );
      const hold = yield* takeCall(shells, "s_hold");
      yield* hold.progress("holding\n");
      yield* settle(parent);
      const stopAt = Date.now();
      yield* prompt(parent, "CMD-STOP");
      const holdInterrupted = yield* hold
        .awaitInterrupted()
        .pipe(Effect.as(true), Effect.timeoutOption(15_000));
      const stopText = yield* toolText("p_stop");
      yield* Effect.promise(() =>
        until("cancelled notice", () =>
          completionNotices(dir, parent, stoppedChild).find(
            (n) => n.at >= stopAt && noticeState(n) === "cancelled",
          ),
        ),
      );
      yield* Effect.sleep(1000);
      yield* settle(parent, stoppedChild);

      const stoppedSendAt = Date.now();
      yield* prompt(parent, "CMD-SEND-STOPPED");
      const stoppedText = yield* toolText("p_send_stopped");
      yield* settle(parent);
      yield* Effect.sleep(1500);
      const stoppedBusy = yield* Effect.promise(() =>
        isBusy(instance, stoppedChild),
      );
      const stoppedTraces = traces(stoppedChild, stoppedSendAt);

      const listAt = Date.now();
      yield* prompt(parent, "CMD-LIST");
      const listText = yield* toolText("p_list");
      yield* settle(parent);
      const latches = listedLatches(codeModeValue(listText));
      const contexts = {
        idle: JSON.stringify(
          yield* ctl<ReadonlyArray<unknown>>("context", {
            sessionID: idleChild,
          }),
        ),
        stopped: JSON.stringify(
          yield* ctl<ReadonlyArray<unknown>>("context", {
            sessionID: stoppedChild,
          }),
        ),
      };
      const plugin = pluginConsole(artifacts);

      const evidence = {
        dir,
        parent,
        idleChild,
        stoppedChild,
        idle: {
          resultText: idleText,
          busyAfterSend: idleBusy,
          traces: idleTraces,
        },
        stopped: {
          stopText,
          resultText: stoppedText,
          busyAfterSend: stoppedBusy,
          traces: stoppedTraces,
          latchAfterSend: latches.get(stoppedChild),
          listedAfterMs: listAt - stoppedSendAt,
        },
        plugin,
      };

      const nothingArrived = (t: typeof idleTraces) =>
        t.enqueued.length === 0 && t.runs === 0 && t.requests === 0;
      const checks = {
        idleRefused: idleText.includes(
          `Subagent ${idleChild} is idle, so nothing was sent`,
        ),
        idleRefusalSaysContinue: idleText.includes(
          "call subagent with its sessionID",
        ),
        idleNothingArrived: nothingArrived(idleTraces) && !idleBusy,
        idleMessageNotPersisted: !contexts.idle.includes("REFUSED-MESSAGE"),
        stopShellInterrupted: Option.isSome(holdInterrupted),
        stopResultStopped:
          stopText.includes(`- ${stoppedChild}`) &&
          /: stopped$/m.test(stopText),
        stoppedRefused: stoppedText.includes(
          `Subagent ${stoppedChild} is stopped, so nothing was sent`,
        ),
        stoppedNothingArrived: nothingArrived(stoppedTraces) && !stoppedBusy,
        stoppedMessageNotPersisted:
          !contexts.stopped.includes("REFUSED-MESSAGE"),
        latchStillActive: latches.get(stoppedChild) === "active",
        latchNeverLifted: !plugin.some(
          (line) =>
            line.includes("latch: lifted") && line.includes(stoppedChild),
        ),
        probeNeverEnforced: readLog(dir).every((r) => r.kind !== "enforce"),
      };

      yield* finishScenario(dir, "send-refusals", evidence, checks);
    }),
);
