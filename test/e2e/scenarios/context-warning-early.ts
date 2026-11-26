import { Effect, Stream } from "effect";
import { Llm, OpenCodeDriver } from "opencode-drive";
import {
  call,
  finishScenario,
  instanceFor,
  recordRequest,
  runDir,
  waitIdle,
} from "../harness";
import {
  contextPlugins,
  defaultAutoWithDistance,
  measurementScope,
  noticeHasPlanningGuidance,
  object,
  usage,
} from "../context-harness";

const defaultSteps = [
  { percent: 49.99, milestones: [] },
  { percent: 50, milestones: [50] },
  { percent: 59.99, milestones: [50] },
  { percent: 60, milestones: [50, 60] },
  { percent: 65, milestones: [50, 60] },
  { percent: 69.99, milestones: [50, 60] },
  { percent: 70, milestones: [50, 60, 70] },
  { percent: 79.99, milestones: [50, 60, 70] },
  { percent: 80, milestones: [50, 60, 70, 80] },
  { percent: 84.99, milestones: [50, 60, 70, 80] },
  { percent: 85, milestones: [50, 60, 70, 80, 85] },
  { percent: 89.99, milestones: [50, 60, 70, 80, 85] },
  { percent: 90, milestones: [50, 60, 70, 80, 85, 90] },
  { percent: 94.99, milestones: [50, 60, 70, 80, 85, 90] },
  { percent: 95, milestones: [50, 60, 70, 80, 85, 90, 95] },
  { percent: 99.99, milestones: [50, 60, 70, 80, 85, 90, 95] },
  { percent: 100, milestones: [50, 60, 70, 80, 85, 90, 95, 100] },
  { percent: 55, milestones: [50, 60, 70, 80, 85, 90, 95, 100] },
] as const;

const overrideSteps = [
  { percent: 74.99, milestones: [] },
  { percent: 75, milestones: [75] },
  { percent: 80, milestones: [75, 80] },
  { percent: 85, milestones: [75, 80, 85] },
  { percent: 90, milestones: [75, 80, 85, 90] },
  { percent: 95, milestones: [75, 80, 85, 90, 95] },
  { percent: 100, milestones: [75, 80, 85, 90, 95, 100] },
] as const;

const configurations = [
  {
    threshold: undefined,
    selfCompaction: true,
    steps: defaultSteps,
  },
  {
    threshold: undefined,
    selfCompaction: false,
    steps: defaultSteps,
  },
  {
    threshold: 75,
    selfCompaction: true,
    steps: overrideSteps,
  },
  {
    threshold: 75,
    selfCompaction: false,
    steps: overrideSteps,
  },
  {
    threshold: 65,
    selfCompaction: true,
    steps: [
      { percent: 50, milestones: [] },
      { percent: 60, milestones: [] },
      { percent: 64.99, milestones: [] },
      { percent: 65, milestones: [65] },
      { percent: 70, milestones: [65] },
      { percent: 74.99, milestones: [65] },
      { percent: 75, milestones: [65, 75] },
      { percent: 79.99, milestones: [65, 75] },
      { percent: 80, milestones: [65, 75, 80] },
      { percent: 85, milestones: [65, 75, 80, 85] },
      { percent: 90, milestones: [65, 75, 80, 85, 90] },
      { percent: 95, milestones: [65, 75, 80, 85, 90, 95] },
      { percent: 100, milestones: [65, 75, 80, 85, 90, 95, 100] },
    ],
  },
  {
    threshold: 83,
    selfCompaction: true,
    steps: [
      { percent: 80, milestones: [] },
      { percent: 82.99, milestones: [] },
      { percent: 83, milestones: [83] },
      { percent: 84.99, milestones: [83] },
      { percent: 85, milestones: [83, 85] },
      { percent: 90, milestones: [83, 85, 90] },
      { percent: 95, milestones: [83, 85, 90, 95] },
      { percent: 100, milestones: [83, 85, 90, 95, 100] },
    ],
  },
  {
    threshold: 90,
    selfCompaction: true,
    steps: [
      { percent: 85, milestones: [] },
      { percent: 89.99, milestones: [] },
      { percent: 90, milestones: [90] },
      { percent: 95, milestones: [90, 95] },
      { percent: 100, milestones: [90, 95, 100] },
    ],
  },
] as const;

