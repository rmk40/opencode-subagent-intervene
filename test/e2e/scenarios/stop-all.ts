// subagent_stop with `all: true` (`experimental.subagent_depth: 2`). The parent has three
// background children: one busy in a shell, one idle whose background grandchild is busy in a
// shell, and one that finished. The stop covers the busy child, the idle child, and its
// grandchild, and leaves the finished child out. The parent keeps running and answers after the
// tool result, and the idle child stays stopped when its grandchild's cancelled notice arrives.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { Effect, Option, Stream } from "effect";
import { Llm, OpenCodeDriver } from "opencode-drive";
import {
  call,
  captureToolResults,
  capturedToolResult,
  codeModeValue,
  events,
  finishScenario,
  forSession,
  instanceFor,
  isBusy,
  LIST_SUBTREE_CODE,
  listedLatches,
  notices,
  pluginConsole,
  probePlugin,
  REPO_ROOT,
  readLlm,
  readLog,
  readToolResults,
  recordRequest,
  runDir,
  takeCall,
  toolCallResponse,
  until,
  waitEvent,
} from "../harness";

const dir = runDir("stop-all");
const REASON = "stop everything";
const CHILDREN = ["busy", "waiter", "done"] as const;

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

      yield* llm.serve((request, index) => {
        const req = recordRequest(dir, request.body, index);
        captureToolResults(dir, request.body);
        const { last } = req;
        if (req.role === "parent") {
          if (last.role === "tool") {
            if (last.toolCallID?.startsWith("p_sub_") === true)
              return Stream.make(Llm.text("Launched."));
            if (last.toolCallID === "p_stop_all")
              return Stream.make(Llm.text("STOP-ALL-DONE"));
            if (last.toolCallID === "p_list")
              return Stream.make(Llm.text("LISTED"));
          }
          if (last.text.includes("CMD-STOP-ALL"))
            return toolCallResponse("p_stop_all", "subagent_stop", {
              all: true,
              reason: REASON,
            });
          if (last.text.includes("CMD-LIST"))
            return toolCallResponse("p_list", "execute", {
              code: LIST_SUBTREE_CODE,
            });
          if (last.text.includes("<subagent"))
            return Stream.make(Llm.text("PARENT-NOTED"));
          if (last.text.includes("ROLE<parent>"))
            return Stream.make(
              ...CHILDREN.map((role, i) =>
                Llm.toolCall({
                  index: i,
                  id: `p_sub_${role}`,
                  name: "subagent",
                  input: {
                    agent: "general",
                    description: role,
                    prompt: `ROLE<${role}> CHILD-TASK`,
                    background: true,
                  },
                }),
              ),
              Llm.finish("tool-calls"),
            );
          return Stream.make(Llm.text("parent-other"));
        }
        if (req.role === "busy") {
          if (last.role === "user" && last.text.includes("CHILD-TASK"))
            return toolCallResponse("busy_hold", "shell", {
              command: "hold",
              description: "hold",
            });
          return Stream.make(Llm.pause(1500), Llm.text("BUSY-WOKEN-REPLY"));
        }
        if (req.role === "waiter") {
          if (last.role === "user" && last.text.includes("CHILD-TASK"))
            return toolCallResponse("w_sub", "subagent", {
              agent: "general",
              description: "grandchild",
              prompt: "ROLE<gc> GC-TASK",
              background: true,
            });
          if (last.role === "tool" && last.toolCallID === "w_sub")
            return Stream.make(Llm.text("WAITER-WAITING"));
          return Stream.make(Llm.pause(1500), Llm.text("WAITER-WOKEN-REPLY"));
        }
        if (req.role === "gc") {
          if (last.role === "user" && last.text.includes("GC-TASK"))
            return toolCallResponse("gc_hold", "shell", {
              command: "hold",
              description: "hold",
            });
          return Stream.make(Llm.pause(1500), Llm.text("GC-WOKEN-REPLY"));
        }
        if (req.role === "done") return Stream.make(Llm.text("DONE-ANSWER"));
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
      const busyNow = (sessionID: string) =>
        Effect.promise(() => isBusy(instance, sessionID, 150));
      const sessionOf = (role: string) =>
        readLlm(dir).find((r) => r.role === role)?.sessionID;

      const parent = (yield* ctl<{ id: string }>("create", { title: "parent" }))
        .id;
      yield* ctl("prompt", { sessionID: parent, text: "ROLE<parent> launch" });
      const busyHold = yield* takeCall(shells, "busy_hold");
      const gcHold = yield* takeCall(shells, "gc_hold");
      yield* busyHold.progress("holding\n");
      yield* gcHold.progress("holding\n");
      const [busy, waiter, done, gc] = yield* Effect.promise(() =>
        until("sessions", () => {
          const ids = [...CHILDREN, "gc"].map(sessionOf);
          return ids.every((id): id is string => id !== undefined)
            ? ids
            : undefined;
        }),
      );
      if (
        busy === undefined ||
        waiter === undefined ||
        done === undefined ||
        gc === undefined
      )
        return yield* Effect.die(new Error("missing sessions"));
      yield* Effect.promise(() =>
        until(
          "parent, waiter, and finished child at rest",
          async () => {
            const completed = notices(dir, parent).filter((n) =>
              JSON.stringify(n.metadata).includes('"completed"'),
            ).length;
            if (completed < 2) return undefined;
            for (const id of [parent, waiter, done])
              if (await isBusy(instance, id, 150)) return undefined;
            return true;
          },
          30_000,
        ),
      );
      yield* Effect.sleep(500);
      const busyBefore = yield* busyNow(busy);
      const gcBefore = yield* busyNow(gc);

      const stopAt = Date.now();
      yield* ctl("prompt", { sessionID: parent, text: "CMD-STOP-ALL" });
      const busyInterrupted = yield* busyHold
        .awaitInterrupted()
        .pipe(Effect.as(true), Effect.timeoutOption(15_000));
      const gcInterrupted = yield* gcHold
        .awaitInterrupted()
        .pipe(Effect.as(true), Effect.timeoutOption(15_000));
      const stopText = yield* Effect.promise(() =>
        until(
          "stop result",
          () => capturedToolResult(dir, "p_stop_all"),
          30_000,
        ),
      );
      const parentEnd = yield* wait(
        parent,
        "session.execution.succeeded",
        stopAt,
      );
      yield* Effect.sleep(3000);
      const waiterContext = yield* ctl<ReadonlyArray<unknown>>("context", {
        sessionID: waiter,
      });
      const waiterIdle = !(yield* busyNow(waiter));

      const listAt = Date.now();
      yield* ctl("prompt", { sessionID: parent, text: "CMD-LIST" });
      const listText = yield* Effect.promise(() =>
        until("list result", () => capturedToolResult(dir, "p_list"), 30_000),
      );
      yield* wait(parent, "session.execution.succeeded", listAt);

      const typed = events(readLog(dir)).filter(
        (e) => e.at >= stopAt && e.at < listAt,
      );
      const parentTyped = forSession(typed, parent);
      const waiterTyped = forSession(typed, waiter);
      const gcNotice = notices(dir, waiter).find(
        (n) =>
          n.at >= stopAt &&
          JSON.stringify(n.metadata).includes(gc) &&
          JSON.stringify(n.metadata).includes('"cancelled"'),
      );
      const waiterRuns = waiterTyped.filter(
        (e) => e.type === "session.execution.started",
      );
      const waiterStops = waiterTyped.filter(
        (e) => e.type === "session.execution.interrupted",
      );
      const stepsEnded = events(readLog(dir), "all").filter(
        (e) =>
          [busy, waiter, gc].includes(e.sessionID ?? "") &&
          e.type === "session.step.ended" &&
          e.at >= stopAt,
      );
      // Only the parent's history holds this call, so its result was captured from the parent's
      // next model request.
      const stopResultSeen = readToolResults(dir).find(
        (r) => r.id === "p_stop_all",
      );
      const lineFor = (id: string) =>
        stopText.split("\n").find((line) => line.startsWith(`- ${id}`));
      const latches = listedLatches(codeModeValue(listText));
      const parentNotices = notices(dir, parent).filter(
        (n) => n.at >= stopAt && n.at < listAt,
      );

      const evidence = {
        dir,
        parent,
        sessions: { busy, waiter, done, gc },
        before: { busyRunning: busyBefore, grandchildRunning: gcBefore },
        stopText,
        parentRun: {
          eventsAfterStop: parentTyped.map((e) => ({
            t: e.at - stopAt,
            type: e.type,
            itemType: e.itemType,
          })),
          endedAfterStopMs: parentEnd.at - stopAt,
        },
        waiterAfterStop: waiterTyped.map((e) => ({
          t: e.at - stopAt,
          type: e.type,
          itemType: e.itemType,
          reason: e.reason,
        })),
        grandchildNoticeToWaiter: gcNotice?.metadata,
        parentNoticesAfterStop: parentNotices.map((n) => n.metadata),
        latches: Object.fromEntries(
          [busy, waiter, done, gc].map((id) => [id, latches.get(id) ?? null]),
        ),
        plugin: pluginConsole(artifacts),
      };

      const checks = {
        setUp: busyBefore && gcBefore,
        busyShellInterrupted: Option.isSome(busyInterrupted),
        grandchildShellInterrupted: Option.isSome(gcInterrupted),
        busyStopped: lineFor(busy)?.endsWith(": stopped") === true,
        // Idle when the stop began; a run its grandchild's notice starts mid-stop is interrupted.
        waiterCovered: /: (already idle|stopped)$/.test(lineFor(waiter) ?? ""),
        grandchildStopped:
          lineFor(gc)?.endsWith(`, launched by ${waiter}: stopped`) === true,
        finishedChildLeftOut: lineFor(done) === undefined,
        parentKeptRunning:
          stopResultSeen !== undefined &&
          stopResultSeen.at < parentEnd.at &&
          parentTyped.filter((e) => e.type === "session.execution.started")
            .length === 1 &&
          !parentTyped.some((e) => e.type === "session.execution.interrupted"),
        waiterStayedStopped:
          waiterIdle &&
          waiterRuns.every((start) =>
            waiterStops.some(
              (stop) => stop.at >= start.at && stop.at - start.at < 500,
            ),
          ) &&
          !JSON.stringify(waiterContext).includes("WAITER-WOKEN-REPLY"),
        grandchildNoticeReachedWaiter: gcNotice !== undefined,
        noStepCompleted: stepsEnded.length === 0,
        parentHeardOnlyBusy:
          parentNotices.length === 1 &&
          JSON.stringify(parentNotices[0]?.metadata).includes(busy) &&
          JSON.stringify(parentNotices[0]?.metadata).includes('"cancelled"'),
        latchesMatch:
          latches.get(busy) === "active" &&
          latches.get(waiter) === "active" &&
          latches.get(gc) === "active" &&
          latches.has(done) &&
          latches.get(done) === undefined,
        probeNeverEnforced: readLog(dir).every((r) => r.kind !== "enforce"),
      };

      yield* finishScenario(dir, "stop-all", evidence, checks);
    }),
);
