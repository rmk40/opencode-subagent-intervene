// The parent is interrupted while subagent_stop is settling. With `confirmStop: true` and an `ask`
// rule, the stop walks the subtree (a hub child and its three busy subagents) and then waits for
// the permission reply. During that wait the hub launches one more subagent, which the walk did not
// see and which inherits no latch, since the hub is not latched yet. The reply lets the stop latch
// and interrupt the four sessions it walked; the hub, interrupted last, waits on sixty shells, so
// the stop then waits for it to settle. The moment the hub's shells see the interrupt, the person
// interrupts the parent through the SDK. Afterwards:
// - every session the stop latched before the cancellation is still latched;
// - the late subagent, which the next settle round would have latched and interrupted, has no
//   latch and was never interrupted, and finishes its run normally;
// - the stop logs that it was cancelled while settling, and issues no interrupt after the
//   cancellation.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { Effect, Fiber, Option, Stream } from "effect";
import { Llm, type OpenCode, OpenCodeDriver } from "opencode-drive";
import {
  call,
  captureToolResults,
  capturedToolResult,
  codeModeValue,
  events,
  finishScenario,
  forSession,
  instanceFor,
  LIST_SUBTREE_CODE,
  listedLatches,
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

const dir = runDir("stop-cancel-parent");
const REASON = "cancel me midway";
const GRANDCHILDREN = ["gc0", "gc1", "gc2"] as const;
/** Shells the hub waits on when it is stopped; each one adds to its stopped run's cleanup. */
const HUB_HOLDS = Array.from({ length: 60 }, (_, i) => `h_hold_${i}`);

type ReplyInput = Parameters<OpenCode["permission"]["reply"]>[0];
type InterruptInput = Parameters<OpenCode["session"]["interrupt"]>[0];

if (!existsSync(join(REPO_ROOT, "dist", "index.js")))
  throw new Error("dist/index.js is missing; run `bun run build` first");

const shellCall = (index: number, id: string) =>
  Llm.toolCall({
    index,
    id,
    name: "shell",
    input: { command: `hold ${id}`, description: id },
  });

const subagentCall = (index: number, id: string, role: string) =>
  Llm.toolCall({
    index,
    id,
    name: "subagent",
    input: {
      agent: "general",
      description: role,
      prompt: `ROLE<${role}> CHILD-TASK`,
      background: true,
    },
  });

export default OpenCodeDriver.use(
  {
    tools: ["shell"],
    config: {
      experimental: { subagent_depth: 2 },
      permissions: [
        { action: "*", resource: "*", effect: "allow" },
        { action: "subagent_stop", resource: "*", effect: "ask" },
      ],
      plugins: [
        probePlugin(dir),
        { package: REPO_ROOT, options: { confirmStop: true } },
      ],
    },
  },
  ({ llm, tools, directory, opencode, artifacts }) =>
    Effect.gen(function* () {
      const shells = yield* tools.control("shell");
      let hub = "";

      yield* llm.serve((request, index) => {
        const req = recordRequest(dir, request.body, index);
        captureToolResults(dir, request.body);
        const { last } = req;
        if (req.role === "parent") {
          if (last.role === "tool") {
            if (last.toolCallID === "p_sub")
              return Stream.make(Llm.text("Launched."));
            if (last.toolCallID === "p_list")
              return Stream.make(Llm.text("LISTED"));
          }
          if (last.text.includes("CMD-STOP"))
            return toolCallResponse("p_stop", "subagent_stop", {
              sessionIDs: [hub],
              reason: REASON,
            });
          if (last.text.includes("CMD-LIST"))
            return toolCallResponse("p_list", "execute", {
              code: LIST_SUBTREE_CODE,
            });
          if (last.text.includes("ROLE<parent>"))
            return toolCallResponse("p_sub", "subagent", {
              agent: "general",
              description: "hub",
              prompt: "ROLE<hub> CHILD-TASK",
              background: true,
            });
          return Stream.make(Llm.text("PARENT-NOTED"));
        }
        if (req.role === "hub") {
          if (last.role === "user" && last.text.includes("CHILD-TASK"))
            return Stream.make(
              ...GRANDCHILDREN.map((role, i) =>
                subagentCall(i, `h_sub_${role}`, role),
              ),
              shellCall(GRANDCHILDREN.length, "h_gate"),
              Llm.finish("tool-calls"),
            );
          if (last.role === "tool" && last.toolCallID === "h_gate")
            return Stream.make(
              subagentCall(0, "h_sub_late", "late"),
              ...HUB_HOLDS.map((id, i) => shellCall(i + 1, id)),
              Llm.finish("tool-calls"),
            );
          return Stream.make(Llm.pause(1500), Llm.text("HUB-WOKEN-REPLY"));
        }
        if (req.role === "late") {
          if (last.role === "tool" && last.toolCallID === "late_hold")
            return Stream.make(Llm.text("LATE-DONE"));
          if (last.role === "user" && last.text.includes("CHILD-TASK"))
            return toolCallResponse("late_hold", "shell", {
              command: "hold",
              description: "hold",
            });
          return Stream.make(Llm.text("LATE-OTHER"));
        }
        if (req.role?.startsWith("gc") === true) {
          if (last.role === "user" && last.text.includes("CHILD-TASK"))
            return toolCallResponse(`${req.role}_hold`, "shell", {
              command: "hold",
              description: "hold",
            });
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
      const sessionOf = (role: string) =>
        readLlm(dir).find((r) => r.role === role)?.sessionID;

      // A hub child whose three subagents hold shells, and which holds a gate shell itself.
      const parent = (yield* ctl<{ id: string }>("create", { title: "parent" }))
        .id;
      const launchAt = Date.now();
      yield* ctl("prompt", { sessionID: parent, text: "ROLE<parent> launch" });
      const gate = yield* takeCall(shells, "h_gate");
      const gcHolds = yield* Effect.all(
        GRANDCHILDREN.map((role) => takeCall(shells, `${role}_hold`)),
      );
      for (const hold of gcHolds) yield* hold.progress("holding\n");
      hub = yield* Effect.promise(() => until("hub", () => sessionOf("hub")));
      const grandchildren = yield* Effect.promise(() =>
        until("hub subagents", () => {
          const ids = GRANDCHILDREN.map(sessionOf);
          return ids.every((id): id is string => id !== undefined)
            ? ids
            : undefined;
        }),
      );
      yield* wait(parent, "session.execution.succeeded", launchAt);
      yield* Effect.sleep(500);

      // The stop walks the subtree and waits for the permission reply.
      const stopAt = Date.now();
      yield* ctl("prompt", { sessionID: parent, text: "CMD-STOP" });
      const ask = yield* Effect.promise(() =>
        until("subagent_stop permission request", async () =>
          (
            await call<
              ReadonlyArray<{ readonly id: string; readonly action: string }>
            >(instance, "permissions", { sessionID: parent })
          ).find((request) => request.action === "subagent_stop"),
        ),
      );

      // Meanwhile the hub launches a late subagent and blocks on sixty shells.
      yield* gate.succeed({ output: "gate open\n", exit: 0 });
      const lateHold = yield* takeCall(shells, "late_hold");
      yield* lateHold.progress("holding\n");
      const hubHolds = yield* Effect.all(
        HUB_HOLDS.map((id) => takeCall(shells, id)),
      );
      const late = yield* Effect.promise(() =>
        until("late subagent", () => sessionOf("late")),
      );
      const lateInterrupted = yield* lateHold
        .awaitInterrupted()
        .pipe(Effect.as(Date.now()), Effect.forkChild);

      // The person interrupts the parent as soon as the hub's shells see the interrupt.
      const cancel = yield* Effect.raceAll(
        hubHolds.map((hold) => hold.awaitInterrupted()),
      ).pipe(
        Effect.andThen(() => {
          const hubShellAt = Date.now();
          return opencode.session
            .interrupt({
              sessionID: parent as InterruptInput["sessionID"],
              resume: false,
            })
            .pipe(
              Effect.orDie,
              Effect.map((result) => ({
                hubShellAt,
                interruptedAt: Date.now(),
                result,
              })),
            );
        }),
        Effect.forkChild,
      );
      const approvedAt = Date.now();
      yield* opencode.permission
        .reply({
          sessionID: parent as ReplyInput["sessionID"],
          requestID: ask.id as ReplyInput["requestID"],
          decision: "once",
        })
        .pipe(Effect.orDie);
      const cancelled = yield* Fiber.join(cancel).pipe(
        Effect.timeoutOption(15_000),
      );
      const parentStopped = yield* wait(
        parent,
        "session.execution.interrupted",
        stopAt,
      );

      // Long enough for every settle round an uncancelled stop would run.
      yield* Effect.sleep(3000);
      const lateBusyBeforeRelease = !(
        (yield* ctl<{ outcome: string }>("wait", {
          sessionID: late,
          timeoutMs: 150,
        })).outcome === "resolved"
      );
      const lateInterruptedEarly = lateInterrupted.pollUnsafe() !== undefined;

      // The late subagent finishes its run normally.
      const releaseAt = Date.now();
      yield* lateHold.succeed({ output: "late work done\n", exit: 0 });
      const lateEnd = yield* wait(
        late,
        "session.execution.succeeded",
        releaseAt,
      );
      yield* Effect.sleep(2000);
      const lateContext = yield* ctl<ReadonlyArray<unknown>>("context", {
        sessionID: late,
      });

      const listAt = Date.now();
      yield* ctl("prompt", { sessionID: parent, text: "CMD-LIST" });
      const listText = yield* Effect.promise(() =>
        until("list result", () => capturedToolResult(dir, "p_list"), 30_000),
      );
      yield* wait(parent, "session.execution.succeeded", listAt);

      const cancelTimes = Option.getOrUndefined(cancelled);
      const typed = events(readLog(dir));
      const interruptsOf = (id: string) =>
        forSession(typed, id).filter(
          (e) => e.type === "session.execution.interrupted" && e.at >= stopAt,
        );
      const latched = [hub, ...grandchildren];
      const latches = listedLatches(codeModeValue(listText));
      const plugin = pluginConsole(artifacts);
      const cancelLine = plugin.find((line) =>
        line.includes("stop: cancelled; issuing no further writes"),
      );
      const stage = /stage: "([a-z]+)"/.exec(cancelLine ?? "")?.[1];
      const stopResult = capturedToolResult(dir, "p_stop");
      const latchInterrupts = plugin.filter((line) =>
        line.includes("latch: interrupted a run in a stopped session"),
      );
      // Each walked session's first interrupt is the stop's own; any later one, and any
      // interrupt of the late subagent, came after the cancellation.
      const interruptsAfterCancel = [
        ...latched.flatMap((id) => interruptsOf(id).slice(1)),
        ...interruptsOf(late),
      ];

      const evidence = {
        dir,
        parent,
        hub,
        grandchildren,
        late,
        timings: {
          askAfterStopMs: approvedAt - stopAt,
          hubShellSawInterruptAfterApprovalMs:
            cancelTimes === undefined
              ? null
              : cancelTimes.hubShellAt - approvedAt,
          parentInterruptReturnedAfterApprovalMs:
            cancelTimes === undefined
              ? null
              : cancelTimes.interruptedAt - approvedAt,
          parentStoppedAfterApprovalMs: parentStopped.at - approvedAt,
          lateEndedAfterReleaseMs: lateEnd.at - releaseAt,
        },
        parentInterrupt: cancelTimes?.result,
        stopResult,
        cancelLine,
        interruptsAt: Object.fromEntries(
          [...latched, late].map((id) => [
            id,
            interruptsOf(id).map((e) => e.at - approvedAt),
          ]),
        ),
        interruptsAfterCancel: interruptsAfterCancel.map((e) => ({
          sessionID: e.sessionID,
          t: e.at - approvedAt,
        })),
        latchInterrupts,
        latches: Object.fromEntries(
          [...latched, late].map((id) => [id, latches.get(id) ?? null]),
        ),
      };

      const checks = {
        parentInterrupted: cancelTimes !== undefined,
        stopCallAborted:
          stopResult !== undefined && stopResult.includes('"aborted"'),
        cancelledWhileSettling: stage === "settle",
        walkedSessionsInterrupted: latched.every(
          (id) => (interruptsOf(id)[0]?.at ?? Infinity) < releaseAt,
        ),
        walkedSessionsStayLatched: latched.every(
          (id) => latches.get(id) === "active",
        ),
        lateSubagentNotLatched:
          latches.has(late) && latches.get(late) === undefined,
        lateSubagentNeverInterrupted:
          interruptsOf(late).length === 0 && !lateInterruptedEarly,
        lateSubagentRanOn: lateBusyBeforeRelease,
        lateSubagentFinishedNormally:
          JSON.stringify(lateContext).includes("LATE-DONE"),
        // Between the cancellation and the late subagent's release, nothing is interrupted; after
        // the release, only the hub's run that the late subagent's notice starts, by the latch.
        noInterruptAfterCancel: interruptsAfterCancel.every(
          (e) => e.at >= releaseAt && e.sessionID === hub,
        ),
        latchStoppedTheWokenHub:
          interruptsAfterCancel.length === 0 ||
          latchInterrupts.some((line) => line.includes(hub)),
        probeNeverEnforced: readLog(dir).every((r) => r.kind !== "enforce"),
      };

      yield* finishScenario(dir, "stop-cancel-parent", evidence, checks);
    }),
);
