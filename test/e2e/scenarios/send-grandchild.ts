// With `experimental.subagent_depth: 2`, the root parent sends to a grandchild launched by its
// background child. The grandchild holds a shell; once the shell finishes, its next model request
// carries the message from the root, `<parent-message from="<rootID>">`, and the grandchild's
// completion notice goes to the child that launched it, not to the root.
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
  finishScenario,
  instanceFor,
  notices,
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

const dir = runDir("send-grandchild");
const MESSAGE =
  "Root here: skip the slow path & report Vec<u8> sizes.\nThanks.";
const ANSWER = "GC-ACK-3";

if (!existsSync(join(REPO_ROOT, "dist", "index.js")))
  throw new Error("dist/index.js is missing; run `bun run build` first");

interface SeenRequest {
  readonly at: number;
  readonly request: ChatRequest;
}

export default OpenCodeDriver.use(
  {
    tools: ["shell"],
    // Drive's blanket allow rule stays, so the general child may launch a subagent.
    config: {
      experimental: { subagent_depth: 2 },
      plugins: [probePlugin(dir), { package: REPO_ROOT, options: {} }],
    },
  },
  ({ llm, tools, directory }) =>
    Effect.gen(function* () {
      const shells = yield* tools.control("shell");
      let grandchild = "";
      const gcRequests: SeenRequest[] = [];

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
              sessionID: grandchild,
              message: MESSAGE,
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
            return Stream.make(Llm.text("CHILD-LAUNCHED-GC"));
          if (last.role === "user" && last.text.includes("CHILD-TASK"))
            return toolCallResponse("c_sub", "subagent", {
              agent: "general",
              description: "grandchild",
              prompt: "ROLE<grandchild> GC-TASK",
              background: true,
            });
          return Stream.make(Llm.text("CHILD-NOTED"));
        }
        if (req.role === "grandchild") {
          gcRequests.push({ at: Date.now(), request: req });
          if (last.role === "user" && last.text.startsWith("<parent-message"))
            return Stream.make(Llm.text(ANSWER));
          if (last.role === "user" && last.text.includes("GC-TASK"))
            return toolCallResponse("g_hold", "shell", {
              command: "hold",
              description: "hold",
            });
          return Stream.make(Llm.text("GC-UNEXPECTED"));
        }
        return Stream.make(Llm.text("other"));
      });

      const instance = yield* Effect.promise(() => instanceFor(dir, directory));
      const ctl = <T = unknown>(
        op: string,
        args: Record<string, unknown> = {},
      ) => Effect.promise(() => call<T>(instance, op, args));

      // The root's child launches a grandchild in the background and ends its run.
      const parent = (yield* ctl<{ id: string }>("create", { title: "parent" }))
        .id;
      yield* ctl("prompt", { sessionID: parent, text: "ROLE<parent> launch" });
      const child = yield* Effect.promise(() =>
        until("child", () => childOf(dir, parent)),
      );
      grandchild = yield* Effect.promise(() =>
        until("grandchild", () => childOf(dir, child)),
      );
      const hold = yield* takeCall(shells, "g_hold");
      yield* hold.progress("holding\n");
      yield* Effect.promise(() =>
        until(
          "child's completion notice",
          () => completionNotices(dir, parent, child)[0],
        ),
      );
      yield* Effect.sleep(300);
      yield* Effect.promise(async () => {
        await waitIdle(instance, child);
        await waitIdle(instance, parent);
      });

      // The root sends to the grandchild while it holds the shell.
      const sendAt = Date.now();
      yield* ctl("prompt", { sessionID: parent, text: "CMD-SEND" });
      const sendText = yield* Effect.promise(() =>
        until("send result", () => capturedToolResult(dir, "p_send"), 30_000),
      );
      yield* Effect.promise(() => waitIdle(instance, parent));
      yield* Effect.sleep(1000);
      const releaseAt = Date.now();
      const gcRequestsWhileHeld = gcRequests.filter(
        (r) => r.at >= sendAt && r.at < releaseAt,
      ).length;

      yield* hold.succeed({ output: "held\n", exit: 0 });
      const firstAfter = yield* Effect.promise(() =>
        until("grandchild request after release", () =>
          gcRequests.find((r) => r.at >= releaseAt),
        ),
      );
      yield* Effect.promise(() =>
        waitEvent(dir, grandchild, "session.execution.succeeded", {
          since: releaseAt,
        }),
      );
      const gcNotice = yield* Effect.promise(() =>
        until("grandchild's completion notice to the child", () =>
          completionNotices(dir, child, grandchild).find(
            (n) => n.at >= releaseAt,
          ),
        ),
      );
      yield* Effect.sleep(2000);
      yield* Effect.promise(async () => {
        await waitIdle(instance, child);
        await waitIdle(instance, parent);
      });

      const expected = parentMessageText(parent, MESSAGE);
      const enqueued = notices(dir, grandchild).filter((n) => n.at >= sendAt);
      const rootNoticesAboutGc = completionNotices(dir, parent, grandchild);

      const evidence = {
        dir,
        parent,
        child,
        grandchild,
        sendText,
        timings: {
          heldAfterSendMs: releaseAt - sendAt,
          firstRequestAfterReleaseMs: firstAfter.at - releaseAt,
          noticeToChildAfterReleaseMs: gcNotice.at - releaseAt,
        },
        gcRequestsWhileHeld,
        enqueuedToGrandchild: enqueued.map((n) => n.metadata),
        firstRequestAfterRelease: firstAfter.request.last,
        gcNotice: gcNotice.text,
        rootNoticesAboutGc: rootNoticesAboutGc.map((n) => n.metadata),
      };

      const checks = {
        resultSaysSent: sendText.startsWith(`Message sent to ${grandchild}`),
        enqueuedFromRoot:
          enqueued.length === 1 &&
          JSON.stringify(enqueued[0]?.metadata).includes(`"from":"${parent}"`),
        modelSawNothingWhileHeld: gcRequestsWhileHeld === 0,
        grandchildGotMessage: firstAfter.request.userTexts.includes(expected),
        grandchildAnswered:
          typeof gcNotice.text === "string" && gcNotice.text.includes(ANSWER),
        rootGotNoGrandchildNotice: rootNoticesAboutGc.length === 0,
        probeNeverEnforced: readLog(dir).every((r) => r.kind !== "enforce"),
      };

      yield* finishScenario(dir, "send-grandchild", evidence, checks);
    }),
);
