// A bounded summary of a session's recent activity, built from its context messages. All lengths
// are counted in code points, and every cut is marked with an ellipsis that counts toward its limit.

import type { SessionMessageInfo } from "@/core/ports";

export const DEFAULT_MAX_CHARS = 4000;
export const MAX_MAX_CHARS = 12000;
export const MIN_MAX_CHARS = 200;
export const RECENT_TOOL_NAMES_LIMIT = 10;

// Each field first gets up to its share of the budget, and `lastText`, usually the longest field,
// gets whatever the first three leave, at least a quarter. Room the text leaves unused goes to the
// active tools, then to the error, and what is still left to the summary of earlier work.
const ACTIVE_TOOLS_SHARE = 3 / 8;
const RECENT_TOOL_NAMES_SHARE = 1 / 8;
const LAST_ERROR_SHARE = 1 / 4;

const ELLIPSIS = "\u2026";

type AssistantMessage = Extract<SessionMessageInfo, { type: "assistant" }>;
type CompletedCompaction = Extract<
  SessionMessageInfo,
  { type: "compaction"; status: "completed" }
>;
type ToolPart = Extract<AssistantMessage["content"][number], { type: "tool" }>;
type StructuredError = NonNullable<AssistantMessage["error"]>;

export interface ActiveTool {
  readonly name: string;
  readonly status: "streaming" | "running";
  /**
   * The tool input on one line: compact JSON for a running tool, the text streamed so far for a
   * streaming one. Cut only to fit the budget.
   */
  readonly input: string;
  /** Milliseconds since the tool started running; left out until it starts or without `now`. */
  readonly runningForMs?: number;
}

export interface ContextSummary {
  /** Tool calls still streaming or running, oldest first. */
  readonly activeTools: readonly ActiveTool[];
  /** The end of the latest assistant message that has text. */
  readonly lastText?: string;
  /** The latest assistant or tool error. */
  readonly lastError?: string;
  /** Names of the last 10 tool calls, oldest first. */
  readonly recentToolNames: readonly string[];
  /** The start of the latest completed compaction's summary of the messages before it. */
  readonly earlierSummary?: string;
  /** Set, to true, only when that compaction has a summary and none of it fit the budget. */
  readonly earlierSummaryOmitted?: boolean;
  /** True when something was cut or left out to fit `maxChars`. */
  readonly truncated: boolean;
}

export interface SummarizeOptions {
  /** Budget for all text in the summary. Defaults to 4000; clamped to 200..12000. */
  readonly maxChars?: number;
  /**
   * Leave `activeTools` empty. Set for an idle session: it runs no tools, and a crash can leave a
   * call recorded as running. Their share of the budget then goes to `lastText`.
   */
  readonly omitActiveTools?: boolean;
  /** The current time in epoch milliseconds, for `runningForMs`. Without it that is left out. */
  readonly now?: number;
}

/** Defaults a missing or NaN budget and clamps the rest to an integer in range. */
export function clampMaxChars(maxChars: number | undefined): number {
  if (maxChars === undefined || Number.isNaN(maxChars)) {
    return DEFAULT_MAX_CHARS;
  }
  const floored = Math.floor(maxChars);
  return Math.min(MAX_MAX_CHARS, Math.max(MIN_MAX_CHARS, floored));
}

/**
 * Summarizes messages in chronological order, as `ctx.session.context` returns them. Only
 * messages after the latest completed compaction are read, plus that compaction's summary. The
 * code points of all strings in the result (tool names, tool inputs, `lastError`, `lastText`,
 * `earlierSummary`) add up to at most the clamped `maxChars`.
 */
export function summarizeContext(
  messages: readonly SessionMessageInfo[],
  options: SummarizeOptions = {},
): ContextSummary {
  const budget = clampMaxChars(options.maxChars);
  const { compaction, assistants } = sinceCompaction(messages);
  const tools = assistants.flatMap((message) =>
    message.content.filter((part): part is ToolPart => part.type === "tool"),
  );
  const candidates =
    options.omitActiveTools === true
      ? []
      : tools.flatMap((tool) => activeCandidate(tool, options.now));

  // First pass: each field up to its share, and the text the rest.
  let active = fitActiveTools(
    candidates,
    Math.floor(budget * ACTIVE_TOOLS_SHARE),
  );
  const names = fitToolNames(
    tools,
    Math.floor(budget * RECENT_TOOL_NAMES_SHARE),
  );
  const error = latestError(assistants);
  let errorFit =
    error === undefined
      ? NOTHING
      : takeHead(error, Math.floor(budget * LAST_ERROR_SHARE));
  const text = latestText(assistants);
  const textFit =
    text === undefined
      ? NOTHING
      : takeTail(
          text,
          budget - active.used - names.used - codePointCount(errorFit.text),
        );

  // Second pass: room the text left unused goes to the cut fields in priority order.
  let spare =
    budget -
    active.used -
    names.used -
    codePointCount(errorFit.text) -
    codePointCount(textFit.text);
  if (active.cut && spare > 0) {
    const widened = fitActiveTools(candidates, active.used + spare);
    spare -= widened.used - active.used;
    active = widened;
  }
  if (error !== undefined && errorFit.cut && spare > 0) {
    const used = codePointCount(errorFit.text);
    errorFit = takeHead(error, used + spare);
    spare -= codePointCount(errorFit.text) - used;
  }
  const summary = compaction?.summary.trim() ?? "";
  const summaryFit = summary === "" ? NOTHING : takeHead(summary, spare);

  return {
    activeTools: active.tools,
    ...(textFit.text === "" ? {} : { lastText: textFit.text }),
    ...(errorFit.text === "" ? {} : { lastError: errorFit.text }),
    recentToolNames: names.names,
    ...(summaryFit.text === "" ? {} : { earlierSummary: summaryFit.text }),
    ...(summary !== "" && summaryFit.text === ""
      ? { earlierSummaryOmitted: true }
      : {}),
    truncated:
      active.cut || names.cut || errorFit.cut || textFit.cut || summaryFit.cut,
  };
}

