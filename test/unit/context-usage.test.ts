import { describe, expect, test } from "bun:test";
import {
  readContextUsage,
  renderContextUsage,
  renderMeasurement,
  selectContextUsage,
  type ContextUsageInput,
} from "@/core/context-usage";
import type { SessionMessageInfo } from "@/core/ports";
import { contextStatusTool } from "@/tools/context-status";
import {
  catalogModel,
  ContextWorld,
  CURRENT,
  current,
  measured,
  SESSION,
  tokens,
  toolContext,
  type UsageAssistant,
} from "./context-fixtures";
import { compaction, deferred, sessionInfo, user } from "./fixtures";

function select(
  messages: readonly SessionMessageInfo[],
  overrides: Partial<ContextUsageInput> = {},
) {
  return selectContextUsage({
    sessionID: SESSION,
    messageID: CURRENT,
    messages: [...messages, current()],
    models: [catalogModel()],
    ...overrides,
  });
}

describe("eligible response measurements", () => {
  test.each([
    ["no response", []],
    ["no token counts", [{ ...current(undefined, "msg_earlier"), finish: "stop" }]],
    ["all-zero counts", [measured("msg_zero", tokens())]],
    ["output and reasoning alone", [measured("msg_output", tokens({ output: 9, reasoning: 8 }))]],
  ] satisfies ReadonlyArray<readonly [string, readonly SessionMessageInfo[]]>)(
    "reports missing usage with known limits for %s",
    (_, messages) => {
      const usage = select(messages);
      expect(usage.status).toBe("missing");
      expect(usage.measurement).toBeUndefined();
      expect(usage).not.toHaveProperty("reportedContextPercent");
      expect(usage.reportedWindowPercent).toBeUndefined();
      expect(usage.usableInputWindow).toBe(100);
      expect(renderMeasurement(usage)).toBe("No completed response measurement · input window 100");
    },
  );

  test.each([
    ["cache reads", { read: 70, write: 0 }],
    ["cache writes", { read: 0, write: 70 }],
  ])("accepts fully cached input from %s", (_, cache) => {
    const usage = select([measured("msg_cached", tokens({ cache, output: 5, reasoning: 2 }))]);
    expect(usage.status).toBe("available");
    expect(usage.measurement?.reportedTokens).toBe(77);
    expect(usage.reportedContextPercent).toBe(38.5);
    expect(usage.reportedWindowPercent).toBe(77);
  });

  const INELIGIBLE: ReadonlyArray<readonly [string, UsageAssistant]> = [
    ["an unfinished response", measured("msg_bad", tokens({ input: 90 }), { finish: undefined, time: { created: 11 } })],
    ["a structured provider error", measured("msg_bad", tokens({ input: 90 }), { error: { type: "ProviderError", message: "failed" } })],
    ["an error finish", measured("msg_bad", tokens({ input: 90 }), { finish: "error" })],
    ["negative usage", measured("msg_bad", tokens({ input: 90, reasoning: -1 }))],
    ["NaN usage", measured("msg_bad", tokens({ input: 90, output: Number.NaN }))],
    ["infinite usage", measured("msg_bad", tokens({ input: Number.POSITIVE_INFINITY }))],
    ["invalid cache usage", measured("msg_bad", tokens({ input: 90, cache: { read: -1, write: 0 } }))],
  ];

  test.each(INELIGIBLE)("keeps the preceding eligible measurement after %s", (_, latest) => {
    const usage = select([measured("msg_good", tokens({ input: 50 })), latest]);
    expect(usage.measurement?.messageID).toBe("msg_good");
    expect(usage.reportedContextPercent).toBe(25);
    expect(usage.reportedWindowPercent).toBe(50);
  });

  test("uses completion time even without a finish reason", () => {
    const usage = select([measured("msg_time", tokens({ input: 40 }), { finish: undefined })]);
    expect(usage.measurement).toMatchObject({ messageID: "msg_time", measuredAt: 20 });
    expect(renderMeasurement(usage)).toContain("measured 1970-01-01T00:00:00Z");
  });

  test("retains the measurement ID when a successful finish has no completion timestamp", () => {
    const usage = select([measured("msg_finish", tokens({ input: 40 }), { time: { created: 10 } })]);
    expect(usage.status).toBe("available");
    expect(usage.measurement?.messageID).toBe("msg_finish");
    expect(usage.measurement?.measuredAt).toBeUndefined();
    expect(renderMeasurement(usage)).toContain("measurement time unavailable");
  });

  test("selects the last eligible history entry and sums all its counts, never session totals", () => {
    const usage = select([
      measured("msg_old", tokens({ input: 90 }), { time: { created: 900, completed: 999 } }),
      measured("msg_latest", tokens({ input: 10, output: 20, reasoning: 30, cache: { read: 40, write: 50 } })),
    ]);
    expect(usage.measurement).toMatchObject({ messageID: "msg_latest", reportedTokens: 150 });
    expect(usage.reportedContextPercent).toBe(75);
    expect(usage.reportedWindowPercent).toBe(150);
  });

  test("excludes the caller's own step even when its counts and finish have already settled", () => {
    const usage = select([], { messages: [measured("msg_previous"), measured(CURRENT, tokens({ input: 99 }))] });
    expect(usage.measurement?.messageID).toBe("msg_previous");
    expect(usage.reportedContextPercent).toBe(40);
    expect(usage.reportedWindowPercent).toBe(80);
  });
});

