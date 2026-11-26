import { Effect, Stream } from "effect";
import { Llm, OpenCodeDriver } from "opencode-drive";
import {
  call,
  captureToolResults,
  capturedToolResult,
  finishScenario,
  instanceFor,
  readLlm,
  recordRequest,
  reportBody,
  runDir,
  until,
  waitIdle,
} from "../harness";
import { contextPlugins, structuredResult, usage } from "../context-harness";

const run = (
  codeMode: boolean,
  selfCompaction = true,
  allowExplore = true,
  contextNotices?: boolean,
) => {
  const dir = runDir(
    `context-visibility-${codeMode}-${selfCompaction}-${allowExplore}-${contextNotices ?? "default"}`,
  );
  return OpenCodeDriver.use(
    {
      config: {
        permissions: [
          ...(codeMode
            ? []
            : [{ action: "execute", resource: "*", effect: "deny" }]),
          ...(allowExplore
            ? [
                { action: "context_status", resource: "*", effect: "allow" },
                { action: "context_compact", resource: "*", effect: "allow" },
              ]
            : []),
        ],
        plugins: contextPlugins(dir, {
          selfCompaction,
          ...(contextNotices === undefined ? {} : { contextNotices }),
        }),
        compaction: { auto: false },
      },
    },
    ({ llm, directory }) =>
      Effect.gen(function* () {
        yield* llm.serve((request, index) => {
          const req = recordRequest(dir, request.body, index);
          captureToolResults(dir, request.body);
          if (req.role === "parent") {
            if (req.last.role === "tool")
              return Stream.make(Llm.text("PARENT-FINAL"));
            // Where every subagent runs in the background, each child's report wakes the parent.
            if (!req.last.text.includes("ROLE<parent>"))
              return Stream.make(Llm.text("PARENT-NOTED"));
            return Stream.make(
              Llm.toolCall({
                index: 0,
                id: "general",
                name: "subagent",
                input: {
                  agent: "general",
                  description: "general context",
                  prompt: "ROLE<general> check your context then answer",
                  background: false,
                },
              }),
              Llm.toolCall({
                index: 1,
                id: "explore",
                name: "subagent",
                input: {
                  agent: "explore",
                  description: "explore context",
                  prompt: "ROLE<explore> check your context then answer",
                  background: false,
                },
              }),
              Llm.finish("tool-calls"),
            );
          }
          if (req.role === "general" || req.role === "explore") {
            if (
              req.last.role === "tool" ||
              !req.tools.includes("context_status")
            )
              return Stream.make(
                Llm.text(`FINAL-${req.role}-180K`),
                usage(180000),
              );
            return Stream.make(
              Llm.toolCall({
                index: 0,
                id: `${req.role}_status`,
                name: "context_status",
                input: {},
              }),
              usage(1000),
              Llm.finish("tool-calls"),
            );
          }
          return Stream.make(Llm.text("Auxiliary reply."));
        });
        const instance = yield* Effect.promise(() =>
          instanceFor(dir, directory),
        );
        yield* Effect.promise(() =>
          call(instance, "model.limit", { context: 250000, input: 200000 }),
        );
        const parent = yield* Effect.promise(() =>
          call<{ id: string }>(instance, "create", { title: "parent" }),
        );
        yield* Effect.promise(() =>
          call(instance, "prompt", {
            sessionID: parent.id,
            text: "ROLE<parent> launch children",
          }),
        );
        yield* Effect.promise(() =>
          until(
            "both foreground results",
            () =>
              capturedToolResult(dir, "general") &&
              capturedToolResult(dir, "explore")
                ? true
                : undefined,
            30000,
          ),
        );
        // OpenCode 2.3 and later run every subagent in the background, whatever the call asks, so
        // the call returns at once and the child's final answer reaches the parent in OpenCode's
        // completed report instead of the call's result.
        const finalAnswer = (role: string) => {
          const result = capturedToolResult(dir, role);
          if (result?.includes(`FINAL-${role}-`) === true) return result;
          const childID = readLlm(dir).find(
            (item) => item.role === role,
          )?.sessionID;
          return childID === undefined
            ? undefined
            : reportBody(dir, parent.id, childID, "completed", 0);
        };
        const answers = yield* Effect.promise(() =>
          until(
            "both final answers",
            () => {
              const general = finalAnswer("general");
              const explore = finalAnswer("explore");
              return general !== undefined && explore !== undefined
                ? { general, explore }
                : undefined;
            },
            30000,
          ).catch(() => ({
            general: finalAnswer("general"),
            explore: finalAnswer("explore"),
          })),
        );
        yield* Effect.promise(() => waitIdle(instance, parent.id));
        const log = readLlm(dir);
        const checks: Record<string, boolean> = {};
        for (const role of ["general", "explore"] as const) {
          const requests = log.filter((item) => item.role === role);
          const first = requests[0];
          const visible = role === "general" || allowExplore;
          checks[`${role}:statusDirect`] =
            first?.tools.includes("context_status") === visible;
          checks[`${role}:compactVisibility`] =
            first?.tools.includes("context_compact") ===
            (visible && selfCompaction);
          checks[`${role}:noSubagentPermissionGranted`] =
            first?.tools.includes("subagent") === false &&
            first?.tools.includes("subagent_stop") === false;
          checks[`${role}:expectedStepsOnly`] =
            requests.length === (visible ? 2 : 1);
          checks[`${role}:finalResultNotReplaced`] =
            answers[role]?.includes(`FINAL-${role}-180K`) === true;
          checks[`${role}:codeModeSelection`] =
            first?.tools.includes("execute") ===
            (codeMode && role === "general");
          checks[`${role}:notInCodeModeCatalog`] =
            first?.catalog.every(
              (name) =>
                !name.includes("context_status") &&
                !name.includes("context_compact"),
            ) === true;
          if (visible) {
            const status = structuredResult(dir, `${role}_status`);
            const rendered = capturedToolResult(dir, `${role}_status`) ?? "";
            checks[`${role}:warningsEnabledMatchesConfiguration`] =
              status.warningsEnabled === (contextNotices ?? true) &&
              status.contextWarningPercent === 50;
            checks[`${role}:noticeSettingRendered`] =
              contextNotices === false
                ? rendered.includes("notices disabled") &&
                  !/notices from|warning/i.test(rendered)
                : rendered.includes("notices from 50%") &&
                  !/notices disabled|warning/i.test(rendered);
          }
        }
        yield* finishScenario(
          dir,
          "context-visibility",
          {
            codeMode,
            selfCompaction,
            allowExplore,
            contextNotices: contextNotices ?? "default",
            statusResults: {
              general: structuredResult(dir, "general_status"),
              explore: structuredResult(dir, "explore_status"),
            },
            log,
          },
          checks,
        );
      }),
  );
};
export default Effect.gen(function* () {
  yield* run(true, true, false);
  yield* run(true);
  yield* run(false);
  yield* run(true, false);
  yield* run(true, true, true, false);
});
