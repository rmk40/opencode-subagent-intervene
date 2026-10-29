// subagents.inspect through Code Mode on a background child that holds a shell with a long command.
// Two inspects 1.5 s apart both list the shell as running, with the full command as `input` and a
// `runningForMs` that grows by about the time between them, and both report the child's
// directory. After the shell finishes, an SDK compaction of the child with a scripted summary
// reply makes inspect return that summary as `earlierSummary`.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { Effect, Stream } from "effect";
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
  instanceFor,
  probePlugin,
  REPO_ROOT,
  readLog,
  recordRequest,
  runDir,
  takeCall,
  toolCallResponse,
  until,
  waitEvent,
  waitIdle,
} from "../harness";

const dir = runDir("inspect-running");
const GAP_MS = 1500;
const MARKER = "# END-OF-COMMAND-91";
const COMMAND = [
  ...Array.from(
    { length: 8 },
    (_, i) =>
      `for f in "src/part ${i}"/*.rs; do grep -n 'Vec<String>' "$f" && echo "$f & ok"; done;`,
  ),
  MARKER,
].join(" ");
const SUMMARY =
  "## Objective\n- SUMMARY-MARK-77: scan the sources for Vec<String> & report\n\n## Next Move\n1. (none)";
const COMPACTION_PROMPT = "You MUST summarize the conversation above";

type CompactInput = Parameters<OpenCode["session"]["compact"]>[0];

if (!existsSync(join(REPO_ROOT, "dist", "index.js")))
  throw new Error("dist/index.js is missing; run `bun run build` first");

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

interface Inspected {
  readonly directory?: string;
  readonly state?: string;
  readonly shell?: Record<string, unknown>;
  readonly activeTools: number;
  readonly earlierSummary?: string;
  readonly truncated?: unknown;
}

function readInspect(text: string): Inspected {
  const value = codeModeValue(text);
  if (!isRecord(value)) return { activeTools: 0 };
  const tools = Array.isArray(value.activeTools) ? value.activeTools : [];
  const shell = tools.find(
    (tool): tool is Record<string, unknown> =>
      isRecord(tool) && tool.name === "shell",
  );
  return {
    ...(typeof value.directory === "string"
      ? { directory: value.directory }
      : {}),
    ...(typeof value.state === "string" ? { state: value.state } : {}),
    ...(shell === undefined ? {} : { shell }),
    activeTools: tools.length,
    ...(typeof value.earlierSummary === "string"
      ? { earlierSummary: value.earlierSummary }
      : {}),
    truncated: value.truncated,
  };
}

const runningFor = (inspected: Inspected) =>
  typeof inspected.shell?.runningForMs === "number"
    ? inspected.shell.runningForMs
    : undefined;