describe("compaction and staged-revert boundaries", () => {
  test("never falls back across the latest completed compaction", () => {
    const checkpoint = compaction("completed");
    const usage = select([measured(), compaction("completed"), measured("msg_middle"), checkpoint]);
    expect(usage.status).toBe("awaiting-post-compaction");
    expect(usage.measurement).toBeUndefined();
    expect(usage).not.toHaveProperty("reportedContextPercent");
    expect(usage).not.toHaveProperty("reportedWindowPercent");
    expect(usage.completedCompactionID).toBe(checkpoint.id);
    expect(renderMeasurement(usage)).toBe("Awaiting post-compaction measurement · input window 100");
  });

  test.each(["running", "failed", "completed"] as const)(
    "reports the latest %s compaction separately from the measurement boundary",
    (status) => {
      const checkpoint = compaction("completed");
      const latest = compaction(status);
      const usage = select([checkpoint, measured(), latest]);
      expect(usage.latestCompaction).toMatchObject({ id: latest.id, status });
      expect(usage.completedCompactionID).toBe(status === "completed" ? latest.id : checkpoint.id);
      expect(usage.measurement?.messageID).toBe(status === "completed" ? undefined : "msg_measured");
      expect(usage.reportedContextPercent).toBe(status === "completed" ? undefined : 40);
      expect(renderContextUsage(usage)).toContain(`last compaction ${status}`);
    },
  );

  test("reports compaction failure text without consuming its token counts", () => {
    const failed = {
      type: "compaction" as const, id: "msg_failed", time: { created: 30 },
      reason: "auto" as const, status: "failed" as const,
      error: { type: "CompactionError", message: "summary provider unavailable" },
      tokens: tokens({ input: 900 }),
    };
    const usage = select([measured(), failed]);
    expect(usage.latestCompaction?.failureMessage).toBe("summary provider unavailable");
    expect(usage.measurement?.reportedTokens).toBe(80);
    expect(usage.reportedContextPercent).toBe(40);
    expect(renderContextUsage(usage)).toContain("summary provider unavailable");
  });

  test("cuts before the revert marker, excluding that measurement and every later compaction", () => {
    const marker = measured("msg_reverted", tokens({ input: 99 }));
    const usage = select([], {
      messages: [measured("msg_active", tokens({ input: 40 })), current(), marker, compaction("completed")],
      revert: { messageID: marker.id },
    });
    expect(usage.historyBoundary).toBe("before-revert");
    expect(usage.measurement?.messageID).toBe("msg_active");
    expect(usage.reportedContextPercent).toBe(20);
    expect(usage.reportedWindowPercent).toBe(40);
    expect(usage.inputHeadroomTokens).toBe(60);
    expect(usage.latestCompaction).toBeUndefined();
    expect(renderContextUsage(usage)).toContain("history before staged revert msg_reverted");
  });

  test("does not resolve a current model from a caller removed by the revert", () => {
    const marker = user("undo from here");
    const usage = select([measured(), marker], { revert: { messageID: marker.id } });
    expect(usage.status).toBe("model-unknown");
    expect(usage.measurement?.messageID).toBe("msg_measured");
    expect(usage.model).toBeUndefined();
    expect(usage).not.toHaveProperty("reportedContextPercent");
    expect(usage.reportedWindowPercent).toBeUndefined();
  });

  test("reports unavailable usage instead of trusting history with a missing revert marker", () => {
    const usage = select([measured(), compaction("completed"), measured("msg_new")], { revert: { messageID: "msg_absent" } });
    expect(usage.status).toBe("revert-boundary-unavailable");
    expect(usage.historyBoundary).toBe("revert-marker-missing");
    expect(usage.measurement).toBeUndefined();
    expect(usage.latestCompaction).toBeUndefined();
    expect(usage).not.toHaveProperty("reportedContextPercent");
    expect(usage.reportedWindowPercent).toBeUndefined();
    expect(renderMeasurement(usage)).toBe("Usage unavailable · staged-revert boundary missing");
  });
});

