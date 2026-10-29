import { describe, expect, test } from "bun:test";
import {
  activeToolNames,
  clampMaxChars,
  MAX_MAX_CHARS,
  renderContextSummary,
  summarizeContext,
  type ContextSummary,
} from "@/core/summarize";
import {
  assistant,
  compaction,
  completed,
  failed,
  reasoning,
  running,
  streaming,
  text,
  tool,
  user,
} from "./fixtures";

const ELLIPSIS = "\u2026";
const SMILE = "\u{1F600}";

function codePoints(value: string): number {
  return [...value].length;
}

/** Code points of every string in a summary. */
function usedChars(summary: ContextSummary): number {
  let total = 0;
  for (const name of summary.recentToolNames) total += codePoints(name);
  for (const active of summary.activeTools) {
    total += codePoints(active.name) + codePoints(active.input);
  }
  total += codePoints(summary.lastError ?? "");
  total += codePoints(summary.lastText ?? "");
  total += codePoints(summary.earlierSummary ?? "");
  return total;
}

describe("clampMaxChars", () => {
  test.each([
    ["undefined", undefined, 4000],
    ["NaN", Number.NaN, 4000],
    ["below the minimum", 50, 200],
    ["a fraction", 1234.9, 1234],
    ["above the maximum", 20_000, 12_000],
  ])("maps %s to %p", (_, input, expected) => {
    expect(clampMaxChars(input)).toBe(expected);
  });
});

