// The `compactionBuffer` option reaches both context_status and the context notices: with
// "10%", an 850.3k measurement in a 1M window reads `configured auto ~900k (49.7k away)` instead of
// the default estimate.
import { Effect, Stream } from "effect";
import { Llm, OpenCodeDriver } from "opencode-drive";
import {
  call,
  captureToolResults,
  capturedToolResult,
  finishScenario,
  instanceFor,
  recordRequest,
  runDir,
  toolCallResponse,
  waitIdle,
} from "../harness";
import {
  contextPlugins,
  noticeHasPlanningGuidance,
  object,
  structuredResult,
  usage,
} from "../context-harness";

/** 850,280 prompt tokens plus 20 completion tokens: an 850.3k measurement. */
const SEEDED_INPUT = 850280;
const CONFIGURED = "configured auto ~900k (49.7k away)";

const dir = runDir("context-compaction-buffer");
export default OpenCodeDriver.use(
  {
    config: {
      plugins: contextPlugins(dir, { compactionBuffer: "10%" }),
      compaction: { auto: false },
    },
  },
  ({ llm, directory }) =>
    Effect.gen(function* () {
      yield* llm.serve((request, index) => {
        const req = recordRequest(dir, request.body, index);
        captureToolResults(dir, request.body);
        if (req.last.role === "user" && req.last.text.includes("SEED"))
          return Stream.make(Llm.text("SEEDED"), usage(SEEDED_INPUT));
        if (req.last.role === "user" && req.last.text.includes("CMD-STATUS"))
          return toolCallResponse("buffer_status", "context_status", {});
        if (req.last.role === "user" && req.last.text.includes("CMD-TOOLS"))
          return Stream.make(
            Llm.toolCall({
              index: 0,
              id: "buffer_tool",
              name: "probe_direct",
              input: {},
            }),
            usage(SEEDED_INPUT),
            Llm.finish("tool-calls"),
          );
        return Stream.make(Llm.text("DONE"), usage(SEEDED_INPUT));
      });
      const instance = yield* Effect.promise(() => instanceFor(dir, directory));
      yield* Effect.promise(() =>
        call(instance, "model.limit", { context: 1000000, input: 1000000 }),
      );
      const session = yield* Effect.promise(() =>
        call<{ id: string }>(instance, "create", { title: "compaction-buffer" }),
      );
      const prompt = (text: string) =>
        Effect.promise(async () => {
          await call(instance, "prompt", { sessionID: session.id, text });
          await waitIdle(instance, session.id);
        });
      yield* prompt("SEED");
      yield* prompt("CMD-STATUS");
      yield* prompt("CMD-TOOLS");
      const status = structuredResult(dir, "buffer_status");
      const statusText = capturedToolResult(dir, "buffer_status") ?? "";
      const history = yield* Effect.promise(() =>
        call<unknown[]>(instance, "context", { sessionID: session.id }),
      );
      const notices = history
        .map(object)
        .filter(
          (item) =>
            item.type === "synthetic" &&
            object(item.metadata).kind === "context-warning",
        );
      const noticeText = notices.map((item) => String(item.text));
      const estimate = object(status.autoCompactionEstimate);
      yield* finishScenario(
        dir,
        "context-compaction-buffer",
        { status, statusText, notices },
        {
          statusMeasuresTheSeed:
            object(status.measurement).reportedTokens === SEEDED_INPUT + 20,
          statusEstimateIsConfigured:
            estimate.source === "configured" &&
            estimate.tokens === 900000 &&
            estimate.percent === 90,
          statusTextShowsConfiguredEstimate:
            statusText.includes(CONFIGURED) &&
            !statusText.includes("assumed default auto"),
          statusTextHasNoBufferReminder: !statusText.includes(
            "set the plugin's compactionBuffer option to match",
          ),
          statusHeadroomUsesConfiguredEstimate:
            status.autoCompactionHeadroomTokens === 49700,
          oneNoticeAtThe85Milestone:
            notices.length === 1 &&
            object(notices[0]?.metadata).milestone === "85",
          noticeShowsConfiguredEstimate:
            noticeText.length === 1 &&
            noticeText.every(
              (text) =>
                text.includes(CONFIGURED) &&
                !text.includes("assumed default auto") &&
                noticeHasPlanningGuidance(text),
            ),
        },
      );
    }),
);
