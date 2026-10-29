import { describe, expect, test } from "bun:test";
import { CallID, type ToolContext } from "@opencode/plugin/promise/tool";
import { Brand } from "effect";
import { Latch } from "@/core/latch";
import type { SessionMessageInfo } from "@/core/ports";
import { RunStateTracker } from "@/core/run-state";
import { inspectTool } from "@/tools/inspect";
import {
  assistant,
  compaction,
  executionStarted,
  FakeClock,
  FakeControl,
  FakeSessionReader,
  MemoryStore,
  RecordingLogger,
  running,
  sessionInfo,
  text,
  tool,
} from "./fixtures";

const CALLER = "caller";
const CHILD = "child";
const NOW = 5_000_000;

const SCOPE = "Scope: messages since the last compaction";
const SCOPE_WITH_SUMMARY =
  "Scope: messages since the last compaction, plus its summary of the earlier work";
const SCOPE_SUMMARY_OMITTED =
  "Scope: messages since the last compaction; its summary of the earlier work did not fit, pass a larger maxChars to see it";

function context(): ToolContext {
  return {
    sessionID: Brand.nominal<ToolContext["sessionID"]>()(CALLER),
    agent: Brand.nominal<ToolContext["agent"]>()("build"),
    messageID: Brand.nominal<ToolContext["messageID"]>()("msg_inspect"),
    id: CallID.make("call_inspect"),
    signal: new AbortController().signal,
    progress: async () => {},
  };
}

/** The caller and one running child in `/work-feature` whose context is `messages`. */
async function inspect(
  messages: readonly SessionMessageInfo[],
  maxChars?: number,
) {
  const reader = new FakeSessionReader([
    sessionInfo(CALLER),
    {
      ...sessionInfo(CHILD, CALLER),
      location: { directory: "/work-feature" },
    },
  ]);
  reader.contexts.set(CHILD, messages);
  const control = new FakeControl();
  const clock = new FakeClock(NOW);
  const logger = new RecordingLogger();
  const runState = new RunStateTracker({ control, clock });
  runState.onEvent(executionStarted(CHILD));
  const latch = new Latch({
    store: new MemoryStore(),
    control,
    clock,
    logger,
    renderNote: () => "",
  });
  const result = await inspectTool({
    reader,
    latch,
    runState,
    clock,
    logger,
  }).execute(
    { sessionID: CHILD, ...(maxChars === undefined ? {} : { maxChars }) },
    context(),
  );
  if (result.output === undefined) throw new Error("expected an output");
  if (typeof result.content !== "string") {
    throw new Error("expected text content");
  }
  return { output: result.output, lines: result.content.split("\n") };
}

describe("subagents.inspect", () => {
  test("reports the subagent's directory in the output and on a header line", async () => {
    const { output, lines } = await inspect([]);
    expect(output.directory).toBe("/work-feature");
    expect(lines.slice(0, 3)).toEqual([
      `Session ${CHILD}`,
      "Directory: /work-feature",
      "State: running",
    ]);
  });

  test("gives each running tool its full input and how long it has run", async () => {
    const command = `bun test ${"x".repeat(400)}`;
    const { output, lines } = await inspect([
      assistant([tool("shell", running({ command }), { ran: NOW - 252_000 })]),
    ]);
    expect(output.activeTools).toEqual([
      {
        name: "shell",
        status: "running",
        input: JSON.stringify({ command }),
        runningForMs: 252_000,
      },
    ]);
    expect(lines).toContain(
      `- shell (running, 4m 12s): ${JSON.stringify({ command })}`,
    );
  });

  describe("the summary of earlier work", () => {
    test("is shown after the last text, and the Scope line says so", async () => {
      const { output, lines } = await inspect([
        compaction("completed", "Added the writer."),
        assistant([text("Fixing quoting.")]),
      ]);
      expect(output.earlierSummary).toBe("Added the writer.");
      expect(output).not.toHaveProperty("earlierSummaryOmitted");
      expect(lines).toContain(SCOPE_WITH_SUMMARY);
      expect(lines.slice(-2)).toEqual([
        "Summary of earlier work (from the last compaction):",
        "Added the writer.",
      ]);
    });

    test("that did not fit is marked omitted, and the Scope line asks for a larger maxChars", async () => {
      // The text fills the whole budget of 200.
      const { output, lines } = await inspect(
        [
          compaction("completed", "Added the writer."),
          assistant([text("t".repeat(200))]),
        ],
        200,
      );
      expect(output).not.toHaveProperty("earlierSummary");
      expect(output.earlierSummaryOmitted).toBe(true);
      expect(output.truncated).toBe(true);
      expect(lines).toContain(SCOPE_SUMMARY_OMITTED);
    });

    const NO_SUMMARY: ReadonlyArray<
      readonly [string, readonly SessionMessageInfo[]]
    > = [
      ["there is no compaction", []],
      ["the compaction's summary is blank", [compaction("completed", "  ")]],
    ];

    test.each(NO_SUMMARY)(
      "leaves both fields out and keeps the plain Scope line when %s",
      async (_, messages) => {
        const { output, lines } = await inspect(messages);
        expect(output).not.toHaveProperty("earlierSummary");
        expect(output).not.toHaveProperty("earlierSummaryOmitted");
        expect(lines).toContain(SCOPE);
      },
    );
  });
});
