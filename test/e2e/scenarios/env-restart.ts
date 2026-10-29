// Restarts. Four Drive servers run one after another on one database file (OPENCODE_DRIVE_DB), so
// sessions and plugin storage survive each server's shutdown while every in-memory plugin instance
// is lost. The sessions keep the first server's project directory as their location.
// - First server: the parent stops a background child that holds a shell.
// - Second server, warm: the plugin is installed only in the sessions' location, so no other
//   location loads it. A scripted prompt to the parent loads that location and reads the stop back
//   through subagents.list; a synthetic wake of the child posted through the SDK is then interrupted
//   by the stored latch.
// - Third server, cold, same install: the first synthetic wake reaches the location before any
//   instance is loaded. The run it starts is already in progress when the plugin loads, so it is
//   left alone and finishes, as documented. A second synthetic wake after it settles is interrupted.
// - Fourth server, cold, global install: the terminal's own location has already loaded an
//   instance, and every instance sees every session's events, so that instance interrupts the first
//   wake even though the sessions' location is still unloaded when the run starts.
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
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
  type Instance,
  instanceFor,
  instances,
  type JsonValue,
  LIST_SUBTREE_CODE,
  listedLatches,
  type LogRecord,
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

const dir = runDir("env-restart");
const DATABASE = join(dir, "restart.sqlite");
// Drive reads OPENCODE_DRIVE_DB each time it creates an instance, so every server below opens this
// file instead of an in-memory database.
process.env.OPENCODE_DRIVE_DB = DATABASE;

const REASON = "restart check";
const ENFORCED = "latch: interrupted a run in a stopped session";
const EXEMPTED = "it was running at startup";

if (!existsSync(join(REPO_ROOT, "dist", "index.js")))
  throw new Error("dist/index.js is missing; run `bun run build` first");

type SessionID = Parameters<OpenCode["session"]["synthetic"]>[0]["sessionID"];

const subagentIntervene: JsonValue = { package: REPO_ROOT, options: {} };

const serverDir = (name: string) => {
  const folder = join(dir, name);
  mkdirSync(folder, { recursive: true });
  return folder;
};

/**
 * Writes the plugins of the sessions' location's own project config, or removes that config so the
 * running server's global config applies there alone. The first server's fixture config stays in
 * that directory otherwise, pointing at its own probe folder and tool endpoint.
 */
function setLocationPlugins(
  location: string,
  plugins: ReadonlyArray<JsonValue> | undefined,
) {
  const file = join(location, ".opencode", "opencode.jsonc");
  if (plugins === undefined) rmSync(file, { force: true });
  else writeFileSync(file, `${JSON.stringify({ plugins }, undefined, 2)}\n`);
}

const isTerminal = (event: LogRecord) =>
  event.type === "session.execution.succeeded" ||
  event.type === "session.execution.interrupted" ||
  event.type === "session.execution.failed";

/** The first run of `sessionID` that starts at or after `since`, and the event that ends it. */
const runAfter = (folder: string, sessionID: string, since: number) =>
  Effect.gen(function* () {
    const start = yield* Effect.promise(() =>
      waitEvent(folder, sessionID, "session.execution.started", {
        since,
        timeoutMs: 20_000,
      }),
    );
    const end = yield* Effect.promise(() =>
      until(`run of ${sessionID} settled`, () =>
        forSession(events(readLog(folder)), sessionID).find(
          (e) => e.at >= start.at && isTerminal(e),
        ),
      ),
    );
    return {
      start,
      end,
      summary: {
        startedAfterMs: start.at - since,
        endedAfterStartMs: end.at - start.at,
        end: end.type,
        reason: end.reason,
      },
    };
  });

const synthetic = (opencode: OpenCode, sessionID: string, text: string) =>
  opencode.session
    .synthetic({ sessionID: sessionID as SessionID, text })
    .pipe(Effect.orDie);

/** The child answers a wake slowly, so a reply can only be persisted if the latch misses its run. */
const wokenReply = (text: string) => {
  const tag = /([A-Z]+-WAKE-\d)/.exec(text)?.[1] ?? "UNTAGGED-WAKE";
  return Stream.make(Llm.pause(1500), Llm.text(`REPLY-TO-${tag}`));
};

/** Polls the child until its `time.idle` moves past `idleBefore`, which a finished run does. */
const settledAfter = (
  instance: Instance,
  sessionID: string,
  idleBefore: number | undefined,
) =>
  Effect.promise(() =>
    until(
      "run settled",
      async () => {
        const info = await call<{
          outcome?: string;
          time: { idle?: number };
        }>(instance, "get", { sessionID });
        return info.time.idle !== idleBefore ? info : undefined;
      },
      30_000,
    ),
  );

