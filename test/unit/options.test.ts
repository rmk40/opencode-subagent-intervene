import { describe, expect, test } from "bun:test";
import {
  DEFAULT_SETTINGS,
  MAX_PROMPT_NOTICE_SECONDS,
  MAX_STALL_NOTICE_MINUTES,
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
      stallNoticeMinutes: 10,
      contextTools: true,
      contextNotices: true,
      selfCompaction: true,
      contextWarningPercent: 50,
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
    ["stallNoticeMinutes", 0],
    ["stallNoticeMinutes", 2.5],
    ["stallNoticeMinutes", 15],
    ["stallNoticeMinutes", MAX_STALL_NOTICE_MINUTES],
    ["contextTools", false],
    ["contextTools", true],
    ["contextNotices", false],
    ["contextNotices", true],
    ["selfCompaction", false],
    ["selfCompaction", true],
    ["contextWarningPercent", 0.01],
    ["contextWarningPercent", 50],
    ["contextWarningPercent", 70],
    ["contextWarningPercent", 75.5],
    ["contextWarningPercent", 99.99],
    ["compactionBuffer", "1%"],
    ["compactionBuffer", "10%"],
    ["compactionBuffer", "12.5%"],
    ["compactionBuffer", "5.0%"],
    ["compactionBuffer", "99%"],
    ["compactionBuffer", "99.99%"],
    ["compactionBuffer", 0],
    ["compactionBuffer", 16_000],
    ["compactionBuffer", Number.MAX_SAFE_INTEGER],
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
    ["stallNoticeMinutes", -1],
    ["stallNoticeMinutes", MAX_STALL_NOTICE_MINUTES + 1],
    ["stallNoticeMinutes", "10"],
    ["stallNoticeMinutes", null],
    ["stallNoticeMinutes", Number.POSITIVE_INFINITY],
    ["stallNoticeMinutes", Number.NaN],
    ["contextTools", "false"],
    ["contextTools", 0],
    ["contextNotices", "false"],
    ["contextNotices", 0],
    ["selfCompaction", "true"],
    ["selfCompaction", null],
    ["contextWarningPercent", 0],
    ["contextWarningPercent", -1],
    ["contextWarningPercent", 100],
    ["contextWarningPercent", 101],
    ["contextWarningPercent", "70"],
    ["contextWarningPercent", Number.POSITIVE_INFINITY],
    ["contextWarningPercent", Number.NaN],
    // Percentage strings outside OpenCode's `^([1-9]\d?(\.\d+)?)%$` pattern.
    ["compactionBuffer", "0%"],
    ["compactionBuffer", "0.5%"],
    ["compactionBuffer", "01%"],
    ["compactionBuffer", "100%"],
    ["compactionBuffer", "1.%"],
    ["compactionBuffer", ".5%"],
    ["compactionBuffer", "-10%"],
    ["compactionBuffer", "10"],
    ["compactionBuffer", "10 %"],
    ["compactionBuffer", " 10%"],
    ["compactionBuffer", "10%\n"],
    ["compactionBuffer", ""],
    // Token counts that are not non-negative safe integers.
    ["compactionBuffer", -1],
    ["compactionBuffer", 1.5],
    ["compactionBuffer", Number.MAX_SAFE_INTEGER + 1],
    ["compactionBuffer", Number.POSITIVE_INFINITY],
    ["compactionBuffer", Number.NaN],
    ["compactionBuffer", null],
    ["compactionBuffer", true],
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

  test("keeps context notices and self-compaction independently configurable", () => {
    const { settings, warnings } = parse({
      contextNotices: false,
      selfCompaction: true,
      contextWarningPercent: 82.5,
    });
    expect(settings).toEqual({
      ...DEFAULT_SETTINGS,
      contextNotices: false,
      selfCompaction: true,
      contextWarningPercent: 82.5,
    });
    expect(warnings).toEqual([]);
  });
});
