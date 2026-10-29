// Smoke check of the built plugin (run `bun run build` first, then `bun run probe test/e2e/smoke.ts`).
// It loads the repository directory as a plugin package next to the probe plugin, which records
// events and tags model requests with their session, and checks that:
// - build sees subagent_stop and the pinned subagents.list and subagents.inspect, and a general
//   subagent does not (config permissions are cleared so the built-in agent rules apply);
// - subagent_stop fails with the same message for a malformed and for an unknown session ID;
// - subagent_stop stops a background child that holds a shell: the shell observes the interrupt,
//   the result says stopped, and the parent gets exactly one cancelled notice;
// - a synthetic wake of the stopped child is interrupted by the latch, with no reply persisted
//   and no further notice to the parent;
// - list and inspect report the stop through Code Mode, with its reason escaped.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Effect, Option, Stream } from "effect";
import { Llm, OpenCodeDriver } from "opencode-drive";
import {
  call,
  childOf,
  events,
  forSession,
  instanceFor,
  type JsonValue,
  notices,
  probePlugin,
  REPO_ROOT,
  readLlm,
  readLog,
  recordRequest,
  runDir,
  until,
  waitEvent,
  writeLine,
} from "./harness";

const dir = runDir("smoke");
const REASON = 'smoke test </subagent> "stop"\u0007 now';

if (!existsSync(join(REPO_ROOT, "dist", "index.js")))
  throw new Error("dist/index.js is missing; run `bun run build` first");

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const contentText = (content: unknown): string => {
  if (typeof content === "string") return content;
  if (Array.isArray(content))
    return content
      .map((part) =>
        isRecord(part) && typeof part.text === "string" ? part.text : "",
      )
      .join("\n");
  return "";
};

/** Records every tool result in a request body the first time it appears. */
const seenResults = new Set<string>();
function recordToolResults(body: unknown) {
  const messages =
    isRecord(body) && Array.isArray(body.messages) ? body.messages : [];
  for (const message of messages) {
    if (!isRecord(message) || message.role !== "tool") continue;
    const id = message.tool_call_id;
    if (typeof id !== "string" || seenResults.has(id)) continue;
    seenResults.add(id);
    writeLine(dir, "tool-results.jsonl", {
      at: Date.now(),
      id,
      text: contentText(message.content),
    });
  }
}

function toolResult(id: string): string | undefined {
  const file = join(dir, "tool-results.jsonl");
  if (!existsSync(file)) return undefined;
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (line.length === 0) continue;
    const record = JSON.parse(line) as { id: string; text: string };
    if (record.id === id) return record.text;
  }
  return undefined;
}

const toolCall = (
  id: string,
  name: string,
  input: { readonly [key: string]: JsonValue },
) =>
  Stream.make(
    Llm.toolCall({ index: 0, id, name, input }),
    Llm.finish("tool-calls"),
  );