const contextText = (instance: Instance, sessionID: string) =>
  Effect.promise(() =>
    call<ReadonlyArray<unknown>>(instance, "context", { sessionID }).then(
      (context) => JSON.stringify(context),
    ),
  );

const enforcements = (artifacts: string) =>
  pluginConsole(artifacts).filter((line) => line.includes(ENFORCED));

const firstServerDir = serverDir("server-1");
let keptArtifacts: string | undefined;

/** First server: stop a background child that holds a shell. */
const stopServer = OpenCodeDriver.use(
  {
    keepArtifacts: true,
    tools: ["shell"],
    config: {
      permissions: [],
      plugins: [probePlugin(firstServerDir), subagentIntervene],
    },
  },
  ({ llm, tools, directory, artifacts }) =>
    Effect.gen(function* () {
      keptArtifacts = artifacts;
      const folder = firstServerDir;
      const shells = yield* tools.control("shell");
      let child = "";
      yield* llm.serve((request, index) => {
        const req = recordRequest(folder, request.body, index);
        captureToolResults(folder, request.body);
        const { last } = req;
        if (req.role === "parent") {
          if (last.toolCallID === "p_sub")
            return Stream.make(Llm.text("Launched."));
          if (last.toolCallID === "p_stop")
            return Stream.make(Llm.text("STOP-DONE"));
          if (last.text.includes("CMD-STOP"))
            return toolCallResponse("p_stop", "subagent_stop", {
              sessionIDs: [child],
              reason: REASON,
            });
          if (last.text.includes("<subagent"))
            return Stream.make(Llm.text("PARENT-NOTED"));
          if (last.text.includes("ROLE<parent>"))
            return toolCallResponse("p_sub", "subagent", {
              agent: "general",
              description: "restart child",
              prompt: "ROLE<child> CHILD-TASK",
              background: true,
            });
          return Stream.make(Llm.text("parent-other"));
        }
        if (req.role === "child") {
          if (last.role === "user" && last.text.includes("CHILD-TASK"))
            return toolCallResponse("c_hold", "shell", {
              command: "hold",
              description: "hold",
            });
          return wokenReply(last.text);
        }
        return Stream.make(Llm.text("other"));
      });

      const instance = yield* Effect.promise(() =>
        instanceFor(folder, directory),
      );
      const ctl = <T = unknown>(
        op: string,
        args: Record<string, unknown> = {},
      ) => Effect.promise(() => call<T>(instance, op, args));

      const parent = (yield* ctl<{ id: string }>("create", { title: "parent" }))
        .id;
      const launchAt = Date.now();
      yield* ctl("prompt", { sessionID: parent, text: "ROLE<parent> launch" });
      child = yield* Effect.promise(() =>
        until("child", () => childOf(folder, parent)),
      );
      const hold = yield* shells.take("c_hold");
      yield* hold.progress("holding\n");
      yield* Effect.promise(() =>
        waitEvent(folder, parent, "session.execution.succeeded", {
          since: launchAt,
        }),
      );

      yield* ctl("prompt", { sessionID: parent, text: "CMD-STOP" });
      const shellInterrupted = yield* hold
        .awaitInterrupted()
        .pipe(Effect.as(true), Effect.timeoutOption(15_000));
      const stopText = yield* Effect.promise(() =>
        until(
          "stop result",
          () => capturedToolResult(folder, "p_stop"),
          30_000,
        ),
      );
      yield* Effect.promise(() =>
        until("cancelled notice", () =>
          notices(folder, parent).find((n) =>
            JSON.stringify(n.metadata).includes('"cancelled"'),
          ),
        ),
      );
      yield* Effect.sleep(500);
      // Nothing may be running when this server stops, or restart recovery would resume it.
      yield* Effect.promise(() => waitIdle(instance, parent));
      yield* Effect.promise(() => waitIdle(instance, child));
      const childInfo = yield* ctl<Record<string, unknown>>("get", {
        sessionID: child,
      });
      return {
        parent,
        child,
        location: directory,
        stopText,
        shellInterrupted: Option.isSome(shellInterrupted),
        childOutcome: childInfo.outcome,
        pid: instance.pid,
      };
    }),
);

type Stopped = Effect.Success<typeof stopServer>;

