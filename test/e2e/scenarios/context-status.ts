import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { Effect, Stream } from "effect";
import { Llm, OpenCodeDriver, type OpenCode } from "opencode-drive";
import {
  call,
  captureToolResults,
  capturedToolResult,
  finishScenario,
  instanceFor,
  readLog,
  recordRequest,
  runDir,
  toolCallResponse,
  until,
  waitIdle,
  writeLine,
} from "../harness";
import {
  contextPlugins,
  object,
  structuredResult,
  toolObservation,
  usage,
} from "../context-harness";

const dir = runDir("context-status");
type RevertInput = Parameters<OpenCode["session"]["revert"]["stage"]>[0];
export default OpenCodeDriver.use(
  {
    config: {
      permissions: [],
      plugins: contextPlugins(dir),
      compaction: { auto: false },
      providers: {
        simulation: {
          models: {
            "alternate-model": {
              limit: { context: 400000, input: 300000, output: 4000 },
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
      const statusDescriptions = new Set<string>();
      const compactDescriptions = new Set<string>();
      yield* llm.serve((request, index) => {
        const req = recordRequest(dir, request.body, index);
        const requestTools = object(request.body).tools;
        if (Array.isArray(requestTools))
          for (const definition of requestTools) {
            const tool = object(object(definition).function);
            if (
              tool.name === "context_status" &&
              typeof tool.description === "string"
            )
              statusDescriptions.add(tool.description);
            if (
              tool.name === "context_compact" &&
              typeof tool.description === "string"
            )
              compactDescriptions.add(tool.description);
          }
        captureToolResults(dir, request.body);
        writeLine(dir, "requests.jsonl", {
          sessionID: req.sessionID,
          body: request.body,
        });
        if (req.last.role === "user" && req.last.text.includes("CMD-STATUS"))
          return toolCallResponse(`status_${serial++}`, "context_status", {});
        if (req.last.role === "user" && req.last.text.includes("SEED-LOW"))
          return Stream.make(Llm.text("LOW-MEASUREMENT"), usage(1000));
        if (req.last.role === "user" && req.last.text.includes("SEED-HIGH"))
          return Stream.make(Llm.text("HIGH-MEASUREMENT"), usage(150000));
        if (req.last.role === "user" && req.last.text.includes("SEED-750K"))
          return Stream.make(Llm.text("MILLION-MEASUREMENT"), usage(749980));
        if (req.last.role === "user" && req.last.text.includes("SEED-OVER"))
          return Stream.make(Llm.text("OVERRUN-MEASUREMENT"), usage(209980));
        return Stream.make(Llm.text("DONE"), usage(1000));
      });
      const a = yield* Effect.promise(() => instanceFor(dir, directory));
      yield* Effect.promise(() =>
        call(a, "model.limit", { context: 250000, input: 200000 }),
      );
      const session = yield* Effect.promise(() =>
        call<{ id: string }>(a, "create", { title: "status" }),
      );
      const prompt = (text: string) =>
        Effect.promise(async () => {
          await call(a, "prompt", { sessionID: session.id, text });
          await waitIdle(a, session.id);
        });
      yield* prompt("ROLE<status> CMD-STATUS empty session");
      const initial = structuredResult(dir, "status_0");
      yield* prompt("SEED-HIGH");
      const beforeHighTool = yield* Effect.promise(() =>
        call<unknown[]>(a, "context", { sessionID: session.id }),
      );
      yield* prompt("CMD-STATUS measured");
      const measured = structuredResult(dir, "status_1");
      const sourceMeasurement = beforeHighTool
        .map(object)
        .find((item) => item.id === object(measured.measurement).messageID);
      yield* Effect.promise(() =>
        call(a, "switchModel", {
          sessionID: session.id,
          modelID: "alternate-model",
        }),
      );
      yield* prompt("CMD-STATUS switched");
      const switched = structuredResult(dir, "status_2");
      const switchedCaller = object(toolObservation(dir, "status_2")?.caller);

      const bDir = resolve(directory, "..", "context-location-b");
      mkdirSync(bDir, { recursive: true });
      yield* Effect.promise(() =>
        call(a, "move", { sessionID: session.id, directory: bDir }),
      );
      const b = yield* Effect.promise(() => instanceFor(dir, bDir));
      const destinationCatalogBeforeOverride = yield* Effect.promise(() =>
        until("destination configured model catalog", async () => {
          const catalog = await call(b, "models", { directory: bDir });
          const data = object(catalog).data;
          if (!Array.isArray(data)) return undefined;
          const models = data.map(object);
          const simulated = models.find((item) => item.id === "gpt-sim-model");
          const alternate = models.find(
            (item) => item.id === "alternate-model",
          );
          return object(simulated?.limit).context === 128000 &&
            object(alternate?.limit).context === 400000
            ? catalog
            : undefined;
        }),
      );
      yield* Effect.promise(() =>
        call(b, "model.limit", {
          context: 600000,
          input: 500000,
        }),
      );
      const destinationCatalogAfterOverride = yield* Effect.promise(() =>
        call(b, "models", { directory: bDir }),
      );
      const destinationModels = object(destinationCatalogAfterOverride).data;
      const destinationModel = Array.isArray(destinationModels)
        ? destinationModels
            .map(object)
            .find((item) => item.id === "gpt-sim-model")
        : undefined;
      const destinationLimits = object(destinationModel?.limit);
      if (
        destinationLimits.context !== 600000 ||
        destinationLimits.input !== 500000
      )
        return yield* Effect.die(
          new Error("destination catalog override is unavailable"),
        );
      yield* Effect.promise(() =>
        call(b, "switchModel", {
          sessionID: session.id,
          modelID: "gpt-sim-model",
        }),
      );
      yield* prompt("CMD-STATUS second location");
      const located = structuredResult(dir, "status_3");
      const crossLocation = yield* Effect.promise(() =>
        call(a, "tool.run", {
          sessionID: session.id,
          tool: "context_status",
          messageID: toolObservation(dir, "status_3")?.messageID,
        }),
      );
      const crossLocationInfo = yield* Effect.promise(() =>
        call(a, "get", { sessionID: session.id }),
      );
      const crossLocationModels = yield* Effect.promise(() =>
        call(a, "models", { directory: bDir }),
      );
      const localModels = yield* Effect.promise(() =>
        call(b, "models", { directory: bDir }),
      );

      const reverted = yield* Effect.promise(() =>
        call<{ id: string }>(b, "create", { title: "revert" }),
      );
      yield* Effect.promise(async () => {
        await call(b, "prompt", { sessionID: reverted.id, text: "SEED-LOW" });
        await waitIdle(b, reverted.id);
        await call(b, "prompt", {
          sessionID: reverted.id,
          text: "SEED-LOW second response",
        });
        await waitIdle(b, reverted.id);
        await call(b, "prompt", { sessionID: reverted.id, text: "SEED-HIGH" });
        await waitIdle(b, reverted.id);
      });
      const beforeRevert = yield* Effect.promise(() =>
        call<unknown[]>(b, "context", { sessionID: reverted.id }),
      );
      const highPrompt = beforeRevert
        .map(object)
        .find(
          (item) =>
            item.type === "user" && JSON.stringify(item).includes("SEED-HIGH"),
        );
      const lowAssistant = beforeRevert
        .map(object)
        .filter((item) => item.type === "assistant")[1];
      if (!highPrompt || !lowAssistant)
        return yield* Effect.die(new Error("missing revert fixture messages"));
      yield* opencode.session.revert
        .stage({
          sessionID: reverted.id as RevertInput["sessionID"],
          messageID: highPrompt.id as RevertInput["messageID"],
          files: false,
        })
        .pipe(Effect.orDie);
      const stagedHistory = yield* Effect.promise(() =>
        call<unknown[]>(b, "context", { sessionID: reverted.id }),
      );
      const stagedStatus = yield* Effect.promise(() =>
        call(b, "tool.run", {
          sessionID: reverted.id,
          tool: "context_status",
          messageID: lowAssistant.id,
        }),
      );
      const unknownCaller = yield* Effect.promise(() =>
        call(b, "tool.run", {
          sessionID: reverted.id,
          tool: "context_status",
          messageID: "msg_absent_probe",
        }),
      );
      yield* Effect.promise(() =>
        call(b, "model.limit", { context: 0, input: 200000 }),
      );
      const inputOnlySession = yield* Effect.promise(() =>
        call<{ id: string }>(b, "create", { title: "input-only-limit" }),
      );
      yield* Effect.promise(async () => {
        await call(b, "prompt", {
          sessionID: inputOnlySession.id,
          text: "SEED-HIGH",
        });
        await waitIdle(b, inputOnlySession.id);
        await call(b, "prompt", {
          sessionID: inputOnlySession.id,
          text: "CMD-STATUS without positive context limit",
        });
        await waitIdle(b, inputOnlySession.id);
      });
      const inputOnly = structuredResult(dir, "status_4");
      yield* Effect.promise(() =>
        call(b, "model.limit", { context: 200000, input: 200000 }),
      );
      const equalSession = yield* Effect.promise(() =>
        call<{ id: string }>(b, "create", {
          title: "equal-context-input-limits",
        }),
      );
      yield* Effect.promise(async () => {
        await call(b, "prompt", {
          sessionID: equalSession.id,
          text: "SEED-HIGH",
        });
        await waitIdle(b, equalSession.id);
        await call(b, "prompt", {
          sessionID: equalSession.id,
          text: "CMD-STATUS equal context and input limits",
        });
        await waitIdle(b, equalSession.id);
      });
      const equalLimits = structuredResult(dir, "status_5");
      const seededStatus = (seed: string, title: string) =>
        Effect.promise(async () => {
          const created = await call<{ id: string }>(b, "create", { title });
          await call(b, "prompt", { sessionID: created.id, text: seed });
          await waitIdle(b, created.id);
          await call(b, "prompt", {
            sessionID: created.id,
            text: `CMD-STATUS ${title}`,
          });
          await waitIdle(b, created.id);
        });
      yield* Effect.promise(() =>
        call(b, "model.limit", { context: 1000000, input: 1000000 }),
      );
      yield* seededStatus("SEED-750K", "million-window");
      const million = structuredResult(dir, "status_6");
      yield* Effect.promise(() =>
        call(b, "model.limit", { context: 200000, input: 200000 }),
      );
      yield* seededStatus("SEED-OVER", "overrun");
      const overrun = structuredResult(dir, "status_7");
      const millionText = capturedToolResult(dir, "status_6") ?? "";
      const overrunText = capturedToolResult(dir, "status_7") ?? "";
      const measuredText = capturedToolResult(dir, "status_1") ?? "";
      const switchedText = capturedToolResult(dir, "status_2") ?? "";
      const inputOnlyText = capturedToolResult(dir, "status_4") ?? "";
      const equalLimitsText = capturedToolResult(dir, "status_5") ?? "";
      const text = (value: unknown) => JSON.stringify(value);
      const checks = {
        emptyStatusIdentifiesSession:
          initial.sessionID === session.id &&
          initial.status === "missing" &&
          initial.measurement === undefined &&
          initial.reportedContextPercent === undefined &&
          initial.reportedWindowPercent === undefined,
        emptyStatusHasCurrentModel:
          object(initial.model).id === "gpt-sim-model",
        usesLatestCompletedMeasurement:
          object(measured.measurement).reportedTokens === 150020,
        structuredMeasurementTimePreservesRuntimePrecision:
          typeof object(measured.measurement).measuredAt === "number" &&
          object(measured.measurement).measuredAt ===
            object(sourceMeasurement?.time).completed,
        usableWindowUsesInputLimit:
          measured.usableInputWindow === 200000 &&
          measured.reportedWindowPercent === 75.01,
        contextPercentUsesContextLimit:
          Math.abs(Number(measured.reportedContextPercent) - 60.008) < 1e-9,
        defaultAutoThresholdUsesUsableWindow:
          object(measured.defaultAutoCompactionThreshold).tokens === 170000 &&
          object(measured.defaultAutoCompactionThreshold).percent === 85 &&
          measured.autoCompactionThreshold === "unknown",
        normalStatusIsOneLineWithoutGeneralCaveats:
          measuredText.length > 0 &&
          !measuredText.includes("\n") &&
          !/Reported counts|Catalog limits|Later messages|Large tool results/.test(
            measuredText,
          ),
        statusTextShowsBothPercentages:
          measuredText.includes("150k / 200k input (75.01%)") &&
          measuredText.includes("UI/context 60.01% of 250k"),
        structuredHeadroomIsSignedAgainstCurrentMeasurement:
          measured.inputHeadroomTokens === 49980 &&
          measured.defaultAutoCompactionHeadroomTokens === 19980 &&
          initial.inputHeadroomTokens === undefined &&
          initial.defaultAutoCompactionHeadroomTokens === undefined,
        normalTextShowsRemainingAndDefaultAutoDistance:
          millionText.includes("750k / 1M input (75%) · 250k remaining") &&
          millionText.includes("default auto ~850k (100k away)") &&
          !millionText.includes("UI/context") &&
          million.inputHeadroomTokens === 250000 &&
          million.defaultAutoCompactionHeadroomTokens === 100000,
        overrunTextIsExplicit:
          overrun.inputHeadroomTokens === -10000 &&
          overrun.defaultAutoCompactionHeadroomTokens === -40000 &&
          overrunText.includes("210k / 200k input (105%) · 10k over input window") &&
          overrunText.includes("default auto ~170k (40k past estimate)") &&
          !/remaining|away/.test(overrunText),
        unknownDistanceIsOmitted:
          capturedToolResult(dir, "status_0")?.includes(
            "default auto ~170k ·",
          ) === true &&
          !/\((?:[\d.]+k) (?:away|past estimate)\)|remaining/.test(
            capturedToolResult(dir, "status_0") ?? "",
          ) &&
          switched.inputHeadroomTokens === undefined &&
          switched.defaultAutoCompactionHeadroomTokens === undefined &&
          switchedText.includes("default auto ~255k ·") &&
          !/away|past estimate|remaining/.test(switchedText),
        statusTextHasNoticeStartDefaultAutoTimeAndCompaction:
          initial.contextWarningPercent === 50 &&
          measured.contextWarningPercent === 50 &&
          measured.warningsEnabled === true &&
          measuredText.includes("notices from 50%") &&
          !/warning|notices disabled/i.test(measuredText) &&
          measuredText.includes(
            "150k / 200k input (75.01%) · 50k remaining · UI/context 60.01% of 250k",
          ) &&
          measuredText.includes("default auto ~170k (20k away)") &&
          measuredText.includes(
            new Date(Number(object(measured.measurement).measuredAt))
              .toISOString()
              .replace(/\.\d{3}Z$/, "Z"),
          ) &&
          !/\d{2}:\d{2}:\d{2}\.\d+Z/.test(measuredText) &&
          measuredText.includes("no visible compaction"),
        descriptionCarriesSnapshotAndAutoAssumptions:
          statusDescriptions.size > 0 &&
          [...statusDescriptions].every(
            (description) =>
              description.includes(
                "Later messages and pending tool or subagent results, including this call, are not included in the measurement.",
              ) &&
              description.includes("signed token headroom") &&
              description.includes("automatic compaction is enabled") &&
              description.includes("default buffer and no override") &&
              description.includes(
                "actual resolved automatic-compaction threshold is unavailable",
              ),
          ),
        compactDescriptionExplainsCostOptionalNotesAndAdmission:
          compactDescriptions.size > 0 &&
          [...compactDescriptions].every(
            (description) =>
              /rebuild\w* cach/i.test(description) &&
              /optional/i.test(description) &&
              /admission/i.test(description) &&
              /batch/i.test(description) &&
              !/use sparingly|only when|stopping point|prepare a handoff|(?:near|approach\w*).*limit/i.test(
                description,
              ),
          ),
        textOnlyFinalDidNotAdmitWarning: beforeHighTool.every(
          (item) => !text(item).includes("context-warning"),
        ),
        switchedCallerMatchesRequest:
          object(switchedCaller.model).id === "alternate-model",
        switchedStatusUsesCallerModel:
          object(switched.model).id === "alternate-model" &&
          switched.usableInputWindow === 300000 &&
          switched.status === "different-model" &&
          switched.reportedWindowPercent === undefined &&
          switched.reportedContextPercent === undefined,
        mismatchedMeasurementTextIsHistorical:
          switchedText.includes("historical (simulation/gpt-sim-model)") &&
          switchedText.includes("current-model usage unavailable") &&
          !switchedText.includes("UI/context") &&
          !/input \([\d.]+%\)/.test(switchedText),
        movedStatusUsesLocationCatalog:
          object(located.model).id === "gpt-sim-model" &&
          located.usableInputWindow === 500000,
        movedCallerExecutesInSessionLocation:
          toolObservation(dir, "status_3")?.location === bDir,
        stagedRevertCutsOffHighUsage:
          object(object(object(stagedStatus).output).measurement)
            .reportedTokens === 1020 &&
          object(object(stagedStatus).output).historyBoundary ===
            "before-revert",
        absentCallerDoesNotGuessModel:
          object(object(unknownCaller).output).model === undefined &&
          object(object(unknownCaller).output).reportedContextPercent ===
            undefined &&
          object(object(unknownCaller).output).reportedWindowPercent ===
            undefined &&
          object(object(unknownCaller).output)
            .defaultAutoCompactionThreshold === undefined,
        missingContextKeepsInputPercentage:
          inputOnly.status === "available" &&
          object(inputOnly.limits).context === undefined &&
          inputOnly.reportedContextPercent === undefined &&
          inputOnly.usableInputWindow === 200000 &&
          inputOnly.reportedWindowPercent === 75.01 &&
          object(inputOnly.defaultAutoCompactionThreshold).tokens === 170000 &&
          object(inputOnly.defaultAutoCompactionThreshold).percent === 85,
        equalLimitsKeepBothStructuredPercentages:
          equalLimits.reportedContextPercent === 75.01 &&
          equalLimits.reportedWindowPercent === 75.01,
        equalLimitsOmitRedundantUIUsage:
          equalLimitsText.includes("150k / 200k input (75.01%)") &&
          !equalLimitsText.includes("UI/context"),
        missingContextTextKeepsInputPercentage:
          inputOnlyText.includes("150k / 200k input (75.01%)") &&
          inputOnlyText.includes("default auto ~170k (20k away)") &&
          inputOnly.inputHeadroomTokens === 49980 &&
          !inputOnlyText.includes("UI/context"),
        hookCallerIsPresent: readLog(dir)
          .filter((item) => item.kind === "context-hook-exit")
          .every((item) => object(item.caller).id === item.messageID),
      };
      yield* finishScenario(
        dir,
        "context-status",
        {
          initial,
          measured,
          sourceMeasurement,
          measuredText,
          switched,
          switchedText,
          located,
          destinationCatalogBeforeOverride,
          destinationCatalogAfterOverride,
          crossLocation,
          crossLocationInfo,
          crossLocationModels,
          localModels,
          stagedStatus,
          unknownCaller,
          inputOnly,
          inputOnlyText,
          equalLimits,
          equalLimitsText,
          million,
          millionText,
          overrun,
          overrunText,
          statusDescriptions: [...statusDescriptions],
          compactDescriptions: [...compactDescriptions],
          runtimeContextIncludesStagedRevertMarker: stagedHistory.some(
            (item) => object(item).id === highPrompt.id,
          ),
          runtimeContextIncludesRevertedHighMeasurement: stagedHistory.some(
            (item) => text(item).includes("HIGH-MEASUREMENT"),
          ),
        },
        checks,
      );
    }),
);