/** Plain-text rendering of a summary, for a tool result's `content`. */
export function renderContextSummary(summary: ContextSummary): string {
  const lines: string[] = [];
  if (summary.activeTools.length === 0) {
    lines.push("Active tools: none");
  } else {
    lines.push("Active tools:");
    for (const tool of summary.activeTools) {
      const status =
        tool.runningForMs === undefined
          ? tool.status
          : `${tool.status}, ${formatDuration(tool.runningForMs)}`;
      const input = tool.input === "" ? "" : `: ${tool.input}`;
      lines.push(`- ${tool.name} (${status})${input}`);
    }
  }
  const names = summary.recentToolNames;
  lines.push(`Recent tools: ${names.length === 0 ? "none" : names.join(", ")}`);
  lines.push(`Last error: ${summary.lastError ?? "none"}`);
  if (summary.truncated) lines.push("Some of this was cut to fit maxChars.");
  // The texts go last because they can span several lines, the summary of earlier work after
  // the latest text.
  if (summary.lastText === undefined) {
    lines.push("Last assistant text: none");
  } else {
    lines.push("Last assistant text:", summary.lastText);
  }
  if (summary.earlierSummary !== undefined) {
    lines.push(
      "Summary of earlier work (from the last compaction):",
      summary.earlierSummary,
    );
  }
  return lines.join("\n");
}

/**
 * A duration in whole units, rounded down: `45s`, `4m 12s`, `2h 5m`. A zero second or minute part
 * is left out, as in `4m` or `2h`.
 */
export function formatDuration(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return withPart(`${minutes}m`, seconds % 60, "s");
  return withPart(`${Math.floor(minutes / 60)}h`, minutes % 60, "m");
}

function withPart(whole: string, part: number, unit: string): string {
  return part === 0 ? whole : `${whole} ${part}${unit}`;
}

/**
 * Names of the tool calls still streaming or running in the messages after the latest completed
 * compaction, oldest first. The same calls `summarizeContext` reports as active, with no budget.
 */
export function activeToolNames(
  messages: readonly SessionMessageInfo[],
): string[] {
  return sinceCompaction(messages)
    .assistants.flatMap((message) => message.content)
    .flatMap((part) =>
      part.type === "tool" && isActive(part.state) ? [part.name] : [],
    );
}

function isActive(
  state: ToolPart["state"],
): state is Extract<ToolPart["state"], { status: "streaming" | "running" }> {
  return state.status === "streaming" || state.status === "running";
}

/** The latest completed compaction and the assistant messages after it. */
function sinceCompaction(messages: readonly SessionMessageInfo[]): {
  readonly compaction?: CompletedCompaction;
  readonly assistants: AssistantMessage[];
} {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (message?.type === "compaction" && message.status === "completed") {
      return {
        compaction: message,
        assistants: assistantsIn(messages.slice(index + 1)),
      };
    }
  }
  return { assistants: assistantsIn(messages) };
}

function assistantsIn(
  messages: readonly SessionMessageInfo[],
): AssistantMessage[] {
  return messages.filter(
    (message): message is AssistantMessage => message.type === "assistant",
  );
}

/** The tool with its whole input when it is still streaming or running, or nothing. */
function activeCandidate(
  tool: ToolPart,
  now: number | undefined,
): ActiveTool[] {
  const state = tool.state;
  if (!isActive(state)) return [];
  const ran = tool.time.ran;
  return [
    {
      name: tool.name,
      status: state.status,
      // Line breaks in the streamed text become single spaces, keeping the input on one line;
      // spacing within a line is kept as streamed.
      input:
        state.status === "streaming"
          ? state.input.replace(/\s*\n\s*/g, " ").trim()
          : JSON.stringify(state.input),
      ...(ran === undefined || now === undefined
        ? {}
        : { runningForMs: Math.max(0, now - ran) }),
    },
  ];
}

