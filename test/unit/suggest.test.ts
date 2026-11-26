import { describe, expect, test } from "bun:test";
import type { Descendant } from "@/core/ancestry";
import { MAX_SCAN_SESSIONS } from "@/core/ancestry";
import { closestChildren } from "@/core/suggest";
import { sessionInfo } from "./fixtures";
import { CALLER, NOW, ToolWorld } from "./tool-world";

const TYPED = "ses_e192abab3ffe5Pp7ZAHb3S1Wsx";
const CLOSE = "ses_e192ababeffe7TE8JsAA6an1OJ";
const NOT_YOURS = `Session ${TYPED} is not one of your subagents.`;
const HEADING =
  "Close matches among the subagents you launched; check the ID before using one:";

function child(id: string): Descendant {
  return {
    id,
    info: sessionInfo(id, CALLER),
    parentID: CALLER,
    depth: 1,
    ancestors: [CALLER],
  };
}

function ranked(ids: readonly string[], input: string): string[] {
  return closestChildren(ids.map(child), input).map((found) => found.id);
}

describe("closestChildren", () => {
  test("puts an ID that matches once its inner whitespace is removed first", () => {
    expect(
      ranked(
        ["ses_abcdefghijkX", "ses_abcdefghijkl", "ses_abcdefghijkY"],
        "  ses_abcdef ghij\tkl ",
      ),
    ).toEqual(["ses_abcdefghijkl", "ses_abcdefghijkX", "ses_abcdefghijkY"]);
  });

  test("keeps IDs that share at least 8 characters after ses_, and leaves out weaker ones", () => {
    expect(
      ranked(["ses_abcdefghZZZZ", "ses_abcdefgZZZZZ"], "ses_abcdefghijkl"),
    ).toEqual(["ses_abcdefghZZZZ"]);
  });

  test("does not count the ses_ prefix toward the shared characters", () => {
    expect(ranked(["ses_abcdefgZZZZZ"], "ses_abcdefgYYYYY")).toEqual([]);
  });

  test("ranks a longer shared prefix first", () => {
    expect(
      ranked(
        ["ses_abcdefghZZZZZZ", "ses_abcdefghijZZZZ", "ses_abcdefghiZZZZZ"],
        "ses_abcdefghijklmn",
      ),
    ).toEqual(["ses_abcdefghijZZZZ", "ses_abcdefghiZZZZZ", "ses_abcdefghZZZZZZ"]);
  });

  test("breaks a tie in shared prefix by edit distance", () => {
    expect(
      ranked(
        ["ses_abcdefghXXXXXX", "ses_abcdefghXlmnop"],
        "ses_abcdefghijklmnop",
      ),
    ).toEqual(["ses_abcdefghXlmnop", "ses_abcdefghXXXXXX"]);
  });

  test("returns at most three", () => {
    expect(
      ranked(
        [
          "ses_abcdefgh1",
          "ses_abcdefgh2",
          "ses_abcdefgh3",
          "ses_abcdefgh4",
        ],
        "ses_abcdefgh",
      ),
    ).toHaveLength(3);
  });

  test("returns nothing for an input that is only whitespace", () => {
    expect(ranked(["ses_abcdefgh1"], " \t ")).toEqual([]);
  });
});

