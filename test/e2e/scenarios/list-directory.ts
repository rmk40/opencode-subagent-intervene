// subagents.list reports the directory each subagent works in. A parent launches two background
// children that answer and go idle, and one of them is moved to a second directory with the SDK's
// `session.move`. Two Drive runs:
// - with Code Mode, the structured result gives the moved child the new directory and the other
//   child the parent's;
// - with Code Mode off (a config rule denies `execute`), the model calls the direct
//   `subagents_list` tool and reads the rendered lines: the moved child's line names its
//   directory, and the other child's line names none.
import { existsSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { Effect, Stream } from "effect";
import { Llm, type OpenCode, OpenCodeDriver } from "opencode-drive";
import {
  call,
  captureToolResults,
  capturedToolResult,
  childOf,
  codeModeValue,
  completionNotices,
  finishScenario,
  instanceFor,
  type JsonValue,
  listedDirectories,
  probePlugin,
  REPO_ROOT,
  readLlm,
  recordRequest,
  runDir,
  toolCallResponse,
  until,
  waitIdle,
} from "../harness";

const dir = runDir("list-directory");

type MoveInput = Parameters<OpenCode["session"]["move"]>[0];
type Rule = { readonly [key: string]: JsonValue };

if (!existsSync(join(REPO_ROOT, "dist", "index.js")))
  throw new Error("dist/index.js is missing; run `bun run build` first");

/** One Drive run; `codeMode: false` denies `execute`, so list is offered as a direct tool. */
const listRun = (label: string, codeMode: boolean) => {
  const runFolder = join(dir, label);
  mkdirSync(runFolder, { recursive: true });
  const rules: ReadonlyArray<Rule> = codeMode
    ? [{ action: "*", resource: "*", effect: "allow" }]
    : [
        { action: "*", resource: "*", effect: "allow" },
        { action: "execute", resource: "*", effect: "deny" },
      ];
  return OpenCodeDriver.use(
    {
      config: {
        permissions: [...rules],
        plugins: [probePlugin(runFolder), { package: REPO_ROOT, options: {} }],
      },
    },
    ({ llm, directory, opencode }) =>
      Effect.gen(function* () {
        const locationB = resolve(directory, "..", "location-b");
        mkdirSync(locationB, { recursive: true });

        yield* llm.serve((request, index) => {
          const req = recordRequest(runFolder, request.body, index);
          captureToolResults(runFolder, request.body);
          const { last } = req;
          if (req.role === "parent") {
            if (last.role === "tool") {
              if (last.toolCallID?.startsWith("p_sub_") === true)
                return Stream.make(Llm.text("Launched."));
              if (last.toolCallID === "p_list")
                return Stream.make(Llm.text("LISTED"));
            }
            const launch = /CMD-LAUNCH-(stay|mover)/.exec(last.text)?.[1];
            if (launch !== undefined)
              return toolCallResponse(`p_sub_${launch}`, "subagent", {
                agent: "general",
                description: `${launch} child`,
                prompt: `ROLE<${launch}> TASK`,
                background: true,
              });
            if (last.text.includes("CMD-LIST"))
              return codeMode
                ? toolCallResponse("p_list", "execute", {
                    code: "return JSON.stringify(await tools.subagents.list({}));",
                  })
                : toolCallResponse("p_list", "subagents_list", {});
            return Stream.make(Llm.text("PARENT-NOTED"));
          }
          if (req.role === "stay" || req.role === "mover")
            return Stream.make(Llm.text(`${req.role.toUpperCase()}-DONE`));
          return Stream.make(Llm.text("other"));
        });

        const a = yield* Effect.promise(() =>
          instanceFor(runFolder, directory),
        );
        const ctl = <T = unknown>(
          op: string,
          args: Record<string, unknown> = {},
        ) => Effect.promise(() => call<T>(a, op, args));
        const launch = (name: string, nth: number, first = false) =>
          Effect.gen(function* () {
            yield* ctl("prompt", {
              sessionID: parent,
              text: `${first ? "ROLE<parent> " : ""}CMD-LAUNCH-${name}`,
            });
            const child = yield* Effect.promise(() =>
              until(`${name} child`, () => childOf(runFolder, parent, nth)),
            );
            yield* Effect.promise(() =>
              until(
                `${name} completion`,
                () => completionNotices(runFolder, parent, child)[0],
              ),
            );
            yield* Effect.sleep(300);
            yield* Effect.promise(async () => {
              await waitIdle(a, child);
              await waitIdle(a, parent);
            });
            return child;
          });

        const parent = (yield* ctl<{ id: string }>("create", {
          title: "parent",
        })).id;
        const stay = yield* launch("stay", 0, true);
        const mover = yield* launch("mover", 1);

        yield* opencode.session
          .move({
            sessionID: mover as MoveInput["sessionID"],
            directory: locationB as MoveInput["directory"],
          })
          .pipe(Effect.orDie);
        const moved = yield* Effect.promise(() =>
          until("mover moved", async () => {
            const info = await call<{ location: { directory: string } }>(
              a,
              "get",
              { sessionID: mover },
            );
            return info.location.directory !== directory ? info : undefined;
          }),
        );
        const b = yield* Effect.promise(() =>
          instanceFor(runFolder, moved.location.directory),
        );
        yield* Effect.promise(async () => {
          await waitIdle(b, mover);
          await waitIdle(a, parent);
        });

        yield* ctl("prompt", { sessionID: parent, text: "CMD-LIST" });
        const listText = yield* Effect.promise(() =>
          until(
            "list result",
            () => capturedToolResult(runFolder, "p_list"),
            30_000,
          ),
        );
        yield* Effect.promise(() => waitIdle(a, parent));
        const listRequest = readLlm(runFolder).find(
          (r) => r.sessionID === parent && r.last.text.includes("CMD-LIST"),
        );

        return {
          dir: runFolder,
          parent,
          stay,
          mover,
          parentDirectory: a.location,
          movedTo: moved.location.directory,
          locationB,
          directTools: listRequest?.tools ?? [],
          listText,
        };
      }),
  );
};

export default Effect.gen(function* () {
  const structured = yield* listRun("code-mode", true);
  const rendered = yield* listRun("direct", false);

  const directories = listedDirectories(codeModeValue(structured.listText));
  const lineFor = (text: string, id: string) =>
    text.split("\n").find((line) => line.startsWith(`- ${id}`));
  const moverLine = lineFor(rendered.listText, rendered.mover);
  const stayLine = lineFor(rendered.listText, rendered.stay);

  const evidence = {
    dir,
    structured: {
      ...structured,
      directories: Object.fromEntries(directories),
    },
    rendered: { ...rendered, moverLine, stayLine },
  };

  const checks = {
    movedToSecondDirectory:
      resolve(structured.movedTo) === structured.locationB &&
      resolve(rendered.movedTo) === rendered.locationB,
    structuredMoverDirectory:
      directories.get(structured.mover) === structured.movedTo,
    structuredStayDirectory:
      directories.get(structured.stay) === structured.parentDirectory,
    codeModeOffOffersDirectList:
      rendered.directTools.includes("subagents_list"),
    renderedMoverNamesDirectory:
      moverLine?.includes(`; directory ${rendered.movedTo}`) === true,
    renderedStayNamesNone:
      stayLine !== undefined && !stayLine.includes("directory"),
  };

  yield* finishScenario(dir, "list-directory", evidence, checks);
});
