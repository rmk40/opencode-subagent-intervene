// Prompt notices with `promptNoticeSeconds: 1`. A config `ask` rule for `glob` patterns starting
// with `ASK-` makes a child's glob call wait on a real permission prompt. Three background
// children, one at a time, each with an idle parent:
// - A waits on the prompt. After the delay the parent gets exactly one
//   `<subagent-waiting … kind="permission">` notice naming the action and the pattern, and the
//   notice wakes the parent.
// - B's prompt is answered before the delay: no notice.
// - Q asks a question with the `question` tool: exactly one `kind="question"` notice naming the
//   form's title, which wakes the parent.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { Effect, Stream } from "effect";
import { Llm, type OpenCode, OpenCodeDriver } from "opencode-drive";
import {
  call,
  captureToolResults,
  childOf,
  completionNotices,
  events,
  finishScenario,
  forSession,
  instanceFor,
  isBusy,
  type LogRecord,
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

const dir = runDir("notice-prompts");
const DELAY_MS = 1000;
const POSTED = "notices: told a parent its subagent is waiting";

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
          if (last.role === "tool" && last.toolCallID?.startsWith("p_sub_"))
            return Stream.make(Llm.text("Launched."));
          const launch = /CMD-LAUNCH-([ABQ])/.exec(last.text)?.[1];
          if (launch !== undefined)
            return toolCallResponse(`p_sub_${launch}`, "subagent", {
              agent: "general",
              description: `waiter ${launch}`,
              prompt: `ROLE<waiter${launch}> WAIT-TASK`,
              background: true,
            });
          if (last.text.includes("<subagent-waiting"))
            return Stream.make(Llm.text("PARENT-SAW-WAITING"));
          if (last.text.includes("<subagent"))
            return Stream.make(Llm.text("PARENT-NOTED"));
          return Stream.make(Llm.text("parent-other"));
        }
        const waiter = /^waiter([ABQ])$/.exec(req.role ?? "")?.[1];
        if (waiter !== undefined) {
          if (last.role === "tool")
            return Stream.make(Llm.text(`${waiter}-DONE`));
          if (last.role === "user" && last.text.includes("WAIT-TASK"))
            return waiter === "Q"
              ? toolCallResponse("q_question", "question", {
                  questions: [
                    {
                      question: "Which branch should I keep?",
                      header: "Branch",
                      options: [
                        { label: "Main", description: "keep main" },
                        { label: "Topic", description: "keep the topic" },
                      ],
                    },
                  ],
                })
              : toolCallResponse(`${waiter.toLowerCase()}_glob`, "glob", {
                  pattern: `ASK-${waiter}-*.txt`,
                });
          return Stream.make(Llm.text(`${waiter}-OTHER`));
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
      const approve = (sessionID: string, requestID: string) =>
        opencode.permission
          .reply({
            sessionID: sessionID as ReplyInput["sessionID"],
            requestID: requestID as ReplyInput["requestID"],
            decision: "once",
          })
          .pipe(Effect.orDie);
      const askedEvent = (sessionID: string): LogRecord | undefined =>
        forSession(events(readLog(dir), "all"), sessionID).find(
          (e) => e.type === "permission.asked",
        );

      const parent = (yield* ctl<{ id: string }>("create", { title: "parent" }))
        .id;
      const noticesFor = (child: string) =>
        waitingNotices(dir, parent).filter((n) =>
          JSON.stringify(n.metadata).includes(`"sessionID":"${child}"`),
        );
      const postedLines = (child: string) =>
        pluginConsole(artifacts).filter(
          (line) => line.includes(POSTED) && line.includes(child),
        );
      const parentSaw = (child: string, since: number) =>
        readLlm(dir).find(
          (r) =>
            r.sessionID === parent &&
            r.at >= since &&
            r.last.text.includes(`<subagent-waiting sessionID="${child}"`),
        );
      const parentStarts = (since: number) =>
        forSession(events(readLog(dir)), parent).filter(
          (e) => e.type === "session.execution.started" && e.at >= since,
        );
      const launch = (letter: string, nth: number, first = false) =>
        Effect.gen(function* () {
          yield* ctl("prompt", {
            sessionID: parent,
            text: `${first ? "ROLE<parent> " : ""}CMD-LAUNCH-${letter}`,
          });
          return yield* Effect.promise(() =>
            until(`child ${letter}`, () => childOf(dir, parent, nth)),
          );
        });
      const finish = (child: string) =>
        Effect.gen(function* () {
          yield* Effect.promise(() =>
            until(
              `${child} completion`,
              () => completionNotices(dir, parent, child)[0],
            ),
          );
          yield* Effect.sleep(300);
          yield* settle(child, parent);
        });

      // A: the prompt stays open past the delay.
      const childA = yield* launch("A", 0, true);
      const askA = yield* Effect.promise(() =>
        waitPermission(instance, childA, "glob"),
      );
      const askedA = yield* Effect.promise(() =>
        until("A asked event", () => askedEvent(childA)),
      );
      const parentIdleBeforeA = !(yield* Effect.promise(() =>
        isBusy(instance, parent, 150),
      ));
      const noticeA = yield* Effect.promise(() =>
        until("A notice", () => noticesFor(childA)[0], 10_000),
      );
      const sawA = yield* Effect.promise(() =>
        until("parent read A's notice", () => parentSaw(childA, noticeA.at)),
      );
      const startsAfterA = parentStarts(noticeA.at - 50);
      // A second notice for the same prompt would arrive within this window.
      yield* Effect.sleep(2000);
      const noticesA = noticesFor(childA);
      yield* settle(parent);
      yield* approve(childA, askA.id);
      yield* finish(childA);

      // B: the prompt is answered before the delay.
      const childB = yield* launch("B", 1);
      const askB = yield* Effect.promise(() =>
        waitPermission(instance, childB, "glob"),
      );
      const answeredB = Date.now();
      yield* approve(childB, askB.id);
      const askedB = yield* Effect.promise(() =>
        until("B asked event", () => askedEvent(childB)),
      );
      yield* finish(childB);
      yield* Effect.sleep(
        Math.max(0, askedB.at + DELAY_MS + 2000 - Date.now()),
      );
      const noticesB = noticesFor(childB);

      // Q: a question form stays open past the delay.
      const childQ = yield* launch("Q", 2);
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
      const formCreated = yield* Effect.promise(() =>
        until("Q form event", () =>
          events(readLog(dir), "all").find(
            (e) =>
              e.type === "form.created" &&
              typeof e.data === "string" &&
              e.data.includes(form.id),
          ),
        ),
      );
      const parentIdleBeforeQ = !(yield* Effect.promise(() =>
        isBusy(instance, parent, 150),
      ));
      const noticeQ = yield* Effect.promise(() =>
        until("Q notice", () => noticesFor(childQ)[0], 10_000),
      );
      const sawQ = yield* Effect.promise(() =>
        until("parent read Q's notice", () => parentSaw(childQ, noticeQ.at)),
      );
      const startsAfterQ = parentStarts(noticeQ.at - 50);
      yield* Effect.sleep(2000);
      const noticesQ = noticesFor(childQ);
      yield* settle(parent);
      yield* opencode.session.form
        .reply({
          sessionID: childQ as FormReplyInput["sessionID"],
          formID: form.id as FormReplyInput["formID"],
          answer: { q0: "Main" },
        })
        .pipe(Effect.orDie);
      yield* finish(childQ);

      const textOf = (notice: { readonly text: unknown } | undefined) =>
        typeof notice?.text === "string" ? notice.text : "";
      const metaOf = (notice: { readonly metadata: unknown } | undefined) =>
        JSON.stringify(notice?.metadata ?? null);

      const evidence = {
        dir,
        parent,
        children: { childA, childB, childQ },
        posting: {
          request: askA,
          noticeAfterAskMs: noticeA.at - askedA.at,
          parentReadAfterNoticeMs: sawA.at - noticeA.at,
          parentIdleBeforeNotice: parentIdleBeforeA,
          parentStartsAfterNotice: startsAfterA.map((e) => e.at - noticeA.at),
          notices: noticesA.map((n) => ({
            metadata: n.metadata,
            text: n.text,
          })),
          posted: postedLines(childA),
        },
        answeredInTime: {
          answeredAfterAskMs: answeredB - askedB.at,
          notices: noticesB.length,
          posted: postedLines(childB),
        },
        question: {
          form: { id: form.id, title: form.title },
          noticeAfterFormMs: noticeQ.at - formCreated.at,
          parentReadAfterNoticeMs: sawQ.at - noticeQ.at,
          parentIdleBeforeNotice: parentIdleBeforeQ,
          parentStartsAfterNotice: startsAfterQ.map((e) => e.at - noticeQ.at),
          notices: noticesQ.map((n) => ({
            metadata: n.metadata,
            text: n.text,
          })),
          posted: postedLines(childQ),
        },
      };

      const textA = textOf(noticeA);
      const textQ = textOf(noticeQ);
      const checks = {
        postedOnce: noticesA.length === 1,
        postedAfterDelay:
          noticeA.at - askedA.at >= DELAY_MS &&
          noticeA.at - askedA.at < DELAY_MS + 1500,
        postedNamesChildAndKind: textA.startsWith(
          `<subagent-waiting sessionID="${childA}" kind="permission">Your subagent ${childA} (general, "waiter A")`,
        ),
        postedNamesActionAndResource: textA.includes(
          "on a permission prompt: glob for ASK-A-*.txt.",
        ),
        postedMetadata:
          metaOf(noticeA).includes(`"prompt":"permission"`) &&
          metaOf(noticeA).includes(`"requestID":"${askA.id}"`),
        idleParentWoken: parentIdleBeforeA && startsAfterA.length >= 1,
        answeredInTimeNoNotice:
          answeredB - askedB.at < DELAY_MS &&
          noticesB.length === 0 &&
          postedLines(childB).length === 0,
        questionPostedOnce: noticesQ.length === 1,
        questionAfterDelay:
          noticeQ.at - formCreated.at >= DELAY_MS &&
          noticeQ.at - formCreated.at < DELAY_MS + 1500,
        questionNamesTitle:
          textQ.startsWith(
            `<subagent-waiting sessionID="${childQ}" kind="question">`,
          ) && textQ.includes(`on a question: "${form.title}".`),
        questionMetadata:
          metaOf(noticeQ).includes(`"prompt":"question"`) &&
          metaOf(noticeQ).includes(`"requestID":"${form.id}"`),
        questionWokeParent: parentIdleBeforeQ && startsAfterQ.length >= 1,
        probeNeverEnforced: readLog(dir).every((r) => r.kind !== "enforce"),
      };

      yield* finishScenario(dir, "notice-prompts", evidence, checks);
    }),
);
