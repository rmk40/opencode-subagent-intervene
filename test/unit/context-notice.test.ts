import { describe, expect, test } from "bun:test";
import { isSelfCompactionID } from "@/core/compaction";
import {
  ContextNotices,
  contextWarningID,
  reachedMilestone,
  renderContextWarning,
  type ContextWarningKey,
} from "@/core/context-notice";
import { renderMeasurement, selectContextUsage } from "@/core/context-usage";
import { Latch } from "@/core/latch";
import type { SessionMessageInfo, SyntheticMessage } from "@/core/ports";
import {
  catalogModel,
  ContextWorld,
  CURRENT,
  current,
  measured,
  SESSION,
  tokens,
} from "./context-fixtures";
import {
  compaction,
  deferred,
  FakeClock,
  FakeControl,
  flush,
  MemoryStore,
  sessionInfo,
} from "./fixtures";

const EVENT = { sessionID: SESSION, messageID: CURRENT, tool: "read", status: "completed" } as const;

function delivered(post: SyntheticMessage): Extract<SessionMessageInfo, { type: "synthetic" }> {
  if (post.id === undefined) throw new Error("warning must supply an ID");
  return { type: "synthetic", id: post.id, time: { created: 30 }, text: post.text, metadata: { ...post.metadata } };
}

function firstPost(world: ContextWorld): SyntheticMessage {
  const post = world.messenger.posts[0];
  if (post === undefined) throw new Error("expected warning admission");
  return post;
}

function expectPlanningGuidance(text: string): void {
  expect(text).toContain("Context planning update. The goal is to use roughly 90% of this input window for useful work.");
  expect(text).toContain("Continue while the next step and its expected output fit in the remaining window, narrowing large results when possible.");
  expect(text).toContain("Neither this notice nor the 90% mark alone is a reason to compact.");
  expect(text.endsWith(" · Later messages and pending tool or subagent results are not included in this measurement.")).toBe(true);
  expect(text).not.toMatch(/stale|earl(?:y|ier)|unreliab|out of date|available tools?|tool availab/i);
  expect(text).not.toMatch(/heads-up|prepare|choose|stopping point|compact (now|at|before|immediately)|(?:must|should) compact|recheck|disregard|context_compact|context_status|auto ~?90%/i);
}

