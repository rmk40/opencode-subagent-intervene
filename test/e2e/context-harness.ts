import { join } from "node:path";
import { Llm } from "opencode-drive";
import { readLog, REPO_ROOT, type JsonValue } from "./harness";

export const contextPlugins = (
  dir: string,
  options: Record<string, JsonValue> = {},
) => [
  {
    package: join(REPO_ROOT, "test/e2e/probe-plugin"),
    options: { dir, contextProbes: true },
  },
  { package: REPO_ROOT, options },
  { package: join(REPO_ROOT, "test/e2e/context-observer"), options: { dir } },
];

export const usage = (input: number, output = 20) =>
  Llm.raw({
    id: "chatcmpl-probe-usage",
    object: "chat.completion.chunk",
    created: 1,
    model: "gpt-sim-model",
    choices: [],
    usage: {
      prompt_tokens: input,
      completion_tokens: output,
      total_tokens: input + output,
    },
  });

export const object = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

// The released runtime validates these summary headings before storing a checkpoint.
export const compactionSummary = `## Objective
- Finish the runtime context-management probe.
## Requirements
- Preserve the current goal and exact next action.
## Decisions
- Continue after the local tool batch settles.
## Work State
### Completed
- Read context status and request compaction.
### Active
- Verify continuation and stored handoff notes.
### Blocked
- (none)
## Next Move
1. Read the stored handoff and answer CONTINUED.
## Relevant Files
- (none)
## Important Context
- The handoff identifies the next action.`;

export const toolObservation = (dir: string, id: string) =>
  readLog(dir).find(
    (record) => record.kind === "context-hook-exit" && record.callID === id,
  );

export const structuredResult = (dir: string, id: string) =>
  object(object(toolObservation(dir, id)?.result).output);

export const noticeMessages = (history: readonly unknown[]) =>
  history.filter((message) => {
    const item = object(message);
    return (
      item.type === "synthetic" &&
      JSON.stringify(item).includes("context-warning")
    );
  });

const noticePlanningGuidance =
  "Context planning update. Continue while the next step and its expected output fit before the automatic-compaction point, leaving room for results not yet measured, and narrow large results when possible. This notice alone is not a reason to compact.";

export const measurementScope =
  "Later messages and pending tool or subagent results are not included in this measurement.";

/**
 * `assumed default auto ~170k (20k away)`, or `configured auto ~…` with a `compactionBuffer`
 * option, or `(20k past estimate)` once the measurement passes it.
 */
export const autoEstimateWithDistance =
  / · (?:configured|assumed default) auto ~[\d.]+[kM]? \([\d.]+[kM]? (?:away|past estimate)\)/;

/**
 * A notice is: measurement · automatic-compaction estimate with distance · planning guidance ·
 * model and epoch · measurement scope. Nothing outside the fixed guidance may nudge toward
 * compaction.
 */
export const noticeHasPlanningGuidance = (text: unknown) => {
  if (typeof text !== "string") return false;
  if (!text.endsWith(` · ${measurementScope}`)) return false;
  const body = text.slice(0, -` · ${measurementScope}`.length);
  const sections = body.split(` · ${noticePlanningGuidance} · `);
  return (
    sections.length === 2 &&
    / · measured \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z(?: · (?:configured|assumed default) auto ~[\d.]+[kM]?(?: \([\d.]+[kM]? (?:away|past estimate)\))?)?$/.test(
      sections[0] ?? "",
    ) &&
    !/Snapshot is stale|earlier under host|rebuilding cached/i.test(text) &&
    !/\b(?:heads-up|prepare|handoff|compact|stop(?:ping)?|recheck|disregard|choose|should|must|tool)\b|context_(?:compact|status|notes)/i.test(
      sections.join(" · "),
    )
  );
};

export const NOTES_KEY = "subagent-intervene.working-notes";

export interface NotesBlock {
  readonly role: string;
  /** Index of the message in the request; leading system messages form the baseline. */
  readonly index: number;
  readonly leading: boolean;
  readonly value: Record<string, unknown>;
}