describe("the not-one-of-your-subagents error", () => {
  type Call = (world: ToolWorld, id: string) => Promise<unknown>;
  const TOOLS: ReadonlyArray<readonly [string, Call]> = [
    ["subagent_stop", (world, id) => world.stop({ sessionIDs: [id] })],
    ["subagent_send", (world, id) => world.send(id)],
    ["subagents.inspect", (world, id) => world.inspect(id)],
  ];

  test.each(TOOLS)("from %s lists a close match with its agent, title and state", async (_, call) => {
    const world = new ToolWorld().add(CLOSE, {
      agent: "general",
      title: "Run the test suite",
      runningSince: NOW,
    });
    const error = await world.failure(() => call(world, TYPED));
    expect(error.message).toBe(
      [
        NOT_YOURS,
        HEADING,
        `- ${CLOSE} (general, "Run the test suite"): running`,
      ].join("\n"),
    );
  });

  test("from subagents.list with sessionIDs comes back in errors, with the suggestions", async () => {
    const world = new ToolWorld().add(CLOSE, {
      agent: "general",
      title: "Run the test suite",
      runningSince: NOW,
    });
    const { output } = await world.list({ sessionIDs: [TYPED] });
    expect(output.errors).toEqual([
      {
        sessionID: TYPED,
        error: [
          NOT_YOURS,
          HEADING,
          `- ${CLOSE} (general, "Run the test suite"): running`,
        ].join("\n"),
        suggestions: [
          {
            sessionID: CLOSE,
            title: "Run the test suite",
            agent: "general",
            state: "running",
          },
        ],
      },
    ]);
  });

  test("names the state of each suggestion, including a run with no recorded end", async () => {
    const world = new ToolWorld()
      .add("ses_e192ababAAAA", { idle: NOW - 1000 })
      .add("ses_e192ababBBBB", { runningSince: NOW - 3 * 60_000 });
    const error = await world.failure(() => world.inspect("ses_e192ababCCCC"));
    expect(error.message.split("\n").slice(2).toSorted()).toEqual([
      "- ses_e192ababAAAA: idle",
      "- ses_e192ababBBBB: idle, its last run recorded no end",
    ]);
  });

  test("lists nothing when no child comes close", async () => {
    const world = new ToolWorld().add("ses_zzzzzzzzzzzz");
    const error = await world.failure(() => world.inspect(TYPED));
    expect(error.message).toBe(NOT_YOURS);
  });

  test("never lists a session below one of the caller's children", async () => {
    const world = new ToolWorld()
      .add("ses_child")
      .add(CLOSE, { parentID: "ses_child" });
    const error = await world.failure(() => world.inspect(TYPED));
    expect(error.message).toBe(NOT_YOURS);
  });

  test("never lists a session that is not the caller's", async () => {
    const world = new ToolWorld().add(CLOSE, { parentID: "ses_someone_else" });
    const error = await world.failure(() => world.inspect(TYPED));
    expect(error.message).toBe(NOT_YOURS);
  });

  test("never acts on a suggestion", async () => {
    const world = new ToolWorld().add(CLOSE, { runningSince: NOW });
    await world.failure(() =>
      world.stop({ sessionIDs: ["ses_e192abab effe7TE8JsAA6an1OJ"] }),
    );
    expect(world.control.interrupts).toEqual([]);
    expect(world.store.keys()).toEqual([]);
    await world.failure(() => world.send("ses_e192abab effe7TE8JsAA6an1OJ"));
    expect(world.messenger.posts).toEqual([]);
  });

  test("says the suggestions may be incomplete when the caller has more children than one scan reads", async () => {
    const world = new ToolWorld();
    world.add(CLOSE);
    for (let index = 0; index < MAX_SCAN_SESSIONS; index++) {
      world.add(`ses_other${index}`);
    }
    const error = await world.failure(() => world.inspect(TYPED));
    expect(error.message.split("\n")).toEqual([
      NOT_YOURS,
      "Only your most recently updated subagents were checked for a close match.",
    ]);
  });

  test("says no close matches were looked up when the children cannot be read", async () => {
    const world = new ToolWorld().add(CLOSE);
    world.reader.listings.set(CALLER, () => {
      throw new Error("listing failed");
    });
    const error = await world.failure(() => world.inspect(TYPED));
    expect(error.message.split("\n")).toEqual([
      NOT_YOURS,
      "Your subagents couldn't be read, so no close matches were looked up.",
    ]);
  });

  test("marks the suggestions it found as possibly incomplete after a partial scan", async () => {
    const world = new ToolWorld();
    for (let index = 0; index < MAX_SCAN_SESSIONS; index++) {
      world.add(`ses_other${index}`);
    }
    world.add(CLOSE);
    const error = await world.failure(() => world.inspect(TYPED));
    expect(error.message.split("\n")).toEqual([
      NOT_YOURS,
      HEADING,
      `- ${CLOSE}: idle`,
      "Only your most recently updated subagents were checked, so these suggestions may be incomplete.",
    ]);
  });
});

describe("session IDs with surrounding whitespace", () => {
  const PADDED = `  ${CLOSE}\n\t`;

  test("subagent_stop stops the session", async () => {
    const world = new ToolWorld().add(CLOSE, { idle: NOW - 1000 });
    const { output } = await world.stop({ sessionIDs: [PADDED] });
    expect(output.nodes.map((node) => node.sessionID)).toEqual([CLOSE]);
  });

  test("subagent_send sends to the session", async () => {
    const world = new ToolWorld().add(CLOSE, { runningSince: NOW });
    const { output } = await world.send(PADDED);
    expect(output.sessionID).toBe(CLOSE);
    expect(world.messenger.posts.map((post) => post.sessionID)).toEqual([CLOSE]);
  });

  test("subagents.inspect inspects the session", async () => {
    const world = new ToolWorld().add(CLOSE, { runningSince: NOW });
    const { output } = await world.inspect(PADDED);
    expect(output.sessionID).toBe(CLOSE);
  });

  test("subagents.list finds the session by ID", async () => {
    const world = new ToolWorld().add(CLOSE, { runningSince: NOW });
    const { output } = await world.list({ sessionIDs: [PADDED] });
    expect(output.entries.map((entry) => entry.sessionID)).toEqual([CLOSE]);
    expect(output).not.toHaveProperty("errors");
  });
});