describe("context milestones", () => {
  test.each([
    [undefined, 50, undefined],
    [Number.NaN, 50, undefined],
    [Number.POSITIVE_INFINITY, 50, undefined],
    [49.999, 50, undefined],
    [50, 50, 50],
    [59.999, 50, 50],
    [60, 50, 60],
    [69.999, 50, 60],
    [70, 50, 70],
    [79.999, 50, 70],
    [80, 50, 80],
    [84.999, 50, 80],
    [85, 50, 85],
    [89.999, 50, 85],
    [90, 50, 90],
    [94.999, 50, 90],
    [95, 50, 95],
    [99.999, 50, 95],
    [100, 50, 100],
    [125, 50, 100],
    [69.999, 70, undefined],
    [82.5, 72.5, 80],
    [99.99, 72.5, 95],
    [100, 72.5, 100],
    [80, 80.0001, undefined],
    [80.0001, 80.0001, 80.0001],
    [84.999, 80.0001, 80.0001],
    [85, 80.0001, 85],
    [99.9, 99.9, 99.9],
    [100, 99.9, 100],
    [19.9, 9.9, 19.9],
    [19.899999999, 9.9, 9.9],
    [29.9, 9.9, 29.9],
  ])("maps reported %p%% with threshold %p to %p", (percent, threshold, expected) => {
    expect(reachedMilestone(percent, threshold)).toBe(expected);
  });

  test.each([
    [19.99, 9.99, 19.99],
    [19.989999999999995, 9.99, 9.99],
    [29.99, 9.99, 29.99],
    [79.99, 9.99, 79.99],
    [80, 9.99, 80],
    [1e-7, 1e-7, 1e-7],
    [9.999999e-8, 1e-7, undefined],
    [10.0000001, 1e-7, 10.0000001],
    [10.000000099999998, 1e-7, 1e-7],
    [10.123456789012345, 0.123456789012345, 10.123456789012345],
    [10.123456789012343, 0.123456789012345, 0.123456789012345],
  ])("preserves decimal boundary %p%% at threshold %p as milestone %p", (percent, threshold, expected) => {
    expect(reachedMilestone(percent, threshold)).toBe(expected);
  });

  test("every hundredth-percent start and its ten-point milestones below 80 preserve exact boundaries", () => {
    const failures: Array<{
      threshold: number;
      percent: number;
      expected: number | undefined;
      actual: number | undefined;
    }> = [];
    for (let hundredths = 1; hundredths < 10_000; hundredths++) {
      const threshold = hundredths / 100;
      for (let offset = 0; offset === 0 || hundredths + offset < 8000; offset += 1000) {
        const milestone = (hundredths + offset) / 100;
        const below = (hundredths + offset - 0.5) / 100;
        const previous = offset === 0 ? undefined : (hundredths + offset - 1000) / 100;
        for (const [percent, expected] of [[milestone, milestone], [below, previous]] as const) {
          const actual = reachedMilestone(percent, threshold);
          if (actual !== expected) failures.push({ threshold, percent, expected, actual });
        }
      }
    }
    expect(failures).toEqual([]);
  });

  test("an exact decimal-boundary warning admits the reached milestone in its metadata and ID", async () => {
    const world = new ContextWorld([measured("msg_decimal", tokens({ input: 1999 })), current()]);
    world.models.catalogs.set("/work", [catalogModel({ context: 10_000, input: 10_000, output: 100 })]);
    await new ContextNotices(world, { warningPercent: 9.99 }).afterTool(EVENT);
    expect(world.messenger.posts).toHaveLength(1);
    expect(firstPost(world)).toMatchObject({
      id: contextWarningID({ sessionID: SESSION, epoch: "initial", providerID: "provider", modelID: "model", threshold: 9.99, milestone: 19.99 }),
      metadata: { threshold: "9.99", milestone: "19.99", measurementID: "msg_decimal" },
    });
  });

  test("a jump admits only its highest milestone using the status measurement wording", async () => {
    const messages = [measured("msg_jump", tokens({ input: 96 })), current()];
    const world = new ContextWorld(messages);
    await new ContextNotices(world).afterTool(EVENT);
    expect(world.messenger.posts).toHaveLength(1);
    const post = firstPost(world);
    expect(post).toMatchObject({
      sessionID: SESSION,
      delivery: "steer",
      resume: false,
      metadata: {
        plugin: "subagent-intervene", kind: "context-warning", sessionID: SESSION,
        epoch: "initial", providerID: "provider", modelID: "model",
        threshold: "50", milestone: "95", measurementID: "msg_jump",
      },
    });
    const usage = selectContextUsage({ sessionID: SESSION, messageID: CURRENT, messages, models: [catalogModel()] });
    expect(post.text).toContain(renderMeasurement(usage));
    expect(post.text).toContain("provider/model, initial context (no completed compaction)");
    expect(post.text).toContain("96 / 100 input (96%) · 4 remaining");
    expect(post.text).toContain("default auto ~85 (11 past estimate)");
    expect(post.text).toContain(usage.measurementScope);
    expectPlanningGuidance(post.text);
    expect(post.description).toBe("Context usage reached the 95% milestone");
  });

  test("a warning identifies its completed-compaction epoch in model-visible text", async () => {
    const checkpoint = compaction("completed");
    const world = new ContextWorld([checkpoint, measured(), current()]);
    await new ContextNotices(world).afterTool(EVENT);
    const post = firstPost(world);
    expect(post.metadata["epoch"]).toBe(checkpoint.id);
    expect(post.text).toContain(`provider/model, after compaction ${checkpoint.id}`);
    expect(post.text).toContain("measured 1970-01-01T00:00:00Z");
    expect(post.text).not.toContain("Recheck");
    expectPlanningGuidance(post.text);
  });

  test("omits an unknown default-auto estimate without inventing an effective threshold", () => {
    const usage = selectContextUsage({ sessionID: SESSION, messageID: CURRENT, messages: [measured(), current()], models: [catalogModel()] });
    const { defaultAutoCompactionThreshold: _estimate, ...withoutEstimate } = usage;
    const before = structuredClone(withoutEstimate);
    const rendered = renderContextWarning(withoutEstimate);
    expect(rendered).toContain(renderMeasurement(usage));
    expect(rendered).not.toContain("auto ~");
    expect(rendered).not.toMatch(/away|past estimate/);
    expect(rendered).toContain("provider/model, initial context (no completed compaction)");
    expect(withoutEstimate.autoCompactionThreshold).toBe("unknown");
    expectPlanningGuidance(rendered);
    expect(withoutEstimate).toEqual(before);
  });

  test("a custom threshold changes both milestone selection and admission metadata", async () => {
    const world = new ContextWorld([measured("msg_85", tokens({ input: 85 })), current()]);
    await new ContextNotices(world, { warningPercent: 72.5 }).afterTool(EVENT);
    expect(firstPost(world).metadata).toMatchObject({ threshold: "72.5", milestone: "85" });
  });

  test.each([
    [69, 6.9, "60"],
    [70, 7, "70"],
    [80, 8, "80"],
  ] as const)("uses input-window usage of %p%% for warnings while context-limit usage is only %p%%", async (input, contextPercent, milestone) => {
    const world = new ContextWorld([measured("msg_input_cap", tokens({ input })), current()]);
    world.models.catalogs.set("/work", [catalogModel({ context: 1000, input: 100, output: 40 })]);
    await new ContextNotices(world).afterTool(EVENT);
    expect(world.messenger.posts).toHaveLength(1);
    const post = firstPost(world);
    expect(post.metadata).toMatchObject({ threshold: "50", milestone, measurementID: "msg_input_cap" });
    expect(post.text).toContain(`UI/context ${contextPercent}% of 1k`);
    expect(post.text).toContain(`${input} / 100 input (${input}%)`);
  });

  test("still warns against the input window when context-limit usage is unavailable", async () => {
    const world = new ContextWorld();
    world.models.catalogs.set("/work", [catalogModel({ context: 0, input: 100, output: 40 })]);
    await new ContextNotices(world).afterTool(EVENT);
    expect(world.messenger.posts).toHaveLength(1);
    const post = firstPost(world);
    expect(post.metadata["milestone"]).toBe("80");
    expect(post.text).not.toContain("UI/context");
    expect(post.text).toContain("80 / 100 input (80%)");
  });
});