describe("current model and usable input window", () => {
  test.each([
    { providerID: "provider", id: "other" },
    { providerID: "other", id: "model" },
  ])("keeps %p usage historical when either model identifier differs", (model) => {
    const usage = select([measured("msg_matching_older"), measured("msg_other", tokens({ input: 90 }), { model })]);
    expect(usage.status).toBe("different-model");
    expect(usage.measurement?.messageID).toBe("msg_other");
    expect(usage).not.toHaveProperty("reportedContextPercent");
    expect(usage.reportedWindowPercent).toBeUndefined();
    expect(renderMeasurement(usage)).toContain(`90 historical (${model.providerID}/${model.id}) · current-model usage unavailable`);
  });

  test.each([
    { label: "absent", messages: [] },
    { label: "not an assistant", messages: [{ ...user("not an assistant"), id: CURRENT }] },
  ])(
    "does not infer the caller's model from previous assistants when its message is $label",
    ({ messages }) => {
      const usage = select([], { messages: [measured(), ...messages] });
      expect(usage.status).toBe("model-unknown");
      expect(usage.model).toBeUndefined();
      expect(usage.limits).toEqual({});
      expect(usage).not.toHaveProperty("reportedContextPercent");
      expect(usage).not.toHaveProperty("defaultAutoCompactionThreshold");
      expect(usage.reportedWindowPercent).toBeUndefined();
      expect(renderMeasurement(usage)).toContain("80 reported · current model unknown");
    },
  );

  test("resolves the caller by ID rather than the most recent assistant", () => {
    const selected = { providerID: "selected-provider", id: "selected-model" };
    const usage = select([], {
      messages: [measured("msg_usage", tokens({ input: 80 }), { model: selected }), current(selected), current(undefined, "msg_later")],
      models: [catalogModel(), catalogModel({ context: 400, input: 200, output: 50 }, selected)],
    });
    expect(usage.model).toEqual(selected);
    expect(usage.reportedContextPercent).toBe(20);
    expect(usage.reportedWindowPercent).toBe(40);
  });

  test("a variant change retains usage for the same provider and model", () => {
    const usage = select([], {
      messages: [
        measured("msg_variant", tokens({ input: 80 }), { model: { providerID: "provider", id: "model", variant: "low" } }),
        current({ providerID: "provider", id: "model", variant: "high" }),
      ],
    });
    expect(usage.status).toBe("available");
    expect(usage.reportedContextPercent).toBe(40);
    expect(usage.reportedWindowPercent).toBe(80);
  });

  test.each([
    [{ context: 200, input: 100, output: 20 }, 100, 40, 80],
    [{ context: 100, input: 200, output: 20 }, 100, 80, 80],
    [{ context: 200, output: 20 }, 200, 40, 40],
    [{ context: 200, input: 0, output: 20 }, 200, 40, 40],
    [{ context: 100, input: 100, output: 20 }, 100, 80, 80],
    [{ context: 0, input: 100, output: 20 }, 100, undefined, 80],
    [{ context: 0, input: 0, output: 0 }, undefined, undefined, undefined],
    [{ context: -1, input: Number.NaN, output: Number.POSITIVE_INFINITY }, undefined, undefined, undefined],
  ] as const)("reports each percentage against its labelled denominator for limits %p", (limit, window, contextPercent, windowPercent) => {
    const usage = select([measured()], { models: [catalogModel(limit)] });
    expect(usage.usableInputWindow).toBe(window);
    expect(usage.reportedContextPercent).toBe(contextPercent);
    expect(usage.reportedWindowPercent).toBe(windowPercent);
    const text = renderMeasurement(usage);
    if (contextPercent === undefined) {
      expect(usage).not.toHaveProperty("reportedContextPercent");
    }
    if (contextPercent !== undefined && limit.context !== window) {
      expect(text).toContain(`UI/context ${contextPercent}% of ${limit.context}`);
    } else {
      expect(text).not.toContain("UI/context");
    }
    if (window !== undefined) {
      expect(text).toContain(`80 / ${window} input (${windowPercent}%)`);
    }
    if (window === undefined) {
      expect(usage.limits).toEqual({});
      expect(usage).not.toHaveProperty("defaultAutoCompactionThreshold");
      expect(text).toContain("input window unknown");
    }
  });

  test.each([-1, Number.NaN, Number.POSITIVE_INFINITY])(
    "keeps input-window usage but omits context usage for invalid context limit %p",
    (context) => {
      const usage = select([measured()], { models: [catalogModel({ context, input: 100, output: 20 })] });
      expect(usage.status).toBe("available");
      expect(usage).not.toHaveProperty("reportedContextPercent");
      expect(usage.reportedWindowPercent).toBe(80);
      const text = renderMeasurement(usage);
      expect(text).not.toContain("UI/context");
      expect(text).toContain("80 / 100 input (80%)");
    },
  );

  test("does not cap either reported percentage when the measurement exceeds both limits", () => {
    const usage = select([measured("msg_large", tokens({ input: 240 }))]);
    expect(usage.reportedContextPercent).toBe(120);
    expect(usage.reportedWindowPercent).toBe(240);
    const text = renderMeasurement(usage);
    expect(text).toContain("UI/context 120% of 200");
    expect(text).toContain("240 / 100 input (240%) · 140 over input window · UI/context 120% of 200");
  });

  test("never picks another provider's catalog entry with the same model ID", () => {
    const usage = select([measured()], { models: [catalogModel(undefined, { providerID: "other", id: "model" })] });
    expect(usage.status).toBe("available");
    expect(usage.limits).toEqual({});
    expect(usage).not.toHaveProperty("reportedContextPercent");
    expect(usage).not.toHaveProperty("defaultAutoCompactionThreshold");
    expect(usage.reportedWindowPercent).toBeUndefined();
    expect(renderMeasurement(usage)).toContain("80 reported · input window unknown");
  });

  test("keeps measurement caveats and the unknown effective threshold in structured output", () => {
    const usage = select([measured()], { warningPercent: 82.5 });
    expect(usage.autoCompactionThreshold).toBe("unknown");
    expect(usage.contextWarningPercent).toBe(82.5);
    const text = renderContextUsage(usage);
    expect(usage.measurementScope).toBe("Later messages and pending tool or subagent results are not included in this measurement.");
    expect(text).toContain("notices from 82.5%");
    expect(text).not.toContain("Later messages");
    expect(text).not.toContain("Reported counts");
  });

  test("formats disabled notices while retaining the usage measurement", () => {
    const usage = select([measured()], { warningPercent: 82.5 });
    const text = renderContextUsage(usage, false);
    expect(text).toContain("notices disabled");
    expect(text).not.toContain("notices from 82.5%");
    expect(text).toContain("80 / 100 input (80%)");
    expect(usage.contextWarningPercent).toBe(82.5);
    expect(usage.autoCompactionThreshold).toBe("unknown");
  });
});

