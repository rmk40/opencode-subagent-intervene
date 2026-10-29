// subagent_send to a background child that is holding a shell. The message is steered into the
// child's inbox and the tool reports `sent`, but the child's model sees nothing while the shell
// runs. Once the shell finishes, the child's next model request carries the message exactly as
// written, line breaks, tab, `Vec<String>`, and `&` included, wrapped in
// `<parent-message from="<parentID>">`. The child answers, and the parent gets exactly one
// completion notice for it.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { Effect, Stream } from "effect";
import { Llm, OpenCodeDriver } from "opencode-drive";
import {
  call,
  captureToolResults,
  capturedToolResult,
  type ChatRequest,
  childOf,
  completionNotices,
  events,
  finishScenario,
  forSession,
  instanceFor,
  isBusy,
  notices,
  noticeState,
  parentMessageText,
  probePlugin,
  REPO_ROOT,
  readLog,
  recordRequest,
  runDir,
  takeCall,
  toolCallResponse,
  until,
  waitEvent,
  waitIdle,
} from "../harness";

const dir = runDir("send-running");
const ANSWER = "CHILD-ACK-5: switching to Vec<String>";
const MESSAGE = [
  "Change of plan: parse the input into Vec<String> first.",
  "",
  "  1. keep `a && b` exactly as written",
  "  2. salt & pepper <tags> stay as they are",
  "\tthis line starts with a tab",
].join("\n");

if (!existsSync(join(REPO_ROOT, "dist", "index.js")))
  throw new Error("dist/index.js is missing; run `bun run build` first");

interface SeenRequest {
  readonly at: number;
  readonly request: ChatRequest;
}

