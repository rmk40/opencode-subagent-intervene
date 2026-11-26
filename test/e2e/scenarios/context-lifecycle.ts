import { Effect, Stream } from "effect";
import { Llm, OpenCodeDriver, type OpenCode } from "opencode-drive";
import {
  call,
  captureToolResults,
  finishScenario,
  Gate,
  instanceFor,
  readLog,
  recordRequest,
  runDir,
  takeCall,
  until,
  waitIdle,
  writeLine,
} from "../harness";
import {
  compactionSummary,
  contextPlugins,
  measurementScope,
  noticeHasPlanningGuidance,
  object,
  structuredResult,
  toolObservation,
  usage,
} from "../context-harness";

const dir = runDir("context-lifecycle");
const modes = [
  "handoff",
  "omitted",
  "queued",
  "coalesced",
  "stale-warning",
  "failed",
] as const;
type Mode = (typeof modes)[number];

export default OpenCodeDriver.use(
  {
    tools: ["shell"],
    config: {
      permissions: [],
      plugins: contextPlugins(dir),
      compaction: { auto: false },
    },
  },
  ({ llm, tools, directory, opencode }) =>
    Effect.gen(function* () {
      const shells = yield* tools.control("shell");
      const states = new Map<
        string,
        { mode: Mode; step: number; gate: Gate; summaryGate: Gate }
      >();
      const compactionRequests: { sessionID: string; at: number }[] = [];
      yield* llm.serve((request, index) => {
        const req = recordRequest(dir, request.body, index);
        captureToolResults(dir, request.body);
        const compactID = /PROBE-COMPACTION<([^>]+)>/.exec(req.system)?.[1];
        if (compactID) {
          writeLine(dir, "compaction-requests.jsonl", request.body);
          compactionRequests.push({ sessionID: compactID, at: Date.now() });
          const summaryGate = states.get(compactID)?.summaryGate;
          return Stream.fromEffect(
            Effect.promise(() => summaryGate?.opened ?? Promise.resolve()),
          ).pipe(
            Stream.flatMap(() =>
              Stream.make(Llm.text(compactionSummary), usage(1000)),
            ),
          );
        }
        const state = states.get(req.sessionID ?? "");
        if (!state) return Stream.make(Llm.text("Auxiliary response."));
        const step = state.step++;
        writeLine(dir, "requests.jsonl", {
          sessionID: req.sessionID,
          mode: state.mode,
          step,
          body: request.body,
        });
        if (step === 0)
          return Stream.make(
            Llm.toolCall({
              index: 0,
              id: `${state.mode}_status`,
              name: "context_status",
              input: {},
            }),
            usage(state.mode === "stale-warning" ? 150000 : 1000),
            Llm.finish("tool-calls"),
          );
        if (step === 1) {
          const compact = Llm.toolCall({
            index: 0,
            id: `${state.mode}_compact`,
            name: "context_compact",
            input:
              state.mode === "omitted"
                ? {}
                : {
                    handoff: `HANDOFF-${state.mode}: preserve the runtime probe goal; exact next action: answer CONTINUED.`,
                  },
          });
          const batch = [
            compact,
            Llm.toolCall({
              index: 1,
              id: `${state.mode}_hold`,
              name: "shell",
              input: { command: "hold", description: "boundary barrier" },
            }),
          ];
          if (state.mode === "coalesced")
            batch.push(
              Llm.toolCall({
                index: 2,
                id: `${state.mode}_second`,
                name: "context_compact",
                input: {},
              }),
            );
          return Stream.fromEffect(
            Effect.promise(() => state.gate.opened),
          ).pipe(
            Stream.flatMap(() =>
              Stream.make(...batch, usage(1100), Llm.finish("tool-calls")),
            ),
          );
        }
        return Stream.make(Llm.text(`CONTINUED-${state.mode}`), usage(900));
      });
      const instance = yield* Effect.promise(() => instanceFor(dir, directory));
      yield* Effect.promise(() =>
        call(instance, "model.limit", { context: 250000, input: 200000 }),
      );
      const checks: Record<string, boolean> = {};
      const evidence: Record<string, unknown> = {};
      for (const mode of modes) {
        const session = yield* Effect.promise(() =>
          call<{ id: string }>(instance, "create", { title: mode }),
        );
        const state = {
          mode,
          step: 0,
          gate: new Gate(),
          summaryGate: new Gate(),
        };
        states.set(session.id, state);
        yield* Effect.promise(() =>
          call(instance, "compaction.fail", { enabled: mode === "failed" }),
        );
        yield* Effect.promise(() =>
          call(instance, "prompt", {
            sessionID: session.id,
            text: `ROLE<${mode}> perform the context lifecycle probe.`,
          }),
        );
        yield* Effect.promise(() =>
          until("status returned and next step requested", () =>
            state.step >= 2 ? true : undefined,
          ),
        );
        let queued: unknown;
        if (mode === "queued")
          queued = yield* Effect.promise(() =>
            call(instance, "compact", {
              sessionID: session.id,
              delivery: "queue",
            }),
          );
        state.gate.open();
        const hold = yield* takeCall(shells, `${mode}_hold`);
        yield* hold.progress("boundary is held\n");
        yield* Effect.promise(() =>
          until("compaction admission returned", () =>
            toolObservation(dir, `${mode}_compact`),
          ),
        );
        if (mode === "coalesced")
          yield* Effect.promise(() =>
            until("second compaction admission returned", () =>
              toolObservation(dir, `${mode}_second`),
            ),
          );
        const beforeRelease = Date.now();
        const pending = yield* opencode.session.inbox
          .list({
            sessionID: session.id as Parameters<
              OpenCode["session"]["inbox"]["list"]
            >[0]["sessionID"],
          })
          .pipe(Effect.orDie);
        const admission = structuredResult(dir, `${mode}_compact`);
        const second = structuredResult(dir, `${mode}_second`);
        checks[`${mode}:admissionReturnsBeforeBoundary`] =
          !compactionRequests.some((item) => item.sessionID === session.id);
        checks[`${mode}:pendingCompaction`] =
          pending.filter((item) => item.type === "compaction").length === 1;
        checks[`${mode}:requested`] = admission.status === "requested";
        if (mode === "queued")
          checks[`${mode}:preservesDeliveryAndID`] =
            admission.delivery === "queue" &&
            JSON.stringify(admission).includes(String(object(queued).id));
        if (mode === "coalesced")
          checks[`${mode}:sameAdmittedID`] = pending.some(
            (item) =>
              item.type === "compaction" &&
              JSON.stringify(admission).includes(item.id) &&
              JSON.stringify(second).includes(item.id),
          );
        yield* hold.succeed({ output: "ORIGINAL-BARRIER-RESULT", exit: 0 });
        yield* Effect.promise(() =>
          until("compaction request started", () =>
            compactionRequests.find((item) => item.sessionID === session.id),
          ),
        );
        const runningStatus = yield* Effect.promise(() =>
          call(instance, "tool.run", {
            sessionID: session.id,
            tool: "context_status",
            messageID: toolObservation(dir, `${mode}_compact`)?.messageID,
          }),
        );
        if (mode !== "failed")
          checks[`${mode}:runningCompactionVisible`] =
            object(object(object(runningStatus).output).latestCompaction)
              .status === "running" &&
            String(object(runningStatus).content).includes(
              "last compaction running",
            );
        state.summaryGate.open();
        yield* Effect.promise(() =>
          until(
            "compaction stored",
            async () => {
              const history = await call<unknown[]>(instance, "context", {
                sessionID: session.id,
              });
              return history.some(
                (message) =>
                  object(message).type === "compaction" &&
                  ["completed", "failed"].includes(
                    String(object(message).status),
                  ),
              )
                ? history
                : undefined;
            },
            30000,
          ),
        );
        yield* Effect.promise(() => waitIdle(instance, session.id, 30000));
        const history = yield* Effect.promise(() =>
          call<unknown[]>(instance, "context", { sessionID: session.id }),
        );
        const compactions = history
          .filter((message) => object(message).type === "compaction")
          .map(object);
        const compaction = compactions.at(-1);
        const handoff = history.findIndex(
          (message) =>
            object(message).type === "synthetic" &&
            JSON.stringify(message).includes(`HANDOFF-${mode}`),
        );
        const checkpoint = history.findIndex(
          (message) => object(message).id === compaction?.id,
        );
        const observations = readLog(dir).filter(
          (item) =>
            item.kind === "context-hook-exit" && item.sessionID === session.id,
        );
        checks[`${mode}:callerPresentDuringToolHook`] = observations.every(
          (item) => object(item.caller).id === item.messageID,
        );
        checks[`${mode}:boundaryAfterBatch`] = compactionRequests.some(
          (item) => item.sessionID === session.id && item.at >= beforeRelease,
        );
        checks[`${mode}:originalToolResult`] = JSON.stringify(
          toolObservation(dir, `${mode}_hold`)?.result,
        ).includes("ORIGINAL-BARRIER-RESULT");
        checks[`${mode}:completionOutcome`] =
          mode === "failed"
            ? compaction?.status === "failed" &&
              JSON.stringify(compaction).includes("PROBE-COMPACTION-FAILURE")
            : compaction?.status === "completed";
        if (mode !== "failed" && mode !== "queued")
          checks[`${mode}:automaticContinuation`] = JSON.stringify(
            history,
          ).includes(`CONTINUED-${mode}`);
        if (mode === "handoff" || mode === "coalesced")
          checks[`${mode}:handoffAfterCheckpoint`] =
            handoff > checkpoint && checkpoint >= 0;
        if (mode === "omitted")
          checks[`${mode}:noSyntheticContinuation`] = history.every(
            (message) => object(message).type !== "synthetic",
          );
        const latestAssistant = history
          .map(object)
          .filter((item) => item.type === "assistant")
          .at(-1);
        const finalStatus = yield* Effect.promise(() =>
          call(instance, "tool.run", {
            sessionID: session.id,
            tool: "context_status",
            messageID: latestAssistant?.id,
          }),
        );
        checks[`${mode}:statusShowsCompactionOutcome`] =
          object(object(object(finalStatus).output).latestCompaction).status ===
            (mode === "failed" ? "failed" : "completed") &&
          String(object(finalStatus).content).includes(
            `last compaction ${mode === "failed" ? "failed" : "completed"}`,
          ) &&
          !String(object(finalStatus).content).includes("\n") &&
          (mode !== "failed" ||
            String(object(finalStatus).content).includes(
              "PROBE-COMPACTION-FAILURE",
            ));
        if (mode === "stale-warning") {
          const warning = history
            .map(object)
            .find(
              (item) =>
                item.type === "synthetic" &&
                object(item.metadata).kind === "context-warning",
            );
          checks[`${mode}:oldEpochWarningDeliveredAfterCheckpoint`] =
            history.indexOf(warning) > checkpoint && checkpoint >= 0;
          checks[`${mode}:warningKeepsMeasuredEpochAndScope`] =
            typeof warning?.text === "string" &&
            object(warning.metadata).epoch === "initial" &&
            warning.text.includes(
              "simulation/gpt-sim-model, initial context (no completed compaction)",
            ) &&
            warning.text.endsWith(` · ${measurementScope}`) &&
            warning.text.includes(
              "150k / 200k input (75.01%) · 50k remaining",
            ) &&
            warning.text.includes("assumed default auto ~170k (20k away)") &&
            noticeHasPlanningGuidance(warning.text) &&
            /measured \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z/.test(warning.text);
        }
        evidence[mode] = {
          sessionID: session.id,
          admission,
          second,
          pending,
          compaction,
          checkpoint,
          handoff,
          steps: state.step,
          runningStatus,
          finalStatus,
        };
        writeLine(dir, "history.jsonl", { mode, history });
      }
      yield* finishScenario(dir, "context-lifecycle", evidence, checks);
    }),
);