describe("compact status text", () => {
  const at = Date.UTC(2026, 10, 1, 22, 28);

  test.each([
    [999_949, "999.9k"],
    [999_950, "1M"],
    [1_000_000, "1M"],
    [1_234_567, "1.23M"],
  ] as const)("formats %i tokens consistently in the used count and input window", (count, expected) => {
    const usage = select([measured("msg_compact_count", tokens({ input: count }))], {
      models: [catalogModel({ context: count, input: count, output: 1000 })],
    });
    expect(renderMeasurement(usage)).toContain(`${expected} / ${expected} input (100%)`);
  });

  test.each([
    { label: "zero", measuredAt: at + 45_000 },
    { label: "nonzero", measuredAt: at + 45_987 },
  ])("shows absolute UTC seconds with $label milliseconds while retaining the raw timestamp", async ({ measuredAt }) => {
    const world = new ContextWorld([
      measured("msg_timestamp", tokens({ input: 80 }), { time: { created: at, completed: measuredAt } }),
      current(),
    ]);
    const result = await contextStatusTool(world).execute({}, toolContext());
    expect(result.content).toContain("measured 2026-11-01T22:28:45Z · notices from 50%");
    expect(result.output?.measurement?.measuredAt).toBe(measuredAt);
  });

  test("returns one compact line while preserving the full structured snapshot", async () => {
    const checkpoint = compaction("completed");
    const counts = tokens({ input: 260_000, output: 3000, reasoning: 1000, cache: { read: 500, write: 500 } });
    const world = new ContextWorld([
      checkpoint,
      measured("msg_snapshot", counts, { time: { created: at - 1000, completed: at } }),
      current(),
    ]);
    world.models.catalogs.set("/work", [catalogModel({ context: 1_000_000, input: 1_000_000, output: 10_000 })]);
    const result = await contextStatusTool(world).execute({}, toolContext());
    expect(result.content).toBe("265k / 1M input (26.5%) · 735k remaining · measured 2026-11-01T22:28:00Z · notices from 50% · default auto ~850k (585k away) · last compaction completed");
    expect(result.output).toMatchObject({
      sessionID: SESSION,
      model: { providerID: "provider", id: "model" },
      limits: { context: 1_000_000, input: 1_000_000, output: 10_000 },
      status: "available",
      reportedContextPercent: 26.5,
      reportedWindowPercent: 26.5,
      inputHeadroomTokens: 735_000,
      defaultAutoCompactionHeadroomTokens: 585_000,
      usableInputWindow: 1_000_000,
      measurement: { messageID: "msg_snapshot", measuredAt: at, tokens: counts, reportedTokens: 265_000 },
      completedCompactionID: checkpoint.id,
      latestCompaction: { id: checkpoint.id, status: "completed" },
      autoCompactionThreshold: "unknown",
      defaultAutoCompactionThreshold: { tokens: 850_000, percent: 85 },
      warningsEnabled: true,
      contextWarningPercent: 50,
    });
    expect(result.output?.measurementScope).toBe("Later messages and pending tool or subagent results are not included in this measurement.");
  });

  test("shows UI/context when distinct denominators round to the same displayed percentage", () => {
    const usage = select([measured("msg_rounding", tokens({ input: 80_000 }))], {
      models: [catalogModel({ context: 100_001, input: 100_000, output: 1000 })],
    });
    expect(usage.reportedContextPercent).not.toBe(usage.reportedWindowPercent);
    expect(renderMeasurement(usage)).toContain("80k / 100k input (80%) · 20k remaining · UI/context 80% of 100k");
  });

  test("normalizes multiline compaction failure text without altering its structured detail", () => {
    const failure = "summary\n  unavailable\t";
    const usage = select([measured(), {
      type: "compaction", id: "msg_failed", time: { created: at }, reason: "manual",
      status: "failed", error: { type: "CompactionError", message: failure },
    }]);
    expect(usage.latestCompaction?.failureMessage).toBe(failure);
    const rendered = renderContextUsage(usage);
    expect(rendered).toContain("last compaction failed (summary unavailable)");
    expect(rendered).not.toMatch(/[\r\n\t]/);
  });

  test("explicitly identifies missing usage, limits and caller model together", () => {
    const usage = select([], { messages: [], models: [] });
    expect(renderContextUsage(usage)).toBe("No completed response measurement · input window unknown · current model unknown · notices from 50% · no visible compaction");
  });

  test("puts snapshot caveats and default-auto assumptions in the tool description", () => {
    const description = contextStatusTool(new ContextWorld()).description;
    expect(description).toContain("Input-window usage drives plugin notices");
    expect(description).toContain("Later messages and pending tool or subagent results, including this call, are not included");
    expect(description).toContain("signed token headroom");
    expect(description).toContain("negative headroom means the measurement is past that point");
    expect(description).not.toMatch(/stale|earlier|unreliab/i);
    expect(description).toContain("assumes automatic compaction is enabled");
    expect(description).toContain("default buffer and no override");
    expect(description).toContain("actual resolved automatic-compaction threshold is unavailable");
  });
});