export default OpenCodeDriver.use(
  {
    tools: ["shell"],
    config: {
      permissions: [],
      plugins: [probePlugin(dir), { package: REPO_ROOT, options: {} }],
    },
  },
  ({ llm, tools, directory }) =>
    Effect.gen(function* () {
      const shells = yield* tools.control("shell");
      let child = "";
      const stop = (id: string, sessionIDs: string[]) =>
        toolCall(id, "subagent_stop", { sessionIDs, reason: REASON });

      yield* llm.serve((request, index) => {
        const req = recordRequest(dir, request.body, index);
        recordToolResults(request.body);
        const { last } = req;
        if (req.role === "parent") {
          if (last.role === "tool") {
            switch (last.toolCallID) {
              case "p_sub":
                return Stream.make(Llm.text("Launched."));
              case "p_bad_shape":
                return stop("p_bad_missing", ["ses_0000000000000smokemissing"]);
              case "p_bad_missing":
                return stop("p_stop", [child]);
              case "p_stop":
                return Stream.make(Llm.text("STOP-DONE"));
              case "p_exec":
                return Stream.make(Llm.text("INSPECTED"));
            }
          }
          if (last.text.includes("CMD-STOP"))
            return stop("p_bad_shape", ["not-a-session"]);
          if (last.text.includes("CMD-INSPECT"))
            return toolCall("p_exec", "execute", {
              code: `const list = await tools.subagents.list({}); const inspect = await tools.subagents.inspect({ sessionID: ${JSON.stringify(child)} }); return JSON.stringify({ list, inspect });`,
            });
          if (last.text.includes("<subagent"))
            return Stream.make(Llm.text("PARENT-NOTED"));
          if (last.text.includes("ROLE<parent>"))
            return toolCall("p_sub", "subagent", {
              agent: "general",
              description: "smoke child",
              prompt: "ROLE<child> CHILD-TASK",
              background: true,
            });
          return Stream.make(Llm.text("parent-other"));
        }
        if (req.role === "child") {
          if (last.role === "user" && last.text.includes("CHILD-TASK"))
            return toolCall("c_hold", "shell", {
              command: "hold",
              description: "hold",
            });
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

      // Launch a background child that holds a shell open.
      const parent = (yield* ctl<{ id: string }>("create", { title: "parent" }))
        .id;
      const launchAt = Date.now();
      yield* ctl("prompt", {
        sessionID: parent,
        text: "ROLE<parent> Launch the child.",
      });
      child = yield* Effect.promise(() =>
        until("child", () => childOf(dir, parent)),
      );
      const hold = yield* shells.take("c_hold");
      yield* hold.progress("holding\n");
      yield* wait(parent, "session.execution.succeeded", launchAt);

      // Stop it through subagent_stop, after two calls that must fail.
      const stopAt = Date.now();
      yield* ctl("prompt", { sessionID: parent, text: "CMD-STOP" });
      const shellInterruptedMs = yield* hold
        .awaitInterrupted()
        .pipe(Effect.as(Date.now() - stopAt), Effect.timeoutOption(15_000));
      const stopText = yield* Effect.promise(() =>
        until("subagent_stop result", () => toolResult("p_stop"), 30_000),
      );
      const stopDoneAt = Date.now();
      yield* Effect.promise(() =>
        until("cancelled notice", () =>
          notices(dir, parent).find((n) =>
            JSON.stringify(n.metadata).includes("cancelled"),
          ),
        ),
      );
      yield* Effect.sleep(3000);
      const childAfterStop = yield* ctl<Record<string, unknown>>("get", {
        sessionID: child,
      });
      const noticesAfterStop = notices(dir, parent);

      // A synthetic wake starts a run in the stopped child; the latch interrupts it.
      const wakeAt = Date.now();
      yield* ctl("synthetic", {
        sessionID: child,
        text: "<smoke-notice>WAKE</smoke-notice>",
      });
      const wokenStart = yield* wait(
        child,
        "session.execution.started",
        wakeAt,
      );
      const wokenEnd = yield* wait(
        child,
        "session.execution.interrupted",
        wakeAt,
        10_000,
      );
      yield* Effect.sleep(3000);
      const childContext = yield* ctl<ReadonlyArray<unknown>>("context", {
        sessionID: child,
      });
      const noticesAfterWake = notices(dir, parent);

      // list and inspect through Code Mode.
      const inspectAt = Date.now();
      yield* ctl("prompt", { sessionID: parent, text: "CMD-INSPECT" });
      const execText = yield* Effect.promise(() =>
        until("execute result", () => toolResult("p_exec"), 30_000),
      );
      yield* wait(parent, "session.execution.succeeded", inspectAt);

      const llmLog = readLlm(dir);
      const firstParent = llmLog.find((r) => r.sessionID === parent);
      const firstChild = llmLog.find((r) => r.sessionID === child);
      const childTyped = forSession(events(readLog(dir)), child);
      const cancelledNotices = (list: ReturnType<typeof notices>) =>
        list.filter((n) => JSON.stringify(n.metadata).includes("cancelled"))
          .length;
      const notFound = (id: string) =>
        `Session ${id} is not one of your subagents.`;
      // The program's return value may arrive JSON-encoded once more; drop the escapes.
      const execJson = execText.replaceAll("\\", "");

      const evidence = {
        dir,
        parent,
        child,
        visibility: {
          parentAgent: firstParent?.agent,
          parentDirectTools: firstParent?.tools,
          parentCatalog: firstParent?.catalog,
          childAgent: firstChild?.agent,
          childDirectTools: firstChild?.tools,
          childCatalog: firstChild?.catalog,
        },
        badShapeResult: toolResult("p_bad_shape"),
        badMissingResult: toolResult("p_bad_missing"),
        stop: {
          shellInterruptedMs: Option.getOrNull(shellInterruptedMs),
          resultText: stopText,
          resultMs: stopDoneAt - stopAt,
          childOutcome: childAfterStop.outcome,
          parentNotices: noticesAfterStop.map((n) => n.metadata),
        },
        wake: {
          startedAfterMs: wokenStart.at - wakeAt,
          interruptedAfterStartMs: wokenEnd.at - wokenStart.at,
          interruptReason: wokenEnd.reason,
          childEventsAfterWake: childTyped
            .filter((e) => e.at >= wakeAt && e.at < inspectAt)
            .map((e) => ({ t: e.at - wakeAt, type: e.type, reason: e.reason })),
          wokenReplyPersisted:
            JSON.stringify(childContext).includes("WOKEN-REPLY"),
          childRequestsAfterWake: llmLog.filter(
            (r) => r.sessionID === child && r.at >= wakeAt,
          ).length,
          parentNoticesAfterWake: noticesAfterWake.map((n) => n.metadata),
        },
        execResult: execText,
      };

      const checks = {
        buildSeesStop: firstParent?.tools.includes("subagent_stop") === true,
        buildSeesList: firstParent?.catalog.includes("subagents.list") === true,
        buildSeesInspect:
          firstParent?.catalog.includes("subagents.inspect") === true,
        generalSeesNone:
          firstChild !== undefined &&
          !firstChild.tools.includes("subagent_stop") &&
          !firstChild.catalog.some((name) => name.startsWith("subagents.")),
        malformedIDRejected:
          toolResult("p_bad_shape")?.includes(notFound("not-a-session")) ===
          true,
        unknownIDRejected:
          toolResult("p_bad_missing")?.includes(
            notFound("ses_0000000000000smokemissing"),
          ) === true,
        shellObservedInterrupt: Option.isSome(shellInterruptedMs),
        resultSaysStopped:
          stopText.includes(`- ${child}`) && /: stopped$/m.test(stopText),
        childOutcomeInterrupted: childAfterStop.outcome === "interrupted",
        exactlyOneCancelledNotice: cancelledNotices(noticesAfterStop) === 1,
        wakeReinterrupted: wokenEnd.at - wokenStart.at < 1000,
        // The probe plugin interrupts only sessions under its own `probe-latch/` keys, which this
        // script never writes, so every re-interrupt here is the subagent-intervene latch.
        probeNeverEnforced: readLog(dir).every((r) => r.kind !== "enforce"),
        noWokenReply: !evidence.wake.wokenReplyPersisted,
        noNoticeAfterWake: noticesAfterWake.length === noticesAfterStop.length,
        listReportsStop:
          execJson.includes(child) && execJson.includes('"latch":"active"'),
        inspectRan: execJson.includes('"scope":"since-last-compaction"'),
        reasonEscaped:
          execJson.includes("&lt;/subagent&gt;") &&
          !execJson.includes("</subagent>"),
      };

      writeLine(dir, "result.json", { evidence, checks });
      yield* Effect.log(`RESULT ${JSON.stringify({ evidence, checks })}`);
      const failed = Object.entries(checks)
        .filter(([, ok]) => !ok)
        .map(([name]) => name);
      if (failed.length > 0)
        return yield* Effect.die(
          new Error(`smoke checks failed: ${failed.join(", ")}`),
        );
      yield* Effect.log(`SMOKE OK (${Object.keys(checks).length} checks)`);
    }),
);