const run = (configuration: (typeof configurations)[number]) => {
  const threshold = configuration.threshold ?? 50;
  const dir = runDir(
    `context-warning-early-${configuration.threshold ?? "default"}-${configuration.selfCompaction}`,
  );
  return OpenCodeDriver.use(
    {
      config: {
        plugins: contextPlugins(dir, {
          selfCompaction: configuration.selfCompaction,
          ...(configuration.threshold === undefined
            ? {}
            : { contextWarningPercent: configuration.threshold }),
        }),
        compaction: { auto: false },
        providers: {
          simulation: {
            models: {
              "gpt-sim-model": {
                limit: { context: 1000000, input: 200000, output: 16000 },
              },
            },
          },
        },
      },
    },
    ({ llm, directory }) =>
      Effect.gen(function* () {
        let reportedInput = 1000;
        let serial = 0;
        const compactVisibility = new Set<boolean>();
        yield* llm.serve((request, index) => {
          const req = recordRequest(dir, request.body, index);
          compactVisibility.add(req.tools.includes("context_compact"));
          if (req.last.role === "user" && req.last.text.startsWith("SEED ")) {
            reportedInput = Number(req.last.text.slice(5)) * 2000 - 20;
            return Stream.make(Llm.text("SEEDED"), usage(reportedInput));
          }
          if (req.last.role === "user" && req.last.text === "CMD-TOOLS")
            return Stream.make(
              Llm.toolCall({
                index: 0,
                id: `early_first_${serial}`,
                name: "probe_direct",
                input: {},
              }),
              Llm.toolCall({
                index: 1,
                id: `early_second_${serial++}`,
                name: "probe_direct",
                input: {},
              }),
              usage(reportedInput),
              Llm.finish("tool-calls"),
            );
          return Stream.make(Llm.text("DONE"), usage(reportedInput));
        });
        const instance = yield* Effect.promise(() =>
          instanceFor(dir, directory),
        );
        const session = yield* Effect.promise(() =>
          call<{ id: string }>(instance, "create", { title: "notice-cadence" }),
        );
        const prompt = (text: string) =>
          Effect.promise(async () => {
            await call(instance, "prompt", { sessionID: session.id, text });
            await waitIdle(instance, session.id);
          });
        const warnings = () =>
          Effect.promise(async () =>
            (
              await call<unknown[]>(instance, "context", {
                sessionID: session.id,
              })
            )
              .map(object)
              .filter(
                (item) =>
                  item.type === "synthetic" &&
                  object(item.metadata).kind === "context-warning",
              ),
          );
        const checks: Record<string, boolean> = {};
        const steps: {
          percent: number;
          milestones: unknown[];
          ids: unknown[];
        }[] = [];
        let latest: Record<string, unknown>[] = [];
        let textFinalsStayedSilent = true;
        for (const step of configuration.steps) {
          yield* prompt(`SEED ${step.percent}`);
          const afterSeed = yield* warnings();
          textFinalsStayedSilent &&= afterSeed.length === latest.length;
          yield* prompt("CMD-TOOLS");
          latest = yield* warnings();
          const milestones = latest.map(
            (item) => object(item.metadata).milestone,
          );
          checks[`at${step.percent}:expectedMilestones`] =
            JSON.stringify(milestones) ===
            JSON.stringify(step.milestones.map(String));
          steps.push({
            percent: step.percent,
            milestones,
            ids: latest.map((item) => item.id),
          });
        }
        checks.textOnlyFinalsStaySilent = textFinalsStayedSilent;
        checks.uniqueDurableIDs =
          new Set(latest.map((item) => item.id)).size === latest.length;
        checks.configuredThresholdRetained = latest.every(
          (item) => object(item.metadata).threshold === String(threshold),
        );
        checks.allStagesHaveWindowFitPlanningGuidance = latest.every((item) =>
          noticeHasPlanningGuidance(item.text),
        );
        if (threshold === 75)
          checks.planningGuidanceCoversBelowAtAndBeyondGoal = [
            75, 90, 95,
          ].every((percent) =>
            latest.some(
              (item) =>
                typeof item.text === "string" &&
                item.text.includes(`input (${percent}%)`) &&
                noticeHasPlanningGuidance(item.text),
            ),
          );
        checks.allStagesIncludeDefaultAutoEstimate = latest.every(
          (item) =>
            typeof item.text === "string" &&
            item.text.includes("default auto ~170k (") &&
            defaultAutoWithDistance.test(item.text),
        );
        checks.descriptionsNameFactualMilestone = latest.every(
          (item) =>
            item.description ===
            `Context usage reached the ${object(item.metadata).milestone}% milestone`,
        );
        checks.selfCompactionAvailabilityMatchesConfiguration =
          compactVisibility.size === 1 &&
          compactVisibility.has(configuration.selfCompaction);
        checks.noticeRetainsTimeIdentityAndMeasurementScope = latest.every(
          (item) =>
            typeof item.text === "string" &&
            !item.text.includes("\n") &&
            /measured \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z/.test(item.text) &&
            item.text.includes("simulation/gpt-sim-model, initial context") &&
            item.text.endsWith(` · ${measurementScope}`) &&
            !/Snapshot is stale|earlier under host/.test(item.text),
        );
        // Headroom in each stored notice is computed from the measurement that triggered it.
        checks.noticeShowsInputHeadroom = latest.every((item) =>
          /input \([\d.]+%\) · (?:[\d.]+k? remaining|[\d.]+k? over input window)/.test(
            typeof item.text === "string" ? item.text : "",
          ),
        );
        yield* finishScenario(
          dir,
          "context-warning-early",
          {
            threshold,
            configuredThreshold: configuration.threshold ?? "default",
            selfCompaction: configuration.selfCompaction,
            compactVisibility: [...compactVisibility],
            steps,
            warnings: latest,
          },
          checks,
        );
      }),
  );
};

export default Effect.gen(function* () {
  for (const configuration of configurations) yield* run(configuration);
});
