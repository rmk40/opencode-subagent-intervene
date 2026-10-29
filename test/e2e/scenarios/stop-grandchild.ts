// With `experimental.subagent_depth: 2`, a background child launches a background grandchild,
// and both hold shells. subagent_stop on the child stops both, deepest first. The grandchild waits
// on sixty shells at once, so its stopped run winds down after the child's, and its cancelled
// notice wakes the already stopped child. The child stays stopped: the run the notice starts is
// interrupted at once, nothing is persisted, and the parent hears only about the child.
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
  readLog,
  recordRequest,
  runDir,
  takeCall,
  toolCallResponse,
  until,
  waitEvent,
} from "../harness";

const dir = runDir("stop-grandchild");
const REASON = "the whole branch is wrong";
/** Shells the grandchild waits on; each one adds to its stopped run's cleanup. */
const GC_HOLDS = Array.from({ length: 60 }, (_, i) => `g_hold_${i}`);

if (!existsSync(join(REPO_ROOT, "dist", "index.js")))
  throw new Error("dist/index.js is missing; run `bun run build` first");

export default OpenCodeDriver.use(
  {
    tools: ["shell"],
    config: {
      experimental: { subagent_depth: 2 },
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
              description: "child",
              prompt: "ROLE<child> CHILD-TASK",
              background: true,
            });
          return Stream.make(Llm.text("parent-other"));
        }
        if (req.role === "child") {
          if (last.role === "tool" && last.toolCallID === "c_sub")
            return toolCallResponse("c_hold", "shell", {
              command: "hold",
              description: "hold",
            });
          if (last.role === "user" && last.text.includes("CHILD-TASK"))
            return toolCallResponse("c_sub", "subagent", {
              agent: "general",
              description: "grandchild",
              prompt: "ROLE<grandchild> GC-TASK",
              background: true,
            });
          // A woken run answers slowly, so a reply can only be persisted if the latch misses it.
          return Stream.make(Llm.pause(1500), Llm.text("CHILD-WOKEN-REPLY"));
        }
        if (req.role === "grandchild") {
          if (last.role === "user" && last.text.includes("GC-TASK"))
            return Stream.make(
              ...GC_HOLDS.map((id, i) =>
                Llm.toolCall({
                  index: i,
                  id,
                  name: "shell",
                  input: { command: `hold ${i}`, description: `hold ${i}` },
                }),
              ),
              Llm.finish("tool-calls"),
            );
          return Stream.make(Llm.pause(1500), Llm.text("GC-WOKEN-REPLY"));
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

      // A background child and its background grandchild, each holding a shell.
      const parent = (yield* ctl<{ id: string }>("create", { title: "parent" }))
        .id;
      const launchAt = Date.now();
      yield* ctl("prompt", { sessionID: parent, text: "ROLE<parent> launch" });
      child = yield* Effect.promise(() =>
        until("child", () => childOf(dir, parent)),
      );
      const grandchild = yield* Effect.promise(() =>
        until("grandchild", () => childOf(dir, child)),
      );
      const childHold = yield* takeCall(shells, "c_hold");
      const gcHolds = yield* Effect.all(
        GC_HOLDS.map((id) => takeCall(shells, id)),
      );
      yield* childHold.progress("holding\n");
      for (const hold of gcHolds) yield* hold.progress("holding\n");
      yield* wait(parent, "session.execution.succeeded", launchAt);
      yield* Effect.sleep(500);

      const stopAt = Date.now();
      yield* ctl("prompt", { sessionID: parent, text: "CMD-STOP" });
      const gcInterrupted = yield* Effect.all(
        gcHolds.map((hold) => hold.awaitInterrupted()),
      ).pipe(Effect.as(Date.now()), Effect.timeoutOption(15_000));
      const childInterrupted = yield* childHold
        .awaitInterrupted()
        .pipe(Effect.as(Date.now()), Effect.timeoutOption(15_000));
      const stopText = yield* Effect.promise(() =>
        until("stop result", () => capturedToolResult(dir, "p_stop"), 30_000),
      );
      const gcNotice = yield* Effect.promise(() =>
        until("grandchild's notice to the child", () =>
          notices(dir, child).find(
            (n) =>
              n.at >= stopAt &&
              JSON.stringify(n.metadata).includes(grandchild) &&
              JSON.stringify(n.metadata).includes('"cancelled"'),
          ),
        ),
      );
      yield* Effect.sleep(3000);
      const childInfo = yield* ctl<Record<string, unknown>>("get", {
        sessionID: child,
      });
      const gcInfo = yield* ctl<Record<string, unknown>>("get", {
        sessionID: grandchild,
      });
      const childIdle = yield* ctl<{ outcome: string }>("wait", {
        sessionID: child,
        timeoutMs: 300,
      });
      const childContext = yield* ctl<ReadonlyArray<unknown>>("context", {
        sessionID: child,
      });

      const listAt = Date.now();
      yield* ctl("prompt", { sessionID: parent, text: "CMD-LIST" });
      const listText = yield* Effect.promise(() =>
        until("list result", () => capturedToolResult(dir, "p_list"), 30_000),
      );
      yield* wait(parent, "session.execution.succeeded", listAt);

      const typed = events(readLog(dir));
      const childTyped = forSession(typed, child).filter(
        (e) => e.at >= stopAt && e.at < listAt,
      );
      const childStoppedAt = childTyped.find(
        (e) => e.type === "session.execution.interrupted",
      )?.at;
      const runsAfterNotice = childTyped.filter(
        (e) => e.type === "session.execution.started" && e.at >= gcNotice.at,
      );
      const stopsAfterNotice = childTyped.filter(
        (e) =>
          e.type === "session.execution.interrupted" && e.at >= gcNotice.at,
      );
      const stepsEnded = events(readLog(dir), "all").filter(
        (e) =>
          (e.sessionID === child || e.sessionID === grandchild) &&
          e.type === "session.step.ended" &&
          e.at >= stopAt,
      );
      const lineFor = (id: string) =>
        stopText.split("\n").find((line) => line.startsWith(`- ${id}`));
      const parentNotices = notices(dir, parent).filter((n) => n.at >= stopAt);
      const latches = listedLatches(codeModeValue(listText));
      const plugin = pluginConsole(artifacts);

      const evidence = {
        dir,
        parent,
        child,
        grandchild,
        stopText,
        shellsInterruptedAfterStopMs: {
          grandchild: Option.getOrNull(
            Option.map(gcInterrupted, (at) => at - stopAt),
          ),
          child: Option.getOrNull(
            Option.map(childInterrupted, (at) => at - stopAt),
          ),
        },
        outcomes: { child: childInfo.outcome, grandchild: gcInfo.outcome },
        grandchildNotice: {
          t: gcNotice.at - stopAt,
          metadata: gcNotice.metadata,
          afterChildStoppedMs:
            childStoppedAt === undefined ? null : gcNotice.at - childStoppedAt,
        },
        childEventsAfterStop: childTyped.map((e) => ({
          t: e.at - stopAt,
          type: e.type,
          itemType: e.itemType,
          reason: e.reason,
        })),
        parentNoticesAfterStop: parentNotices.map((n) => n.metadata),
        latches: {
          child: latches.get(child),
          grandchild: latches.get(grandchild),
        },
        plugin,
      };

      const checks = {
        grandchildShellInterrupted: Option.isSome(gcInterrupted),
        childShellInterrupted: Option.isSome(childInterrupted),
        grandchildStopped:
          lineFor(grandchild)?.endsWith(`, launched by ${child}: stopped`) ===
          true,
        childStopped: lineFor(child)?.endsWith(": stopped") === true,
        bothInterrupted:
          childInfo.outcome === "interrupted" &&
          gcInfo.outcome === "interrupted",
        noticeAfterChildStopped:
          childStoppedAt !== undefined && gcNotice.at >= childStoppedAt,
        noticeWokeChild: runsAfterNotice.length > 0,
        noticeRunsInterrupted: runsAfterNotice.every((start) =>
          stopsAfterNotice.some(
            (stop) => stop.at >= start.at && stop.at - start.at < 500,
          ),
        ),
        childIdleAtEnd: childIdle.outcome === "resolved",
        noStepCompleted: stepsEnded.length === 0,
        noWokenReply:
          !JSON.stringify(childContext).includes("CHILD-WOKEN-REPLY"),
        parentHeardOnlyChild:
          parentNotices.length === 1 &&
          JSON.stringify(parentNotices[0]?.metadata).includes(child) &&
          JSON.stringify(parentNotices[0]?.metadata).includes('"cancelled"'),
        bothLatched:
          latches.get(child) === "active" &&
          latches.get(grandchild) === "active",
        probeNeverEnforced: readLog(dir).every((r) => r.kind !== "enforce"),
      };

      yield* finishScenario(dir, "stop-grandchild", evidence, checks);
    }),
);
