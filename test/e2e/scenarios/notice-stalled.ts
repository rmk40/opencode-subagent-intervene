// Stall notices with `stallNoticeMinutes: 0.05` (3 s). A background child's model response starts
// and then streams nothing until the script releases it, so the child runs with no tool call, no
// prompt open and no progress. Its idle parent gets exactly one
// `<subagent-stalled … kind="no-progress">` notice, which wakes it, and no second one however long
// the silence lasts. While the child is silent, subagents.list shows it running with the last
// progress the plugin observed. Nothing interrupts the child, which finishes once released.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { Effect, Stream } from "effect";
import { Llm, OpenCodeDriver } from "opencode-drive";
import {
  call,
  captureToolResults,
  capturedToolResult,
  childOf,
  codeModeValue,
  distinctNotices,
  events,
  finishScenario,
  forSession,
  Gate,
  instanceFor,
  probePlugin,
  REPO_ROOT,
  readLog,
  recordRequest,
  runDir,
  toolCallResponse,
  until,
  waitIdle,
} from "../harness";

const dir = runDir("notice-stalled");
const THRESHOLD_MS = 3000;

if (!existsSync(join(REPO_ROOT, "dist", "index.js")))
  throw new Error("dist/index.js is missing; run `bun run build` first");

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const stallNotices = (sessionID: string) =>
  distinctNotices(dir, sessionID).filter(
    (notice) =>
      isRecord(notice.metadata) && notice.metadata.kind === "subagent-stalled",
  );

export default OpenCodeDriver.use(
  {
    config: {
      permissions: [{ action: "*", resource: "*", effect: "allow" }],
      plugins: [
        probePlugin(dir),
        {
          package: REPO_ROOT,
          options: { stallNoticeMinutes: THRESHOLD_MS / 60_000 },
        },
      ],
    },
  },
  ({ llm, directory }) =>
    Effect.gen(function* () {
      const release = new Gate();
      let child = "";
      yield* llm.serve((request, index) => {
        const req = recordRequest(dir, request.body, index);
        captureToolResults(dir, request.body);
        const { last } = req;
        if (req.role === "parent") {
          if (last.role === "tool" && last.toolCallID === "p_sub")
            return Stream.make(Llm.text("Launched."));
          if (last.role === "tool" && last.toolCallID === "p_list")
            return Stream.make(Llm.text("LISTED"));
          if (last.text.includes("CMD-LIST"))
            return toolCallResponse("p_list", "execute", {
              code: `return JSON.stringify(await tools.subagents.list({ sessionIDs: [${JSON.stringify(child)}] }));`,
            });
          if (last.text.includes("<subagent-stalled"))
            return Stream.make(Llm.text("PARENT-NOTED-STALL"));
          if (last.text.includes("ROLE<parent>"))
            return toolCallResponse("p_sub", "subagent", {
              agent: "general",
              description: "stalling child",
              prompt: "ROLE<child> STALL-TASK",
              background: true,
            });
          return Stream.make(Llm.text("parent-other"));
        }
        if (req.role === "child") {
          if (last.role === "user" && last.text.includes("STALL-TASK"))
            // The response starts, then streams nothing until released.
            return Stream.fromEffect(Effect.promise(() => release.opened)).pipe(
              Stream.flatMap(() => Stream.make(Llm.text("CHILD-DONE"))),
            );
          return Stream.make(Llm.text("CHILD-OTHER"));
        }
        return Stream.make(Llm.text("other"));
      });

      const instance = yield* Effect.promise(() => instanceFor(dir, directory));
      const parent = (yield* Effect.promise(() =>
        call<{ id: string }>(instance, "create", { title: "parent" }),
      )).id;
      const launchedAt = Date.now();
      yield* Effect.promise(() =>
        call(instance, "prompt", { sessionID: parent, text: "ROLE<parent> launch" }),
      );
      child = yield* Effect.promise(() =>
        until("child", () => childOf(dir, parent)),
      );
      const first = yield* Effect.promise(() =>
        until("stall notice", () => stallNotices(parent)[0], 30_000),
      );
      yield* Effect.promise(() => waitIdle(instance, parent, 30_000));

      // The silence goes on for three more thresholds: no second notice.
      yield* Effect.sleep(3 * THRESHOLD_MS);
      const afterSilence = stallNotices(parent);
      yield* Effect.promise(() => waitIdle(instance, parent, 30_000));

      yield* Effect.promise(() =>
        call(instance, "prompt", { sessionID: parent, text: "CMD-LIST" }),
      );
      const listText = yield* Effect.promise(() =>
        until("list result", () => capturedToolResult(dir, "p_list"), 30_000),
      );
      yield* Effect.promise(() => waitIdle(instance, parent, 30_000));
      const listed = codeModeValue(listText);
      const entries =
        isRecord(listed) && Array.isArray(listed.entries) ? listed.entries : [];
      const entry = entries.find(
        (item): item is Record<string, unknown> =>
          isRecord(item) && item.sessionID === child,
      );

      release.open();
      yield* Effect.promise(() => waitIdle(instance, child, 30_000));
      yield* Effect.sleep(1000);
      yield* Effect.promise(() => waitIdle(instance, parent, 30_000));

      const log = readLog(dir);
      const childEvents = forSession(events(log), child).map((event) => event.type);
      // The event log keeps only the start of a notice; the parent's history has all of it.
      const history = yield* Effect.promise(() =>
        call<unknown[]>(instance, "context", { sessionID: parent }),
      );
      const stored = history.filter(
        (item): item is Record<string, unknown> =>
          isRecord(item) &&
          item.type === "synthetic" &&
          isRecord(item.metadata) &&
          item.metadata.kind === "subagent-stalled",
      );
      const text = typeof stored[0]?.text === "string" ? stored[0].text : "";
      const metadata = isRecord(first.metadata) ? first.metadata : {};
      const evidence = {
        dir,
        parent,
        child,
        noticeAfterMs: first.at - launchedAt,
        notice: first,
        noticesAfterSilence: afterSilence.length,
        finalNotices: stallNotices(parent).length,
        entry,
        childEvents,
      };
      yield* finishScenario(dir, "notice-stalled", evidence, {
        oneNoticeToTheParent: afterSilence.length === 1,
        noticeIsNoProgress:
          metadata.stall === "no-progress" &&
          metadata.sessionID === child &&
          metadata.plugin === "subagent-intervene",
        noticeText:
          stored.length === 1 &&
          text.startsWith(
            `<subagent-stalled sessionID="${child}" kind="no-progress">Your subagent ${child} (general`,
          ) &&
          text.includes(
            "appears stalled: it is running but has shown no progress for ",
          ) &&
          text.endsWith(
            "Nothing was interrupted; it keeps running until you act.</subagent-stalled>",
          ),
        noticeAfterTheThreshold: first.at - launchedAt >= THRESHOLD_MS,
        noticeWokeTheParent: log.some(
          (record) =>
            record.kind === "event" &&
            record.sessionID === parent &&
            record.type === "session.execution.started" &&
            record.at >= first.at,
        ),
        listShowsItRunningWithLastActivity:
          entry?.state === "running" &&
          entry.stateSource === "event" &&
          typeof entry.lastActivityAt === "number" &&
          entry.lastActivityAt >= launchedAt &&
          entry.noRecordedEnd === undefined,
        childNeverInterrupted: !childEvents.includes(
          "session.execution.interrupted",
        ),
        childFinished: childEvents.includes("session.execution.succeeded"),
        noNoticeAfterItFinished: stallNotices(parent).length === 1,
      });
    }),
);
