// A background child finishes on its own while subagent_stop stops it, at natural timing. Each
// round launches a fresh child that holds a shell, then releases the shell at a different offset
// from the parent's stop call, from shortly after it to shortly before it, so the child's last
// step races the stop. Every round must end in one consistent state: `finished` (or `already
// idle` when the child won outright) with exactly one completed notice and outcome succeeded, or
// `stopped` with exactly one cancelled notice and outcome interrupted. Never both notices, never
// neither. The `finished` window, between the stop's subtree walk and its interrupt, is a few
// milliseconds wide here; stop-finish-gated.ts holds it open to reach that branch on purpose.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { Effect, Stream } from "effect";
import { Llm, OpenCodeDriver, type Tool } from "opencode-drive";
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
  pluginConsole,
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

const dir = runDir("stop-finish-race");
const REASON = "racing the finish";
/**
 * Milliseconds from the shell's release to the parent's stop call. Negative: the stop call goes
 * out first and the shell is released that much later.
 */
const OFFSETS = [-10, -5, 0, 3, 5, 6, 7, 8, 10, 20] as const;

type ShellCall = Tool.ControlledCall<Tool.ShellInput, Tool.ShellResult>;

if (!existsSync(join(REPO_ROOT, "dist", "index.js")))
  throw new Error("dist/index.js is missing; run `bun run build` first");

interface Race {
  readonly child: string;
  readonly hold: ShellCall;
  readonly offset: number;
}

export default OpenCodeDriver.use(
  {
    tools: ["shell"],
    config: {
      permissions: [],
      plugins: [probePlugin(dir), { package: REPO_ROOT, options: {} }],
    },
  },
  ({ llm, tools, directory, artifacts }) =>
    Effect.gen(function* () {
      const shells = yield* tools.control("shell");
      const races = new Map<number, Race>();

      /** Releases the round's shell and calls subagent_stop, `offset` ms apart. */
      const raceResponse = (round: number, race: Race) => {
        const release = race.hold
          .succeed({ output: "held\n", exit: 0 })
          .pipe(Effect.ignore);
        const lag = Math.max(0, -race.offset);
        const lead = Math.max(0, race.offset);
        return Stream.fromEffectDrain(
          Effect.forkDetach(
            lag === 0
              ? release
              : Effect.sleep(lag).pipe(Effect.andThen(release)),
          ),
        ).pipe(
          Stream.concat(
            Stream.make(
              Llm.pause(lead),
              Llm.toolCall({
                index: 0,
                id: `p_stop_${round}`,
                name: "subagent_stop",
                input: { sessionIDs: [race.child], reason: REASON },
              }),
              Llm.finish("tool-calls"),
            ),
          ),
        );
      };

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
          const race = stop === null ? undefined : races.get(Number(stop[1]));
          if (last.role === "user" && stop !== null && race !== undefined)
            return raceResponse(Number(stop[1]), race);
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
      const rounds: Array<Record<string, unknown>> = [];
      const consistent: boolean[] = [];

      for (const [round, offset] of OFFSETS.entries()) {
        // A fresh background child that holds a shell.
        const launchAt = Date.now();
        yield* ctl("prompt", {
          sessionID: parent,
          text: `ROLE<parent> CMD-LAUNCH-${round}`,
        });
        const child = yield* Effect.promise(() =>
          until("child", () => childOf(dir, parent, round)),
        );
        const hold = yield* takeCall(shells, `r${round}_hold`);
        yield* hold.progress("holding\n");
        yield* Effect.promise(() =>
          waitEvent(dir, parent, "session.execution.succeeded", {
            since: launchAt,
          }),
        );
        yield* atRest("parent at rest", [parent]);
        races.set(round, { child, hold, offset });

        const stopAt = Date.now();
        yield* ctl("prompt", { sessionID: parent, text: `CMD-STOP-${round}` });
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
        const context = yield* ctl<ReadonlyArray<unknown>>("context", {
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
        const parentAll = forSession(events(readLog(dir), "all"), parent);
        const stopCalled = parentAll.find(
          (e) =>
            e.type === "session.tool.called" &&
            typeof e.data === "string" &&
            e.data.includes(`"id":"p_stop_${round}"`),
        );
        const childEnd = forSession(events(readLog(dir)), child).find(
          (e) =>
            e.at >= stopAt &&
            (e.type === "session.execution.succeeded" ||
              e.type === "session.execution.interrupted"),
        );

        const finished =
          (result === "finished on its own before the stop landed" ||
            result === "already idle") &&
          completed === 1 &&
          cancelled === 0 &&
          info.outcome === "succeeded";
        const stopped =
          result === "stopped" &&
          cancelled === 1 &&
          completed === 0 &&
          info.outcome === "interrupted";
        consistent.push(finished || stopped);
        rounds.push({
          round,
          offset,
          child,
          result,
          outcome: info.outcome,
          completedNotices: completed,
          cancelledNotices: cancelled,
          replyPersisted: JSON.stringify(context).includes(
            `RACE-${round}-DONE`,
          ),
          childEnded:
            childEnd === undefined || stopCalled === undefined
              ? null
              : {
                  type: childEnd.type,
                  afterStopCallMs: childEnd.at - stopCalled.at,
                },
        });
      }

      const results = rounds.map((r) => r.result);
      const evidence = {
        dir,
        parent,
        rounds,
        distribution: Object.fromEntries(
          [...new Set(results)].map((r) => [
            String(r),
            results.filter((x) => x === r).length,
          ]),
        ),
        plugin: pluginConsole(artifacts).length,
      };

      const checks = {
        everyRoundConsistent: consistent.every((ok) => ok),
        neverBothNotices: rounds.every(
          (r) =>
            !(Number(r.completedNotices) > 0 && Number(r.cancelledNotices) > 0),
        ),
        // At least one round where the shell was released no later than the stop call and the
        // child's last step was still underway when the stop landed.
        raceHit: rounds.some(
          (r) =>
            Number(r.offset) >= 0 &&
            (r.result === "finished on its own before the stop landed" ||
              r.result === "stopped"),
        ),
        probeNeverEnforced: readLog(dir).every((r) => r.kind !== "enforce"),
      };

      yield* finishScenario(dir, "stop-finish-race", evidence, checks);
    }),
);
