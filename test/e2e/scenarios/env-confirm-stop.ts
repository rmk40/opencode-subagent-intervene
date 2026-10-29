// With option `confirmStop: true`, subagent_stop asks for the `subagent_stop` permission on each
// stopped root's agent before it writes or interrupts anything. A config deny rule fails the call
// before any side effect: the child's held shell is never interrupted, no latch is written, and the
// child finishes its run normally. An allow rule for the child's agent lets the stop through without
// a permission prompt.
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { Effect, Option, Stream } from "effect";
import { Llm, OpenCodeDriver } from "opencode-drive";
import {
  call,
  captureToolResults,
  capturedToolResult,
  childOf,
  codeModeValue,
  events,
  finishScenario,
  forSession,
  instanceFor,
  isBusy,
  type JsonValue,
  LIST_SUBTREE_CODE,
  listedLatches,
  notices,
  pluginConsole,
  probePlugin,
  REPO_ROOT,
  readLog,
  recordRequest,
  runDir,
  toolCallResponse,
  until,
  waitEvent,
  waitIdle,
} from "../harness";

const dir = runDir("env-confirm-stop");
const REASON = "confirm-stop check";

if (!existsSync(join(REPO_ROOT, "dist", "index.js")))
  throw new Error("dist/index.js is missing; run `bun run build` first");

type Rule = { readonly [key: string]: JsonValue };

interface ListEntry {
  readonly sessionID?: unknown;
  readonly state?: unknown;
}

/**
 * One Drive run: a background general child holds a shell, and the parent calls subagent_stop on
 * it under `rules`. The shell is released afterwards if the stop did not interrupt it.
 */
const confirmRun = (label: string, rules: ReadonlyArray<Rule>) => {
  const runFolder = join(dir, label);
  mkdirSync(runFolder, { recursive: true });
  return OpenCodeDriver.use(
    {
      tools: ["shell"],
      config: {
        permissions: [...rules],
        plugins: [
          probePlugin(runFolder),
          { package: REPO_ROOT, options: { confirmStop: true } },
        ],
      },
    },
    ({ llm, tools, directory, artifacts }) =>
      Effect.gen(function* () {
        const shells = yield* tools.control("shell");
        let child = "";

        yield* llm.serve((request, index) => {
          const req = recordRequest(runFolder, request.body, index);
          captureToolResults(runFolder, request.body);
          const { last } = req;
          if (req.role === "parent") {
            if (last.role === "tool") {
              if (last.toolCallID === "p_sub")
                return Stream.make(Llm.text("Launched."));
              if (last.toolCallID === "p_stop")
                return Stream.make(Llm.text("STOP-REPLIED"));
              if (last.toolCallID === "p_list")
                return Stream.make(Llm.text("LISTED"));
            }
            if (last.text.includes("CMD-STOP"))
              return toolCallResponse("p_stop", "subagent_stop", {
                sessionIDs: [child],
                reason: REASON,
              });
            if (last.text.includes("CMD-LIST"))
              return toolCallResponse("p_list", "execute", {
                code: LIST_SUBTREE_CODE,
              });
            if (last.text.includes("<subagent"))
              return Stream.make(Llm.text("PARENT-NOTED"));
            if (last.text.includes("ROLE<parent>"))
              return toolCallResponse("p_sub", "subagent", {
                agent: "general",
                description: "confirm child",
                prompt: "ROLE<child> CHILD-TASK",
                background: true,
              });
            return Stream.make(Llm.text("parent-other"));
          }
          if (req.role === "child") {
            if (last.role === "tool" && last.toolCallID === "c_hold")
              return Stream.make(Llm.text("CHILD-FINISHED"));
            if (last.role === "user" && last.text.includes("CHILD-TASK"))
              return toolCallResponse("c_hold", "shell", {
                command: "hold",
                description: "hold",
              });
            return Stream.make(Llm.pause(1500), Llm.text("UNEXPECTED-TURN"));
          }
          return Stream.make(Llm.text("other"));
        });

        const instance = yield* Effect.promise(() =>
          instanceFor(runFolder, directory),
        );
        const ctl = <T = unknown>(
          op: string,
          args: Record<string, unknown> = {},
        ) => Effect.promise(() => call<T>(instance, op, args));
        const wait = (sessionID: string, type: string, since: number) =>
          Effect.promise(() =>
            waitEvent(runFolder, sessionID, type, { since, timeoutMs: 20_000 }),
          );

        const parent = (yield* ctl<{ id: string }>("create", {
          title: "parent",
        })).id;
        const launchAt = Date.now();
        yield* ctl("prompt", {
          sessionID: parent,
          text: "ROLE<parent> launch",
        });
        child = yield* Effect.promise(() =>
          until("child", () => childOf(runFolder, parent)),
        );
        const hold = yield* shells.take("c_hold");
        yield* hold.progress("holding\n");
        yield* wait(parent, "session.execution.succeeded", launchAt);

        const stopAt = Date.now();
        yield* ctl("prompt", { sessionID: parent, text: "CMD-STOP" });
        const stopText = yield* Effect.promise(() =>
          until(
            "stop result",
            () => capturedToolResult(runFolder, "p_stop"),
            30_000,
          ),
        );
        const stopResultAt = Date.now();
        // A stop that got through has interrupted the shell by the time its result arrives.
        const interrupted = yield* hold
          .awaitInterrupted()
          .pipe(Effect.as(true), Effect.timeoutOption(4000));
        const childBusyAfterStop = yield* Effect.promise(() =>
          isBusy(instance, child),
        );
        yield* Effect.promise(() => waitIdle(instance, parent));

        const listAt = Date.now();
        yield* ctl("prompt", { sessionID: parent, text: "CMD-LIST" });
        const listText = yield* Effect.promise(() =>
          until(
            "list result",
            () => capturedToolResult(runFolder, "p_list"),
            30_000,
          ),
        );
        yield* wait(parent, "session.execution.succeeded", listAt);

        // A child the stop never reached still holds its shell; release it so it finishes.
        const releaseAt = Date.now();
        if (Option.isNone(interrupted))
          yield* hold.succeed({ output: "released\n", exit: 0 });
        const childEnd = yield* Effect.promise(() =>
          until("child settled", () =>
            forSession(events(readLog(runFolder)), child).find(
              (e) =>
                e.at >= stopAt &&
                (e.type === "session.execution.succeeded" ||
                  e.type === "session.execution.interrupted" ||
                  e.type === "session.execution.failed"),
            ),
          ),
        );
        yield* Effect.promise(() =>
          until("parent notice", () =>
            notices(runFolder, parent).find((n) => n.at >= launchAt),
          ),
        );
        yield* Effect.sleep(500);
        yield* Effect.promise(() => waitIdle(instance, parent));

        const childInfo = yield* ctl<Record<string, unknown>>("get", {
          sessionID: child,
        });
        const listValue = codeModeValue(listText);
        const entries: ReadonlyArray<ListEntry> =
          typeof listValue === "object" &&
          listValue !== null &&
          "entries" in listValue &&
          Array.isArray(listValue.entries)
            ? listValue.entries
            : [];
        const listed = entries.find((entry) => entry.sessionID === child);
        const all = events(readLog(runFolder), "all");
        return {
          dir: runFolder,
          parent,
          child,
          stopText,
          stopResultMs: stopResultAt - stopAt,
          shellInterrupted: Option.isSome(interrupted),
          childBusyAfterStop,
          childEnd: {
            type: childEnd.type,
            reason: childEnd.reason,
            afterStopMs: childEnd.at - stopAt,
            afterReleaseMs: childEnd.at - releaseAt,
          },
          childOutcome: childInfo.outcome,
          childInterruptsAfterStop: forSession(
            events(readLog(runFolder)),
            child,
          ).filter(
            (e) => e.at >= stopAt && e.type === "session.execution.interrupted",
          ).length,
          permissionEvents: all
            .filter((e) => e.at >= stopAt && e.type?.startsWith("permission."))
            .map((e) => ({ type: e.type, data: e.data })),
          listedState: listed?.state,
          listedLatch: listedLatches(listValue).get(child),
          listedChild: listed !== undefined,
          noticeStates: notices(runFolder, parent).map((n) =>
            JSON.stringify(n.metadata),
          ),
          probeNeverEnforced: readLog(runFolder).every(
            (r) => r.kind !== "enforce",
          ),
          plugin: pluginConsole(artifacts),
        };
      }),
  );
};

