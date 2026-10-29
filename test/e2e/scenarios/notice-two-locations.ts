// Prompt notices with two locations loaded. The plugin comes from global config (Drive's
// OPENCODE_CONFIG_DIR), so each location loads its own instance, and every instance sees every
// event. The parent stays in the project directory; its child is moved to a second directory with
// the SDK's `session.move` and continued there in the background. With `promptNoticeSeconds: 1`:
// - the child waits on a real permission prompt (a config `ask` rule for `glob` patterns starting
//   with `ASK-`), held by the second location; the parent gets exactly one notice;
// - the child asks a question with the `question` tool; both instances post its notice under the
//   same inbox item ID, and the parent still gets exactly one.
import { existsSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { Effect, Result, Stream } from "effect";
import { Llm, type OpenCode, OpenCodeDriver } from "opencode-drive";
import {
  call,
  childOf,
  completionNotices,
  events,
  finishScenario,
  type Instance,
  instanceFor,
  notices,
  pendingPermissions,
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

const dir = runDir("notice-two-locations");
const DELAY_MS = 1000;
const POSTED = "notices: told a parent its subagent is waiting";

type MoveInput = Parameters<OpenCode["session"]["move"]>[0];
type ReplyInput = Parameters<OpenCode["permission"]["reply"]>[0];
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
      const locationB = resolve(directory, "..", "location-b");
      mkdirSync(locationB, { recursive: true });
      let child = "";

      yield* llm.serve((request, index) => {
        const req = recordRequest(dir, request.body, index);
        const { last } = req;
        if (req.role === "parent") {
          if (last.role === "tool") return Stream.make(Llm.text("Launched."));
          const task = /CMD-(PERM|ASK)/.exec(last.text)?.[1];
          if (task !== undefined)
            return toolCallResponse(`p_${task.toLowerCase()}`, "subagent", {
              agent: "general",
              description: "moved child",
              sessionID: child,
              prompt: `${task}-TASK`,
              background: true,
            });
          if (last.text.includes("<subagent-waiting"))
            return Stream.make(Llm.text("PARENT-SAW-WAITING"));
          if (last.text.includes("ROLE<parent>"))
            return toolCallResponse("p_sub", "subagent", {
              agent: "general",
              description: "moved child",
              prompt: "ROLE<child> CHILD-TASK",
              background: true,
            });
          return Stream.make(Llm.text("PARENT-NOTED"));
        }
        if (req.role === "child") {
          if (last.role === "tool") return Stream.make(Llm.text("CHILD-DONE"));
          if (last.role === "user" && last.text.includes("PERM-TASK"))
            return toolCallResponse("c_glob", "glob", {
              pattern: "ASK-L-*.txt",
            });
          if (last.role === "user" && last.text.includes("ASK-TASK"))
            return toolCallResponse("c_question", "question", {
              questions: [
                {
                  question: "Which location?",
                  header: "Location",
                  options: [
                    { label: "First", description: "the project" },
                    { label: "Second", description: "location-b" },
                  ],
                },
              ],
            });
          return Stream.make(Llm.text("CHILD-OTHER"));
        }
        return Stream.make(Llm.text("other"));
      });

      const a = yield* Effect.promise(() => instanceFor(dir, directory));
      const ctl = <T = unknown>(
        instance: Instance,
        op: string,
        args: Record<string, unknown> = {},
      ) => Effect.promise(() => call<T>(instance, op, args));
      const settle = (instance: Instance, ...ids: string[]) =>
        Effect.promise(async () => {
          for (const id of ids) await waitIdle(instance, id, 30_000);
        });

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
        until(
          "first completion",
          () => completionNotices(dir, parent, child)[0],
        ),
      );
      yield* Effect.sleep(300);
      yield* settle(a, child, parent);

      // The child moves to the second location, which loads its own instance.
      yield* opencode.session
        .move({
          sessionID: child as MoveInput["sessionID"],
          directory: locationB as MoveInput["directory"],
        })
        .pipe(Effect.orDie);
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
      yield* settle(b, child);
      yield* settle(a, parent);

      const noticesFor = (requestID: string) =>
        waitingNotices(dir, parent).filter((n) =>
          JSON.stringify(n.metadata).includes(`"requestID":"${requestID}"`),
        );
      /** Enqueued records for the notice across both probe instances, before de-duplication. */
      const probeRecords = (requestID: string) =>
        notices(dir, parent).filter((n) =>
          JSON.stringify(n.metadata).includes(`"requestID":"${requestID}"`),
        ).length;
      const postedFor = (requestID: string) =>
        pluginConsole(artifacts).filter(
          (line) => line.includes(POSTED) && line.includes(requestID),
        );
      /** Ends the child's wait: answers through the SDK, or interrupts it from its own location. */
      const release = (answer: Effect.Effect<void, unknown>) =>
        Effect.gen(function* () {
          const answered = yield* Effect.result(answer);
          if (Result.isFailure(answered))
            yield* ctl(b, "interrupt", { sessionID: child });
          return Result.isSuccess(answered) ? "answered" : "interrupted";
        });

      // A permission prompt, held in the child's location.
      const permAt = Date.now();
      yield* ctl(a, "prompt", { sessionID: parent, text: "CMD-PERM" });
      const ask = yield* Effect.promise(() => waitPermission(b, child, "glob"));
      const seenFromA = yield* Effect.promise(() =>
        pendingPermissions(a, child),
      );
      const permNotice = yield* Effect.promise(() =>
        until("permission notice", () => noticesFor(ask.id)[0], 10_000),
      );
      yield* Effect.sleep(2500);
      const permNotices = noticesFor(ask.id);
      const permPosted = postedFor(ask.id);
      const permEnd = yield* release(
        opencode.permission.reply({
          sessionID: child as ReplyInput["sessionID"],
          requestID: ask.id as ReplyInput["requestID"],
          decision: "once",
        }),
      );
      yield* Effect.sleep(500);
      yield* settle(b, child);
      yield* Effect.sleep(500);
      yield* settle(a, parent);

      // A question.
      const askAt = Date.now();
      yield* ctl(a, "prompt", { sessionID: parent, text: "CMD-ASK" });
      const formID = yield* Effect.promise(() =>
        until("form created", () => {
          const created = events(readLog(dir), "all").find(
            (e) =>
              e.type === "form.created" &&
              e.at >= askAt &&
              typeof e.data === "string" &&
              e.data.includes(child),
          );
          return typeof created?.data === "string"
            ? /"id":"(frm_[^"]+)"/.exec(created.data)?.[1]
            : undefined;
        }),
      );
      const formSeenBy = [
        ...new Set(
          events(readLog(dir), "all")
            .filter(
              (e) =>
                e.type === "form.created" &&
                typeof e.data === "string" &&
                e.data.includes(formID),
            )
            .map((e) => e.instance),
        ),
      ];
      const askNotice = yield* Effect.promise(() =>
        until("question notice", () => noticesFor(formID)[0], 10_000),
      );
      yield* Effect.sleep(2500);
      const askNotices = noticesFor(formID);
      const askPosted = postedFor(formID);
      const askEnd = yield* release(
        opencode.session.form.reply({
          sessionID: child as FormReplyInput["sessionID"],
          formID: formID as FormReplyInput["formID"],
          answer: { q0: "Second" },
        }),
      );
      yield* Effect.sleep(500);
      yield* settle(b, child);
      yield* Effect.sleep(500);
      yield* settle(a, parent);

      const loaded = readLog(dir).filter((r) => r.kind === "ready");
      const unloaded = readLog(dir).filter((r) => r.kind === "cleanup");
      const evidence = {
        dir,
        parent,
        child,
        locations: { a: a.location, b: b.location },
        instances: { a: a.instance, b: b.instance },
        loadedInstances: loaded.map((r) => ({
          instance: r.instance,
          location: r.location,
        })),
        unloadedBeforeEnd: unloaded.map((r) => r.instance),
        permission: {
          request: ask,
          pendingSeenFromParentLocation: seenFromA.length,
          noticeAfterPromptMs: permNotice.at - permAt,
          notices: permNotices.map((n) => ({
            eventID: n.eventID,
            text: n.text,
          })),
          probeRecords: probeRecords(ask.id),
          posted: permPosted,
          end: permEnd,
        },
        question: {
          formID,
          formCreatedSeenBy: formSeenBy,
          noticeAfterPromptMs: askNotice.at - askAt,
          notices: askNotices.map((n) => ({
            eventID: n.eventID,
            text: n.text,
          })),
          probeRecords: probeRecords(formID),
          posted: askPosted,
          end: askEnd,
        },
      };

      const checks = {
        childMoved:
          resolve(moved.location.directory) === locationB &&
          b.location === moved.location.directory &&
          a.location !== b.location,
        bothLocationsStayedLoaded:
          unloaded.length === 0 &&
          [a.instance, b.instance].every((id) =>
            loaded.some((r) => r.instance === id),
          ),
        permissionOneNotice:
          permNotices.length === 1 &&
          typeof permNotice.text === "string" &&
          permNotice.text.includes("glob for ASK-L-*.txt"),
        questionSeenByBothInstances:
          formSeenBy.includes(a.instance) && formSeenBy.includes(b.instance),
        questionPostedByBothInstances: askPosted.length === 2,
        questionOneNotice:
          askNotices.length === 1 &&
          typeof askNotice.text === "string" &&
          askNotice.text.includes('kind="question"'),
        probeNeverEnforced: readLog(dir).every((r) => r.kind !== "enforce"),
      };

      yield* finishScenario(dir, "notice-two-locations", evidence, checks);
    }),
);