describe("planning notices and configured schedules", () => {
  test.each([
    [50, "50 remaining", "35 away"],
    [60, "40 remaining", "25 away"],
    [70, "30 remaining", "15 away"],
    [80, "20 remaining", "5 away"],
    [85, "15 remaining", "0 away"],
    [90, "10 remaining", "5 past estimate"],
    [95, "5 remaining", "10 past estimate"],
    [100, "0 remaining", "15 past estimate"],
  ] as const)("milestone %p preserves the snapshot and gives a utilization goal without a compaction trigger", async (input, remaining, distance) => {
    const at = Date.UTC(2026, 10, 1, 22, 28);
    const world = new ContextWorld([
      measured("msg_snapshot", tokens({ input }), { time: { created: at - 1000, completed: at } }),
      current(),
    ]);
    await new ContextNotices(world).afterTool(EVENT);
    expect(world.messenger.posts).toHaveLength(1);
    const post = firstPost(world);
    expect(post).toMatchObject({
      delivery: "steer", resume: false,
      description: `Context usage reached the ${input}% milestone`,
      metadata: { threshold: "50", milestone: String(input), measurementID: "msg_snapshot", epoch: "initial" },
    });
    expect(post.text).toContain(`${input} / 100 input (${input}%) · ${remaining} · UI/context ${input / 2}% of 200 · measured 2026-11-01T22:28:00Z · default auto ~85 (${distance})`);
    expect(post.text).toContain("provider/model, initial context (no completed compaction) · Later messages and pending tool or subagent results are not included in this measurement.");
    expectPlanningGuidance(post.text);
  });

  test.each([
    { start: 60, schedule: [60, 70, 80, 85, 90, 95, 100] },
    { start: 65, schedule: [65, 75, 80, 85, 90, 95, 100] },
    { start: 75, schedule: [75, 80, 85, 90, 95, 100] },
    { start: 83, schedule: [83, 85, 90, 95, 100] },
    { start: 90, schedule: [90, 95, 100] },
  ])("configured start $start admits only its expected schedule", async ({ start, schedule }) => {
    const world = new ContextWorld();
    for (const input of [49, 50, 60, 65, 70, 75, 80, 83, 85, 90, 95, 100]) {
      world.reader.contexts.set(SESSION, [
        ...world.messenger.posts.map(delivered),
        measured(`msg_at_${input}`, tokens({ input })), current(),
      ]);
      await new ContextNotices(world, { warningPercent: start }).afterTool(EVENT);
      if (input < start) expect(world.messenger.posts).toEqual([]);
    }
    expect(world.messenger.posts.map((post) => post.metadata["milestone"])).toEqual(schedule.map(String));
    expect(world.messenger.posts.every((post) => post.metadata["threshold"] === String(start))).toBe(true);
    expectPlanningGuidance(firstPost(world).text);
  });

  test("reports a non-85% default estimate from the measured model's window", async () => {
    const world = new ContextWorld([measured("msg_64k", tokens({ input: 51_200 })), current()]);
    world.models.catalogs.set("/work", [catalogModel({ context: 64_000, input: 64_000, output: 1000 })]);
    await new ContextNotices(world).afterTool(EVENT);
    expect(firstPost(world).text).toContain("51.2k / 64k input (80%) · 12.8k remaining · measured");
    expect(firstPost(world).text).toContain("default auto ~48k (3.2k past estimate)");
    expectPlanningGuidance(firstPost(world).text);
  });

  test("delivers the default schedule once across reloads without replacing older snapshots", async () => {
    const world = new ContextWorld();
    let first: SyntheticMessage | undefined;
    for (const input of [50, 50, 60, 55, 70, 80, 85, 80, 90, 95, 90, 100, 95]) {
      world.reader.contexts.set(SESSION, [
        ...world.messenger.posts.map(delivered),
        measured(`msg_at_${input}`, tokens({ input })),
        current(),
      ]);
      await new ContextNotices(world).afterTool(EVENT);
      first ??= structuredClone(firstPost(world));
    }
    if (first === undefined) throw new Error("expected an initial notice");
    expect(world.messenger.posts.map((post) => post.metadata["milestone"])).toEqual(["50", "60", "70", "80", "85", "90", "95", "100"]);
    expect(new Set(world.messenger.posts.map((post) => post.id)).size).toBe(8);
    expect(firstPost(world)).toEqual(first);
    expect(firstPost(world).text).toContain("50 / 100 input (50%)");
  });

  test("milestones reset independently after compaction and after a model change", async () => {
    const world = new ContextWorld([measured("msg_before", tokens({ input: 65 })), current()]);
    await new ContextNotices(world).afterTool(EVENT);
    const checkpoint = compaction("completed");
    world.reader.contexts.set(SESSION, [delivered(firstPost(world)), checkpoint, measured("msg_after", tokens({ input: 50 })), current()]);
    await new ContextNotices(world).afterTool(EVENT);
    expect(world.messenger.posts[1]?.metadata).toMatchObject({ milestone: "50", epoch: checkpoint.id });
    const model = { providerID: "provider", id: "new-model" };
    world.models.catalogs.set("/work", [catalogModel(undefined, model)]);
    world.reader.contexts.set(SESSION, [
      checkpoint, ...world.messenger.posts.map(delivered),
      measured("msg_new_model", tokens({ input: 50 }), { model }), current(model),
    ]);
    await new ContextNotices(world).afterTool(EVENT);
    expect(world.messenger.posts[2]?.metadata).toMatchObject({ milestone: "50", modelID: "new-model", epoch: checkpoint.id });
    expect(new Set(world.messenger.posts.map((post) => post.id)).size).toBe(3);
  });

  test("a pending notice derives the same ID in a reloaded instance", async () => {
    const world = new ContextWorld([measured("msg_snapshot", tokens({ input: 50 })), current()]);
    await new ContextNotices(world).afterTool(EVENT);
    const first = structuredClone(firstPost(world));
    await new ContextNotices(world).afterTool(EVENT);
    expect(world.messenger.posts).toHaveLength(2);
    expect(world.messenger.posts[1]).toEqual(first);
  });
});

