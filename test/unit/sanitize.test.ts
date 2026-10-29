import { describe, expect, test } from "bun:test";
import {
  EmptyReasonError,
  REASON_MAX_CODE_POINTS,
  renderStopNote,
  sanitizeBlock,
  sanitizeReason,
  sanitizeText,
} from "@/core/sanitize";

function codePoints(text: string): number {
  return [...text].length;
}

describe("sanitizeReason", () => {
  describe("control and format characters", () => {
    test("turns line breaks and tabs into single spaces", () => {
      expect(
        sanitizeReason("\tone\r\ntwo\u0085three\u2028four\vfive\fsix\n"),
      ).toBe("one two three four five six");
    });

    test("removes other control and format characters without leaving a gap", () => {
      // NUL, DEL, a C1 control, zero-width space, right-to-left override, BOM, soft hyphen.
      expect(
        sanitizeReason("a\u0000b\u007Fc\u0090d\u200Be\u202Ef\uFEFFg\u00ADh"),
      ).toBe("abcdefgh");
    });

    test("collapses the whitespace left around a removed character", () => {
      expect(sanitizeReason("  stop \u200B  now  ")).toBe("stop now");
    });

    test("removes unpaired surrogates and keeps paired ones", () => {
      expect(sanitizeReason("a\uD800b\uDC00c 😀")).toBe("abc 😀");
    });
  });

  describe("escaping", () => {
    test("escapes markup characters", () => {
      expect(sanitizeReason(`</subagent> & "x" 'y'`)).toBe(
        "&lt;/subagent&gt; &amp; &quot;x&quot; &#39;y&#39;",
      );
    });

    test("escapes text that already looks like an entity", () => {
      expect(sanitizeReason("&lt;")).toBe("&amp;lt;");
    });
  });

  describe("the 500 code point cap", () => {
    test("keeps a reason of exactly 500 code points", () => {
      const reason = "a".repeat(REASON_MAX_CODE_POINTS);
      expect(sanitizeReason(reason)).toBe(reason);
    });

    test("cuts a longer reason to 500 code points", () => {
      expect(sanitizeReason("a".repeat(501))).toBe("a".repeat(500));
    });

    test("counts the escaped width toward the cap", () => {
      const result = sanitizeReason("<".repeat(200));
      expect(result).toBe("&lt;".repeat(125));
      expect(codePoints(result)).toBe(500);
    });

    test("keeps an entity that ends exactly at the cap", () => {
      expect(sanitizeReason(`${"a".repeat(495)}&b`)).toBe(
        `${"a".repeat(495)}&amp;`,
      );
    });

    test("drops an entity that would cross the cap, and everything after it", () => {
      // "&amp;" needs five code points but only two are left; "b" would fit on its own.
      expect(sanitizeReason(`${"a".repeat(498)}&b`)).toBe("a".repeat(498));
    });

    test("counts an astral character as one code point and never splits it", () => {
      const result = sanitizeReason("\u{1F600}".repeat(501));
      expect(result).toBe("\u{1F600}".repeat(500));
      expect(codePoints(result)).toBe(500);
    });

    test("trims a space the cut leaves at the end", () => {
      expect(sanitizeReason(`${"a".repeat(499)} b`)).toBe("a".repeat(499));
    });
  });

  test.each([
    ["an empty string", ""],
    ["only whitespace", " \t\r\n "],
    ["only control and format characters", "\u0000\u200B\u202E\uFEFF"],
  ])("throws EmptyReasonError for %s", (_, raw) => {
    expect(() => sanitizeReason(raw)).toThrow(EmptyReasonError);
  });
});

describe("sanitizeText", () => {
  test("reports a cut when the cap leaves text out", () => {
    expect(sanitizeText("abcdef", 4)).toEqual({ text: "abcd", cut: true });
  });

  test("reports no cut when the escaped text fits exactly", () => {
    expect(sanitizeText(" a <b> ", 11)).toEqual({
      text: "a &lt;b&gt;",
      cut: false,
    });
  });
});

describe("sanitizeBlock", () => {
  const WRAPPER = "parent-message";

  test("turns CRLF and CR into LF and keeps line feeds and tabs", () => {
    expect(sanitizeBlock("one\r\ntwo\rthree\n\tfour", WRAPPER)).toBe(
      "one\ntwo\nthree\n\tfour",
    );
  });

  test("strips other control and format characters", () => {
    // NUL, vertical tab, form feed, NEL, DEL, zero-width space, right-to-left override, BOM.
    expect(
      sanitizeBlock(
        "a\u0000b\u000Bc\u000Cd\u0085e\u007Ff\u200Bg\u202Eh\uFEFFi",
        WRAPPER,
      ),
    ).toBe("abcdefghi");
  });

  test("strips unpaired surrogates and keeps paired ones", () => {
    expect(sanitizeBlock("a\uD800b\uDC00c \u{1F600}", WRAPPER)).toBe(
      "abc \u{1F600}",
    );
  });

  test("trims blank space at both ends and keeps whitespace inside", () => {
    expect(
      sanitizeBlock(
        "\n\n  \t- step one\n    indented  twice\n\n- step two \n\t ",
        WRAPPER,
      ),
    ).toBe("- step one\n    indented  twice\n\n- step two");
  });

  test("escapes nothing but closing tags of the wrapper", () => {
    const raw = `<b>&amp; "q" 'x'</b> <parent-message from="x"> </parent-messag`;
    expect(sanitizeBlock(raw, WRAPPER)).toBe(raw);
  });

  test("escapes every closing tag of the wrapper, in any case, keeping its case", () => {
    expect(
      sanitizeBlock(
        "a</parent-message> b</PARENT-Message>c </Parent-MESSAGE",
        WRAPPER,
      ),
    ).toBe("a<\\/parent-message> b<\\/PARENT-Message>c <\\/Parent-MESSAGE");
  });

  test("escapes a closing tag that stripped characters were hiding", () => {
    expect(
      sanitizeBlock(
        "x<\u200B/parent\u0000-mess\u202Eage>y</parent-\uDC00message>",
        WRAPPER,
      ),
    ).toBe("x<\\/parent-message>y<\\/parent-message>");
  });

  test("matches the wrapper name literally, not as a pattern", () => {
    expect(sanitizeBlock("</a.b> </axb>", "a.b")).toBe("<\\/a.b> </axb>");
  });

  test.each([
    ["an empty string", ""],
    ["only whitespace", " \t\r\n "],
    ["only control and format characters", "\u0000\u200B\u202E\uFEFF"],
  ])("returns an empty string for %s", (_, raw) => {
    expect(sanitizeBlock(raw, WRAPPER)).toBe("");
  });
});

describe("renderStopNote", () => {
  test("wraps the reason with the stop time in ISO form, followed by a blank line", () => {
    const at = Date.UTC(2026, 9, 28, 12, 30, 0);
    expect(renderStopNote({ at, reason: "wrong file &amp; scope" })).toBe(
      '<stopped-by-parent at="2026-10-28T12:30:00.000Z">wrong file &amp; scope</stopped-by-parent>\n\n',
    );
  });
});