export default OpenCodeDriver.use(
  {
    tools: ["shell"],
    config: {
      permissions: [],
      plugins: [probePlugin(dir), { package: REPO_ROOT, options: {} }],
    },
  },
  ({ llm, tools, directory, opencode }) =>
    Effect.gen(function* () {
      const shells = yield* tools.control("shell");
      let child = "";

      yield* llm.serve((request, index) => {
        const req = recordRequest(dir, request.body, index);
        captureToolResults(dir, request.body);
        const { last } = req;
        if (last.role === "user" && last.text.includes(COMPACTION_PROMPT))
          return Stream.make(Llm.text(SUMMARY));
        if (req.role === "parent") {
          if (last.role === "tool") {
            if (last.toolCallID === "p_sub")
              return Stream.make(Llm.text("Launched."));
            if (last.toolCallID?.startsWith("p_inspect_") === true)
              return Stream.make(Llm.text("INSPECTED"));
          }
          const nth = /CMD-INSPECT-(\d)/.exec(last.text)?.[1];
          if (nth !== undefined)
            return toolCallResponse(`p_inspect_${nth}`, "execute", {
              code: `return JSON.stringify(await tools.subagents.inspect({ sessionID: ${JSON.stringify(child)} }));`,
            });
          if (last.text.includes("<subagent"))
            return Stream.make(Llm.text("PARENT-NOTED"));
          if (last.text.includes("ROLE<parent>"))
            return toolCallResponse("p_sub", "subagent", {
              agent: "general",
              description: "inspect child",
              prompt: "ROLE<child> CHILD-TASK",
              background: true,
            });
          return Stream.make(Llm.text("parent-other"));
        }
        if (req.role === "child") {
          if (last.role === "tool")
            return Stream.make(Llm.text("CHILD-DONE: no matches"));
          if (last.role === "user" && last.text.includes("CHILD-TASK"))
            return toolCallResponse("c_scan", "shell", {
              command: COMMAND,
              description: "scan",
            });
          return Stream.make(Llm.text("CHILD-OTHER"));
        }
        return Stream.make(Llm.text("other"));
      });

      const instance = yield* Effect.promise(() => instanceFor(dir, directory));
      const ctl = <T = unknown>(
        op: string,
        args: Record<string, unknown> = {},
      ) => Effect.promise(() => call<T>(instance, op, args));
      const inspect = (nth: number) =>
        Effect.gen(function* () {
          const sentAt = Date.now();
          yield* ctl("prompt", {
            sessionID: parent,
            text: `CMD-INSPECT-${nth}`,
          });
          const text = yield* Effect.promise(() =>
            until(
              `inspect ${nth}`,
              () => capturedToolResult(dir, `p_inspect_${nth}`),
              30_000,
            ),
          );
          const readAt = Date.now();
          yield* Effect.promise(() => waitIdle(instance, parent));
          return { sentAt, readAt, text, value: readInspect(text) };
        });

      // A background child running a long shell command.
      const parent = (yield* ctl<{ id: string }>("create", { title: "parent" }))
        .id;
      const launchAt = Date.now();
      yield* ctl("prompt", { sessionID: parent, text: "ROLE<parent> launch" });
      child = yield* Effect.promise(() =>
        until("child", () => childOf(dir, parent)),
      );
      const scan = yield* takeCall(shells, "c_scan");
      const takenAt = Date.now();
      yield* scan.progress("scanning\n");
      yield* Effect.promise(() =>
        waitEvent(dir, parent, "session.execution.succeeded", {
          since: launchAt,
        }),
      );
      yield* Effect.promise(() => waitIdle(instance, parent));

      const first = yield* inspect(1);
      yield* Effect.sleep(GAP_MS);
      const second = yield* inspect(2);

      // The shell finishes, then the child is compacted.
      yield* scan.succeed({ output: "no matches\n", exit: 0 });
      yield* Effect.promise(() => waitIdle(instance, child));
      yield* Effect.sleep(500);
      yield* Effect.promise(() => waitIdle(instance, parent));
      const compactAt = Date.now();
      yield* opencode.session
        .compact({ sessionID: child as CompactInput["sessionID"] })
        .pipe(Effect.orDie);
      const compactionEnded = yield* Effect.promise(() =>
        until("compaction ended", () =>
          forSession(events(readLog(dir), "all"), child).find(
            (e) =>
              e.at >= compactAt &&
              (e.type === "session.compaction.ended" ||
                e.type === "session.compaction.failed"),
          ),
        ),
      );
      yield* Effect.promise(() => waitIdle(instance, child));
      const third = yield* inspect(3);

      const r1 = runningFor(first.value);
      const r2 = runningFor(second.value);
      const growth = r1 !== undefined && r2 !== undefined ? r2 - r1 : undefined;
      const wallGap = second.readAt - first.readAt;
      const input = (inspected: Inspected) =>
        typeof inspected.shell?.input === "string" ? inspected.shell.input : "";

      const evidence = {
        dir,
        parent,
        child,
        commandLength: COMMAND.length,
        first: {
          afterShellTakenMs: first.readAt - takenAt,
          runningForMs: r1,
          shell: first.value.shell,
          directory: first.value.directory,
          state: first.value.state,
          truncated: first.value.truncated,
        },
        second: {
          afterShellTakenMs: second.readAt - takenAt,
          runningForMs: r2,
          state: second.value.state,
        },
        runningForGrowthMs: growth,
        wallClockGapMs: wallGap,
        compaction: {
          end: compactionEnded.type,
          afterRequestMs: compactionEnded.at - compactAt,
        },
        afterCompaction: third.value,
        probeLocation: instance.location,
      };

      const checks = {
        shellListedRunning:
          first.value.state === "running" &&
          first.value.shell?.status === "running" &&
          second.value.shell?.status === "running",
        fullCommandAsInput:
          input(first.value).includes(JSON.stringify(COMMAND)) &&
          input(second.value).includes(JSON.stringify(COMMAND)),
        notCut:
          first.value.truncated === false &&
          !input(first.value).includes("\u2026"),
        runningForPositive: r1 !== undefined && r1 > 0,
        runningForGrows:
          growth !== undefined && Math.abs(growth - wallGap) < 750,
        directoryReported:
          first.value.directory === instance.location &&
          second.value.directory === instance.location,
        compactionCompleted:
          compactionEnded.type === "session.compaction.ended",
        earlierSummaryIsTheSummary: third.value.earlierSummary === SUMMARY,
        noActiveToolsAfter: third.value.activeTools === 0,
        probeNeverEnforced: readLog(dir).every((r) => r.kind !== "enforce"),
      };

      yield* finishScenario(dir, "inspect-running", evidence, checks);
    }),
);