const messageText = (content: unknown): string =>
  typeof content === "string"
    ? content
    : Array.isArray(content)
      ? content
          .map((part) =>
            typeof object(part).text === "string"
              ? String(object(part).text)
              : "",
          )
          .join("\n")
      : "";

/** Chronological instruction updates arrive wrapped and entity-escaped in a conversation message. */
const SYSTEM_UPDATE = "<system-update>";
const unescapeUpdate = (text: string) =>
  text.includes(SYSTEM_UPDATE)
    ? text
        .replaceAll("&lt;", "<")
        .replaceAll("&gt;", ">")
        .replaceAll("&quot;", '"')
        .replaceAll("&amp;", "&")
    : text;

export const isSystemUpdate = (body: unknown, index: number) => {
  const messages = object(body).messages;
  return (
    Array.isArray(messages) &&
    messageText(object(messages[index]).content).startsWith(SYSTEM_UPDATE)
  );
};

/**
 * Every rendered working-notes entry in a simulated request body, from the leading system
 * baseline and from later update messages. The host renders an object value as indented JSON,
 * whose strings cannot hold a raw newline, so `\n}\n</context>` ends the block even when the notes
 * themselves contain `</context>`.
 */
export function notesBlocks(body: unknown): NotesBlock[] {
  const messages = object(body).messages;
  if (!Array.isArray(messages)) return [];
  const leadingEnd = messages.findIndex(
    (message) => object(message).role !== "system",
  );
  const start = `<context key="${NOTES_KEY}">\n`;
  const blocks: NotesBlock[] = [];
  messages.forEach((message, index) => {
    const text = unescapeUpdate(messageText(object(message).content));
    let from = 0;
    for (;;) {
      const at = text.indexOf(start, from);
      if (at === -1) break;
      const end = text.indexOf("\n}\n</context>", at);
      if (end === -1) break;
      try {
        blocks.push({
          role: String(object(message).role),
          index,
          leading: leadingEnd === -1 || index < leadingEnd,
          value: object(JSON.parse(text.slice(at + start.length, end + 2))),
        });
      } catch {
        // A block that does not parse is not counted.
      }
      from = end + 1;
    }
  });
  return blocks;
}

/** Messages naming the notes key outside a rendered block, such as a removal update. */
export const notesMentions = (body: unknown): string[] => {
  const messages = object(body).messages;
  if (!Array.isArray(messages)) return [];
  return messages
    .map((message) => unescapeUpdate(messageText(object(message).content)))
    .filter((text) => text.includes(`"${NOTES_KEY}"`));
};

/**
 * The notes a model reading the request in order would take as current: the last rendered block,
 * unless a later update says the entry no longer applies.
 */
export function effectiveNotes(
  body: unknown,
): Record<string, unknown> | undefined {
  const messages = object(body).messages;
  if (!Array.isArray(messages)) return undefined;
  const blocks = notesBlocks(body);
  let current: Record<string, unknown> | undefined;
  messages.forEach((message, index) => {
    for (const block of blocks.filter((item) => item.index === index))
      current = block.value;
    const text = unescapeUpdate(messageText(object(message).content));
    if (
      text.includes(`The context under "${NOTES_KEY}" no longer applies`) &&
      !text.includes(`<context key="${NOTES_KEY}">`)
    )
      current = undefined;
  });
  return current;
}

export function hookTimings(dir: string) {
  const log = readLog(dir);
  return log
    .filter((item) => item.kind === "context-hook-exit")
    .flatMap((end) => {
      const start = log.find(
        (item) =>
          item.kind === "context-hook-enter" &&
          item.callID === end.callID &&
          item.messageID === end.messageID,
      );
      return start
        ? [
            {
              callID: end.callID,
              ms: end.hr - start.hr,
              historyBytes: end.historyBytes,
            },
          ]
        : [];
    });
}
