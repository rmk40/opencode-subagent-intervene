import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { Effect, Stream } from "effect";
import { Llm, OpenCodeDriver } from "opencode-drive";
import {
  call,
  finishScenario,
  instanceFor,
  instances,
  recordRequest,
  runDir,
  until,
  waitIdle,
} from "../harness";
import {
  compactionSummary,
  contextPlugins,
  measurementScope,
  noticeHasPlanningGuidance,
  object,
  usage,
} from "../context-harness";

const dir = runDir("context-warning-milestones");
const limit = { context: 1000000, input: 200000, output: 16000 };
export default OpenCodeDriver.use(
  {
    config: {
      plugins: contextPlugins(dir),
      compaction: { auto: false },
      providers: {
        simulation: {
          models: {
            "gpt-sim-model": { limit },
            alternate: {
              limit,
              capabilities: { tools: true, input: ["text"], output: ["text"] },
            },
          },
        },
      },
    },
  },
  ({ llm, directory, opencode }) =>
    Effect.gen(function* () {
      let serial = 0;
      yield* llm.serve((request, index) => {
        const req = recordRequest(dir, request.body, index);
        if (req.system.includes("PROBE-COMPACTION"))
          return Stream.make(Llm.text(compactionSummary), usage(1000));
        if (req.last.role === "user" && req.last.text.startsWith("SEED"))
          return Stream.make(
            Llm.text("SEEDED"),
            usage(req.last.text.includes("LOW") ? 150000 : 190000),
          );
        if (req.last.role === "user" && req.last.text === "CMD-FAIL")
          return Stream.make(
            Llm.toolCall({
              index: 0,
              id: `failure_${serial++}`,
              name: "probe_fail",
              input: {},
            }),
            usage(190000),
            Llm.finish("tool-calls"),
          );
        if (req.last.role === "user" && req.last.text === "CMD-TOOLS")
          return Stream.make(
            Llm.toolCall({
              index: 0,
              id: `first_${serial}`,
              name: "probe_direct",
              input: {},
            }),
            Llm.toolCall({
              index: 1,
              id: `second_${serial++}`,
              name: "probe_direct",
              input: {},
            }),
            usage(190000),
            Llm.finish("tool-calls"),
          );
        return Stream.make(Llm.text("DONE"), usage(190000));
      });
      let a = yield* Effect.promise(() => instanceFor(dir, directory));
      const session = yield* Effect.promise(() =>
        call<{ id: string }>(a, "create", { title: "milestones" }),
      );
      const prompt = (text: string) =>
        Effect.promise(async () => {
          await call(a, "prompt", { sessionID: session.id, text });
          await waitIdle(a, session.id);
        });
      const warnings = () =>
        Effect.promise(async () =>
          (await call<unknown[]>(a, "context", { sessionID: session.id }))
            .map(object)
            .filter(
              (item) =>
                item.type === "synthetic" &&
                object(item.metadata).kind === "context-warning",
            ),
        );
      yield* prompt("SEED-HIGH");
      yield* prompt("CMD-FAIL");
      const afterFailure = yield* warnings();
      yield* prompt("CMD-TOOLS");
      const first = yield* warnings();
      yield* prompt("SEED-LOW");
      yield* prompt("CMD-TOOLS");
      const afterDecrease = yield* warnings();
      const warning = first[0];
      if (!warning) return yield* Effect.die(new Error("no initial warning"));
      yield* Effect.promise(() =>
        call(a, "synthetic", {
          sessionID: session.id,
          id: warning.id,
          text: warning.text,
          metadata: warning.metadata,
          delivery: "steer",
          resume: false,
        }),
      );

      // Another location keeps a public control endpoint alive while the original plugin unloads.
      const bDir = resolve(directory, "..", "warning-control");
      mkdirSync(bDir, { recursive: true });
      const control = yield* Effect.promise(() =>
        call<{ id: string }>(a, "create", { title: "control" }),
      );
      yield* Effect.promise(() =>
        call(a, "move", { sessionID: control.id, directory: bDir }),
      );
      const b = yield* Effect.promise(() => instanceFor(dir, bDir));
      const originalInstance = a.instance;
      yield* opencode.debug.location
        .evict({ location: { directory } })
        .pipe(Effect.orDie);
      yield* Effect.promise(() =>
        call(b, "prompt", { sessionID: session.id, text: "CMD-TOOLS" }),
      );
      a = yield* Effect.promise(() =>
        until("reloaded plugin", () =>
          instances(dir).find(
            (item) =>
              item.location === directory && item.instance !== originalInstance,
          ),
        ),
      );
      yield* Effect.promise(() => waitIdle(a, session.id));
      const afterReload = yield* warnings();
      yield* Effect.promise(() =>
        call(a, "switchModel", { sessionID: session.id, modelID: "alternate" }),
      );
      yield* prompt("CMD-TOOLS");
      const afterSwitchWithoutMeasurement = yield* warnings();
      yield* prompt("SEED-HIGH");
      yield* prompt("CMD-TOOLS");
      const afterSwitch = yield* warnings();
      yield* Effect.promise(() =>
        call(a, "compact", { sessionID: session.id }),
      );
      yield* Effect.promise(() => waitIdle(a, session.id));
      yield* prompt("SEED-HIGH");
      yield* prompt("CMD-TOOLS");
      const afterCompaction = yield* warnings();
      yield* finishScenario(
        dir,
        "context-warning-milestones",
        {
          afterFailure,
          first,
          afterDecrease,
          afterReload,
          afterSwitchWithoutMeasurement,
          afterSwitch,
          afterCompaction,
        },
        {
          failedToolIsSilent: afterFailure.length === 0,
          concurrentBatchAdmitsOnlyHighestJump:
            first.length === 1 &&
            object(first[0]?.metadata).milestone === "95" &&
            object(first[0]?.metadata).threshold === "50",
          storedWarningsShowBothPercentages: [
            ...first,
            ...afterSwitch,
            ...afterCompaction,
          ].every(
            (item) =>
              typeof item.text === "string" &&
              item.text.includes(
                "190k / 200k input (95.01%) · 10k remaining · UI/context 19% of 1M",
              ) &&
              item.text.includes("assumed default auto ~170k (20k past estimate)"),
          ),
          noticesRetainPlanningGuidanceAcrossModelAndEpochChanges: [
            ...first,
            ...afterSwitch,
            ...afterCompaction,
          ].every(
            (item) =>
              noticeHasPlanningGuidance(item.text) &&
              item.description ===
                `Context usage reached the ${object(item.metadata).milestone}% milestone`,
          ),
          warningIdentitySurvivesModelAndEpochChanges: [
            ...first,
            ...afterSwitch,
            ...afterCompaction,
          ].every((item) => {
            const metadata = object(item.metadata);
            return (
              typeof item.text === "string" &&
              !item.text.includes("\n") &&
              /measured \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z/.test(item.text) &&
              item.text.includes(
                `${metadata.providerID}/${metadata.modelID}`,
              ) &&
              item.text.includes(
                metadata.epoch === "initial"
                  ? "initial context"
                  : `after compaction ${metadata.epoch}`,
              ) &&
              item.text.endsWith(` · ${measurementScope}`) &&
              !item.text.includes("Snapshot is stale")
            );
          }),
          decreaseDoesNotEmitLowerMilestone: afterDecrease.length === 1,
          duplicateAndReloadPreserveOneMessage:
            afterReload.length === 1 &&
            afterReload[0]?.id === warning.id &&
            afterReload[0]?.text === warning.text,
          switchedHistoricalMeasurementSilent:
            afterSwitchWithoutMeasurement.length === 1,
          newModelGetsOwnMilestone:
            afterSwitch.length === 2 &&
            object(afterSwitch[1]?.metadata).modelID === "alternate",
          completedCompactionStartsNewEpoch:
            afterCompaction.length === 1 &&
            object(afterCompaction[0]?.metadata).epoch !== "initial" &&
            afterCompaction[0]?.id !== afterSwitch[1]?.id,
        },
      );
    }),
);
