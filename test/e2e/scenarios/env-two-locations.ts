// Two locations. The plugin comes from global config (Drive's OPENCODE_CONFIG_DIR), so every
// location loads its own instance. The parent stays in the project directory and moves its child to
// a second directory with `opencode.session_move`. The parent stops the child there; the stop runs
// in the parent's instance. The parent's location is then evicted, so only the child's instance is
// loaded when a notice wakes the child, and that instance interrupts the run. Continuing the child
// afterwards runs its prompt hook in the child's location, which lifts the latch and prepends the
// stop note.
import { existsSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
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
  type Instance,
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
  toolCallResponse,
  until,
  waitEvent,
  waitIdle,
} from "../harness";

const dir = runDir("env-two-locations");
const REASON = "moved child stop";
const CONT_PROMPT = "CONT-TASK answer from the second location";

if (!existsSync(join(REPO_ROOT, "dist", "index.js")))
  throw new Error("dist/index.js is missing; run `bun run build` first");

const ENFORCED = "latch: interrupted a run in a stopped session";

export default OpenCodeDriver.use(
  {
    tools: ["shell"],
    // Drive's default blanket allow stays, so moving a session never waits on a prompt.
    config: {
      plugins: [probePlugin(dir), { package: REPO_ROOT, options: {} }],
    },
  },
  ({ llm, tools, directory, artifacts, opencode }) =>
    Effect.gen(function* () {
      const shells = yield* tools.control("shell");
      const locationB = resolve(directory, "..", "location-b");
      mkdirSync(locationB, { recursive: true });
      let child = "";

      yield* llm.serve((request, index) => {
        const req = recordRequest(dir, request.body, index);
        captureToolResults(dir, request.body);
        const { last } = req;
        if (req.role === "parent") {
          if (last.role === "tool") {
            switch (last.toolCallID) {
              case "p_sub":
                return Stream.make(Llm.text("Launched."));
              case "p_move":
                return Stream.make(Llm.text("MOVED"));
              case "p_work":
                return Stream.make(Llm.text("WORKING"));
              case "p_stop":
                return Stream.make(Llm.text("STOP-DONE"));
              case "p_cont":
                return toolCallResponse("p_list", "execute", {
                  code: LIST_SUBTREE_CODE,
                });
              case "p_list":
                return Stream.make(Llm.text("LISTED"));
            }
          }
          if (last.text.includes("CMD-MOVE"))
            return toolCallResponse("p_move", "execute", {
              code: `return JSON.stringify(await tools.opencode.session_move({ sessionID: ${JSON.stringify(child)}, directory: ${JSON.stringify(locationB)} }));`,
            });
          if (last.text.includes("CMD-WORK"))
            return toolCallResponse("p_work", "subagent", {
              agent: "general",
              description: "moved child",
              sessionID: child,
              prompt: "WORK-TASK hold a shell",
              background: true,
            });
          if (last.text.includes("CMD-STOP"))
            return toolCallResponse("p_stop", "subagent_stop", {
              sessionIDs: [child],
              reason: REASON,
            });
          if (last.text.includes("CMD-CONTINUE"))
            return toolCallResponse("p_cont", "subagent", {
              agent: "general",
              description: "moved child",
              sessionID: child,
              prompt: CONT_PROMPT,
            });
          if (last.text.includes("<subagent"))
            return Stream.make(Llm.text("PARENT-NOTED"));
          if (last.text.includes("ROLE<parent>"))
            return toolCallResponse("p_sub", "subagent", {
              agent: "general",
              description: "moved child",
              prompt: "ROLE<child> CHILD-TASK",
              background: true,
            });
          return Stream.make(Llm.text("parent-other"));
        }
        if (req.role === "child") {
          if (last.role === "user" && last.text.includes("CONT-TASK"))
            return Stream.make(Llm.text("CONT-ANSWER"));
          if (last.role === "user" && last.text.includes("WORK-TASK"))
            return toolCallResponse("c_hold", "shell", {
              command: "hold",
              description: "hold",
            });
          if (last.role === "user" && last.text.includes("CHILD-TASK"))
            return Stream.make(Llm.text("CHILD-FIRST-DONE"));
          // A woken run answers slowly, so a reply can only be persisted if the latch misses it.
          return Stream.make(Llm.pause(1500), Llm.text("WOKEN-REPLY"));
        }
        return Stream.make(Llm.text("other"));
      });

      const a = yield* Effect.promise(() => instanceFor(dir, directory));
      const ctl = <T = unknown>(
        instance: Instance,
        op: string,
        args: Record<string, unknown> = {},
      ) => Effect.promise(() => call<T>(instance, op, args));
      const wait = (sessionID: string, type: string, since: number) =>
        Effect.promise(() =>
          waitEvent(dir, sessionID, type, { since, timeoutMs: 20_000 }),
        );
      const toolText = (id: string) =>
        Effect.promise(() =>
          until(`${id} result`, () => capturedToolResult(dir, id), 30_000),
        );

      // The parent launches a child, which answers and goes idle.
      const parent = (yield* ctl<{ id: string }>(a, "create", {
        title: "parent",
      })).id;
      yield* ctl(a, "prompt", {
        sessionID: parent,
        text: "ROLE<parent> launch",
      });
      child = yield* Effect.promise(() =>
        until("child", () => childOf(dir, parent)),
      );
      yield* Effect.promise(() =>
        until("completed notice", () =>
          notices(dir, parent).find((n) =>
            JSON.stringify(n.metadata).includes('"completed"'),
          ),
        ),
      );
      yield* Effect.sleep(300);
      yield* Effect.promise(() => waitIdle(a, parent));

      // The parent moves the child to the second location.
      const moveAt = Date.now();
      yield* ctl(a, "prompt", { sessionID: parent, text: "CMD-MOVE" });
      const moveText = yield* toolText("p_move");
      const moved = yield* Effect.promise(() =>
        until("child moved", async () => {
          const info = await call<{ location: { directory: string } }>(
            a,
            "get",
            { sessionID: child },
          );
          return info.location.directory !== directory ? info : undefined;
        }),
      );
      const b = yield* Effect.promise(() =>
        instanceFor(dir, moved.location.directory),
      );
      yield* Effect.promise(() => waitIdle(b, child));
      yield* Effect.promise(() => waitIdle(a, parent));

      // The child works in its new location, holding a shell, and the parent stops it.
      yield* ctl(a, "prompt", { sessionID: parent, text: "CMD-WORK" });
      const hold = yield* shells.take("c_hold");
      yield* hold.progress("holding\n");
      yield* Effect.promise(() => waitIdle(a, parent));

      const stopAt = Date.now();
      yield* ctl(a, "prompt", { sessionID: parent, text: "CMD-STOP" });
      const shellInterrupted = yield* hold
        .awaitInterrupted()
        .pipe(Effect.as(true), Effect.timeoutOption(15_000));
      const stopText = yield* toolText("p_stop");
      yield* Effect.promise(() =>
        until("cancelled notice", () =>
          notices(dir, parent).find(
            (n) =>
              n.at >= stopAt &&
              JSON.stringify(n.metadata).includes('"cancelled"'),
          ),
        ),
      );
      yield* Effect.sleep(500);
      yield* Effect.promise(() => waitIdle(a, parent));
      const enforcedBeforeWake = pluginConsole(artifacts).filter((line) =>
        line.includes(ENFORCED),
      ).length;

      // Unload the parent's location, so only the child's instance is loaded at the wake.
      const evictAt = Date.now();
      yield* opencode.debug.location
        .evict({ location: { directory } })
        .pipe(Effect.orDie);
      yield* Effect.promise(() =>
        until("parent location unloaded", () =>
          readLog(dir).find(
            (r) => r.kind === "cleanup" && r.instance === a.instance,
          ),
        ),
      );

      const wakeAt = Date.now();
      yield* ctl(b, "synthetic", {
        sessionID: child,
        text: "<two-location-notice>WAKE</two-location-notice>",
      });
      const wokenStart = yield* wait(
        child,
        "session.execution.started",
        wakeAt,
      );
      const wokenEnd = yield* Effect.promise(() =>
        until("woken run settled", () =>
          forSession(events(readLog(dir)), child).find(
            (e) =>
              e.at >= wokenStart.at &&
              (e.type === "session.execution.succeeded" ||
                e.type === "session.execution.interrupted" ||
                e.type === "session.execution.failed"),
          ),
        ),
      );
      yield* Effect.sleep(2500);
      const wakeCheckedAt = Date.now();
      const parentLocationLoadsDuringWake = readLog(dir).filter(
        (r) =>
          r.kind === "ready" &&
          r.location === directory &&
          r.at >= evictAt &&
          r.at < wakeCheckedAt,
      ).length;
      const enforcedAfterWake = pluginConsole(artifacts).filter((line) =>
        line.includes(ENFORCED),
      );
      const contextAfterWake = yield* ctl<ReadonlyArray<unknown>>(
        b,
        "context",
        {
          sessionID: child,
        },
      );

      // The parent continues the child; its prompt hook runs in the child's location.
      const contAt = Date.now();
      yield* ctl(b, "prompt", { sessionID: parent, text: "CMD-CONTINUE" });
      const contText = yield* toolText("p_cont");
      const listText = yield* toolText("p_list");
      const continuation = yield* Effect.promise(() =>
        until("child continuation request", () => {
          const record = readLog(dir).find(
            (r) =>
              r.kind === "prompt-hook" &&
              r.sessionID === child &&
              r.at >= contAt,
          );
          const request = readLlm(dir).find(
            (r) =>
              r.sessionID === child &&
              r.at >= contAt &&
              r.last.text.includes("CONT-TASK"),
          );
          return record !== undefined && request !== undefined
            ? { record, request }
            : undefined;
        }),
      );
      yield* wait(parent, "session.execution.succeeded", contAt);

      const log = readLog(dir);
      const contRequest = readLlm(dir).find(
        (r) => r.sessionID === child && r.at >= contAt,
      );
      const noteMatch =
        /^<stopped-by-parent at="[^"]+">([\s\S]*?)<\/stopped-by-parent>\n\n/.exec(
          continuation.request.last.text,
        );
      const childHookLocations = log
        .filter(
          (r) =>
            (r.kind === "prompt-hook" || r.kind === "context-hook") &&
            r.sessionID === child &&
            r.at >= moveAt,
        )
        .map((r) => ({ kind: r.kind, location: r.location, t: r.at - moveAt }));
      const wokenText = JSON.stringify(contextAfterWake);

      const evidence = {
        dir,
        parent,
        child,
        locationA: directory,
        locationB: moved.location.directory,
        moveText,
        stopText,
        wake: {
          startedAfterMs: wokenStart.at - wakeAt,
          endedAfterStartMs: wokenEnd.at - wokenStart.at,
          end: wokenEnd.type,
          reason: wokenEnd.reason,
          observedBy: wokenStart.instance,
          enforcedBeforeWake,
          enforcedAfterWake,
          parentLocationLoadsDuringWake,
        },
        continuation: {
          prompt: continuation.request.last.text,
          hookLocation: continuation.record.location,
          result: contText.slice(0, 300),
          firstRequestAt: contRequest?.at,
        },
        latches: Object.fromEntries(listedLatches(codeModeValue(listText))),
        childHookLocations,
      };

      const checks = {
        movedToSecondLocation:
          resolve(moved.location.directory) === locationB &&
          b.location === moved.location.directory,
        workRanInSecondLocation: childHookLocations.some(
          (h) => h.kind === "context-hook" && h.location === locationB,
        ),
        shellObservedInterrupt: Option.isSome(shellInterrupted),
        stopResultStopped:
          stopText.includes(`- ${child}`) && /: stopped$/m.test(stopText),
        parentLocationUnloaded: parentLocationLoadsDuringWake === 0,
        wakeSeenOnlyByChildInstance: wokenStart.instance === b.instance,
        wakeInterrupted:
          wokenEnd.type === "session.execution.interrupted" &&
          wokenEnd.at - wokenStart.at < 1000,
        childInstanceEnforced:
          enforcedBeforeWake === 0 &&
          enforcedAfterWake.length === 1 &&
          enforcedAfterWake[0]?.includes("interrupted: true") === true,
        noWokenReply: !wokenText.includes("WOKEN-REPLY"),
        promptHookInChildLocation: continuation.record.location === locationB,
        noteDelivered:
          noteMatch?.[1] === REASON &&
          continuation.request.last.text.endsWith(CONT_PROMPT),
        continuationAnswered: contText.includes("CONT-ANSWER"),
        latchLifted:
          listedLatches(codeModeValue(listText)).get(child) === "lifted",
        probeNeverEnforced: log.every((r) => r.kind !== "enforce"),
      };

      yield* finishScenario(dir, "env-two-locations", evidence, checks);
    }),
);
