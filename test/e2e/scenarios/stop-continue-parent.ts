// The parent continues a stopped subagent with `subagent` and its sessionID. The continuation lifts
// the latch, its prompt starts with the stop note, the child runs with its tools, and the parent's
// completed notice carries exactly the child's answer to the continuation, with no turn after it.
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
  events,
  finishScenario,
  forSession,
  instanceFor,
  LIST_SUBTREE_CODE,
  listedLatches,
  notices,
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

const dir = runDir("stop-continue-parent");
const REASON = "heading the wrong way";
const ANSWER = "CONT-ANSWER-7: the second part is done";

if (!existsSync(join(REPO_ROOT, "dist", "index.js")))
  throw new Error("dist/index.js is missing; run `bun run build` first");

/** The output inside a completed notice's `<subagent>` element. */
const completedOutput = (text: unknown) =>
  typeof text === "string"
    ? /^<subagent [^>]*state="completed"[^>]*>\n([\s\S]*)\n<\/subagent>$/.exec(
        text,
      )?.[1]
    : undefined;

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
            if (last.toolCallID === "p_list")
              return Stream.make(Llm.text("LISTED"));
          }
          if (last.text.includes("CMD-STOP"))
            return toolCallResponse("p_stop", "subagent_stop", {
              sessionIDs: [child],
              reason: REASON,
            });
          if (last.text.includes("CMD-CONTINUE"))
            return toolCallResponse("p_cont", "subagent", {
              agent: "general",
              description: "parent child",
              sessionID: child,
              prompt: "CONT-TASK do the second part instead",
              background: true,
            });
          if (last.text.includes("CMD-LIST"))
            return toolCallResponse("p_list", "execute", {
              code: LIST_SUBTREE_CODE,
            });
          if (last.text.includes("<subagent"))
            return Stream.make(Llm.text("PARENT-NOTED"));
          if (last.text.includes("ROLE<parent>"))
            return toolCallResponse("p_sub", "subagent", {
              agent: "general",
              description: "parent child",
              prompt: "ROLE<child> CHILD-TASK",
              background: true,
            });
          return Stream.make(Llm.text("parent-other"));
        }
        if (req.role === "child") {
          if (last.role === "tool" && last.toolCallID === "c_cont_tool")
            return Stream.make(Llm.text(ANSWER));
          if (last.role === "user" && last.text.includes("CONT-TASK"))
            return toolCallResponse("c_cont_tool", "shell", {
              command: "second-part",
              description: "second part",
            });
          if (last.role === "user" && last.text.includes("CHILD-TASK"))
            return toolCallResponse("c_hold", "shell", {
              command: "hold",
              description: "hold",
            });
          return Stream.make(Llm.pause(1500), Llm.text("UNEXPECTED-TURN"));
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

      // A background child that holds a shell, stopped through subagent_stop.
      const parent = (yield* ctl<{ id: string }>("create", { title: "parent" }))
        .id;
      const launchAt = Date.now();
      yield* ctl("prompt", { sessionID: parent, text: "ROLE<parent> launch" });
      child = yield* Effect.promise(() =>
        until("child", () => childOf(dir, parent)),
      );
      const hold = yield* takeCall(shells, "c_hold");
      yield* hold.progress("holding\n");
      yield* wait(parent, "session.execution.succeeded", launchAt);

      const stopAt = Date.now();
      yield* ctl("prompt", { sessionID: parent, text: "CMD-STOP" });
      const holdInterrupted = yield* hold
        .awaitInterrupted()
        .pipe(Effect.as(true), Effect.timeoutOption(15_000));
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
      yield* Effect.sleep(1500);

      // The parent continues the stopped child in the background.
      const contAt = Date.now();
      yield* ctl("prompt", { sessionID: parent, text: "CMD-CONTINUE" });
      const work = yield* takeCall(shells, "c_cont_tool");
      yield* work.succeed({ output: "second part done\n", exit: 0 });
      const childEnd = yield* wait(
        child,
        "session.execution.succeeded",
        contAt,
      );
      const completed = yield* Effect.promise(() =>
        until("completed notice", () =>
          notices(dir, parent).find(
            (n) =>
              n.at >= contAt &&
              JSON.stringify(n.metadata).includes('"completed"'),
          ),
        ),
      );
      yield* Effect.sleep(2500);
      const childContext = yield* ctl<ReadonlyArray<unknown>>("context", {
        sessionID: child,
      });

      const listAt = Date.now();
      yield* ctl("prompt", { sessionID: parent, text: "CMD-LIST" });
      const listText = yield* Effect.promise(() =>
        until("list result", () => capturedToolResult(dir, "p_list"), 30_000),
      );
      yield* wait(parent, "session.execution.succeeded", listAt);

      const llmLog = readLlm(dir);
      const contRequests = llmLog.filter(
        (r) => r.sessionID === child && r.at >= contAt && r.at < listAt,
      );
      const firstCont = contRequests[0];
      const childTyped = forSession(events(readLog(dir)), child).filter(
        (e) => e.at >= contAt && e.at < listAt,
      );
      const childAll = forSession(events(readLog(dir), "all"), child);
      const noticesAfterCont = notices(dir, parent).filter(
        (n) => n.at >= contAt,
      );
      const parentSawNotice = llmLog.find(
        (r) =>
          r.sessionID === parent &&
          r.at >= contAt &&
          r.last.text.includes('state="completed"'),
      );
      const latches = listedLatches(codeModeValue(listText));
      const persistedUser = JSON.stringify(childContext).includes(
        `>${REASON}</stopped-by-parent>\\n\\nCONT-TASK`,
      );

      const evidence = {
        dir,
        parent,
        child,
        stopText,
        continuation: {
          runMs: childEnd.at - contAt,
          childEvents: childTyped.map((e) => ({
            t: e.at - contAt,
            type: e.type,
            itemType: e.itemType,
            reason: e.reason,
          })),
          requests: contRequests.map((r) => ({
            t: r.at - contAt,
            last: r.last.text.slice(0, 200),
            tools: r.tools,
          })),
          completedNotice: completed.text,
          noticesAfterContinue: noticesAfterCont.map((n) => n.metadata),
          parentSawNotice: parentSawNotice?.last.text.slice(0, 300),
        },
        latch: latches.get(child),
        plugin: pluginConsole(artifacts),
      };

      const checks = {
        shellObservedInterrupt: Option.isSome(holdInterrupted),
        stopResultStopped:
          stopText.includes(`- ${child}`) && /: stopped$/m.test(stopText),
        promptStartsWithNote:
          firstCont !== undefined &&
          firstCont.last.text.startsWith('<stopped-by-parent at="') &&
          firstCont.last.text.includes(
            `>${REASON}</stopped-by-parent>\n\nCONT-TASK`,
          ),
        notePersisted: persistedUser,
        childHadTools: firstCont?.tools.includes("shell") === true,
        toolRan: childAll.some(
          (e) =>
            e.type === "session.tool.success" &&
            typeof e.data === "string" &&
            e.data.includes('"id":"c_cont_tool"'),
        ),
        oneRunNoInterrupt:
          childTyped.filter((e) => e.type === "session.execution.started")
            .length === 1 &&
          !childTyped.some((e) => e.type === "session.execution.interrupted"),
        noTurnAfterAnswer: contRequests.length === 2,
        completedCarriesAnswer: completedOutput(completed.text) === ANSWER,
        oneNoticeAfterContinue:
          noticesAfterCont.length === 1 &&
          !JSON.stringify(noticesAfterCont).includes('"cancelled"'),
        parentModelGotNotice:
          parentSawNotice?.last.text.includes(`\n${ANSWER}\n</subagent>`) ===
          true,
        answerPersisted: JSON.stringify(childContext).includes(ANSWER),
        latchLifted: latches.get(child) === "lifted",
        probeNeverEnforced: readLog(dir).every((r) => r.kind !== "enforce"),
      };

      yield* finishScenario(dir, "stop-continue-parent", evidence, checks);
    }),
);
