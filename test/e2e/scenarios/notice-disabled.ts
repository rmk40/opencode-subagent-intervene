// With `promptNotices: false`, a parent hears nothing about a waiting subagent. Two background
// children each wait three times the delay set by `promptNoticeSeconds: 1`: one on a real
// permission prompt (a config `ask` rule for `glob` patterns starting with `ASK-`), one on a
// question from the `question` tool. Neither produces a notice, and the parent is not woken
// until each child's own completion notice.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { Effect, Stream } from "effect";
import { Llm, type OpenCode, OpenCodeDriver } from "opencode-drive";
import {
  call,
  childOf,
  completionNotices,
  events,
  finishScenario,
  forSession,
  instanceFor,
  notices,
  pluginConsole,
  probePlugin,
  REPO_ROOT,
  readLog,
  recordRequest,
  runDir,
  toolCallResponse,
  until,
  waitIdle,
  waitingNotices,
  waitPermission,
} from "../harness";

const dir = runDir("notice-disabled");
const DELAY_MS = 1000;

type ReplyInput = Parameters<OpenCode["permission"]["reply"]>[0];
type FormListInput = Parameters<OpenCode["session"]["form"]["list"]>[0];
type FormReplyInput = Parameters<OpenCode["session"]["form"]["reply"]>[0];

if (!existsSync(join(REPO_ROOT, "dist", "index.js")))
  throw new Error("dist/index.js is missing; run `bun run build` first");

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
          options: {
            promptNotices: false,
            promptNoticeSeconds: DELAY_MS / 1000,
          },
        },
      ],
    },
  },
  ({ llm, directory, opencode, artifacts }) =>
    Effect.gen(function* () {
      yield* llm.serve((request, index) => {
        const req = recordRequest(dir, request.body, index);
        const { last } = req;
        if (req.role === "parent") {
          if (last.role === "tool") return Stream.make(Llm.text("Launched."));
          const launch = /CMD-LAUNCH-([PQ])/.exec(last.text)?.[1];
          if (launch !== undefined)
            return toolCallResponse(`p_sub_${launch}`, "subagent", {
              agent: "general",
              description: `waiter ${launch}`,
              prompt: `ROLE<waiter${launch}> WAIT-TASK`,
              background: true,
            });
          return Stream.make(Llm.text("PARENT-NOTED"));
        }
        if (req.role === "waiterP") {
          if (last.role === "tool") return Stream.make(Llm.text("P-DONE"));
          return toolCallResponse("p_glob", "glob", { pattern: "ASK-P-*.txt" });
        }
        if (req.role === "waiterQ") {
          if (last.role === "tool") return Stream.make(Llm.text("Q-DONE"));
          return toolCallResponse("q_question", "question", {
            questions: [
              {
                question: "Keep going?",
                header: "Continue",
                options: [
                  { label: "Yes", description: "keep going" },
                  { label: "No", description: "stop here" },
                ],
              },
            ],
          });
        }
        return Stream.make(Llm.text("other"));
      });

      const instance = yield* Effect.promise(() => instanceFor(dir, directory));
      const ctl = <T = unknown>(
        op: string,
        args: Record<string, unknown> = {},
      ) => Effect.promise(() => call<T>(instance, op, args));
      const settle = (...ids: string[]) =>
        Effect.promise(async () => {
          for (const id of ids) await waitIdle(instance, id, 30_000);
        });

      const parent = (yield* ctl<{ id: string }>("create", { title: "parent" }))
        .id;
      const parentStarts = (from: number, to: number) =>
        forSession(events(readLog(dir)), parent).filter(
          (e) =>
            e.type === "session.execution.started" && e.at >= from && e.at < to,
        ).length;

      // A permission prompt left open for three times the delay.
      yield* ctl("prompt", {
        sessionID: parent,
        text: "ROLE<parent> CMD-LAUNCH-P",
      });
      const childP = yield* Effect.promise(() =>
        until("child P", () => childOf(dir, parent, 0)),
      );
      const ask = yield* Effect.promise(() =>
        waitPermission(instance, childP, "glob"),
      );
      yield* settle(parent);
      const openP = Date.now();
      yield* Effect.sleep(3 * DELAY_MS);
      const closeP = Date.now();
      const startsWhileP = parentStarts(openP, closeP);
      yield* opencode.permission
        .reply({
          sessionID: childP as ReplyInput["sessionID"],
          requestID: ask.id as ReplyInput["requestID"],
          decision: "once",
        })
        .pipe(Effect.orDie);
      yield* Effect.promise(() =>
        until("P completion", () => completionNotices(dir, parent, childP)[0]),
      );
      yield* Effect.sleep(300);
      yield* settle(childP, parent);

      // A question left open for three times the delay.
      yield* ctl("prompt", { sessionID: parent, text: "CMD-LAUNCH-Q" });
      const childQ = yield* Effect.promise(() =>
        until("child Q", () => childOf(dir, parent, 1)),
      );
      const form = yield* Effect.promise(() =>
        until(
          "Q form",
          async () =>
            (
              await Effect.runPromise(
                opencode.session.form
                  .list({ sessionID: childQ as FormListInput["sessionID"] })
                  .pipe(Effect.orDie),
              )
            )[0],
        ),
      );
      yield* settle(parent);
      const openQ = Date.now();
      yield* Effect.sleep(3 * DELAY_MS);
      const closeQ = Date.now();
      const startsWhileQ = parentStarts(openQ, closeQ);
      yield* opencode.session.form
        .reply({
          sessionID: childQ as FormReplyInput["sessionID"],
          formID: form.id as FormReplyInput["formID"],
          answer: { q0: "Yes" },
        })
        .pipe(Effect.orDie);
      yield* Effect.promise(() =>
        until("Q completion", () => completionNotices(dir, parent, childQ)[0]),
      );
      yield* Effect.sleep(300);
      yield* settle(childQ, parent);

      const waiting = waitingNotices(dir, parent);
      const parentNotices = notices(dir, parent);
      const evidence = {
        dir,
        parent,
        childP,
        childQ,
        request: ask,
        form: { id: form.id, title: form.title },
        openMs: { permission: closeP - openP, question: closeQ - openQ },
        parentStartsWhileOpen: {
          permission: startsWhileP,
          question: startsWhileQ,
        },
        parentNotices: parentNotices.map((n) => n.metadata),
        plugin: pluginConsole(artifacts),
      };

      const checks = {
        noWaitingNotice: waiting.length === 0,
        onlyCompletionNotices:
          parentNotices.length === 2 &&
          completionNotices(dir, parent, childP).length === 1 &&
          completionNotices(dir, parent, childQ).length === 1,
        parentNotWokenWhileOpen: startsWhileP === 0 && startsWhileQ === 0,
        noNoticeLog: !pluginConsole(artifacts).some((line) =>
          line.includes("notices:"),
        ),
        probeNeverEnforced: readLog(dir).every((r) => r.kind !== "enforce"),
      };

      yield* finishScenario(dir, "notice-disabled", evidence, checks);
    }),
);