describe("summarizeContext", () => {
  test("returns an empty summary when no assistant message has anything to report", () => {
    expect(summarizeContext([user("hello")])).toStrictEqual({
      activeTools: [],
      recentToolNames: [],
      truncated: false,
    });
  });

  describe("the compaction cut-off", () => {
    test("reads only messages after the latest completed compaction", () => {
      const summary = summarizeContext([
        assistant([text("oldest"), tool("read", completed())], {
          type: "ProviderError",
          message: "old",
        }),
        compaction("completed"),
        assistant([text("middle"), tool("grep", running())]),
        compaction("completed"),
        user("go on"),
        assistant([text("newest")]),
      ]);
      expect(summary.lastText).toBe("newest");
      expect(summary.recentToolNames).toEqual([]);
      expect(summary.activeTools).toEqual([]);
      expect(summary.lastError).toBeUndefined();
    });

    test.each(["running", "failed"] as const)(
      "does not cut at a %s compaction",
      (status) => {
        const summary = summarizeContext([
          assistant([text("before"), tool("read", completed())]),
          compaction(status),
        ]);
        expect(summary.lastText).toBe("before");
        expect(summary.recentToolNames).toEqual(["read"]);
      },
    );
  });

  describe("active tools", () => {
    test("lists streaming and running tools oldest first and leaves out finished ones", () => {
      const summary = summarizeContext([
        assistant([
          tool("read", completed()),
          tool("bash", running({ command: "sleep 10" })),
        ]),
        assistant([
          tool("edit", failed({ type: "ToolError", message: "no match" })),
          tool("write", streaming('{"path":\n   "a.ts"')),
        ]),
      ]);
      expect(summary.activeTools).toEqual([
        {
          name: "bash",
          status: "running",
          input: '{"command":"sleep 10"}',
        },
        { name: "write", status: "streaming", input: '{"path": "a.ts"' },
      ]);
      expect(summary.truncated).toBe(false);
    });

    test("omitActiveTools leaves active tools out and gives their budget to lastText", () => {
      const messages = [
        assistant([
          tool("bash", running({ command: "y".repeat(500) })),
          text("t".repeat(400)),
        ]),
      ];
      const kept = summarizeContext(messages, { maxChars: 400 });
      const omitted = summarizeContext(messages, {
        maxChars: 400,
        omitActiveTools: true,
      });
      expect(kept.activeTools).toHaveLength(1);
      expect(kept.truncated).toBe(true);
      expect(omitted.activeTools).toEqual([]);
      expect(codePoints(omitted.lastText ?? "")).toBeGreaterThan(
        codePoints(kept.lastText ?? ""),
      );
    });

    test("gives an active tool its whole input when it fits the budget", () => {
      const summary = summarizeContext([
        assistant([tool("bash", running({ command: "x".repeat(500) }))]),
      ]);
      expect(summary.activeTools[0]?.input).toBe(
        JSON.stringify({ command: "x".repeat(500) }),
      );
      expect(summary.truncated).toBe(false);
    });

    test("keeps the newest active tools when they do not all fit", () => {
      // At 200 characters, active tools get 75 plus the 119 nothing else uses: "new" and its cut
      // input use all 194.
      const summary = summarizeContext(
        [
          assistant([
            tool("old", running({ command: "o".repeat(300) })),
            tool("new", running({ command: "n".repeat(300) })),
          ]),
        ],
        { maxChars: 200 },
      );
      expect(summary.activeTools.map((active) => active.name)).toEqual(["new"]);
      const input = summary.activeTools[0]?.input ?? "";
      expect(codePoints(input)).toBe(191);
      expect(input.endsWith(ELLIPSIS)).toBe(true);
      expect(summary.truncated).toBe(true);
    });

    describe("runningForMs", () => {
      const NOW = 10_000_000;

      test("is the time since a running tool started", () => {
        const summary = summarizeContext(
          [assistant([tool("shell", running(), { ran: NOW - 252_000 })])],
          { now: NOW },
        );
        expect(summary.activeTools[0]?.runningForMs).toBe(252_000);
      });

      test("is 0, never negative, when the start lies after now", () => {
        const summary = summarizeContext(
          [assistant([tool("shell", running(), { ran: NOW + 5_000 })])],
          { now: NOW },
        );
        expect(summary.activeTools[0]?.runningForMs).toBe(0);
      });

      test("is left out for a tool that has not started running", () => {
        const summary = summarizeContext(
          [assistant([tool("write", streaming('{"path"'))])],
          { now: NOW },
        );
        expect(summary.activeTools[0]).not.toHaveProperty("runningForMs");
      });

      test("is left out without the current time", () => {
        const summary = summarizeContext([
          assistant([tool("shell", running(), { ran: NOW - 1_000 })]),
        ]);
        expect(summary.activeTools[0]).not.toHaveProperty("runningForMs");
      });
    });
  });

  describe("the summary of earlier work", () => {
    test("is the latest completed compaction's summary, trimmed", () => {
      const summary = summarizeContext([
        compaction("completed", "old summary"),
        assistant([text("between")]),
        compaction("completed", "  Added the writer.\nNext: quoting.  "),
        compaction("running"),
        assistant([text("now")]),
      ]);
      expect(summary.earlierSummary).toBe("Added the writer.\nNext: quoting.");
      expect(summary).not.toHaveProperty("earlierSummaryOmitted");
      expect(summary.truncated).toBe(false);
    });

    test("is absent without a completed compaction", () => {
      const summary = summarizeContext([
        compaction("failed"),
        assistant([text("now")]),
      ]);
      expect(summary).not.toHaveProperty("earlierSummary");
      expect(summary).not.toHaveProperty("earlierSummaryOmitted");
    });

    test("gets only the room the other fields leave and keeps its start when cut", () => {
      // At 200 characters the text uses 150, leaving 50 for the summary.
      const summary = summarizeContext(
        [
          compaction("completed", "s".repeat(100)),
          assistant([text("t".repeat(150))]),
        ],
        { maxChars: 200 },
      );
      expect(summary.lastText).toBe("t".repeat(150));
      expect(summary.earlierSummary).toBe("s".repeat(49) + ELLIPSIS);
      expect(summary).not.toHaveProperty("earlierSummaryOmitted");
      expect(summary.truncated).toBe(true);
    });

    test("comes after the active tools, which take the room an absent text leaves", () => {
      // At 200 characters the active "bash" and its input widen to fill everything its name in the
      // recent tools leaves: 4 + 192 + 4.
      const summary = summarizeContext(
        [
          compaction("completed", "earlier"),
          assistant([tool("bash", running({ command: "x".repeat(500) }))]),
        ],
        { maxChars: 200 },
      );
      expect(codePoints(summary.activeTools[0]?.input ?? "")).toBe(192);
      expect(summary).not.toHaveProperty("earlierSummary");
      expect(summary.earlierSummaryOmitted).toBe(true);
    });

    test("is marked omitted, and the summary truncated, when none of it fits", () => {
      // The text exactly fills the budget, so only the summary is cut.
      const summary = summarizeContext(
        [
          compaction("completed", "earlier"),
          assistant([text("t".repeat(200))]),
        ],
        { maxChars: 200 },
      );
      expect(summary.lastText).toBe("t".repeat(200));
      expect(summary).not.toHaveProperty("earlierSummary");
      expect(summary.earlierSummaryOmitted).toBe(true);
      expect(summary.truncated).toBe(true);
    });

    test("leaves a blank summary out without marking anything cut", () => {
      const summary = summarizeContext(
        [compaction("completed", " \n\t "), assistant([text("t".repeat(200))])],
        { maxChars: 200 },
      );
      expect(summary).not.toHaveProperty("earlierSummary");
      expect(summary).not.toHaveProperty("earlierSummaryOmitted");
      expect(summary.truncated).toBe(false);
    });
  });

  test("names the last 10 tool calls of any status, oldest first", () => {
    const names = Array.from({ length: 12 }, (_, index) => `t${index + 1}`);
    const states = [completed(), running(), failed({ type: "E", message: "" })];
    const summary = summarizeContext([
      assistant(
        names
          .slice(0, 6)
          .map((name, index) => tool(name, states[index % 3] ?? completed())),
      ),
      assistant(names.slice(6).map((name) => tool(name, completed()))),
    ]);
    expect(summary.recentToolNames).toEqual(names.slice(2));
    expect(summary.truncated).toBe(false);
  });

  describe("last text", () => {
    test("comes from the latest assistant message that has text, with its text parts joined", () => {
      const summary = summarizeContext([
        assistant([text("first")]),
        assistant([
          text("  part one  "),
          reasoning("thinking"),
          text("part two"),
        ]),
        assistant([text("   "), tool("bash", running())]),
      ]);
      expect(summary.lastText).toBe("part one\n\npart two");
    });

    test("keeps the end of a long text, starting with an ellipsis", () => {
      const summary = summarizeContext(
        [assistant([text("a".repeat(150) + "b".repeat(150))])],
        { maxChars: 200 },
      );
      expect(summary.lastText).toBe(
        ELLIPSIS + "a".repeat(49) + "b".repeat(150),
      );
      expect(summary.truncated).toBe(true);
    });

    test("never splits an astral character at the cut", () => {
      const summary = summarizeContext([assistant([text(SMILE.repeat(300))])], {
        maxChars: 200,
      });
      expect(summary.lastText).toBe(ELLIPSIS + SMILE.repeat(199));
    });
  });

  describe("last error", () => {
    test("prefers a message's own error over tool errors in the same message", () => {
      const summary = summarizeContext([
        assistant(
          [tool("bash", failed({ type: "ToolError", message: "exit 1" }))],
          { type: "ProviderError", message: "overloaded" },
        ),
      ]);
      expect(summary.lastError).toBe("ProviderError: overloaded");
    });

    test("takes a tool error in a newer message over an older message's error", () => {
      const summary = summarizeContext([
        assistant([], { type: "ProviderError", message: "old" }),
        assistant([
          tool("bash", failed({ type: "ToolError", message: " exit 1 " })),
        ]),
      ]);
      expect(summary.lastError).toBe("tool bash: ToolError: exit 1");
    });

    test("takes the last failed tool within a message", () => {
      const summary = summarizeContext([
        assistant([
          tool("read", failed({ type: "ToolError", message: "first" })),
          tool("bash", failed({ type: "ToolError", message: "second" })),
          tool("edit", completed()),
        ]),
      ]);
      expect(summary.lastError).toBe("tool bash: ToolError: second");
    });

    test("shows only the error type when its message is blank", () => {
      const summary = summarizeContext([
        assistant([], { type: "Aborted", message: "  " }),
      ]);
      expect(summary.lastError).toBe("Aborted");
    });
  });

  describe("the budget", () => {
    test.each([
      [10, 200],
      [50_000, 12_000],
    ])("clamps maxChars %p to %p", (maxChars, effective) => {
      const summary = summarizeContext(
        [assistant([text("z".repeat(20_000))])],
        {
          maxChars,
        },
      );
      expect(codePoints(summary.lastText ?? "")).toBe(effective);
    });

    test("gives each field its share and the rest to lastText", () => {
      // At 200 characters: tool names get 25, active tools 75, the error 50, and the text the
      // remaining 50. Every field is long enough to be cut.
      const older = ["aaaaa", "bbbbb", "ccccc", "ddddd", "eeeee"];
      const summary = summarizeContext(
        [
          assistant(
            [
              ...older.map((name) => tool(name, completed())),
              tool("shell", running({ command: "x".repeat(500) })),
              tool("fffff", completed()),
              tool("ggggg", completed()),
              tool("hhhhh", completed()),
              tool("iiiii", completed()),
              text("t".repeat(500)),
            ],
            { type: "E", message: "m".repeat(100) },
          ),
        ],
        { maxChars: 200 },
      );
      expect(summary.recentToolNames).toEqual([
        "shell",
        "fffff",
        "ggggg",
        "hhhhh",
        "iiiii",
      ]);
      const active = summary.activeTools[0];
      expect(active?.name).toBe("shell");
      expect(codePoints(active?.input ?? "")).toBe(70);
      expect(summary.lastError).toBe(`E: ${"m".repeat(46)}${ELLIPSIS}`);
      expect(summary.lastText).toBe(ELLIPSIS + "t".repeat(49));
      expect(summary.truncated).toBe(true);
    });

    test.each([200, 777, 4000, 12_000])(
      "fits every string within a budget of %p and gives lastText what is left",
      (maxChars) => {
        const longName = (index: number) => `${index}`.padEnd(60, "n");
        const summary = summarizeContext(
          [
            assistant([
              ...Array.from({ length: 12 }, (_, index) =>
                tool(longName(index), completed()),
              ),
              tool("bash", running({ command: SMILE.repeat(400) })),
              tool("write", streaming("w".repeat(400))),
              tool(
                "read",
                failed({ type: "ToolError", message: "r".repeat(5000) }),
              ),
            ]),
            assistant([text(SMILE.repeat(20_000))]),
          ],
          { maxChars },
        );
        expect(usedChars(summary)).toBe(maxChars);
        expect(summary.truncated).toBe(true);
      },
    );
  });
});

