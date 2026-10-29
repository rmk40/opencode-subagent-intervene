// A background child finishes on its own while subagent_stop is stopping it, with the stop held
// open between its subtree walk and its first latch write. With `confirmStop: true` and an `ask`
// rule for `subagent_stop`, the stop waits for a permission reply at exactly that point, so the
// script decides what happens inside the window:
// - finish first: the child's shell is released and the child completes before the reply; the
//   stop reports `finished`, and the parent gets one completed notice and no cancelled one;
// - stop first: the reply goes out while the child still holds its shell; the stop reports
//   `stopped`, and the parent gets one cancelled notice and no completed one;
// - together: the shell is released and the reply sent a few milliseconds apart; either outcome
//   is fine, as long as the result, the notice, and the outcome agree.
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
  notices,
  probePlugin,
  REPO_ROOT,
  readLog,
  recordRequest,
  runDir,
  takeCall,
  toolCallResponse,
  until,
  waitEvent,
} from "../harness";

const dir = runDir("stop-finish-gated");
const REASON = "racing the finish";

type Kind = "finish-first" | "stop-first" | "together";
/** For `together`, milliseconds from the shell's release to the permission reply; negative: reply first. */
const ROUNDS: ReadonlyArray<{ readonly kind: Kind; readonly offset: number }> =
  [
    { kind: "finish-first", offset: 0 },
    { kind: "stop-first", offset: 0 },
    { kind: "finish-first", offset: 0 },
    { kind: "stop-first", offset: 0 },
    { kind: "together", offset: -5 },
    { kind: "together", offset: 0 },
    { kind: "together", offset: 0 },
    { kind: "together", offset: 5 },
    { kind: "together", offset: 10 },
    { kind: "together", offset: 20 },
  ];

const FINISHED = "finished on its own before the stop landed";

type ReplyInput = Parameters<OpenCode["permission"]["reply"]>[0];

if (!existsSync(join(REPO_ROOT, "dist", "index.js")))
  throw new Error("dist/index.js is missing; run `bun run build` first");

