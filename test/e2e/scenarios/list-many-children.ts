// subagents.list for a parent with more children than one walk of 200 sessions holds (run
// `bun run build` first, then `bun run probe ./test/e2e/scenarios/list-many-children.ts`).
// A parent gets 250 child sessions through the plugin API, with no model calls, and the two newest
// are prompted to hold a shell, so they are running. The parent then calls subagents.list through
// Code Mode, once for every state and once with `state: "running"`, and checks that:
// - every child is read and counted, the two running ones come first, and the output reports the
//   cut at the entry limit;
// - the running filter lists exactly those two, with no cut.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Effect, Stream } from "effect";
import { Llm, OpenCodeDriver } from "opencode-drive";
import {
  call,
  instanceFor,
  type JsonValue,
  probePlugin,
  REPO_ROOT,
  recordRequest,
  runDir,
  until,
  waitEvent,
  writeLine,
} from "../harness";

const dir = runDir("list-many-children");
const CHILDREN = 250;
const RUNNERS = ["runner0", "runner1"] as const;
const ENTRY_LIMIT = 50;

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

interface Entry {
  readonly sessionID: string;
  readonly state: string;
  readonly stateSource: string;
}

interface Listing {
  readonly entries: ReadonlyArray<Entry>;
  readonly total: number;
  readonly truncated: boolean;
  readonly complete: boolean;
}

function toListing(value: unknown): Listing {
  if (
    !isRecord(value) ||
    !Array.isArray(value.entries) ||
    typeof value.total !== "number" ||
    typeof value.truncated !== "boolean" ||
    typeof value.complete !== "boolean"
  )
    throw new Error(`not a subagents.list output: ${JSON.stringify(value)}`);
  const entries = value.entries.map((entry): Entry => {
    if (
      !isRecord(entry) ||
      typeof entry.sessionID !== "string" ||
      typeof entry.state !== "string" ||
      typeof entry.stateSource !== "string"
    )
      throw new Error(`not a list entry: ${JSON.stringify(entry)}`);
    return {
      sessionID: entry.sessionID,
      state: entry.state,
      stateSource: entry.stateSource,
    };
  });
  return {
    entries,
    total: value.total,
    truncated: value.truncated,
    complete: value.complete,
  };
}

/** The program's return value, decoded again while it is still a JSON string. */
function decode(text: string): unknown {
  let value: unknown = text;
  while (typeof value === "string") value = JSON.parse(value);
  return value;
}

const sameSet = (a: ReadonlyArray<string>, b: ReadonlyArray<string>) =>
  a.length === b.length && a.every((id) => b.includes(id));

