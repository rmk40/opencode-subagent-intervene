// Loading the plugin while a stopped child is already running. The plugin is added to and removed
// from the live config file, and OpenCode's config watcher reloads plugins each time. The child is
// stopped while the plugin is loaded, woken by a notice while it is not, and is holding a shell when
// the plugin loads again. Then:
// - the reload leaves the held shell running;
// - subagents.list reports the child running with `stateSource: "probe"`, since the new instance
//   never saw its run start, and subagents.inspect shows the held shell as an active tool;
// - the run in progress at load is exempt and finishes normally;
// - the next notice wake is interrupted, because the stored latch is still active.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Effect, Option, Stream } from "effect";
import { Llm, type OpenCode, OpenCodeDriver } from "opencode-drive";
import {
  call,
  captureToolResults,
  capturedToolResult,
  childOf,
  codeModeValue,
  events,
  finishScenario,
  forSession,
  instances,
  instanceFor,
  type JsonValue,
  notices,
  pluginConsole,
  probePlugin,
  REPO_ROOT,
  readLlm,
  readLog,
  recordRequest,
  runDir,
  toolCallResponse,
  until,
  waitEvent,
  waitIdle,
} from "../harness";

const dir = runDir("env-late-load");
const REASON = "late load check";
const PLUGIN_ID = "subagent-intervene";

if (!existsSync(join(REPO_ROOT, "dist", "index.js")))
  throw new Error("dist/index.js is missing; run `bun run build` first");

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const subagentIntervene: JsonValue = { package: REPO_ROOT, options: {} };

/** Rewrites the `plugins` list of the fixture's config file, which OpenCode watches. */
function editPlugins(
  directory: string,
  edit: (plugins: ReadonlyArray<JsonValue>) => ReadonlyArray<JsonValue>,
) {
  const file = join(directory, ".opencode", "opencode.jsonc");
  const config = JSON.parse(readFileSync(file, "utf8")) as Record<
    string,
    JsonValue
  >;
  const plugins = Array.isArray(config.plugins) ? config.plugins : [];
  writeFileSync(
    file,
    `${JSON.stringify({ ...config, plugins: edit(plugins) }, undefined, 2)}\n`,
  );
}

const isSubagentIntervene = (entry: JsonValue) =>
  isRecord(entry) && entry.package === REPO_ROOT;

/** Whether the location's plugin inventory lists subagent-intervene as active. */
const pluginActive = (opencode: OpenCode) =>
  opencode.plugin.list().pipe(
    Effect.orDie,
    Effect.map((list) =>
      list.data.some(
        (plugin) => plugin.id === PLUGIN_ID && plugin.state.status === "active",
      ),
    ),
  );

const awaitPlugin = (opencode: OpenCode, active: boolean) =>
  Effect.gen(function* () {
    const deadline = Date.now() + 30_000;
    while ((yield* pluginActive(opencode)) !== active) {
      if (Date.now() > deadline)
        return yield* Effect.die(
          new Error(
            `subagent-intervene never became ${active ? "active" : "inactive"}`,
          ),
        );
      yield* Effect.sleep(50);
    }
    return Date.now();
  });