/**
 * The newest active tools whose names fit `cap`, oldest first, each with as much of its input as
 * is left; filled newest first, so a tight cap drops the oldest. `used` counts names and inputs.
 */
function fitActiveTools(
  candidates: readonly ActiveTool[],
  cap: number,
): {
  readonly tools: ActiveTool[];
  readonly used: number;
  readonly cut: boolean;
} {
  const tools: ActiveTool[] = [];
  let used = 0;
  let cut = false;
  for (const candidate of candidates.toReversed()) {
    const nameWidth = codePointCount(candidate.name);
    if (used + nameWidth > cap) {
      cut = true;
      break;
    }
    const input = takeHead(candidate.input, cap - used - nameWidth);
    if (input.cut) cut = true;
    tools.push({ ...candidate, input: input.text });
    used += nameWidth + codePointCount(input.text);
  }
  return { tools: tools.reverse(), used, cut };
}

/** Names of the last 10 tool calls that fit `cap`, oldest first; a tight cap drops the oldest. */
function fitToolNames(
  tools: readonly ToolPart[],
  cap: number,
): { readonly names: string[]; readonly used: number; readonly cut: boolean } {
  const names: string[] = [];
  let used = 0;
  for (const tool of tools.slice(-RECENT_TOOL_NAMES_LIMIT).reverse()) {
    const width = codePointCount(tool.name);
    if (used + width > cap) return { names: names.reverse(), used, cut: true };
    names.push(tool.name);
    used += width;
  }
  return { names: names.reverse(), used, cut: false };
}

function latestText(
  assistants: readonly AssistantMessage[],
): string | undefined {
  for (const message of assistants.toReversed()) {
    const parts = message.content
      .flatMap((part) => (part.type === "text" ? [part.text.trim()] : []))
      .filter((text) => text !== "");
    if (parts.length > 0) return parts.join("\n\n");
  }
  return undefined;
}

// A message's own error ends its step, so it is newer than any tool error in the same message.
function latestError(
  assistants: readonly AssistantMessage[],
): string | undefined {
  for (const message of assistants.toReversed()) {
    if (message.error !== undefined) return formatError(message.error);
    for (const part of message.content.toReversed()) {
      if (part.type === "tool" && part.state.status === "error") {
        return `tool ${part.name}: ${formatError(part.state.error)}`;
      }
    }
  }
  return undefined;
}

function formatError(error: StructuredError): string {
  const message = error.message.trim();
  return message === "" ? error.type : `${error.type}: ${message}`;
}

function isHighSurrogate(unit: number): boolean {
  return unit >= 0xd800 && unit <= 0xdbff;
}

function isLowSurrogate(unit: number): boolean {
  return unit >= 0xdc00 && unit <= 0xdfff;
}

// UTF-16 index just after the code point that starts at `index`.
function nextIndex(text: string, index: number): number {
  const pair =
    isHighSurrogate(text.charCodeAt(index)) &&
    isLowSurrogate(text.charCodeAt(index + 1));
  return pair ? index + 2 : index + 1;
}

// UTF-16 index where the code point that ends just before `index` starts.
function previousIndex(text: string, index: number): number {
  const pair =
    index >= 2 &&
    isLowSurrogate(text.charCodeAt(index - 1)) &&
    isHighSurrogate(text.charCodeAt(index - 2));
  return pair ? index - 2 : index - 1;
}

function codePointCount(text: string): number {
  let count = 0;
  for (let index = 0; index < text.length; index = nextIndex(text, index)) {
    count++;
  }
  return count;
}

interface Fitted {
  readonly text: string;
  readonly cut: boolean;
}

const NOTHING: Fitted = { text: "", cut: false };

/** The first `limit` code points of `text`, ending in an ellipsis when cut. */
function takeHead(text: string, limit: number): Fitted {
  if (limit <= 0) return { text: "", cut: text !== "" };
  // Stops at the limit, so a long text is not scanned to its end.
  let beforeLast = 0;
  let index = 0;
  for (let count = 0; count < limit && index < text.length; count++) {
    beforeLast = index;
    index = nextIndex(text, index);
  }
  if (index >= text.length) return { text, cut: false };
  // Keeps `limit - 1` code points to leave room for the ellipsis.
  return { text: text.slice(0, beforeLast) + ELLIPSIS, cut: true };
}

/** The last `limit` code points of `text`, starting with an ellipsis when cut. */
function takeTail(text: string, limit: number): Fitted {
  if (limit <= 0) return { text: "", cut: text !== "" };
  let afterFirst = text.length;
  let index = text.length;
  for (let count = 0; count < limit && index > 0; count++) {
    afterFirst = index;
    index = previousIndex(text, index);
  }
  if (index <= 0) return { text, cut: false };
  return { text: ELLIPSIS + text.slice(afterFirst), cut: true };
}
