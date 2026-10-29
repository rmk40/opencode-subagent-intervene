// A person continues a subagent while subagent_stop is still settling it. The parent stops one
// background child that is waiting on eighty shells at once, so its stopped run takes tens of
// milliseconds to wind down, and the stop waits for it. The moment the first shell sees the
// interrupt, the person prompts the child through the SDK, and the prompt's hook lifts the latch
// during that wait. The stop's settle round then finds its latch released and leaves the child
// alone: no second interrupt, from the stop or the latch. It reports the child as continued, and
// the continuation, which runs a tool of its own, completes.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { Effect, Fiber, Option, Stream } from "effect";
import { Llm, type OpenCode, OpenCodeDriver } from "opencode-drive";
import {
  call,
  captureToolResults,
  capturedToolResult,
  childOf,
  events,
  finishScenario,
  forSession,
  instanceFor,
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
  waitEvent,
} from "../harness";

const dir = runDir("stop-continue-during-stop");
const REASON = "superseded";
const ANSWER = "USER-CONT-ANSWER-9";
/** Shells the child waits on when it is stopped; each one adds to the stopped run's cleanup. */
const HOLDS = Array.from({ length: 80 }, (_, i) => `c_hold_${i}`);

type PromptInput = Parameters<OpenCode["session"]["prompt"]>[0];

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
  ({ llm, tools, directory, opencode, artifacts }) =>
    Effect.gen(function* () {
      const shells = yield* tools.control("shell");
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
              description: "continued child",
              prompt: "ROLE<child> CHILD-TASK",
              background: true,
            });
          return Stream.make(Llm.text("parent-other"));
        }
        if (req.role === "child") {
          if (last.role === "tool" && last.toolCallID === "c_cont_work")
            return Stream.make(Llm.text(ANSWER));
          if (last.role === "user" && last.text.includes("USER-CONT"))
            return toolCallResponse("c_cont_work", "shell", {
              command: "continued-work",
              description: "continued work",
            });
          if (last.role === "user" && last.text.includes("CHILD-TASK"))
            return Stream.make(
              ...HOLDS.map((id, i) =>
                Llm.toolCall({
                  index: i,
                  id,
                  name: "shell",
                  input: { command: `hold ${i}`, description: `hold ${i}` },
                }),
              ),
              Llm.finish("tool-calls"),
            );
          return Stream.make(Llm.pause(1500), Llm.text("WOKEN-REPLY"));
        }
        return Stream.make(Llm.text("other"));
      });

      const instance = yield* Effect.promise(() => instanceFor(dir, directory));
      const ctl = <T = unknown>(
        op: string,
        args: Record<string, unknown> = {},
      ) => Effect.promise(() => call<T>(instance, op, args));
      const wait = (sessionID: string, type: string, since: number) =>
        Effect.promise(() =>
          waitEvent(dir, sessionID, type, { since, timeoutMs: 20_000 }),
        );

      // A background child waiting on eighty shells.
      const parent = (yield* ctl<{ id: string }>("create", { title: "parent" }))
        .id;
      const launchAt = Date.now();
      yield* ctl("prompt", { sessionID: parent, text: "ROLE<parent> launch" });
      child = yield* Effect.promise(() =>
        until("child", () => childOf(dir, parent)),
      );
      const holds = yield* Effect.all(HOLDS.map((id) => takeCall(shells, id)));
      for (const hold of holds) yield* hold.progress("holding\n");
      yield* wait(parent, "session.execution.succeeded", launchAt);
      yield* Effect.sleep(500);

      // The person's prompt goes out as soon as the first shell sees the interrupt.
      const reaction = yield* Effect.raceAll(
        holds.map((hold) => hold.awaitInterrupted()),
      ).pipe(
        Effect.andThen(() => {
          const interruptedAt = Date.now();
          return opencode.session
            .prompt({
              sessionID: child as PromptInput["sessionID"],
              text: "USER-CONT keep going with the original task",
            })
            .pipe(
              Effect.orDie,
              Effect.map(() => ({ interruptedAt, promptedAt: Date.now() })),
            );
        }),
        Effect.forkChild,
      );
      const allHoldsInterrupted = yield* Effect.forkChild(
        Effect.all(
          holds.map((hold) =>
            hold
              .awaitInterrupted()
              .pipe(Effect.as(true), Effect.timeoutOption(15_000)),
          ),
        ),
      );

      const stopAt = Date.now();
      yield* ctl("prompt", { sessionID: parent, text: "CMD-STOP" });
      const user = yield* Fiber.join(reaction).pipe(
        Effect.timeoutOption(15_000),
      );
      const work = yield* takeCall(shells, "c_cont_work");
      const workHeldAt = Date.now();
      const workInterrupted = yield* work
        .awaitInterrupted()
        .pipe(Effect.as(Date.now()), Effect.forkChild);
      const stopText = yield* Effect.promise(() =>
        until("stop result", () => capturedToolResult(dir, "p_stop"), 30_000),
      );
      const stopResultAt = Date.now();
      yield* Effect.sleep(500);
      const releaseAt = Date.now();
      const workInterruptedEarly = workInterrupted.pollUnsafe() !== undefined;
      yield* work.succeed({ output: "continued work done\n", exit: 0 });
      const contEnd = yield* wait(child, "session.execution.succeeded", stopAt);
      const holdResults = yield* Fiber.join(allHoldsInterrupted);
      yield* Effect.sleep(2000);
      const context = yield* ctl<ReadonlyArray<unknown>>("context", {
        sessionID: child,
      });

      const userTimes = Option.getOrUndefined(user);
      const parentAll = forSession(events(readLog(dir), "all"), parent);
      const stopCall = (types: readonly string[]) =>
        parentAll.find(
          (e) =>
            types.includes(e.type ?? "") &&
            typeof e.data === "string" &&
            e.data.includes('"id":"p_stop"'),
        );
      const stopCalled = stopCall(["session.tool.called"]);
      const stopEnded = stopCall([
        "session.tool.success",
        "session.tool.failed",
      ]);
      const typed = forSession(events(readLog(dir)), child).filter(
        (e) => e.at >= stopAt,
      );
      const childInterrupted = typed.find(
        (e) => e.type === "session.execution.interrupted",
      );
      const userEnqueued = typed.find(
        (e) => e.type === "session.inbox.enqueued" && e.itemType === "user",
      );
      const contStarted = typed.find(
        (e) =>
          e.type === "session.execution.started" &&
          userEnqueued !== undefined &&
          e.at >= userEnqueued.at,
      );
      const contRequests = readLlm(dir).filter(
        (r) => r.sessionID === child && r.at >= stopAt,
      );
      // The probe's prompt hook runs next to the plugin's, which lifts the latch.
      const promptHook = readLog(dir).find(
        (r) =>
          r.kind === "prompt-hook" && r.sessionID === child && r.at >= stopAt,
      );
      const plugin = pluginConsole(artifacts);
      const since = (at: number | undefined) =>
        at === undefined || stopCalled === undefined
          ? null
          : at - stopCalled.at;

      const evidence = {
        dir,
        parent,
        child,
        stopText,
        timingsFromStopCall: {
          firstShellSawInterrupt: since(userTimes?.interruptedAt),
          promptHookRan: since(promptHook?.at),
          stoppedRunEnded: since(childInterrupted?.at),
          stopToolEnded: since(stopEnded?.at),
          userPromptEnqueued: since(userEnqueued?.at),
          continuationStarted: since(contStarted?.at),
          continuationHeld: since(workHeldAt),
          stopResultRead: since(stopResultAt),
          continuationReleased: since(releaseAt),
          continuationEnded: since(contEnd.at),
        },
        childEvents: typed.map((e) => ({
          t: e.at - stopAt,
          type: e.type,
          itemType: e.itemType,
          reason: e.reason,
        })),
        continuationRequests: contRequests.map((r) => ({
          t: r.at - stopAt,
          last: r.last.text.slice(0, 200),
        })),
        plugin,
      };

      const checks = {
        userPromptSent: userTimes !== undefined,
        allHoldsInterrupted: holdResults.every(Option.isSome),
        promptHookRanDuringStop:
          promptHook !== undefined &&
          userTimes !== undefined &&
          stopEnded !== undefined &&
          userTimes.interruptedAt <= promptHook.at &&
          promptHook.at < stopEnded.at,
        resultContinued: stopText.includes(
          `- ${child} (general, "continued child"): given new work while the stop ran, so it was left running`,
        ),
        continuationNotInterrupted: !workInterruptedEarly,
        interruptedOnlyOnce:
          typed.filter((e) => e.type === "session.execution.interrupted")
            .length === 1,
        continuationCompleted:
          JSON.stringify(context).includes(ANSWER) &&
          contRequests.some((r) => r.last.text.includes("USER-CONT")),
        noLatchInterruptOfChild: !plugin.some(
          (line) =>
            line.includes("latch: interrupted a run") && line.includes(child),
        ),
        probeNeverEnforced: readLog(dir).every((r) => r.kind !== "enforce"),
      };

      yield* finishScenario(dir, "stop-continue-during-stop", evidence, checks);
    }),
);