export default Effect.gen(function* () {
  const denied = yield* confirmRun("deny-rule", [
    { action: "*", resource: "*", effect: "allow" },
    { action: "subagent_stop", resource: "*", effect: "deny" },
  ]);
  const allowed = yield* confirmRun("allow-rule", [
    { action: "subagent_stop", resource: "general", effect: "allow" },
  ]);

  const evidence = { dir, denied, allowed };
  const checks = {
    denyFailsTheCall:
      /denied/i.test(denied.stopText) && !/: stopped$/m.test(denied.stopText),
    denyNeverInterruptsShell: !denied.shellInterrupted,
    denyChildKeptRunning: denied.childBusyAfterStop,
    denyNoLatch: denied.listedChild && denied.listedLatch === undefined,
    denyListedRunning: denied.listedState === "running",
    denyChildFinishedNormally:
      denied.childEnd.type === "session.execution.succeeded" &&
      denied.childOutcome === "succeeded" &&
      denied.childInterruptsAfterStop === 0,
    denyCompletedNotice:
      denied.noticeStates.length === 1 &&
      denied.noticeStates.every((n) => n.includes('"completed"')),
    denyNoPrompt: denied.permissionEvents.length === 0,
    allowStops:
      allowed.stopText.includes(`- ${allowed.child}`) &&
      /: stopped$/m.test(allowed.stopText),
    allowInterruptsShell: allowed.shellInterrupted,
    allowChildInterrupted:
      allowed.childEnd.type === "session.execution.interrupted" &&
      allowed.childOutcome === "interrupted",
    allowNoPrompt: allowed.permissionEvents.length === 0,
    allowLatched: allowed.listedLatch === "active",
    allowCancelledNotice:
      allowed.noticeStates.length === 1 &&
      allowed.noticeStates.every((n) => n.includes('"cancelled"')),
    probeNeverEnforced: denied.probeNeverEnforced && allowed.probeNeverEnforced,
  };

  yield* finishScenario(dir, "env-confirm-stop", evidence, checks);
});
