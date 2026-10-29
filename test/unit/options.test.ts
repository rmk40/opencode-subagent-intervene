import { describe, expect, test } from "bun:test";
import {
  DEFAULT_SETTINGS,
  MAX_PROMPT_NOTICE_SECONDS,
  parseOptions,
} from "@/index";
import { RecordingLogger } from "./fixtures";

function parse(options: Readonly<Record<string, unknown>>) {
  const logger = new RecordingLogger();
  return {
    settings: parseOptions(options, logger),
    warnings: logger.warnings(),
  };
}

describe("parseOptions", () => {
  test("returns the documented defaults when no options are given", () => {
    const { settings, warnings } = parse({});
    expect(settings).toEqual({
      confirmStop: false,
      latch: true,
      latchTtlHours: 24,
      notifyChild: true,
      settleMs: 4000,
      promptNotices: true,
      promptNoticeSeconds: 60,
    });
    expect(settings).toEqual(DEFAULT_SETTINGS);
    expect(warnings).toEqual([]);
  });

  const VALID: ReadonlyArray<readonly [string, unknown]> = [
    ["confirmStop", true],
    ["latch", false],
    ["notifyChild", false],
    ["latchTtlHours", 0.5],
    ["settleMs", 0],
    ["settleMs", 2500],
    ["promptNotices", false],
    ["promptNoticeSeconds", 0],
    ["promptNoticeSeconds", 1.5],
    ["promptNoticeSeconds", MAX_PROMPT_NOTICE_SECONDS],
  ];

  test.each(VALID)(
    "applies %s set to %p without a warning",
    (option, value) => {
      const { settings, warnings } = parse({ [option]: value });
      expect(settings).toEqual({ ...DEFAULT_SETTINGS, [option]: value });
      expect(warnings).toEqual([]);
    },
  );

  const INVALID: ReadonlyArray<readonly [string, unknown]> = [
    ["confirmStop", "true"],
    ["latch", 0],
    ["notifyChild", null],
    ["latchTtlHours", 0],
    ["latchTtlHours", -1],
    ["latchTtlHours", "24"],
    ["latchTtlHours", Number.POSITIVE_INFINITY],
    ["latchTtlHours", Number.NaN],
    ["settleMs", -1],
    ["settleMs", "4000"],
    ["settleMs", Number.POSITIVE_INFINITY],
    ["settleMs", Number.NaN],
    ["promptNotices", "false"],
    ["promptNotices", 0],
    ["promptNoticeSeconds", -1],
    ["promptNoticeSeconds", MAX_PROMPT_NOTICE_SECONDS + 1],
    ["promptNoticeSeconds", "60"],
    ["promptNoticeSeconds", Number.POSITIVE_INFINITY],
    ["promptNoticeSeconds", Number.NaN],
  ];

  test.each(INVALID)(
    "keeps the default for %s set to %p, with a warning",
    (option, value) => {
      const { settings, warnings } = parse({ [option]: value });
      expect(settings).toEqual(DEFAULT_SETTINGS);
      expect(warnings).toEqual([expect.stringContaining(option)]);
    },
  );

  test("ignores an unknown option with a warning", () => {
    const { settings, warnings } = parse({ latchTtl: 5 });
    expect(settings).toEqual(DEFAULT_SETTINGS);
    expect(warnings).toEqual([expect.stringContaining("latchTtl")]);
  });

  test("applies the valid options of a call and ignores the rest", () => {
    const { settings, warnings } = parse({
      latch: false,
      settleMs: -5,
      verbose: true,
    });
    expect(settings).toEqual({ ...DEFAULT_SETTINGS, latch: false });
    expect(warnings).toHaveLength(2);
  });
});