export default OpenCodeDriver.use(
  {
    tools: ["shell"],
    config: {
      permissions: [],
      plugins: [probePlugin(dir), { package: REPO_ROOT, options: {} }],
    },
  },
  ({ llm, tools, directory }) =>
    Effect.gen(function* () {
      const shells = yield* tools.control("shell");
      let child = "";
      const childRequests: SeenRequest[] = [];

      yield* llm.serve((request, index) => {
        const req = recordRequest(dir, request.body, index);
        captureToolResults(dir, request.body);
        const { last } = req;
        if (req.role === "parent") {
          if (last.role === "tool") {
            if (last.toolCallID === "p_sub")
              return Stream.make(Llm.text("Launched."));
            if (last.toolCallID === "p_send")
              return Stream.make(Llm.text("SENT"));
          }
          if (last.text.includes("CMD-SEND"))
            return toolCallResponse("p_send", "subagent_send", {
              sessionID: child,
              message: MESSAGE,
            });
          if (last.text.includes("<subagent"))
            return Stream.make(Llm.text("PARENT-NOTED"));
          if (last.text.includes("ROLE<parent>"))
            return toolCallResponse("p_sub", "subagent", {
              agent: "general",
              description: "send child",
              prompt: "ROLE<child> CHILD-TASK",
              background: true,
            });
          return Stream.make(Llm.text("parent-other"));
        }
        if (req.role === "child") {
          childRequests.push({ at: Date.now(), request: req });
          if (last.role === "user" && last.text.startsWith("<parent-message"))
            return Stream.make(Llm.text(ANSWER));
          if (last.role === "user" && last.text.includes("CHILD-TASK"))
            return toolCallResponse("c_hold", "shell", {
              command: "hold",
              description: "hold",
            });
          return Stream.make(Llm.text("CHILD-UNEXPECTED"));
        }
        return Stream.make(Llm.text("other"));
      });

      const instance = yield* Effect.promise(() => instanceFor(dir, directory));
      const ctl = <T = unknown>(
        op: string,
        args: Record<string, unknown> = {},
      ) => Effect.promise(() => call<T>(instance, op, args));

      // A background child holding a shell; the parent is idle.
      const parent = (yield* ctl<{ id: string }>("create", { title: "parent" }))
        .id;
      const launchAt = Date.now();
      yield* ctl("prompt", { sessionID: parent, text: "ROLE<parent> launch" });
      child = yield* Effect.promise(() =>
        until("child", () => childOf(dir, parent)),
      );
      const hold = yield* takeCall(shells, "c_hold");
      yield* hold.progress("holding\n");
      yield* Effect.promise(() =>
        waitEvent(dir, parent, "session.execution.succeeded", {
          since: launchAt,
        }),
      );
      yield* Effect.promise(() => waitIdle(instance, parent));
      const childRequestsBeforeSend = childRequests.length;

      // The parent sends while the shell is held.
      const sendAt = Date.now();
      yield* ctl("prompt", { sessionID: parent, text: "CMD-SEND" });
      const sendText = yield* Effect.promise(() =>
        until("send result", () => capturedToolResult(dir, "p_send"), 30_000),
      );
      const sendResultAt = Date.now();
      yield* Effect.promise(() => waitIdle(instance, parent));
      // Give a delivery that ignored the held shell time to show up.
      yield* Effect.sleep(1500);
      const childBusyWhileHeld = yield* Effect.promise(() =>
        isBusy(instance, child),
      );
      const releaseAt = Date.now();
      const requestsWhileHeld = childRequests.filter(
        (r) => r.at >= sendAt && r.at < releaseAt,
      ).length;
      const deliveredWhileHeld = forSession(events(readLog(dir), "all"), child)
        .filter(
          (e) =>
            e.at >= sendAt &&
            e.at < releaseAt &&
            e.type === "session.inbox.delivered",
        )
        .map((e) => e.data);

      // The shell finishes; the child's next request carries the message.
      yield* hold.succeed({ output: "held\n", exit: 0 });
      const firstAfter = yield* Effect.promise(() =>
        until("child request after release", () =>
          childRequests.find((r) => r.at >= releaseAt),
        ),
      );
      yield* Effect.promise(() =>
        waitEvent(dir, child, "session.execution.succeeded", {
          since: releaseAt,
        }),
      );
      yield* Effect.promise(() =>
        until("completion notice", () =>
          completionNotices(dir, parent, child).find((n) => n.at >= releaseAt),
        ),
      );
      // A second notice would arrive within this window.
      yield* Effect.sleep(2500);
      yield* Effect.promise(() => waitIdle(instance, parent));
      const childContext = yield* ctl<ReadonlyArray<unknown>>("context", {
        sessionID: child,
      });

      const expected = parentMessageText(parent, MESSAGE);
      const enqueued = notices(dir, child).filter((n) => n.at >= sendAt);
      const childCompletion = completionNotices(dir, parent, child);
      const parentNoticesAfterSend = notices(dir, parent).filter(
        (n) => n.at >= sendAt,
      );
      const messageIndex = firstAfter.request.userTexts.indexOf(expected);

      const evidence = {
        dir,
        parent,
        child,
        sendText,
        timings: {
          sendResultMs: sendResultAt - sendAt,
          heldAfterResultMs: releaseAt - sendResultAt,
          firstRequestAfterReleaseMs: firstAfter.at - releaseAt,
        },
        childRequestsBeforeSend,
        requestsWhileHeld,
        deliveredWhileHeld,
        childBusyWhileHeld,
        enqueuedToChild: enqueued.map((n) => ({
          t: n.at - sendAt,
          metadata: n.metadata,
        })),
        firstRequestAfterRelease: {
          last: firstAfter.request.last,
          userTexts: firstAfter.request.userTexts,
        },
        childCompletion: childCompletion.map((n) => ({
          t: n.at - sendAt,
          state: noticeState(n),
          text: n.text,
        })),
        parentNoticesAfterSend: parentNoticesAfterSend.map((n) => n.metadata),
      };

      const checks = {
        resultSaysSent: sendText.startsWith(`Message sent to ${child}`),
        resultNamesHeldShell: sendText.includes(
          "after its current tool calls finish: shell",
        ),
        oneSyntheticEnqueued:
          enqueued.length === 1 &&
          JSON.stringify(enqueued[0]?.metadata).includes(
            `"kind":"parent-message"`,
          ) &&
          JSON.stringify(enqueued[0]?.metadata).includes(`"from":"${parent}"`),
        childStillRunningWhileHeld: childBusyWhileHeld,
        modelSawNothingWhileHeld: requestsWhileHeld === 0,
        notDeliveredWhileHeld: deliveredWhileHeld.length === 0,
        // A user message equal to the expected text: wrapper, line breaks, tab, `<`, `>`, and `&`.
        nextRequestCarriesExactMessage: messageIndex >= 0,
        messageIsLastUserText:
          messageIndex === firstAfter.request.userTexts.length - 1,
        messagePersisted: JSON.stringify(childContext).includes(
          JSON.stringify(expected).slice(1, -1),
        ),
        childAnswered: JSON.stringify(childContext).includes(ANSWER),
        exactlyOneCompletionNotice:
          childCompletion.length === 1 &&
          childCompletion.every(
            (n) =>
              noticeState(n) === "completed" &&
              typeof n.text === "string" &&
              n.text.includes(ANSWER),
          ),
        noOtherParentNotice: parentNoticesAfterSend.length === 1,
        probeNeverEnforced: readLog(dir).every((r) => r.kind !== "enforce"),
      };

      yield* finishScenario(dir, "send-running", evidence, checks);
    }),
);