describe("activeToolNames", () => {
  // Each running input is longer than the largest summary budget, so a budgeted list could not
  // name both running calls.
  const messages = [
    assistant([tool("grep", running())]),
    compaction("completed"),
    assistant([
      tool("read", completed()),
      tool("bash", running({ command: "b".repeat(20_000) })),
    ]),
    assistant([
      tool("edit", failed({ type: "ToolError", message: "no match" })),
      tool("write", streaming('{"path":"a.ts"')),
      tool("shell", running({ command: "s".repeat(20_000) })),
    ]),
  ];

  test("names every streaming and running call since the latest compaction, oldest first, however long their inputs", () => {
    expect(activeToolNames(messages)).toEqual(["bash", "write", "shell"]);
  });

  test("names the calls summarizeContext reports as active when the budget holds them all", () => {
    const small = [
      assistant([tool("grep", running())]),
      compaction("completed"),
      assistant([tool("read", completed()), tool("bash", running())]),
      assistant([tool("write", streaming("{")), tool("shell", running())]),
    ];
    const summary = summarizeContext(small, { maxChars: MAX_MAX_CHARS });
    expect(summary.truncated).toBe(false);
    expect(summary.activeTools.map((active) => active.name)).toEqual(
      activeToolNames(small),
    );
  });
});