describe("the default-auto estimate", () => {
  test.each([
    [{ context: 1_000_000, input: 272_000, output: 1000 }, 231_200, 85, "231.2k (231.1k away)"],
    [{ context: 64_000, input: 1_000_000, output: 1000 }, 48_000, 75, "48k (47.9k away)"],
    [{ context: 0, input: 32_000, output: 1000 }, 16_000, 50, "16k (15.9k away)"],
    [{ context: 31_999, output: 1000 }, 27_200, 85.0026563330104, "27.2k (27.1k away)"],
    [{ context: 30_000, input: 30_000, output: 1000 }, 25_500, 85, "25.5k (25.4k away)"],
  ] as const)("uses the default buffer for limits %p without claiming effective configuration", (limit, expectedTokens, expectedPercent, display) => {
    const usage = select([measured()], { models: [catalogModel(limit)] });
    expect(usage.defaultAutoCompactionThreshold?.tokens).toBe(expectedTokens);
    expect(usage.defaultAutoCompactionThreshold?.percent).toBeCloseTo(expectedPercent, 10);
    expect(usage.defaultAutoCompactionHeadroomTokens).toBe(expectedTokens - 80);
    expect(usage.autoCompactionThreshold).toBe("unknown");
    expect(renderContextUsage(usage)).toContain(`default auto ~${display}`);
  });

  test.each([
    { label: "missing measurement", messages: [], status: "missing" },
    { label: "post-compaction measurement pending", messages: [compaction("completed")], status: "awaiting-post-compaction" },
    { label: "different-model measurement", messages: [measured("msg_other_model", tokens({ input: 50 }), { model: { providerID: "other", id: "model" } })], status: "different-model" },
  ])("retains the default estimate without a distance with $label", ({ messages, status }) => {
    const usage = select(messages, { models: [catalogModel({ context: 272_000, input: 272_000, output: 1000 })] });
    expect(usage.status).toBe(status);
    expect(usage.defaultAutoCompactionThreshold).toEqual({ tokens: 231_200, percent: 85 });
    expect(usage.autoCompactionThreshold).toBe("unknown");
    expect(usage).not.toHaveProperty("reportedWindowPercent");
    expect(usage).not.toHaveProperty("inputHeadroomTokens");
    expect(usage).not.toHaveProperty("defaultAutoCompactionHeadroomTokens");
    const text = renderContextUsage(usage);
    expect(text).toContain(" · default auto ~231.2k · ");
    expect(text).not.toMatch(/remaining|over input window|away|past estimate/);
  });

  test("omits the default estimate when the catalog cannot provide a positive window", () => {
    const usage = select([measured()], { models: [] });
    expect(usage).not.toHaveProperty("defaultAutoCompactionThreshold");
    expect(usage.autoCompactionThreshold).toBe("unknown");
    expect(renderContextUsage(usage)).not.toContain("auto ~");
  });
});