describe("warning identity and delivered history", () => {
  const key: ContextWarningKey = {
    sessionID: SESSION, epoch: "initial", providerID: "provider", modelID: "model", threshold: 70, milestone: 80,
  };

  test("uses a stable msg_ ID distinct from self-compaction IDs", () => {
    const id = contextWarningID(key);
    expect(id).toBe(contextWarningID({ ...key }));
    expect(id).toMatch(/^msg_.*context_warning_[0-9a-f]{64}$/);
    expect(isSelfCompactionID(id)).toBe(false);
  });

  test.each([
    { sessionID: "other" }, { epoch: "msg_checkpoint" }, { providerID: "other" },
    { modelID: "other" }, { threshold: 75 }, { milestone: 90 },
  ])("changes its identity for key change %p", (change) => {
    expect(contextWarningID({ ...key, ...change })).not.toBe(contextWarningID(key));
  });

  test("keeps key fields unambiguous even when delimiters move between identifiers", () => {
    expect(contextWarningID({ ...key, sessionID: "ses_a", epoch: "b_c" })).not.toBe(
      contextWarningID({ ...key, sessionID: "ses_a_b", epoch: "c" }),
    );
  });

  test("duplicate callbacks and a new instance use the same ID even for a newer measurement", async () => {
    const world = new ContextWorld();
    const notices = new ContextNotices(world);
    await notices.afterTool(EVENT);
    await notices.afterTool(EVENT);
    world.reader.contexts.set(SESSION, [measured("msg_newer", tokens({ input: 84 })), current()]);
    await new ContextNotices(world).afterTool(EVENT);
    expect(world.messenger.posts).toHaveLength(3);
    expect(new Set(world.messenger.posts.map((post) => post.id)).size).toBe(1);
    expect(world.messenger.posts[2]?.metadata["measurementID"]).toBe("msg_newer");
  });

  test.each([80, 75])("suppresses reported %p%% after an 80%% warning is delivered, across reloads", async (input) => {
    const world = new ContextWorld();
    await new ContextNotices(world).afterTool(EVENT);
    const warning = delivered(firstPost(world));
    const original = structuredClone(warning);
    world.reader.contexts.set(SESSION, [warning, measured("msg_lower", tokens({ input })), current()]);
    await new ContextNotices(world).afterTool(EVENT);
    expect(world.messenger.posts).toHaveLength(1);
    expect(warning).toEqual(original);
  });

  test("admits a higher milestone after delivery of a lower one", async () => {
    const world = new ContextWorld();
    const notices = new ContextNotices(world);
    await notices.afterTool(EVENT);
    world.reader.contexts.set(SESSION, [delivered(firstPost(world)), measured("msg_high", tokens({ input: 99 })), current()]);
    await notices.afterTool(EVENT);
    expect(world.messenger.posts.map((post) => post.metadata["milestone"])).toEqual(["80", "95"]);
  });

  const unrelatedMetadata: ReadonlyArray<Readonly<Record<string, string>>> = [
    { plugin: "other" }, { kind: "other" }, { sessionID: "other" }, { epoch: "msg_old" },
    { providerID: "other" }, { modelID: "other" }, { threshold: "75" },
    { milestone: "NaN" }, { milestone: "101" }, { milestone: "-10" },
  ];
  test.each(unrelatedMetadata)("does not suppress a warning with unrelated or invalid delivered metadata %p", async (change) => {
    const world = new ContextWorld();
    await new ContextNotices(world).afterTool(EVENT);
    const warning = delivered(firstPost(world));
    world.reader.contexts.set(SESSION, [{ ...warning, metadata: { ...warning.metadata, ...change } }, measured(), current()]);
    await new ContextNotices(world).afterTool(EVENT);
    expect(world.messenger.posts).toHaveLength(2);
  });

  test("starts a fresh milestone epoch after a completed compaction", async () => {
    const world = new ContextWorld();
    const notices = new ContextNotices(world);
    await notices.afterTool(EVENT);
    const first = firstPost(world);
    const checkpoint = compaction("completed");
    world.reader.contexts.set(SESSION, [delivered(first), checkpoint, measured("msg_after", tokens({ input: 70 })), current()]);
    await notices.afterTool(EVENT);
    expect(world.messenger.posts[1]?.metadata).toMatchObject({ epoch: checkpoint.id, milestone: "70" });
    expect(world.messenger.posts[1]?.id).not.toBe(first.id);
    expect(first.text).toContain("initial context (no completed compaction)");
  });

  test.each(["running", "failed"] as const)("a %s compaction does not reset delivered milestones", async (status) => {
    const world = new ContextWorld();
    await new ContextNotices(world).afterTool(EVENT);
    world.reader.contexts.set(SESSION, [delivered(firstPost(world)), measured(), compaction(status), current()]);
    await new ContextNotices(world).afterTool(EVENT);
    expect(world.messenger.posts).toHaveLength(1);
  });

  test.each([undefined, { milestone: 90 }, { milestone: "Infinity" }])(
    "ignores a synthetic message with absent or invalid milestone metadata %p",
    async (metadata) => {
      const world = new ContextWorld();
      await new ContextNotices(world).afterTool(EVENT);
      const warning = delivered(firstPost(world));
      world.reader.contexts.set(SESSION, [{ ...warning, metadata: metadata === undefined ? undefined : { ...warning.metadata, ...metadata } }, measured(), current()]);
      await new ContextNotices(world).afterTool(EVENT);
      expect(world.messenger.posts).toHaveLength(2);
    },
  );

  test("a model change starts independent milestones once that model has a measurement", async () => {
    const world = new ContextWorld();
    await new ContextNotices(world).afterTool(EVENT);
    const model = { providerID: "provider", id: "new-model" };
    world.models.catalogs.set("/work", [catalogModel(undefined, model)]);
    world.reader.contexts.set(SESSION, [delivered(firstPost(world)), measured("msg_new_model", tokens({ input: 70 }), { model }), current(model)]);
    await new ContextNotices(world).afterTool(EVENT);
    expect(world.messenger.posts[1]?.metadata).toMatchObject({ modelID: "new-model", milestone: "70" });
  });
});