/** Second server: warm the location with a parent prompt, then wake the child through the SDK. */
const warmServer = (stopped: Stopped) => {
  const folder = serverDir("server-2");
  const { parent, child, location } = stopped;
  setLocationPlugins(location, [probePlugin(folder), subagentIntervene]);
  return OpenCodeDriver.use(
    { config: { permissions: [], plugins: [] } },
    ({ llm, opencode, artifacts }) =>
      Effect.gen(function* () {
        yield* llm.serve((request, index) => {
          const req = recordRequest(folder, request.body, index);
          captureToolResults(folder, request.body);
          const { last } = req;
          if (req.role === "parent") {
            if (last.toolCallID === "p_warm")
              return Stream.make(Llm.text("WARM-DONE"));
            if (last.text.includes("CMD-WARM"))
              return toolCallResponse("p_warm", "execute", {
                code: LIST_SUBTREE_CODE,
              });
            return Stream.make(Llm.text("parent-other"));
          }
          if (req.role === "child") return wokenReply(last.text);
          return Stream.make(Llm.text("other"));
        });

        const warmAt = Date.now();
        yield* opencode.session
          .prompt({ sessionID: parent as SessionID, text: "CMD-WARM" })
          .pipe(Effect.orDie);
        const listText = yield* Effect.promise(() =>
          until(
            "warm list result",
            () => capturedToolResult(folder, "p_warm"),
            30_000,
          ),
        );
        const instance = yield* Effect.promise(() =>
          instanceFor(folder, location),
        );
        yield* Effect.promise(() => waitIdle(instance, parent));
        const warmMs = Date.now() - warmAt;

        const wakeAt = Date.now();
        yield* synthetic(
          opencode,
          child,
          "<restart-notice>WARM-WAKE-1</restart-notice>",
        );
        const woken = yield* runAfter(folder, child, wakeAt);
        yield* Effect.sleep(2500);
        const context = yield* contextText(instance, child);
        const childInfo = yield* Effect.promise(() =>
          call<{ time: { idle?: number } }>(instance, "get", {
            sessionID: child,
          }),
        );
        return {
          warmMs,
          latch: listedLatches(codeModeValue(listText)).get(child),
          woken: woken.summary,
          replyPersisted: context.includes("REPLY-TO-WARM-WAKE-1"),
          childIdleAt: childInfo.time.idle,
          enforcements: enforcements(artifacts),
          probeInstances: instances(folder).map((item) => item.location),
          pid: instance.pid,
        };
      }),
  );
};

/** Third server: wake the child through the SDK before anything loads its location. */
const coldServer = (stopped: Stopped, idleBefore: number | undefined) => {
  const folder = serverDir("server-3");
  const { child, location } = stopped;
  setLocationPlugins(location, [probePlugin(folder), subagentIntervene]);
  return OpenCodeDriver.use(
    { config: { permissions: [], plugins: [] } },
    ({ llm, opencode, artifacts }) =>
      Effect.gen(function* () {
        yield* llm.serve((request, index) => {
          const req = recordRequest(folder, request.body, index);
          if (req.role === "child") return wokenReply(req.last.text);
          return Stream.make(Llm.text("other"));
        });

        const firstWakeAt = Date.now();
        yield* synthetic(
          opencode,
          child,
          "<restart-notice>COLD-WAKE-1</restart-notice>",
        );
        const instance = yield* Effect.promise(() =>
          instanceFor(folder, location),
        );
        const loadedAfterMs = Date.now() - firstWakeAt;
        const first = yield* settledAfter(instance, child, idleBefore);
        const firstContext = yield* contextText(instance, child);
        const firstEvents = forSession(events(readLog(folder)), child).map(
          (e) => ({ t: e.at - firstWakeAt, type: e.type, reason: e.reason }),
        );
        yield* Effect.promise(() => waitIdle(instance, child));

        const secondWakeAt = Date.now();
        yield* synthetic(
          opencode,
          child,
          "<restart-notice>COLD-WAKE-2</restart-notice>",
        );
        const second = yield* runAfter(folder, child, secondWakeAt);
        yield* Effect.sleep(2500);
        const context = yield* contextText(instance, child);
        const childInfo = yield* Effect.promise(() =>
          call<{ time: { idle?: number } }>(instance, "get", {
            sessionID: child,
          }),
        );
        return {
          loadedAfterMs,
          first: {
            outcome: first.outcome,
            idleAfterWakeMs:
              first.time.idle === undefined
                ? undefined
                : first.time.idle - firstWakeAt,
            replyPersisted: firstContext.includes("REPLY-TO-COLD-WAKE-1"),
            eventsSeenByProbe: firstEvents,
          },
          second: {
            ...second.summary,
            replyPersisted: context.includes("REPLY-TO-COLD-WAKE-2"),
          },
          exempted: pluginConsole(artifacts).some((line) =>
            line.includes(EXEMPTED),
          ),
          enforcements: enforcements(artifacts),
          childIdleAt: childInfo.time.idle,
          probeInstances: instances(folder).map((item) => item.location),
          pid: instance.pid,
        };
      }),
  );
};