describe("signed token headroom", () => {
  const MILLION = { context: 1_000_000, input: 1_000_000, output: 10_000 };

  test.each([
    {
      label: "inside both", reported: 750_000, input: 250_000, auto: 100_000,
      text: "750k / 1M input (75%) · 250k remaining · measured 1970-01-01T00:00:00Z · notices from 75% · default auto ~850k (100k away) · no visible compaction",
    },
    {
      label: "exactly at the estimate", reported: 850_000, input: 150_000, auto: 0,
      text: "850k / 1M input (85%) · 150k remaining · measured 1970-01-01T00:00:00Z · notices from 75% · default auto ~850k (0 away) · no visible compaction",
    },
    {
      label: "exactly at the window", reported: 1_000_000, input: 0, auto: -150_000,
      text: "1M / 1M input (100%) · 0 remaining · measured 1970-01-01T00:00:00Z · notices from 75% · default auto ~850k (150k past estimate) · no visible compaction",
    },
    {
      label: "past the window", reported: 1_050_000, input: -50_000, auto: -200_000,
      text: "1.05M / 1M input (105%) · 50k over input window · measured 1970-01-01T00:00:00Z · notices from 75% · default auto ~850k (200k past estimate) · no visible compaction",
    },
  ])("reports signed distances without clamping when $label", ({ reported, input, auto, text }) => {
    const usage = select([measured("msg_headroom", tokens({ input: reported }))], {
      models: [catalogModel(MILLION)], warningPercent: 75,
    });
    expect(usage.inputHeadroomTokens).toBe(input);
    expect(usage.defaultAutoCompactionHeadroomTokens).toBe(auto);
    expect(usage.measurement?.reportedTokens).toBe(reported);
    expect(usage.reportedWindowPercent).toBe(reported / 10_000);
    expect(usage.defaultAutoCompactionThreshold).toEqual({ tokens: 850_000, percent: 85 });
    expect(renderContextUsage(usage)).toBe(text);
  });

  test.each([
    ["a larger context limit", { context: 1000, input: 100, output: 40 }, "80 / 100 input (80%) · 20 remaining · UI/context 8% of 1k"],
    ["a larger input limit", { context: 100, input: 200, output: 40 }, "80 / 100 input (80%) · 20 remaining · measured"],
  ] as const)("measures input headroom against the usable window with %s", (_, limit, text) => {
    const usage = select([measured()], { models: [catalogModel(limit)] });
    expect(usage.inputHeadroomTokens).toBe(20);
    expect(usage.defaultAutoCompactionHeadroomTokens).toBe(5);
    expect(renderMeasurement(usage)).toContain(text);
  });

  test("keeps the same-model headroom across a variant change", () => {
    const usage = select([], {
      messages: [
        measured("msg_variant", tokens({ input: 80 }), { model: { providerID: "provider", id: "model", variant: "low" } }),
        current({ providerID: "provider", id: "model", variant: "high" }),
      ],
    });
    expect(usage.inputHeadroomTokens).toBe(20);
    expect(usage.defaultAutoCompactionHeadroomTokens).toBe(5);
  });

  test.each([
    { label: "a different model", messages: [measured("msg_other", tokens({ input: 50 }), { model: { providerID: "other", id: "model" } }), current()], models: [catalogModel()], estimate: true },
    { label: "an unknown caller model", messages: [measured()], models: [catalogModel()], estimate: false },
    { label: "an unknown window", messages: [measured(), current()], models: [catalogModel(undefined, { providerID: "other", id: "model" })], estimate: false },
    { label: "a missing revert marker", messages: [measured(), current()], models: [catalogModel()], estimate: false, revert: { messageID: "msg_absent" } },
  ])("omits both distances for $label", ({ messages, models, estimate, revert }) => {
    const usage = selectContextUsage({
      sessionID: SESSION, messageID: CURRENT, messages, models, ...(revert === undefined ? {} : { revert }),
    });
    expect(usage).not.toHaveProperty("inputHeadroomTokens");
    expect(usage).not.toHaveProperty("defaultAutoCompactionHeadroomTokens");
    expect(usage.defaultAutoCompactionThreshold !== undefined).toBe(estimate);
    const text = renderContextUsage(usage);
    expect(text).not.toMatch(/remaining|over input window|away|past estimate/);
    if (estimate) expect(text).toContain(" · default auto ~85 · ");
  });
});