export default OpenCodeDriver.use(
  {
    tools: ["shell"],
    config: {
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
  ({ llm, tools, directory, opencode }) =>
    Effect.gen(function* () {
      const shells = yield* tools.control("shell");
      const children = new Map<number, string>();

      yield* llm.serve((request, index) => {
        const req = recordRequest(dir, request.body, index);
        captureToolResults(dir, request.body);
        const { last } = req;
        if (req.role === "parent") {
          if (last.role === "tool") {
            if (last.toolCallID?.startsWith("p_sub_") === true)
              return Stream.make(Llm.text("Launched."));
            if (last.toolCallID?.startsWith("p_stop_") === true)
              return Stream.make(Llm.text("STOP-DONE"));
          }
          const stop = /CMD-STOP-(\d+)/.exec(last.text);
          const child =
            stop === null ? undefined : children.get(Number(stop[1]));
          if (last.role === "user" && stop !== null && child !== undefined)
            return toolCallResponse(`p_stop_${stop[1]}`, "subagent_stop", {
              sessionIDs: [child],
              reason: REASON,
            });
          const launch = /CMD-LAUNCH-(\d+)/.exec(last.text);
          if (last.role === "user" && launch !== null)
            return toolCallResponse(`p_sub_${launch[1]}`, "subagent", {
              agent: "general",
              description: `race ${launch[1]}`,
              prompt: `ROLE<race${launch[1]}> CHILD-TASK`,
              background: true,
            });
          if (last.text.includes("<subagent"))
            return Stream.make(Llm.text("PARENT-NOTED"));
          return Stream.make(Llm.text("parent-other"));
        }
        const round = /^race(\d+)$/.exec(req.role ?? "")?.[1];
        if (round !== undefined) {
          if (last.role === "tool" && last.toolCallID === `r${round}_hold`)
            return Stream.make(Llm.text(`RACE-${round}-DONE`));
          if (last.role === "user" && last.text.includes("CHILD-TASK"))
            return toolCallResponse(`r${round}_hold`, "shell", {
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
      const atRest = (label: string, ids: readonly string[]) =>
        Effect.promise(() =>
          until(
            label,
            async () => {
              for (const id of ids)
                if (await isBusy(instance, id, 150)) return undefined;
              return true;
            },
            30_000,
          ),
        );

      const parent = (yield* ctl<{ id: string }>("create", { title: "parent" }))
        .id;
      const pendingAsk = () =>
        Effect.promise(() =>
          until(
            "subagent_stop permission request",
            async () =>
              (
                await call<
                  ReadonlyArray<{
                    readonly id: string;
                    readonly action: string;
                  }>
                >(instance, "permissions", { sessionID: parent })
              ).find((request) => request.action === "subagent_stop"),
            20_000,
          ),
        );
      const approve = (requestID: string) =>
        opencode.permission
          .reply({
            sessionID: parent as ReplyInput["sessionID"],
            requestID: requestID as ReplyInput["requestID"],
            decision: "once",
          })
          .pipe(Effect.orDie);

      const rounds: Array<Record<string, unknown>> = [];
      const verdicts: Array<{ kind: Kind; ok: boolean }> = [];

      for (const [round, { kind, offset }] of ROUNDS.entries()) {
        // A fresh background child that holds a shell.
        const launchAt = Date.now();
        yield* ctl("prompt", {
          sessionID: parent,
          text: `ROLE<parent> CMD-LAUNCH-${round}`,
        });
        const child = yield* Effect.promise(() =>
          until("child", () => childOf(dir, parent, round)),
        );
        children.set(round, child);
        const hold = yield* takeCall(shells, `r${round}_hold`);
        yield* hold.progress("holding\n");
        yield* Effect.promise(() =>
          waitEvent(dir, parent, "session.execution.succeeded", {
            since: launchAt,
          }),
        );
        yield* atRest("parent at rest", [parent]);

        // The stop walks the subtree, then waits on the permission reply.
        const stopAt = Date.now();
        yield* ctl("prompt", { sessionID: parent, text: `CMD-STOP-${round}` });
        const ask = yield* pendingAsk();
        const release = hold
          .succeed({ output: "held\n", exit: 0 })
          .pipe(Effect.ignore);
        if (kind === "finish-first") {
          yield* release;
          yield* Effect.promise(() =>
            waitEvent(dir, child, "session.execution.succeeded", {
              since: stopAt,
            }),
          );
          yield* approve(ask.id);
        } else if (kind === "stop-first") {
          yield* approve(ask.id);
          yield* hold
            .awaitInterrupted()
            .pipe(Effect.timeoutOption(15_000), Effect.asVoid);
        } else {
          const first = offset >= 0 ? release : approve(ask.id);
          const second = offset >= 0 ? approve(ask.id) : release;
          yield* first;
          if (offset !== 0) yield* Effect.sleep(Math.abs(offset));
          yield* second;
        }
        const stopText = yield* Effect.promise(() =>
          until(
            "stop result",
            () => capturedToolResult(dir, `p_stop_${round}`),
            30_000,
          ),
        );
        yield* Effect.sleep(1500);
        yield* atRest("round at rest", [parent, child]);

        const info = yield* ctl<Record<string, unknown>>("get", {
          sessionID: child,
        });
        const childNotices = notices(dir, parent).filter((n) =>
          JSON.stringify(n.metadata).includes(child),
        );
        const count = (state: string) =>
          childNotices.filter((n) =>
            JSON.stringify(n.metadata).includes(`"state":"${state}"`),
          ).length;
        const completed = count("completed");
        const cancelled = count("cancelled");
        const line = stopText
          .split("\n")
          .find((text) => text.startsWith(`- ${child}`));
        const result = /: ([^:]+)$/.exec(line ?? "")?.[1];
        const childEnd = forSession(events(readLog(dir)), child).find(
          (e) =>
            e.at >= stopAt &&
            (e.type === "session.execution.succeeded" ||
              e.type === "session.execution.interrupted"),
        );

        const finished =
          result === FINISHED &&
          completed === 1 &&
          cancelled === 0 &&
          info.outcome === "succeeded";
        const stopped =
          result === "stopped" &&
          cancelled === 1 &&
          completed === 0 &&
          info.outcome === "interrupted";
        verdicts.push({
          kind,
          ok:
            kind === "finish-first"
              ? finished
              : kind === "stop-first"
                ? stopped
                : finished || stopped,
        });
        rounds.push({
          round,
          kind,
          offset,
          child,
          result,
          outcome: info.outcome,
          completedNotices: completed,
          cancelledNotices: cancelled,
          childEnded: childEnd?.type ?? null,
        });
      }

      const evidence = { dir, parent, rounds };
      const checks = {
        finishFirstReportsFinished: verdicts
          .filter((v) => v.kind === "finish-first")
          .every((v) => v.ok),
        stopFirstReportsStopped: verdicts
          .filter((v) => v.kind === "stop-first")
          .every((v) => v.ok),
        togetherConsistent: verdicts
          .filter((v) => v.kind === "together")
          .every((v) => v.ok),
        neverBothNotices: rounds.every(
          (r) =>
            !(Number(r.completedNotices) > 0 && Number(r.cancelledNotices) > 0),
        ),
        probeNeverEnforced: readLog(dir).every((r) => r.kind !== "enforce"),
      };

      yield* finishScenario(dir, "stop-finish-gated", evidence, checks);
    }),
);
