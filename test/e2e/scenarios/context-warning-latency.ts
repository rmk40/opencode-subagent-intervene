import { Effect, Stream } from "effect";
import { Llm, OpenCodeDriver } from "opencode-drive";
import {
  call,
  captureToolResults,
  finishScenario,
  instanceFor,
  readLog,
  recordRequest,
  runDir,
  waitIdle,
  writeLine,
} from "../harness";
import {
  contextPlugins,
  hookTimings,
  measurementScope,
  noticeHasPlanningGuidance,
  object,
  usage,
} from "../context-harness";

// About 200k tokens under the usual four-character estimate; no provider cache-hit claim.
const text =
  "some ordinary context text for the local latency fixture. ".repeat(14546);
const run = (enabled: boolean) => {
  const dir = runDir(`context-warning-latency-${enabled}`);
  return OpenCodeDriver.use(
    {
      config: {
        plugins: contextPlugins(dir, { contextNotices: enabled }),
        compaction: { auto: false },
      },
    },
    ({ llm, directory }) =>
      Effect.gen(function* () {
        let step = 0;
        const requests: { index: number; userTexts: string[] }[] = [];
        yield* llm.serve((request, index) => {
          const req = recordRequest(dir, request.body, index);
          captureToolResults(dir, request.body);
          requests.push({
            index,
            userTexts: req.userTexts.filter((item) => item.length < 4000),
          });
          if (req.last.role === "user" && req.last.text.includes("SEED-LARGE"))
            return Stream.make(Llm.text("SEEDED"), usage(150000));
          if (step++ < 40)
            return Stream.make(
              Llm.toolCall({
                index: 0,
                id: `latency_${step}`,
                name: "probe_direct",
                input: {},
              }),
              usage(150000),
              Llm.finish("tool-calls"),
            );
          return Stream.make(Llm.text("FINAL-UNCHANGED"), usage(180000));
        });
        const instance = yield* Effect.promise(() =>
          instanceFor(dir, directory),
        );
        yield* Effect.promise(() =>
          call(instance, "model.limit", { context: 250000, input: 200000 }),
        );
        const session = yield* Effect.promise(() =>
          call<{ id: string }>(instance, "create", { title: "large-context" }),
        );
        yield* Effect.promise(async () => {
          await call(instance, "prompt", {
            sessionID: session.id,
            text: `SEED-LARGE ${text}`,
          });
          await waitIdle(instance, session.id);
          await call(instance, "prompt", {
            sessionID: session.id,
            text: "TOOLS",
          });
          await waitIdle(instance, session.id, 60000);
        });
        const history = yield* Effect.promise(() =>
          call<unknown[]>(instance, "context", { sessionID: session.id }),
        );
        const timings = hookTimings(dir);
        const sorted = timings.map((item) => item.ms).sort((a, b) => a - b);
        const p95 = sorted[Math.ceil(sorted.length * 0.95) - 1] ?? Infinity;
        const warnings = history.filter(
          (item) => object(item).type === "synthetic",
        );
        const warningText = object(warnings[0]).text;
        const firstWarningRequest = requests.findIndex((item) =>
          item.userTexts.includes(String(warningText)),
        );
        const warningsPersist =
          firstWarningRequest < 0 ? [] : requests.slice(firstWarningRequest);
        const log = readLog(dir);
        writeLine(dir, "timings.json", { timings, p95, requests });
        yield* finishScenario(
          dir,
          "context-warning-latency",
          {
            enabled,
            bytes: text.length,
            p95,
            warnings,
            requestCount: requests.length,
          },
          {
            allHooksMeasured: timings.length === 40,
            largeHistoryWasRead: timings.every(
              (item) => Number(item.historyBytes) >= 800000,
            ),
            p95Within100ms: p95 <= 100,
            exactlyOneMilestoneOrDisabled: enabled
              ? warnings.length === 1 &&
                object(object(warnings[0]).metadata).threshold === "50" &&
                object(object(warnings[0]).metadata).milestone === "70" &&
                noticeHasPlanningGuidance(warningText) &&
                typeof warningText === "string" &&
                warningText.includes(
                  "150k / 200k input (75.01%) · 50k remaining",
                ) &&
                warningText.includes("default auto ~170k (20k away)") &&
                warningText.endsWith(` · ${measurementScope}`)
              : warnings.length === 0,
            durableWarningBytesUnchanged:
              !enabled ||
              (warningsPersist.length >= 2 &&
                warningsPersist.every(
                  (item) =>
                    item.userTexts.filter((value) => value === warningText)
                      .length === 1,
                )),
            finalResponseDidNotCreateTurn: requests.length === 42,
            finalResponseStored:
              JSON.stringify(history).includes("FINAL-UNCHANGED"),
            originalToolResultsPreserved: log
              .filter((item) => item.kind === "context-hook-exit")
              .every(
                (item) =>
                  JSON.stringify(item.result) ===
                  JSON.stringify(
                    log.find(
                      (before) =>
                        before.kind === "context-hook-enter" &&
                        before.callID === item.callID,
                    )?.result,
                  ),
              ),
          },
        );
      }),
  );
};

export default Effect.gen(function* () {
  yield* run(true);
  yield* run(false);
});