describe("fresh self-scoped reads", () => {
  const call = { sessionID: SESSION, messageID: CURRENT };

  test("starts session and history reads together, then looks up the session directory", async () => {
    const world = new ContextWorld();
    const lookup = deferred<ReturnType<typeof sessionInfo>>();
    const history = deferred<readonly SessionMessageInfo[]>();
    world.reader.getImpl = () => lookup.promise;
    world.reader.contextImpl = () => history.promise;
    const pending = readContextUsage(world, call);
    expect(world.reader.gets).toEqual([SESSION]);
    expect(world.reader.contextReads).toEqual([SESSION]);
    expect(world.models.reads).toEqual([]);
    lookup.resolve({ ...sessionInfo(SESSION), location: { directory: "/session-location" } });
    history.resolve([measured(), current()]);
    await pending;
    expect(world.models.reads).toEqual(["/session-location"]);
  });

  test("rereads history and location-scoped limits after a session moves", async () => {
    const world = new ContextWorld();
    expect((await readContextUsage(world, call)).usage).toMatchObject({ reportedContextPercent: 40, reportedWindowPercent: 80 });
    world.reader.put({ ...sessionInfo(SESSION), location: { directory: "/moved" } });
    world.reader.contexts.set(SESSION, [measured("msg_new", tokens({ input: 60 })), current()]);
    world.models.catalogs.set("/moved", [catalogModel({ context: 400, input: 200, output: 10 })]);
    const result = await readContextUsage(world, call);
    expect(result.usage.measurement?.messageID).toBe("msg_new");
    expect(result.usage.reportedContextPercent).toBe(15);
    expect(result.usage.reportedWindowPercent).toBe(30);
    expect(world.models.reads).toEqual(["/work", "/moved"]);
  });

  test("keeps measured counts and logs unavailable catalog limits", async () => {
    const world = new ContextWorld();
    world.models.impl = async () => { throw new Error("catalog unavailable"); };
    const { usage } = await readContextUsage(world, call);
    expect(usage.measurement?.reportedTokens).toBe(80);
    expect(usage.limits).toEqual({});
    expect(usage).not.toHaveProperty("reportedContextPercent");
    expect(usage.reportedWindowPercent).toBeUndefined();
    expect(world.logger.warnings()).toEqual(["context: could not read model limits"]);
  });

  test.each(["missing session", "session read", "history read"])("rejects a %s failure", async (failure) => {
    const world = new ContextWorld();
    if (failure === "missing session") world.reader.remove(SESSION);
    if (failure === "session read") world.reader.failingGets.add(SESSION);
    if (failure === "history read") world.reader.failingContexts.add(SESSION);
    await expect(readContextUsage(world, call)).rejects.toThrow();
    expect(world.models.reads).toEqual([]);
  });

  test("the direct status tool stays self-scoped even when input contains a foreign target", async () => {
    const world = new ContextWorld();
    const tool = contextStatusTool(world, { warningPercent: 85 });
    const result = await tool.execute({ sessionID: "ses_foreign" }, toolContext());
    expect(result.output?.sessionID).toBe(SESSION);
    expect(result.output?.contextWarningPercent).toBe(85);
    expect(result.output?.reportedContextPercent).toBe(40);
    expect(result.output?.reportedWindowPercent).toBe(80);
    expect(result.content).toContain("UI/context 40% of 200");
    expect(result.content).toContain("80 / 100 input (80%)");
    expect(world.reader.gets).toEqual([SESSION]);
    expect(world.reader.contextReads).toEqual([SESSION]);
    expect(tool.options).toMatchObject({ codemode: false, permission: "context_status" });
    expect(typeof result.content).toBe("string");
  });

  test.each([
    ["omitted", {}],
    ["explicitly enabled", { warningsEnabled: true }],
  ] as const)("reports enabled notices in output and text when the option is %s", async (_, options) => {
    const world = new ContextWorld();
    const result = await contextStatusTool(world, { ...options, warningPercent: 82.5 }).execute({}, toolContext());
    expect(result.output).toMatchObject({
      warningsEnabled: true,
      contextWarningPercent: 82.5,
      status: "available",
      reportedContextPercent: 40,
      reportedWindowPercent: 80,
      measurement: { messageID: "msg_measured", reportedTokens: 80 },
    });
    expect(result.content).toContain("notices from 82.5%");
    expect(result.content).not.toContain("notices disabled");
  });

  test("reports disabled notices in output and text without disabling context status", async () => {
    const world = new ContextWorld();
    const result = await contextStatusTool(world, { warningsEnabled: false, warningPercent: 82.5 }).execute({}, toolContext());
    expect(result.output).toMatchObject({
      warningsEnabled: false,
      contextWarningPercent: 82.5,
      autoCompactionThreshold: "unknown",
      status: "available",
      reportedContextPercent: 40,
      reportedWindowPercent: 80,
      measurement: { messageID: "msg_measured", reportedTokens: 80 },
    });
    expect(result.content).toContain("notices disabled");
    expect(result.content).not.toContain("notices from 82.5%");
    expect(result.content).toContain("80 / 100 input (80%)");
  });
});