export default OpenCodeDriver.use(
  {
    tools: ["shell"],
    config: {
      plugins: [probePlugin(dir), { package: REPO_ROOT, options: {} }],
    },
  },
  ({ llm, tools, directory }) =>
    Effect.gen(function* () {
      const shells = yield* tools.control("shell");

      yield* llm.serve((request, index) => {
        const req = recordRequest(dir, request.body, index);
        recordToolResults(request.body);
        const { last } = req;
        if (req.role === "parent") {
          if (last.role === "tool" && last.toolCallID === "p_list")
            return Stream.make(Llm.text("LISTED"));
          if (last.text.includes("CMD-LIST"))
            return toolCall("p_list", "execute", {
              code: 'const all = await tools.subagents.list({}); const running = await tools.subagents.list({ state: "running" }); return JSON.stringify({ all, running });',
            });
          return Stream.make(Llm.text("parent-other"));
        }
        if (req.role !== undefined && req.role.startsWith("runner")) {
          if (last.role === "user" && last.text.includes("RUN-TASK"))
            return toolCall(`hold_${req.role}`, "shell", {
              command: "hold",
              description: "hold",
            });
          return Stream.make(Llm.text("RUNNER-DONE"));
        }
        return Stream.make(Llm.text("other"));
      });

      const instance = yield* Effect.promise(() => instanceFor(dir, directory));
      const ctl = <T = unknown>(
        op: string,
        args: Record<string, unknown> = {},
      ) => Effect.promise(() => call<T>(instance, op, args));
      const create = (title: string, parentID?: string) =>
        ctl<{ id: string }>("create", {
          title,
          ...(parentID === undefined ? {} : { parentID }),
        }).pipe(Effect.map((session) => session.id));

      // The idle children first, then the two that will run, so those two are the newest.
      const createdAt = Date.now();
      const parent = yield* create("parent");
      const idle = yield* Effect.all(
        Array.from({ length: CHILDREN - RUNNERS.length }, (_, index) =>
          create(`child ${index}`, parent),
        ),
        { concurrency: 10 },
      );
      const runners: string[] = [];
      for (const role of RUNNERS) runners.push(yield* create(role, parent));
      const createMs = Date.now() - createdAt;
      const listedByCore = yield* ctl<{ data: ReadonlyArray<unknown> }>(
        "list",
        { parentID: parent },
      );

      // Each runner holds a shell, so its run stays open until the shell is released.
      const runAt = Date.now();
      const holds = yield* Effect.forEach(RUNNERS, (role, index) =>
        Effect.gen(function* () {
          const sessionID = runners[index];
          if (sessionID === undefined)
            throw new Error(`no session for ${role}`);
          yield* ctl("prompt", { sessionID, text: `ROLE<${role}> RUN-TASK` });
          const hold = yield* shells.take(`hold_${role}`);
          yield* Effect.promise(() =>
            waitEvent(dir, sessionID, "session.execution.started", {
              since: runAt,
            }),
          );
          return hold;
        }),
      );
      // The plugin folds run state from its own event subscription; give it a moment to catch up.
      yield* Effect.sleep(500);

      const listAt = Date.now();
      yield* ctl("prompt", {
        sessionID: parent,
        text: "ROLE<parent> CMD-LIST",
      });
      const listText = yield* Effect.promise(() =>
        until("subagents.list result", () => toolResult("p_list"), 60_000),
      );
      const listMs = Date.now() - listAt;
      yield* Effect.promise(() =>
        waitEvent(dir, parent, "session.execution.succeeded", {
          since: listAt,
          timeoutMs: 30_000,
        }),
      );

      // Release the shells so both runners finish before the sandbox closes. The time is taken
      // before the first release, so a runner that finishes during the second is still seen.
      const releaseAt = Date.now();
      for (const hold of holds)
        yield* hold.succeed({ output: "released\n", exit: 0 });
      for (const sessionID of runners)
        yield* Effect.promise(() =>
          waitEvent(dir, sessionID, "session.execution.succeeded", {
            since: releaseAt,
            timeoutMs: 30_000,
          }),
        );

      const decoded = decode(listText);
      if (!isRecord(decoded))
        throw new Error(`unexpected list result: ${listText.slice(0, 400)}`);
      const all = toListing(decoded.all);
      const running = toListing(decoded.running);
      const firstTwo = all.entries.slice(0, RUNNERS.length);
      const allIDs = all.entries.map((entry) => entry.sessionID);

      const evidence = {
        dir,
        parent,
        runners,
        createdChildren: idle.length + runners.length,
        createMs,
        coreFirstPage: listedByCore.data.length,
        listMs,
        all: {
          total: all.total,
          truncated: all.truncated,
          complete: all.complete,
          entries: all.entries.length,
          firstEntries: all.entries.slice(0, 4),
          states: Object.fromEntries(
            ["running", "unknown", "idle"].map((state) => [
              state,
              all.entries.filter((entry) => entry.state === state).length,
            ]),
          ),
          distinctIDs: new Set(allIDs).size,
        },
        running: {
          total: running.total,
          truncated: running.truncated,
          complete: running.complete,
          entries: running.entries,
        },
      };

      const checks = {
        createdAllChildren: evidence.createdChildren === CHILDREN,
        totalCountsEveryChild: all.total === CHILDREN,
        readInFull: all.complete && running.complete,
        cutAtEntryLimit: all.truncated && all.entries.length === ENTRY_LIMIT,
        noDuplicateEntries: evidence.all.distinctIDs === all.entries.length,
        runningComeFirst: sameSet(
          firstTwo.map((entry) => entry.sessionID),
          runners,
        ),
        runningFromEvents: firstTwo.every(
          (entry) => entry.state === "running" && entry.stateSource === "event",
        ),
        restIdle: all.entries
          .slice(RUNNERS.length)
          .every((entry) => entry.state === "idle"),
        runningFilterExact:
          sameSet(
            running.entries.map((entry) => entry.sessionID),
            runners,
          ) &&
          running.total === RUNNERS.length &&
          !running.truncated,
      };

      writeLine(dir, "result.json", { evidence, checks });
      yield* Effect.log(`RESULT ${JSON.stringify({ evidence, checks })}`);
      const failed = Object.entries(checks)
        .filter(([, ok]) => !ok)
        .map(([name]) => name);
      if (failed.length > 0)
        return yield* Effect.die(
          new Error(`list-many-children checks failed: ${failed.join(", ")}`),
        );
      yield* Effect.log(
        `LIST-MANY-CHILDREN OK (${Object.keys(checks).length} checks)`,
      );
    }),
);
