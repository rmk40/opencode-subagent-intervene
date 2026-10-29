// A person prompts a stopped subagent directly through the SDK. The prompt lifts the latch, carries
// the stop note, and runs normally: the child calls a tool, answers, and is never interrupted.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { Effect, Option, Stream } from "effect";
import { Llm, type OpenCode, OpenCodeDriver } from "opencode-drive";
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

const dir = runDir("stop-continue-user");
const REASON = "wrong file";
const ANSWER = "USER-ANSWER-8";

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
            if (last.toolCallID === "p_list")
              return Stream.make(Llm.text("LISTED"));
          }
          if (last.text.includes("CMD-STOP"))
            return toolCallResponse("p_stop", "subagent_stop", {
              sessionIDs: [child],
              reason: REASON,
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
              description: "user child",
              prompt: "ROLE<child> CHILD-TASK",
              background: true,
            });
          return Stream.make(Llm.text("parent-other"));
        }
        if (req.role === "child") {
          if (last.role === "tool" && last.toolCallID === "c_user_tool")
            return Stream.make(Llm.text(ANSWER));
          if (last.role === "user" && last.text.includes("USER-DIRECT"))
            return toolCallResponse("c_user_tool", "shell", {
              command: "user-work",
              description: "user work",
            });
          if (last.role === "user" && last.text.includes("CHILD-TASK"))
            return toolCallResponse("c_hold", "shell", {
              command: "hold",
              description: "hold",
            });
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
      yield* wait(parent, "session.execution.succeeded", stopAt);
      yield* Effect.promise(() =>
        until("cancelled notice", () =>
          notices(dir, parent).find((n) =>
            JSON.stringify(n.metadata).includes('"cancelled"'),
          ),
        ),
      );
      yield* Effect.sleep(1500);
      const noticesBeforeUser = notices(dir, parent).length;

      // The person's prompt, sent to the stopped child through the SDK.
      const userAt = Date.now();
      yield* opencode.session
        .prompt({
          sessionID: child as PromptInput["sessionID"],
          text: "USER-DIRECT please finish the task",
        })
        .pipe(Effect.orDie);
      const work = yield* takeCall(shells, "c_user_tool");
      yield* work.succeed({ output: "user work done\n", exit: 0 });
      const userEnd = yield* wait(child, "session.execution.succeeded", userAt);
      yield* Effect.sleep(2000);
      const childContext = yield* ctl<ReadonlyArray<unknown>>("context", {
        sessionID: child,
      });

      // The plugin's own view of the latch, through Code Mode.
      const listAt = Date.now();
      yield* ctl("prompt", { sessionID: parent, text: "CMD-LIST" });
      const listText = yield* Effect.promise(() =>
        until("list result", () => capturedToolResult(dir, "p_list"), 30_000),
      );
      yield* wait(parent, "session.execution.succeeded", listAt);

      const llmLog = readLlm(dir);
      const userRequests = llmLog.filter(
        (r) => r.sessionID === child && r.at >= userAt && r.at < listAt,
      );
      const firstUserRequest = userRequests[0];
      const childTyped = forSession(events(readLog(dir)), child);
      const childAll = forSession(events(readLog(dir), "all"), child);
      const afterUser = childTyped.filter(
        (e) => e.at >= userAt && e.at < listAt,
      );
      const latches = listedLatches(codeModeValue(listText));
      const notePrefix = '<stopped-by-parent at="';

      const evidence = {
        dir,
        parent,
        child,
        stopText,
        userRunMs: userEnd.at - userAt,
        childEventsAfterUser: afterUser.map((e) => ({
          t: e.at - userAt,
          type: e.type,
          itemType: e.itemType,
          reason: e.reason,
        })),
        userRequests: userRequests.map((r) => ({
          t: r.at - userAt,
          last: r.last.text.slice(0, 200),
          tools: r.tools,
        })),
        latch: latches.get(child),
        parentNotices: notices(dir, parent).map((n) => n.metadata),
        plugin: pluginConsole(artifacts),
      };

      const checks = {
        shellObservedInterrupt: Option.isSome(holdInterrupted),
        stopResultStopped:
          stopText.includes(`- ${child}`) && /: stopped$/m.test(stopText),
        promptStartsWithNote:
          firstUserRequest !== undefined &&
          firstUserRequest.last.text.startsWith(notePrefix) &&
          firstUserRequest.last.text.includes(
            `>${REASON}</stopped-by-parent>`,
          ) &&
          firstUserRequest.last.text.includes("USER-DIRECT"),
        childHadTools: firstUserRequest?.tools.includes("shell") === true,
        toolRan: childAll.some(
          (e) =>
            e.type === "session.tool.success" &&
            typeof e.data === "string" &&
            e.data.includes('"id":"c_user_tool"'),
        ),
        runStartedOnce:
          afterUser.filter((e) => e.type === "session.execution.started")
            .length === 1,
        neverInterrupted: !afterUser.some(
          (e) => e.type === "session.execution.interrupted",
        ),
        answerPersisted: JSON.stringify(childContext).includes(ANSWER),
        latchLifted: latches.get(child) === "lifted",
        noNoticeFromUserRun: notices(dir, parent).length === noticesBeforeUser,
        probeNeverEnforced: readLog(dir).every((r) => r.kind !== "enforce"),
      };

      yield* finishScenario(dir, "stop-continue-user", evidence, checks);
    }),
);