describe("renderContextSummary", () => {
  test("says none for every empty field", () => {
    expect(
      renderContextSummary({
        activeTools: [],
        recentToolNames: [],
        truncated: false,
      }),
    ).toBe(
      [
        "Active tools: none",
        "Recent tools: none",
        "Last error: none",
        "Last assistant text: none",
      ].join("\n"),
    );
  });

  test("lists each field, leaves out an empty input, and puts the text last", () => {
    expect(
      renderContextSummary({
        activeTools: [
          { name: "bash", status: "running", input: '{"command":"ls"}' },
          { name: "write", status: "streaming", input: "" },
        ],
        recentToolNames: ["read", "bash", "write"],
        lastError: "tool read: ToolError: missing",
        lastText: "line one\nline two",
        truncated: true,
      }),
    ).toBe(
      [
        "Active tools:",
        '- bash (running): {"command":"ls"}',
        "- write (streaming)",
        "Recent tools: read, bash, write",
        "Last error: tool read: ToolError: missing",
        "Some of this was cut to fit maxChars.",
        "Last assistant text:",
        "line one",
        "line two",
      ].join("\n"),
    );
  });

  test.each([
    [0, "0s"],
    [999, "0s"],
    [45_900, "45s"],
    [60_000, "1m"],
    [240_999, "4m"],
    [252_000, "4m 12s"],
    [3_599_999, "59m 59s"],
    [3_600_000, "1h"],
    [3_659_999, "1h"],
    [7_500_000, "2h 5m"],
  ])("shows a tool running for %p ms as %p", (runningForMs, shown) => {
    const rendered = renderContextSummary({
      activeTools: [
        {
          name: "shell",
          status: "running",
          input: '{"command":"bun test"}',
          runningForMs,
        },
      ],
      recentToolNames: [],
      truncated: false,
    });
    expect(rendered.split("\n").slice(0, 2)).toEqual([
      "Active tools:",
      `- shell (running, ${shown}): {"command":"bun test"}`,
    ]);
  });

  test("puts the summary of earlier work after the last text, under its own heading", () => {
    expect(
      renderContextSummary({
        activeTools: [],
        recentToolNames: [],
        lastText: "latest",
        earlierSummary: "first line\nsecond line",
        truncated: false,
      }),
    ).toBe(
      [
        "Active tools: none",
        "Recent tools: none",
        "Last error: none",
        "Last assistant text:",
        "latest",
        "Summary of earlier work (from the last compaction):",
        "first line",
        "second line",
      ].join("\n"),
    );
  });
});