describe("warning eligibility and failure isolation", () => {
  test.each([
    { ...EVENT, status: "error" as const },
    { ...EVENT, tool: "context_compact" },
  ])("does not read or admit anything for ineligible completion %p", async (event) => {
    const world = new ContextWorld();
    await new ContextNotices(world).afterTool(event);
    expect(world.reader.gets).toEqual([]);
    expect(world.reader.contextReads).toEqual([]);
    expect(world.models.reads).toEqual([]);
    expect(world.messenger.posts).toEqual([]);
  });

  test.each([
    ["below the first advisory milestone", [measured("msg_small", tokens({ input: 49 })), current()]],
    ["no measurement", [current()]],
    ["post-compaction", [measured(), compaction("completed"), current()]],
    ["different model", [measured(), current({ providerID: "provider", id: "other" })]],
    ["unknown model", [measured()]],
  ] satisfies ReadonlyArray<readonly [string, readonly SessionMessageInfo[]]>)(
    "stays silent for %s usage", async (_, messages) => {
      const world = new ContextWorld(messages);
      await new ContextNotices(world).afterTool(EVENT);
      expect(world.messenger.posts).toEqual([]);
    },
  );

  test.each([50, 80])("stays silent during a staged revert even with eligible %p%% usage", async (input) => {
    const world = new ContextWorld([measured("msg_usage", tokens({ input })), current(), measured("msg_revert")]);
    world.reader.put({ ...sessionInfo(SESSION), revert: { messageID: "msg_revert" } });
    await new ContextNotices(world).afterTool(EVENT);
    expect(world.messenger.posts).toEqual([]);
  });

  test("stays silent without catalog limits even when measured counts are available", async () => {
    const world = new ContextWorld();
    world.models.catalogs.clear();
    await new ContextNotices(world).afterTool(EVENT);
    expect(world.messenger.posts).toEqual([]);
    expect(world.logger.warnings()).toEqual([]);
  });

  test("uses different input windows for sessions in different locations", async () => {
    const world = new ContextWorld();
    world.reader.put({ ...sessionInfo("ses_large"), location: { directory: "/large" } });
    world.reader.contexts.set("ses_large", [measured(), current()]);
    world.models.catalogs.set("/large", [catalogModel({ context: 400, input: 200, output: 40 })]);
    const notices = new ContextNotices(world);
    await Promise.all([notices.afterTool(EVENT), notices.afterTool({ ...EVENT, sessionID: "ses_large" })]);
    expect(world.models.reads.toSorted()).toEqual(["/large", "/work"]);
    expect(world.messenger.posts.map((post) => post.sessionID)).toEqual([SESSION]);
  });

  test.each([50, 80])("checks the stop latch after asynchronous reads finish for %p%% usage", async (input) => {
    const world = new ContextWorld([measured("msg_usage", tokens({ input })), current()]);
    const latch = new Latch({ store: new MemoryStore(), control: new FakeControl(), clock: new FakeClock(100), logger: world.logger, renderNote: () => "" });
    const catalog = deferred<readonly ReturnType<typeof catalogModel>[]>();
    world.models.impl = () => catalog.promise;
    const pending = new ContextNotices({ ...world, latch }).afterTool(EVENT);
    await flush();
    await latch.add(SESSION, { generation: "g", parentSessionID: "parent", reason: "stop", at: 100 });
    catalog.resolve([catalogModel()]);
    await pending;
    expect(world.messenger.posts).toEqual([]);
    await new ContextNotices(world).afterTool(EVENT);
    expect(world.messenger.posts).toHaveLength(1);
  });

  test.each(["session", "history", "catalog", "latch", "admission"])(
    "logs a %s failure without rejecting or changing the original result",
    async (failure) => {
      const world = new ContextWorld();
      if (failure === "session") world.reader.failingGets.add(SESSION);
      if (failure === "history") world.reader.failingContexts.add(SESSION);
      if (failure === "catalog") world.models.impl = async () => { throw new Error("offline"); };
      if (failure === "admission") world.messenger.failing = true;
      const latch = { isActive: async () => { if (failure === "latch") throw new Error("store offline"); return false; } };
      const event = Object.freeze({ ...EVENT, content: Object.freeze([{ type: "text", text: "original result" }]) });
      const before = structuredClone(event);
      await new ContextNotices({ ...world, latch }).afterTool(event);
      expect(event).toEqual(before);
      expect(world.messenger.posts).toEqual([]);
      expect(world.logger.warnings()).toHaveLength(1);
    },
  );

  test("retries a failed admission at the same deterministic ID on a later hook", async () => {
    const world = new ContextWorld();
    const attempts: SyntheticMessage[] = [];
    const messenger = { synthetic: async (post: SyntheticMessage) => {
      attempts.push(post);
      if (attempts.length === 1) throw new Error("temporary failure");
      return world.messenger.synthetic(post);
    } };
    const notices = new ContextNotices({ ...world, messenger });
    await notices.afterTool(EVENT);
    await notices.afterTool(EVENT);
    expect(attempts).toHaveLength(2);
    expect(attempts[0]?.id).toBe(attempts[1]?.id);
    expect(world.messenger.posts).toHaveLength(1);
  });
});

