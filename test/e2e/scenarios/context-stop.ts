import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { Effect, Stream } from "effect";
import { Llm, OpenCodeDriver, type OpenCode } from "opencode-drive";
import {
  call,
  captureToolResults,
  childOf,
  finishScenario,
  instanceFor,
  listedLatches,
  readLog,
  recordRequest,
  runDir,
  takeCall,
  toolCallResponse,
  until,
  waitIdle,
} from "../harness";
import {
  compactionSummary,
  contextPlugins,
  object,
  toolObservation,
} from "../context-harness";

const dir = runDir("context-stop");
type InboxInput = Parameters<OpenCode["session"]["inbox"]["list"]>[0];
export default OpenCodeDriver.use(
  {
    tools: ["shell"],
    config: { plugins: contextPlugins(dir), compaction: { auto: false } },
  },
  ({ llm, tools, directory, opencode }) =>
    Effect.gen(function* () {
      const shells = yield* tools.control("shell");
      let child = "";
      yield* llm.serve((request, index) => {
        const req = recordRequest(dir, request.body, index);
        captureToolResults(dir, request.body);
        if (req.system.includes("PROBE-COMPACTION"))
          return Stream.make(Llm.pause(1000), Llm.text(compactionSummary));
        if (req.role === "parent") {
          if (req.last.role === "tool")
            return Stream.make(Llm.text("PARENT-DONE"));
          if (req.last.text.includes("CMD-STOP"))
            return toolCallResponse("parent_stop", "subagent_stop", {
              sessionIDs: [child],
              reason: "runtime stop classification",
            });
          if (req.last.text.includes("ROLE<parent>"))
            return toolCallResponse("parent_launch", "subagent", {
              agent: "general",
              prompt: "ROLE<child> wait",
              description: "stop probe",
              background: true,
            });
          return Stream.make(Llm.text("NOTED"));
        }
        if (req.role === "child") {
          if (req.last.text.includes("CMD-HOLD"))
            return toolCallResponse("child_hold", "shell", {
              command: "hold",
              description: "hold",
            });
          if (req.last.text.includes("ROLE<child>"))
            return Stream.make(Llm.text("CHILD-READY"));
          return Stream.make(
            Llm.pause(1000),
            Llm.text("UNEXPECTED-CHILD-CONTINUATION"),
          );
        }
        return Stream.make(Llm.text("Auxiliary reply."));
      });
      const a = yield* Effect.promise(() => instanceFor(dir, directory));
      const parent = yield* Effect.promise(() =>
        call<{ id: string }>(a, "create", { title: "parent" }),
      );
      yield* Effect.promise(() =>
        call(a, "prompt", {
          sessionID: parent.id,
          text: "ROLE<parent> launch",
        }),
      );
      child = yield* Effect.promise(() =>
        until("child", () => childOf(dir, parent.id)),
      );
      yield* Effect.promise(() => waitIdle(a, child));
      yield* Effect.promise(() => waitIdle(a, parent.id));
      const bDir = resolve(directory, "..", "context-stop-child");
      mkdirSync(bDir, { recursive: true });
      yield* Effect.promise(() =>
        call(a, "move", { sessionID: child, directory: bDir }),
      );
      const b = yield* Effect.promise(() => instanceFor(dir, bDir));
      yield* Effect.promise(() =>
        call(b, "prompt", { sessionID: child, text: "CMD-HOLD" }),
      );
      const hold = yield* takeCall(shells, "child_hold");
      yield* hold.progress("holding\n");
      yield* Effect.promise(() =>
        call(a, "prompt", { sessionID: parent.id, text: "CMD-STOP" }),
      );
      yield* Effect.promise(() =>
        until(
          "parent stopped child",
          () => toolObservation(dir, "parent_stop"),
          30000,
        ),
      );
      yield* Effect.promise(() => waitIdle(a, parent.id));
      yield* Effect.promise(() => waitIdle(b, child));
      const childHistory = yield* Effect.promise(() =>
        call<unknown[]>(b, "context", { sessionID: child }),
      );
      const caller = childHistory
        .map(object)
        .filter((item) => item.type === "assistant")
        .at(-1);
      const latch = () =>
        Effect.promise(async () => {
          const result = await call(a, "tool.run", {
            sessionID: parent.id,
            messageID: toolObservation(dir, "parent_stop")?.messageID,
            tool: "subagents_list",
            input: { depth: 4 },
          });
          return listedLatches(object(result).output).get(child);
        });
      const before = yield* latch();
      // Admission runs in the parent's plugin instance; the child-location instance also receives its event.
      const selfAt = Date.now();
      const self = yield* Effect.promise(() =>
        call(a, "tool.run", {
          sessionID: child,
          messageID: caller?.id,
          tool: "context_compact",
          input: {},
        }),
      );
      yield* Effect.sleep(1500);
      const afterSelf = yield* latch();
      const afterSelfHistory = yield* Effect.promise(() =>
        call<unknown[]>(b, "context", { sessionID: child }),
      );
      const pending = yield* opencode.session.inbox
        .list({ sessionID: child as InboxInput["sessionID"] })
        .pipe(Effect.orDie);
      for (const item of pending)
        if (item.type === "compaction")
          yield* opencode.session.inbox
            .cancel({
              sessionID: child as InboxInput["sessionID"],
              inboxID: item.id,
            })
            .pipe(Effect.orDie);
      const externalAt = Date.now();
      const external = yield* Effect.promise(() =>
        call(b, "compact", { sessionID: child }),
      );
      yield* Effect.promise(() =>
        until(
          "external compaction completed",
          async () => {
            const history = await call<unknown[]>(b, "context", {
              sessionID: child,
            });
            return history.some(
              (item) =>
                object(item).type === "compaction" &&
                object(item).status === "completed",
            )
              ? true
              : undefined;
          },
          30000,
        ),
      );
      yield* Effect.promise(() => waitIdle(b, child));
      const afterExternal = yield* latch();
      const admissionEvents = readLog(dir).filter(
        (item) =>
          item.type === "session.inbox.enqueued" &&
          item.sessionID === child &&
          item.itemType === "compaction",
      );
      yield* finishScenario(
        dir,
        "context-stop",
        {
          before,
          self,
          afterSelf,
          pending,
          external,
          afterExternal,
          admissionEvents,
        },
        {
          stoppedBeforeSelfAdmission: before === "active",
          selfAdmissionSucceeded:
            object(object(self).output).status === "requested",
          selfAdmissionDidNotLift: afterSelf === "active",
          selfAdmissionSeenAcrossInstances:
            new Set(
              admissionEvents
                .filter((item) => item.at >= selfAt && item.at < externalAt)
                .map((item) => item.location),
            ).size === 2,
          noStoppedChildFinal: !JSON.stringify(afterSelfHistory).includes(
            "UNEXPECTED-CHILD-CONTINUATION",
          ),
          externalCompactionLifts: afterExternal === "lifted",
          distinctExternalAdmission:
            object(external).id !== object(object(self).output).id,
        },
      );
    }),
);
