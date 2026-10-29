// Text written by a model or taken from session data is cleaned before another model reads it in
// markup. Stop reasons and the values notices quote become one line of escaped text. Parent
// messages are instructions whose layout matters, so they keep their lines and characters and only
// lose what could hide text or close their wrapper.

export const REASON_MAX_CODE_POINTS = 500;

/** Thrown by `sanitizeReason` when nothing visible is left of the reason. */
export class EmptyReasonError extends Error {
  override name = "EmptyReasonError";

  constructor() {
    super("reason must contain visible text");
  }
}

// Line breaks and tabs separate words, so they become spaces instead of disappearing. U+0085
// (NEL) is the C1 line break; JavaScript's `\s` does not match it.
const SEPARATING_CONTROLS = /[\t\n\v\f\r\u0085]/g;
// \p{Cc} is exactly C0 (U+0000-U+001F), DEL (U+007F), and C1 (U+0080-U+009F). \p{Cf} adds the
// invisible format characters (bidi overrides, zero-width characters, BOM) that can hide or reorder
// text in another model's context. \p{Cs} catches unpaired surrogates, which would leave the stored
// reason ill-formed.
const CONTROLS = /[\p{Cc}\p{Cf}\p{Cs}]/gu;
const WHITESPACE_RUN = /\s+/g;
const LINE_ENDINGS = /\r\n?/g;
// `CONTROLS` without the tab and line feed, which lay out a block.
const BLOCK_CONTROLS = /(?![\t\n])[\p{Cc}\p{Cf}\p{Cs}]/gu;
const REGEXP_SYNTAX = /[.*+?^${}()|[\]\\]/g;

const ESCAPES: Readonly<Record<string, string>> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

export interface SanitizedText {
  /** Empty when no visible text remains. */
  readonly text: string;
  /** True when the cap left out part of the text. */
  readonly cut: boolean;
}

/**
 * Strips control and format characters, collapses whitespace to single spaces, escapes
 * `& < > " '`, and caps the escaped result at `maxCodePoints` without splitting an entity.
 */
export function sanitizeText(
  raw: string,
  maxCodePoints: number,
): SanitizedText {
  const collapsed = raw
    .replace(SEPARATING_CONTROLS, " ")
    .replace(CONTROLS, "")
    .replace(WHITESPACE_RUN, " ")
    .trim();

  let escaped = "";
  let codePoints = 0;
  let cut = false;
  for (const char of collapsed) {
    const entity = ESCAPES[char];
    // Entities are ASCII, so their string length is their code point count.
    const width = entity === undefined ? 1 : entity.length;
    if (codePoints + width > maxCodePoints) {
      cut = true;
      break;
    }
    escaped += entity ?? char;
    codePoints += width;
  }

  // The cap can end the text on a space.
  return { text: escaped.trimEnd(), cut };
}

/**
 * Cleans multi-line text for the body of a `<wrapper>` element and keeps its layout. Turns `\r\n`
 * and `\r` into `\n`, strips control and format characters other than `\n` and `\t`, and trims
 * blank space at both ends; whitespace inside is kept. Nothing is escaped except closing tags of
 * the wrapper: each `</wrapper`, in any case, becomes `<\/wrapper`, so the text cannot end its
 * element. Returns an empty string when no visible text remains. Not capped.
 */
export function sanitizeBlock(raw: string, wrapper: string): string {
  const closing = new RegExp(
    `</${wrapper.replace(REGEXP_SYNTAX, "\\$&")}`,
    "gi",
  );
  // Closing tags are escaped last, so stripped characters cannot hide one.
  return raw
    .replace(LINE_ENDINGS, "\n")
    .replace(BLOCK_CONTROLS, "")
    .trim()
    .replace(closing, (tag) => `<\\${tag.slice(1)}`);
}

/**
 * `sanitizeText` capped at 500 code points. Throws `EmptyReasonError` when no visible text
 * remains.
 */
export function sanitizeReason(raw: string): string {
  const { text } = sanitizeText(raw, REASON_MAX_CODE_POINTS);
  if (text === "") throw new EmptyReasonError();
  return text;
}

export interface StopNote {
  /** When the stop was requested, in epoch milliseconds. */
  readonly at: number;
  /** Output of `sanitizeReason`; inserted as is. */
  readonly reason: string;
}

/** The note prepended to the prompt that continues a stopped session, followed by a blank line. */
export function renderStopNote(note: StopNote): string {
  const at = new Date(note.at).toISOString();
  return `<stopped-by-parent at="${at}">${note.reason}</stopped-by-parent>\n\n`;
}