describe("concurrent evaluations and disposal", () => {
  test("shares concurrent hooks from one assistant, then rereads after settlement", async () => {
    const world = new ContextWorld();
    const catalog = deferred<readonly ReturnType<typeof catalogModel>[]>();
    world.models.impl = () => catalog.promise;
    const notices = new ContextNotices(world);
    const first = notices.afterTool(EVENT);
    const second = notices.afterTool({ ...EVENT, tool: "shell" });
    await flush();
    expect(world.reader.gets).toEqual([SESSION]);
    expect(world.reader.contextReads).toEqual([SESSION]);
    expect(world.models.reads).toEqual(["/work"]);
    catalog.resolve([catalogModel()]);
    await Promise.all([first, second]);
    expect(world.messenger.posts).toHaveLength(1);
    await notices.afterTool(EVENT);
    expect(world.reader.gets).toEqual([SESSION, SESSION]);
    expect(world.messenger.posts).toHaveLength(2);
  });

  test("does not share evaluations across different sessions or assistant IDs", async () => {
    const world = new ContextWorld([measured(), current(), current(undefined, "msg_other")]);
    world.reader.put(sessionInfo("ses_other"));
    world.reader.contexts.set("ses_other", [measured(), current()]);
    const catalog = deferred<readonly ReturnType<typeof catalogModel>[]>();
    world.models.impl = () => catalog.promise;
    const notices = new ContextNotices(world);
    const pending = [
      notices.afterTool(EVENT),
      notices.afterTool({ ...EVENT, messageID: "msg_other" }),
      notices.afterTool({ ...EVENT, sessionID: "ses_other" }),
    ];
    await flush();
    expect(world.reader.gets).toHaveLength(3);
    expect(world.models.reads).toHaveLength(3);
    catalog.resolve([catalogModel()]);
    await Promise.all(pending);
    expect(world.messenger.posts).toHaveLength(3);
    expect(new Set(world.messenger.posts.map((post) => post.id)).size).toBe(2);
  });

  test("disposal prevents new reads and drops an evaluation awaiting its latch check", async () => {
    const world = new ContextWorld();
    const latchRead = deferred<boolean>();
    const entered = deferred<void>();
    const notices = new ContextNotices({ ...world, latch: { isActive: () => { entered.resolve(); return latchRead.promise; } } });
    const pending = notices.afterTool(EVENT);
    await entered.promise;
    notices.dispose();
    latchRead.resolve(false);
    await pending;
    await notices.afterTool(EVENT);
    expect(world.reader.gets).toEqual([SESSION]);
    expect(world.messenger.posts).toEqual([]);
  });

  test("disposal drops an evaluation still awaiting its usage reads", async () => {
    const world = new ContextWorld();
    const catalog = deferred<readonly ReturnType<typeof catalogModel>[]>();
    world.models.impl = () => catalog.promise;
    const notices = new ContextNotices(world);
    const pending = notices.afterTool(EVENT);
    await flush();
    notices.dispose();
    catalog.resolve([catalogModel()]);
    await pending;
    expect(world.messenger.posts).toEqual([]);
  });
});