export default OpenCodeDriver.use(
  {
    tools: ["shell"],
    config: { permissions: [], plugins: [probePlugin(dir)] },
  },
  ({ llm, tools, directory, artifacts, opencode }) =>
    Effect.gen(function* () {
      const shells = yield* tools.control("shell");
      let child = "";

      yield* llm.serve((request, index) => {
        const req = recordRequest(dir, request.body, index);
        captureToolResults(dir, request.body);
        const { last } = req;
        if (req.role === "parent") {
          if (last.role === "tool") {
            if (last.toolCallID === "p_sub")
              return Stream.make(Llm.text("Launched."));
            if (last.toolCallID === "p_stop")
              return Stream.make(Llm.text("STOP-DONE"));
            if (last.toolCallID === "p_read")
              return Stream.make(Llm.text("READ-DONE"));
          }
          if (last.text.includes("CMD-STOP"))
            return toolCallResponse("p_stop", "subagent_stop", {
              sessionIDs: [child],
              reason: REASON,
            });
          if (last.text.includes("CMD-READ"))
            return toolCallResponse("p_read", "execute", {
              code: `const list = await tools.subagents.list({}); const inspect = await tools.subagents.inspect({ sessionID: ${JSON.stringify(child)} }); return JSON.stringify({ list, inspect });`,
            });
          if (last.text.includes("<subagent"))
            return Stream.make(Llm.text("PARENT-NOTED"));
          if (last.text.includes("ROLE<parent>"))
            return toolCallResponse("p_sub", "subagent", {
              agent: "general",
              description: "late child",
              prompt: "ROLE<child> CHILD-TASK",
              background: true,
            });
          return Stream.make(Llm.text("parent-other"));
        }
        if (req.role === "child") {
          if (last.role === "tool" && last.toolCallID === "c_hold_late")
            return Stream.make(Llm.text("LATE-RUN-DONE"));
          if (last.text.includes("LATE-WAKE"))
            return toolCallResponse("c_hold_late", "shell", {
              command: "hold",
              description: "hold",
            });
          if (last.role === "user" && last.text.includes("CHILD-TASK"))
            return Stream.make(Llm.text("CHILD-FIRST-DONE"));
          // A woken run answers slowly, so a reply can only be persisted if the latch misses it.
          return Stream.make(Llm.pause(1500), Llm.text("WOKEN-REPLY"));
        }
        return Stream.make(Llm.text("other"));
      });

      const instance = yield* Effect.promise(() => instanceFor(dir, directory));
      const ctl = <T = unknown>(
        op: string,
        args: Record<string, unknown> = {},
      ) => Effect.promise(() => call<T>(instance, op, args));
      const wait = (
        sessionID: string,
        type: string,
        since: number,
        timeoutMs = 20_000,
      ) =>
        Effect.promise(() =>
          waitEvent(dir, sessionID, type, { since, timeoutMs }),
        );

      // Load the plugin, launch a child that finishes, and stop it while idle, which latches it.
      const firstEditAt = Date.now();
      editPlugins(directory, (plugins) => [...plugins, subagentIntervene]);
      const firstLoadAt = yield* awaitPlugin(opencode, true);

      const parent = (yield* ctl<{ id: string }>("create", { title: "parent" }))
        .id;
      yield* ctl("prompt", { sessionID: parent, text: "ROLE<parent> launch" });
      child = yield* Effect.promise(() =>
        until("child", () => childOf(dir, parent)),
      );
      yield* Effect.promise(() =>
        until("completed notice", () =>
          notices(dir, parent).find((n) =>
            JSON.stringify(n.metadata).includes('"completed"'),
          ),
        ),
      );
      yield* Effect.sleep(300);
      yield* Effect.promise(() => waitIdle(instance, parent));
      yield* ctl("prompt", { sessionID: parent, text: "CMD-STOP" });
      const stopText = yield* Effect.promise(() =>
        until("stop result", () => capturedToolResult(dir, "p_stop"), 30_000),
      );
      yield* Effect.promise(() => waitIdle(instance, parent));

      // Unload it, then let a notice wake the child, which starts holding a shell.
      const unloadEditAt = Date.now();
      editPlugins(directory, (plugins) =>
        plugins.filter((entry) => !isSubagentIntervene(entry)),
      );
      const unloadedAt = yield* awaitPlugin(opencode, false);
      const wakeAt = Date.now();
      yield* ctl("synthetic", {
        sessionID: child,
        text: "<late-notice>LATE-WAKE</late-notice>",
      });
      const hold = yield* shells.take("c_hold_late");
      yield* hold.progress("holding\n");
      const heldAt = Date.now();

      // Load it again while the child runs.
      const reloadEditAt = Date.now();
      editPlugins(directory, (plugins) => [...plugins, subagentIntervene]);
      const reloadedAt = yield* awaitPlugin(opencode, true);
      const interruptedByReload = yield* hold
        .awaitInterrupted()
        .pipe(Effect.as(true), Effect.timeoutOption(1500));

      const readAt = Date.now();
      yield* ctl("prompt", { sessionID: parent, text: "CMD-READ" });
      const readText = yield* Effect.promise(() =>
        until("read result", () => capturedToolResult(dir, "p_read"), 30_000),
      );
      yield* wait(parent, "session.execution.succeeded", readAt);

      // The run in progress at load finishes on its own.
      const releaseAt = Date.now();
      yield* hold.succeed({ output: "released\n", exit: 0 });
      const lateEnd = yield* Effect.promise(() =>
        until("late run settled", () =>
          forSession(events(readLog(dir)), child).find(
            (e) =>
              e.at >= releaseAt &&
              (e.type === "session.execution.succeeded" ||
                e.type === "session.execution.interrupted" ||
                e.type === "session.execution.failed"),
          ),
        ),
      );
      yield* Effect.sleep(500);
      const childAfterLateRun = yield* ctl<Record<string, unknown>>("get", {
        sessionID: child,
      });

      // The next wake is enforced.
      const secondWakeAt = Date.now();
      yield* ctl("synthetic", {
        sessionID: child,
        text: "<late-notice>SECOND-WAKE</late-notice>",
      });
      const secondStart = yield* wait(
        child,
        "session.execution.started",
        secondWakeAt,
      );
      const secondEnd = yield* Effect.promise(() =>
        until("second wake settled", () =>
          forSession(events(readLog(dir)), child).find(
            (e) =>
              e.at >= secondStart.at &&
              (e.type === "session.execution.succeeded" ||
                e.type === "session.execution.interrupted" ||
                e.type === "session.execution.failed"),
          ),
        ),
      );
      yield* Effect.sleep(2500);
      const childContext = yield* ctl<ReadonlyArray<unknown>>("context", {
        sessionID: child,
      });

      const read = codeModeValue(readText);
      const listEntry =
        isRecord(read) &&
        isRecord(read.list) &&
        Array.isArray(read.list.entries)
          ? read.list.entries.find(
              (entry: unknown) => isRecord(entry) && entry.sessionID === child,
            )
          : undefined;
      const inspect = isRecord(read) ? read.inspect : undefined;
      const activeTools =
        isRecord(inspect) && Array.isArray(inspect.activeTools)
          ? inspect.activeTools
          : [];
      const childEvents = forSession(events(readLog(dir)), child);
      const plugin = pluginConsole(artifacts);
      const contextText = JSON.stringify(childContext);

      const evidence = {
        dir,
        parent,
        child,
        timings: {
          firstLoadMs: firstLoadAt - firstEditAt,
          unloadMs: unloadedAt - unloadEditAt,
          reloadMs: reloadedAt - reloadEditAt,
          heldBeforeReloadMs: reloadEditAt - heldAt,
          lateRunEndAfterReleaseMs: lateEnd.at - releaseAt,
          secondStartAfterWakeMs: secondStart.at - secondWakeAt,
          secondEndAfterStartMs: secondEnd.at - secondStart.at,
        },
        stopText,
        listEntry,
        inspect,
        lateRun: {
          end: lateEnd.type,
          reason: lateEnd.reason,
          outcome: childAfterLateRun.outcome,
        },
        secondWake: { end: secondEnd.type, reason: secondEnd.reason },
        childEventsSinceWake: childEvents
          .filter((e) => e.at >= wakeAt)
          .map((e) => ({ t: e.at - wakeAt, type: e.type, reason: e.reason })),
        childRequestsAfterSecondWake: readLlm(dir).filter(
          (r) => r.sessionID === child && r.at >= secondWakeAt,
        ).length,
        probeInstances: instances(dir).length,
        plugin,
      };

      const checks = {
        stoppedWhileIdle:
          stopText.includes(`- ${child}`) &&
          /: already idle$/m.test(stopText),
        reloadLeftShellRunning: Option.isNone(interruptedByReload),
        listRunning: isRecord(listEntry) && listEntry.state === "running",
        listFromProbe: isRecord(listEntry) && listEntry.stateSource === "probe",
        listLatchActive:
          isRecord(listEntry) &&
          isRecord(listEntry.stopped) &&
          listEntry.stopped.latch === "active",
        inspectShowsHeldShell: activeTools.some(
          (tool: unknown) =>
            isRecord(tool) &&
            tool.name === "shell" &&
            tool.status === "running",
        ),
        runAtLoadExempted: plugin.some((line) =>
          line.includes("it was running at startup"),
        ),
        runAtLoadFinished:
          lateEnd.type === "session.execution.succeeded" &&
          childAfterLateRun.outcome === "succeeded" &&
          contextText.includes("LATE-RUN-DONE"),
        noInterruptBeforeSecondWake: !childEvents.some(
          (e) =>
            e.at >= wakeAt &&
            e.at < secondWakeAt &&
            e.type === "session.execution.interrupted",
        ),
        secondWakeInterrupted:
          secondEnd.type === "session.execution.interrupted" &&
          secondEnd.at - secondStart.at < 1000,
        noWokenReply: !contextText.includes("WOKEN-REPLY"),
        // The unloaded instance's subscription is gone, so only the reloaded one enforces.
        oneEnforcement:
          plugin.filter((line) =>
            line.includes("latch: interrupted a run in a stopped session"),
          ).length === 1,
        probeLoadedOnce: instances(dir).length === 1,
        probeNeverEnforced: readLog(dir).every((r) => r.kind !== "enforce"),
      };

      yield* finishScenario(dir, "env-late-load", evidence, checks);
    }),
);
