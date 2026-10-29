// A parent that waits on its child in a foreground `subagent` call gets no prompt notice, since it
// could only read one after that call returns. With `promptNoticeSeconds: 1` and a config `ask`
// rule for `glob` patterns starting with `ASK-`, the child's glob call waits on a real permission
// prompt for twice the delay while the parent's call is running, then the prompt is answered and
// the call returns. The plugin tells that the parent is blocked from the `subagent` call's progress
// event, which names the child; the evidence also records the parent's running `subagent` tool
// part as `session.context` returns it, whose metadata does not name the child.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { Effect, Stream } from "effect";
import { Llm, type OpenCode, OpenCodeDriver } from "opencode-drive";
import {
  call,
  captureToolResults,
  capturedToolResult,
  childOf,
  events,
  finishScenario,
  forSession,
  instanceFor,
  isBusy,
  pluginConsole,
  probePlugin,
  REPO_ROOT,
  readLlm,
  readLog,
  recordRequest,
  runDir,
  toolCallResponse,
  until,
  waitIdle,
  waitingNotices,
  waitPermission,
} from "../harness";

const dir = runDir("notice-foreground");
const DELAY_MS = 1000;
const POSTED = "notices: told a parent its subagent is waiting";

type ReplyInput = Parameters<OpenCode["permission"]["reply"]>[0];

if (!existsSync(join(REPO_ROOT, "dist", "index.js")))
  throw new Error("dist/index.js is missing; run `bun run build` first");

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** The parent's `subagent` tool parts, as `session.context` returns them. */
const subagentParts = (messages: ReadonlyArray<unknown>) =>
  messages.flatMap((message) =>
    isRecord(message) &&
    message.type === "assistant" &&
    Array.isArray(message.content)
      ? message.content.filter(
          (part): part is Record<string, unknown> =>
            isRecord(part) && part.type === "tool" && part.name === "subagent",
        )
      : [],
  );

export default OpenCodeDriver.use(
  {
    config: {
      permissions: [
        { action: "*", resource: "*", effect: "allow" },
        { action: "glob", resource: "ASK-*", effect: "ask" },
      ],
      plugins: [
        probePlugin(dir),
        {
          package: REPO_ROOT,
          options: { promptNoticeSeconds: DELAY_MS / 1000 },
        },
      ],
    },
  },
  ({ llm, directory, opencode, artifacts }) =>
    Effect.gen(function* () {
      yield* llm.serve((request, index) => {
        const req = recordRequest(dir, request.body, index);
        captureToolResults(dir, request.body);
        const { last } = req;
        if (req.role === "parent") {
          if (last.role === "tool" && last.toolCallID === "p_fg")
            return Stream.make(Llm.text("FG-RETURNED"));
          if (last.text.includes("<subagent-waiting"))
            return Stream.make(Llm.text("PARENT-SAW-WAITING"));
          if (last.text.includes("ROLE<parent>"))
            return toolCallResponse("p_fg", "subagent", {
              agent: "general",
              description: "foreground waiter",
              prompt: "ROLE<fg> FG-TASK",
            });
          return Stream.make(Llm.text("parent-other"));
        }
        if (req.role === "fg") {
          if (last.role === "tool") return Stream.make(Llm.text("FG-DONE"));
          return toolCallResponse("f_glob", "glob", { pattern: "ASK-F-*.txt" });
        }
        return Stream.make(Llm.text("other"));
      });

      const instance = yield* Effect.promise(() => instanceFor(dir, directory));
      const ctl = <T = unknown>(
        op: string,
        args: Record<string, unknown> = {},
      ) => Effect.promise(() => call<T>(instance, op, args));

      const parent = (yield* ctl<{ id: string }>("create", { title: "parent" }))
        .id;
      yield* ctl("prompt", {
        sessionID: parent,
        text: "ROLE<parent> wait on it",
      });
      const child = yield* Effect.promise(() =>
        until("child", () => childOf(dir, parent)),
      );
      const ask = yield* Effect.promise(() =>
        waitPermission(instance, child, "glob"),
      );
      const asked = yield* Effect.promise(() =>
        until("asked event", () =>
          forSession(events(readLog(dir), "all"), child).find(
            (e) => e.type === "permission.asked",
          ),
        ),
      );
      const parentContext = yield* ctl<ReadonlyArray<unknown>>("context", {
        sessionID: parent,
      });
      const progress = forSession(events(readLog(dir), "all"), parent).find(
        (e) => e.type === "session.tool.progress",
      );
      yield* Effect.sleep(Math.max(0, asked.at + 2 * DELAY_MS - Date.now()));
      const parentBlocked = yield* Effect.promise(() =>
        isBusy(instance, parent, 150),
      );
      const noticesFor = () =>
        waitingNotices(dir, parent).filter((n) =>
          JSON.stringify(n.metadata).includes(`"sessionID":"${child}"`),
        );
      const whileBlocked = noticesFor();

      const answerAt = Date.now();
      yield* opencode.permission
        .reply({
          sessionID: child as ReplyInput["sessionID"],
          requestID: ask.id as ReplyInput["requestID"],
          decision: "once",
        })
        .pipe(Effect.orDie);
      const fgText = yield* Effect.promise(() =>
        until(
          "foreground result",
          () => capturedToolResult(dir, "p_fg"),
          30_000,
        ),
      );
      yield* Effect.promise(async () => {
        await waitIdle(instance, child);
        await waitIdle(instance, parent);
      });
      yield* Effect.sleep(1000);
      yield* Effect.promise(() => waitIdle(instance, parent));
      const after = noticesFor();
      const parentRead = readLlm(dir).find(
        (r) =>
          r.sessionID === parent && r.last.text.includes("<subagent-waiting"),
      );

      const evidence = {
        dir,
        parent,
        child,
        request: ask,
        parentBlocked,
        runningSubagentParts: subagentParts(parentContext).map((part) => ({
          id: part.id,
          state: part.state,
        })),
        progressEvent: progress?.data,
        noticesWhileBlocked: whileBlocked.map((n) => ({
          afterAskMs: n.at - asked.at,
          text: n.text,
        })),
        noticesAfter: after.length,
        parentReadNoticeAfterAnswerMs:
          parentRead === undefined ? null : parentRead.at - answerAt,
        posted: pluginConsole(artifacts).filter(
          (line) => line.includes(POSTED) && line.includes(child),
        ),
        result: fgText.slice(0, 200),
      };

      const checks = {
        parentBlocked,
        noNoticeWhileBlocked: whileBlocked.length === 0,
        noNoticeAfter: after.length === 0,
        foregroundReturned: fgText.includes("FG-DONE"),
        probeNeverEnforced: readLog(dir).every((r) => r.kind !== "enforce"),
      };

      yield* finishScenario(dir, "notice-foreground", evidence, checks);
    }),
);