/** Fourth server: the plugin installed globally, so the terminal's location loads it at launch. */
const coldGlobalServer = (stopped: Stopped) => {
  const folder = serverDir("server-4");
  const { child, location } = stopped;
  setLocationPlugins(location, undefined);
  return OpenCodeDriver.use(
    {
      config: {
        permissions: [],
        plugins: [probePlugin(folder), subagentIntervene],
      },
    },
    ({ llm, opencode, artifacts, directory }) =>
      Effect.gen(function* () {
        yield* llm.serve((request, index) => {
          const req = recordRequest(folder, request.body, index);
          if (req.role === "child") return wokenReply(req.last.text);
          return Stream.make(Llm.text("other"));
        });
        const terminal = yield* Effect.promise(() =>
          instanceFor(folder, directory),
        );

        const wakeAt = Date.now();
        yield* synthetic(
          opencode,
          child,
          "<restart-notice>GLOBAL-WAKE-1</restart-notice>",
        );
        const woken = yield* runAfter(folder, child, wakeAt);
        const sessionsInstance = yield* Effect.promise(() =>
          instanceFor(folder, location),
        );
        yield* Effect.sleep(2500);
        const context = yield* contextText(sessionsInstance, child);
        const sessionsLoadedAt = readLog(folder).find(
          (r) => r.kind === "ready" && r.instance === sessionsInstance.instance,
        )?.at;
        return {
          woken: woken.summary,
          observedBy:
            woken.start.instance === terminal.instance
              ? "terminal location"
              : "sessions' location",
          sessionsLocationLoadedAfterStartMs:
            sessionsLoadedAt === undefined
              ? undefined
              : sessionsLoadedAt - woken.start.at,
          replyPersisted: context.includes("REPLY-TO-GLOBAL-WAKE-1"),
          enforcements: enforcements(artifacts),
          pid: terminal.pid,
        };
      }),
  );
};

export default Effect.gen(function* () {
  const stopped = yield* stopServer;
  const warm = yield* warmServer(stopped);
  const cold = yield* coldServer(stopped, warm.childIdleAt);
  const global = yield* coldGlobalServer(stopped);

  const probeEnforced = ["server-1", "server-2", "server-3", "server-4"].some(
    (name) => readLog(join(dir, name)).some((r) => r.kind === "enforce"),
  );
  const evidence = { dir, database: DATABASE, stopped, warm, cold, global };
  const onlySessionsLocation = (locations: ReadonlyArray<string>) =>
    locations.length === 1 && locations[0] === stopped.location;
  const checks = {
    databaseFile: existsSync(DATABASE),
    fourServerProcesses:
      new Set([stopped.pid, warm.pid, cold.pid, global.pid]).size === 4,
    stopShellInterrupted: stopped.shellInterrupted,
    stopResultStopped:
      stopped.stopText.includes(`- ${stopped.child}`) &&
      /: stopped$/m.test(stopped.stopText),
    stopOutcomeInterrupted: stopped.childOutcome === "interrupted",
    warmOnlySessionsLocationLoaded: onlySessionsLocation(warm.probeInstances),
    warmLatchSurvived: warm.latch === "active",
    warmWakeInterrupted:
      warm.woken.end === "session.execution.interrupted" &&
      warm.woken.endedAfterStartMs < 1000,
    warmNoReply: !warm.replyPersisted,
    warmOneEnforcement:
      warm.enforcements.length === 1 &&
      warm.enforcements[0]?.includes("interrupted: true") === true,
    coldOnlySessionsLocationLoaded: onlySessionsLocation(cold.probeInstances),
    coldFirstRunNotStopped:
      cold.first.outcome === "succeeded" && cold.first.replyPersisted,
    coldFirstRunExempted: cold.exempted,
    coldSecondWakeInterrupted:
      cold.second.end === "session.execution.interrupted" &&
      cold.second.endedAfterStartMs < 1000,
    coldSecondNoReply: !cold.second.replyPersisted,
    coldOneEnforcement: cold.enforcements.length === 1,
    globalStartedBeforeSessionsLocationLoaded:
      global.observedBy === "terminal location" &&
      (global.sessionsLocationLoadedAfterStartMs ?? -1) > 0,
    globalColdWakeInterrupted:
      global.woken.end === "session.execution.interrupted" &&
      global.woken.endedAfterStartMs < 1000,
    globalNoReply: !global.replyPersisted,
    probeNeverEnforced: !probeEnforced,
  };
  yield* finishScenario(dir, "env-restart", evidence, checks);
}).pipe(
  Effect.ensuring(
    Effect.sync(() => {
      if (keptArtifacts !== undefined)
        rmSync(keptArtifacts, { recursive: true, force: true });
    }),
  ),
);
