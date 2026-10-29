// Which agents see the three tools. They follow the `subagent` permission, so with the built-in agent
// rules (config `permissions: []`) build sees them and the general and explore subagents do not.
// A config-level blanket allow is applied after each agent's own rules, so with Drive's default
// `{ action: "*", resource: "*", effect: "allow" }` the general subagent sees them too.
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { Effect, Stream } from "effect";
import { Llm, OpenCodeDriver } from "opencode-drive";
import {
  call,
  events,
  finishScenario,
  instanceFor,
  type JsonValue,
  type LlmRecord,
  notices,
  probePlugin,
  REPO_ROOT,
  readLlm,
  readLog,
  recordRequest,
  runDir,
  until,
  waitIdle,
} from "../harness";

const dir = runDir("env-visibility");

if (!existsSync(join(REPO_ROOT, "dist", "index.js")))
  throw new Error("dist/index.js is missing; run `bun run build` first");

interface Seen {
  readonly agent?: string;
  readonly directTools: ReadonlyArray<string>;
  readonly catalog: ReadonlyArray<string>;
}

const seen = (record: LlmRecord | undefined): Seen | undefined =>
  record === undefined
    ? undefined
    : {
        ...(record.agent === undefined ? {} : { agent: record.agent }),
        directTools: record.tools,
        catalog: record.catalog,
      };

/** Every name of the three tools, as a direct tool or in the Code Mode catalog. */
const controlTools = (view: Seen | undefined) =>
  view === undefined
    ? []
    : [
        ...view.directTools.filter(
          (name) => name === "subagent_stop" || name.startsWith("subagents_"),
        ),
        ...view.catalog.filter((name) => name.startsWith("subagents.")),
      ];

const seesAll = (view: Seen | undefined) =>
  view !== undefined &&
  view.directTools.includes("subagent_stop") &&
  view.catalog.includes("subagents.list") &&
  view.catalog.includes("subagents.inspect");

const seesNone = (view: Seen | undefined) =>
  view !== undefined && controlTools(view).length === 0;

const launch = (id: string, agent: string, role: string, index: number) =>
  Llm.toolCall({
    index,
    id,
    name: "subagent",
    input: {
      agent,
      description: `${agent} child`,
      prompt: `ROLE<${role}> look around`,
      background: true,
    } satisfies { readonly [key: string]: JsonValue },
  });

/** One Drive run: build launches a general and an explore subagent; each records what it was offered. */
const visibilityRun = (
  label: string,
  config: { readonly [key: string]: JsonValue },
) => {
  const runFolder = join(dir, label);
  mkdirSync(runFolder, { recursive: true });
  return OpenCodeDriver.use(
    {
      config: {
        ...config,
        plugins: [probePlugin(runFolder), { package: REPO_ROOT, options: {} }],
      },
    },
    ({ llm, directory }) =>
      Effect.gen(function* () {
        yield* llm.serve((request, index) => {
          const req = recordRequest(runFolder, request.body, index);
          const { last } = req;
          if (req.role === "parent") {
            if (last.toolCallID === "p_gen" || last.toolCallID === "p_exp")
              return Stream.make(Llm.text("Launched both."));
            if (last.text.includes("<subagent"))
              return Stream.make(Llm.text("PARENT-NOTED"));
            if (last.text.includes("ROLE<parent>"))
              return Stream.make(
                launch("p_gen", "general", "gen", 0),
                launch("p_exp", "explore", "exp", 1),
                Llm.finish("tool-calls"),
              );
            return Stream.make(Llm.text("parent-other"));
          }
          if (req.role === "gen") return Stream.make(Llm.text("gen done"));
          if (req.role === "exp") return Stream.make(Llm.text("exp done"));
          return Stream.make(Llm.text("other"));
        });

        const instance = yield* Effect.promise(() =>
          instanceFor(runFolder, directory),
        );
        const parent = (yield* Effect.promise(() =>
          call<{ id: string }>(instance, "create", { title: "parent" }),
        )).id;
        yield* Effect.promise(() =>
          call(instance, "prompt", {
            sessionID: parent,
            text: "ROLE<parent> launch both",
          }),
        );
        yield* Effect.promise(() =>
          until("both children answered and noticed", () =>
            notices(runFolder, parent).length >= 2 ? true : undefined,
          ),
        );
        yield* Effect.sleep(300);
        yield* Effect.promise(() => waitIdle(instance, parent));

        const log = readLlm(runFolder);
        const byRole = (role: string) => seen(log.find((r) => r.role === role));
        return {
          dir: runFolder,
          build: byRole("parent"),
          general: byRole("gen"),
          explore: byRole("exp"),
          childrenCreated: events(readLog(runFolder)).filter(
            (e) => e.type === "session.created" && e.parentID === parent,
          ).length,
        };
      }),
  );
};

export default Effect.gen(function* () {
  const builtin = yield* visibilityRun("builtin-rules", { permissions: [] });
  // Leaving `permissions` out keeps Drive's default blanket allow rule.
  const blanket = yield* visibilityRun("blanket-allow", {});

  const evidence = {
    dir,
    builtinRules: {
      ...builtin,
      generalControlTools: controlTools(builtin.general),
      exploreControlTools: controlTools(builtin.explore),
    },
    blanketAllow: {
      ...blanket,
      generalControlTools: controlTools(blanket.general),
      exploreControlTools: controlTools(blanket.explore),
    },
  };

  const checks = {
    builtinBuildSeesAll:
      builtin.build?.agent === "build" && seesAll(builtin.build),
    builtinGeneralSeesNone:
      builtin.general?.agent === "general" && seesNone(builtin.general),
    builtinExploreSeesNone:
      builtin.explore?.agent === "explore" && seesNone(builtin.explore),
    blanketBuildSeesAll: seesAll(blanket.build),
    blanketGeneralSeesAll:
      blanket.general?.agent === "general" && seesAll(blanket.general),
    bothChildrenLaunchedEachRun:
      builtin.childrenCreated === 2 && blanket.childrenCreated === 2,
  };

  yield* finishScenario(dir, "env-visibility", evidence, checks);
});
