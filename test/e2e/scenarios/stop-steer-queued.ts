// A person queues a prompt for a busy subagent, the parent then stops it, and the person switches the
// still-pending prompt to steer through the SDK (`session.inbox.update`). The switch lifts the
// latch and the prompt runs to completion without being interrupted.
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

const dir = runDir("stop-steer-queued");
const REASON = "stop before the queued work";
const ANSWER = "STEERED-ANSWER-18";

type PromptInput = Parameters<OpenCode["session"]["prompt"]>[0];
type InboxUpdate = Parameters<OpenCode["session"]["inbox"]["update"]>[0];

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
            if (last.toolCallID === "p_list" || last.toolCallID === "p_prelist")
              return Stream.make(Llm.text("LISTED"));
          }
          if (last.text.includes("CMD-PRELIST"))
            return toolCallResponse("p_prelist", "execute", {
              code: LIST_SUBTREE_CODE,
            });
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
              description: "steer child",
              prompt: "ROLE<child> CHILD-TASK",
              background: true,
            });
          return Stream.make(Llm.text("parent-other"));
        }
        if (req.role === "child") {
          if (last.role === "tool" && last.toolCallID === "c_steer_tool")
            return Stream.make(Llm.text(ANSWER));
          if (last.role === "user" && last.text.includes("QUEUED-PROMPT"))
            return toolCallResponse("c_steer_tool", "shell", {
              command: "queued-work",
              description: "queued work",
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
      const pendingQueued = () =>
        opencode.session.inbox
          .list({ sessionID: child as InboxUpdate["sessionID"] })
          .pipe(
            Effect.orDie,
            Effect.map((items) =>
              items.find((item) =>
                JSON.stringify(item).includes("QUEUED-PROMPT"),
              ),
            ),
          );

      // A background child that holds a shell.
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

      // The person queues a prompt while the child is busy, before it is stopped.
      const queueAt = Date.now();
      const queued = yield* opencode.session
        .prompt({
          sessionID: child as PromptInput["sessionID"],
          text: "QUEUED-PROMPT run this after the current work",
          delivery: "queue",
        })
        .pipe(Effect.orDie);
      yield* Effect.promise(() =>
        waitEvent(dir, child, "session.inbox.enqueued", { since: queueAt }),
      );
      yield* Effect.sleep(300);

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
          notices(dir, parent).find((n) =>
            JSON.stringify(n.metadata).includes('"cancelled"'),
          ),
        ),
      );
      yield* Effect.sleep(1500);
      const pendingAfterStop = yield* pendingQueued();
      const queuedRequestsWhileStopped = readLlm(dir).filter(
        (r) =>
          r.sessionID === child &&
          r.at >= stopAt &&
          r.last.text.includes("QUEUED-PROMPT"),
      ).length;

      // The latch is still active with the queued prompt pending.
      const prelistAt = Date.now();
      yield* ctl("prompt", { sessionID: parent, text: "CMD-PRELIST" });
      const prelistText = yield* Effect.promise(() =>
        until(
          "list result before steer",
          () => capturedToolResult(dir, "p_prelist"),
          30_000,
        ),
      );
      yield* wait(parent, "session.execution.succeeded", prelistAt);
      const latchBeforeSteer = listedLatches(codeModeValue(prelistText)).get(
        child,
      );

      // Switch the pending prompt to steer.
      const inboxID =
        (pendingAfterStop as { readonly id?: string } | undefined)?.id ??
        String((queued as { readonly id?: string }).id);
      const steerAt = Date.now();
      yield* opencode.session.inbox
        .update({
          sessionID: child as InboxUpdate["sessionID"],
          inboxID: inboxID as InboxUpdate["inboxID"],
          delivery: "steer",
        })
        .pipe(Effect.orDie);
      const work = yield* takeCall(shells, "c_steer_tool");
      yield* work.succeed({ output: "queued work done\n", exit: 0 });
      const steerEnd = yield* wait(
        child,
        "session.execution.succeeded",
        steerAt,
      );
      yield* Effect.sleep(2000);
      const childContext = yield* ctl<ReadonlyArray<unknown>>("context", {
        sessionID: child,
      });

      const listAt = Date.now();
      yield* ctl("prompt", { sessionID: parent, text: "CMD-LIST" });
      const listText = yield* Effect.promise(() =>
        until("list result", () => capturedToolResult(dir, "p_list"), 30_000),
      );
      yield* wait(parent, "session.execution.succeeded", listAt);

      const typed = forSession(events(readLog(dir)), child);
      const window = (from: number, to: number) =>
        typed
          .filter((e) => e.at >= from && e.at < to)
          .map((e) => ({
            t: e.at - from,
            type: e.type,
            itemType: e.itemType,
            delivery: e.delivery ?? e.itemDelivery,
            created: e.created,
            reason: e.reason,
          }));
      const afterSteer = typed.filter((e) => e.at >= steerAt && e.at < listAt);
      const deliveryChanged = afterSteer.find(
        (e) =>
          e.type === "session.inbox.delivery.changed" && e.delivery === "steer",
      );
      const steerRequests = readLlm(dir).filter(
        (r) => r.sessionID === child && r.at >= steerAt && r.at < listAt,
      );
      const latches = listedLatches(codeModeValue(listText));
      const plugin = pluginConsole(artifacts);

      const evidence = {
        dir,
        parent,
        child,
        inboxID,
        stopText,
        queuedWindow: window(queueAt, steerAt),
        pendingAfterStop: pendingAfterStop !== undefined,
        steerWindow: window(steerAt, listAt),
        steerRunMs: steerEnd.at - steerAt,
        steerRequests: steerRequests.map((r) => ({
          t: r.at - steerAt,
          last: r.last.text.slice(0, 200),
        })),
        latchBeforeSteer,
        latch: latches.get(child),
        plugin,
      };

      const checks = {
        shellObservedInterrupt: Option.isSome(holdInterrupted),
        stopResultStopped:
          stopText.includes(`- ${child}`) && /: stopped$/m.test(stopText),
        queuedPromptStillPending: pendingAfterStop !== undefined,
        queuedPromptNotRunWhileStopped: queuedRequestsWhileStopped === 0,
        latchActiveBeforeSteer: latchBeforeSteer === "active",
        steerEventSeen:
          deliveryChanged !== undefined &&
          typeof deliveryChanged.created === "number" &&
          deliveryChanged.created >= stopAt,
        promptRan: steerRequests.some((r) =>
          r.last.text.includes("QUEUED-PROMPT"),
        ),
        toolRan: forSession(events(readLog(dir), "all"), child).some(
          (e) =>
            e.type === "session.tool.success" &&
            typeof e.data === "string" &&
            e.data.includes('"id":"c_steer_tool"'),
        ),
        neverInterrupted: !afterSteer.some(
          (e) => e.type === "session.execution.interrupted",
        ),
        answerPersisted: JSON.stringify(childContext).includes(ANSWER),
        latchLifted: latches.get(child) === "lifted",
        pluginLoggedLift: plugin.some(
          (line) => line.includes("latch: lifted") && line.includes(child),
        ),
        probeNeverEnforced: readLog(dir).every((r) => r.kind !== "enforce"),
      };

      yield* finishScenario(dir, "stop-steer-queued", evidence, checks);
    }),
);
