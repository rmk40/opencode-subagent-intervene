// Shared helpers for end-to-end Drive scripts: per-run artifact directories, plugin config,
// the probe plugin's loopback control client, log reading, and simulated-LLM request parsing.
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Effect, Option, Stream } from "effect";
import { Llm, type Tool } from "opencode-drive";

// Drive compiles scripts into its own runtime directory, so `import.meta.url` does not point at
// the repository. Scripts run from the repository root (see the `probe` package script).
export const REPO_ROOT = resolve(process.env.E2E_REPO_ROOT ?? process.cwd());
export const PROBE_PLUGIN_DIR = join(REPO_ROOT, "test", "e2e", "probe-plugin");

/** Creates a fresh artifact directory for one script run. `E2E_RUN_DIR` overrides the root. */
export function runDir(name: string): string {
  const root =
    process.env.E2E_RUN_DIR ??
    join(tmpdir(), "opencode", "subagent-intervene-e2e");
  const dir = join(
    root,
    `${name}-${new Date().toISOString().replace(/[:.]/g, "-")}`,
  );
  mkdirSync(dir, { recursive: true });
  return dir;
}

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | ReadonlyArray<JsonValue>
  | { readonly [key: string]: JsonValue };

/** Plugins entry that loads the probe plugin with its artifact directory. */
export function probePlugin(dir: string): JsonValue {
  return { package: PROBE_PLUGIN_DIR, options: { dir } };
}

export interface Instance {
  readonly instance: string;
  readonly location: string;
  readonly pid: number;
  readonly port: number;
}

export function instances(dir: string): Instance[] {
  const folder = join(dir, "instances");
  if (!existsSync(folder)) return [];
  return readdirSync(folder)
    .filter((name) => name.endsWith(".json"))
    .map(
      (name) =>
        JSON.parse(readFileSync(join(folder, name), "utf8")) as Instance,
    );
}

/** Waits until a probe plugin instance for `location` (or any location) has registered. */
export async function instanceFor(
  dir: string,
  location?: string,
  timeoutMs = 20_000,
): Promise<Instance> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const found = instances(dir).find(
      (item) => location === undefined || item.location === location,
    );
    if (found) return found;
    if (Date.now() > deadline)
      throw new Error(
        `no probe instance for ${location ?? "any location"} in ${dir}`,
      );
    await Bun.sleep(50);
  }
}

export class ControlError extends Error {}

/** Calls one control operation on a probe plugin instance. */
export async function call<T = unknown>(
  instance: Instance,
  op: string,
  args: Record<string, unknown> = {},
): Promise<T> {
  const response = await fetch(`http://127.0.0.1:${instance.port}/`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ op, args }),
  });
  const body = (await response.json()) as { result?: T; error?: string };
  if (body.error !== undefined) throw new ControlError(`${op}: ${body.error}`);
  return body.result as T;
}

export interface LogRecord {
  readonly kind: string;
  readonly instance: string;
  readonly location: string;
  readonly seq: number;
  readonly at: number;
  readonly hr: number;
  /** Event records: the event type and the session it names. */
  readonly type?: string;
  readonly sessionID?: string;
  readonly [key: string]: unknown;
}

/** Reads every probe instance log, ordered by wall-clock time and then per-instance sequence. */
export function readLog(dir: string): LogRecord[] {
  return readdirSync(dir)
    .filter((name) => name.startsWith("log-") && name.endsWith(".jsonl"))
    .flatMap((name) =>
      readFileSync(join(dir, name), "utf8")
        .split("\n")
        .filter((line) => line.length > 0)
        .map((line) => JSON.parse(line) as LogRecord),
    )
    .sort(
      (a, b) => a.at - b.at || (a.instance === b.instance ? a.seq - b.seq : 0),
    );
}

export const events = (
  log: ReadonlyArray<LogRecord>,
  source: "typed" | "all" = "typed",
) =>
  log.filter((record) => record.kind === "event" && record.source === source);

export const forSession = (log: ReadonlyArray<LogRecord>, sessionID: string) =>
  log.filter((record) => record.sessionID === sessionID);

/** Appends one JSON line to a run artifact. */
export function writeLine(dir: string, file: string, value: unknown) {
  appendFileSync(join(dir, file), `${JSON.stringify(value)}\n`);
}

/** Polls `check` until it returns a value other than `undefined`. */
export async function until<T>(
  label: string,
  check: () => T | undefined | Promise<T | undefined>,
  timeoutMs = 20_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value !== undefined) return value;
    if (Date.now() > deadline)
      throw new Error(`timed out waiting for ${label}`);
    await Bun.sleep(25);
  }
}

// Simulated LLM request bodies are OpenAI chat-completions JSON. The probe plugin's `context`
// hook tags every model request with `PROBE-SID<sessionID> PROBE-AGENT<agent>` in its system
// prompt, which attributes a request to its session without guessing from history.

export interface ChatRequest {
  readonly sessionID?: string;
  readonly agent?: string;
  /** `ROLE<name>` tag from the first user message, set by scripts in task prompts. */
  readonly role?: string;
  readonly last: {
    readonly role: string;
    readonly text: string;
    readonly toolCallID?: string;
  };
  /** Text of every user message, oldest first. */
  readonly userTexts: ReadonlyArray<string>;
  readonly tools: ReadonlyArray<string>;
  readonly system: string;
  readonly raw: string;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const contentText = (content: unknown): string => {
  if (typeof content === "string") return content;
  if (Array.isArray(content))
    return content
      .map((part) =>
        isRecord(part) && typeof part.text === "string" ? part.text : "",
      )
      .join("\n");
  return "";
};

export function parseRequest(body: unknown): ChatRequest {
  const raw = JSON.stringify(body);
  const messages =
    isRecord(body) && Array.isArray(body.messages) ? body.messages : [];
  const system = messages
    .filter((message) => isRecord(message) && message.role === "system")
    .map((message) => (isRecord(message) ? contentText(message.content) : ""))
    .join("\n");
  const lastMessage: unknown = messages.at(-1);
  const tools =
    isRecord(body) && Array.isArray(body.tools)
      ? body.tools.flatMap((tool) =>
          isRecord(tool) &&
          isRecord(tool.function) &&
          typeof tool.function.name === "string"
            ? [tool.function.name]
            : [],
        )
      : [];
  const userTexts = messages
    .filter((message) => isRecord(message) && message.role === "user")
    .map((message) => (isRecord(message) ? contentText(message.content) : ""));
  return {
    sessionID: /PROBE-SID<([^>]+)>/.exec(system)?.[1],
    agent: /PROBE-AGENT<([^>]+)>/.exec(system)?.[1],
    role: /ROLE<([^>]+)>/.exec(userTexts[0] ?? "")?.[1],
    last: {
      role:
        isRecord(lastMessage) && typeof lastMessage.role === "string"
          ? lastMessage.role
          : "",
      text: isRecord(lastMessage) ? contentText(lastMessage.content) : "",
      ...(isRecord(lastMessage) && typeof lastMessage.tool_call_id === "string"
        ? { toolCallID: lastMessage.tool_call_id }
        : {}),
    },
    userTexts,
    tools,
    system,
    raw,
  };
}

/** Records one simulated-LLM request to `llm.jsonl` and returns its parsed form. */
export function recordRequest(
  dir: string,
  body: unknown,
  index: number,
): ChatRequest {
  const parsed = parseRequest(body);
  writeLine(dir, "llm.jsonl", {
    at: Date.now(),
    index,
    sessionID: parsed.sessionID,
    agent: parsed.agent,
    role: parsed.role,
    last: { ...parsed.last, text: parsed.last.text.slice(0, 400) },
    tools: parsed.tools,
    catalog: codeModeCatalog(parsed.system),
  });
  return parsed;
}

/** Code Mode catalog entries (`namespace.name`) rendered into a request's system prompt. */
export function codeModeCatalog(system: string): string[] {
  return [
    ...new Set(
      [...system.matchAll(/tools\.([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)\(/g)].map(
        (m) => `${m[1]}.${m[2]}`,
      ),
    ),
  ];
}

export interface LlmRecord {
  readonly at: number;
  readonly index: number;
  readonly sessionID?: string;
  readonly agent?: string;
  readonly role?: string;
  readonly catalog: ReadonlyArray<string>;
  readonly last: {
    readonly role: string;
    readonly text: string;
    readonly toolCallID?: string;
  };
  readonly tools: ReadonlyArray<string>;
}

export function readLlm(dir: string): LlmRecord[] {
  const file = join(dir, "llm.jsonl");
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as LlmRecord);
}

/** Waits for the `count`-th typed event (1-based) of `type` for `sessionID` at or after `since`. */
export function waitEvent(
  dir: string,
  sessionID: string,
  type: string,
  options: {
    readonly since?: number;
    readonly count?: number;
    readonly timeoutMs?: number;
  } = {},
): Promise<LogRecord> {
  const count = options.count ?? 1;
  return until(
    `${type} #${count} for ${sessionID}`,
    () =>
      events(readLog(dir)).filter(
        (event) =>
          event.sessionID === sessionID &&
          event.type === type &&
          event.at >= (options.since ?? 0),
      )[count - 1],
    options.timeoutMs,
  );
}

/** The first child session the probe saw created under `parentID`. */
export function childOf(
  dir: string,
  parentID: string,
  nth = 0,
): string | undefined {
  return events(readLog(dir)).filter(
    (event) => event.type === "session.created" && event.parentID === parentID,
  )[nth]?.sessionID as string | undefined;
}

/** Subagent notices enqueued to `sessionID`, from the typed event stream. */
export function notices(dir: string, sessionID: string) {
  return events(readLog(dir))
    .filter(
      (event) =>
        event.type === "session.inbox.enqueued" &&
        event.sessionID === sessionID &&
        event.itemType === "synthetic",
    )
    .map((event) => ({
      at: event.at,
      created: event.created,
      metadata: event.itemMetadata,
      text: event.itemText,
    }));
}

/** The value of `key` in a notice's metadata, when it is a string. */
const metadataText = (metadata: unknown, key: string): string | undefined => {
  const value = isRecord(metadata) ? metadata[key] : undefined;
  return typeof value === "string" ? value : undefined;
};

/**
 * Synthetic items enqueued to `sessionID`, one per event. Every loaded probe instance logs every
 * event, so with several locations loaded the same event appears once per instance; this keeps
 * the first record of each event ID.
 */
export function distinctNotices(dir: string, sessionID: string) {
  const seen = new Set<string>();
  return events(readLog(dir))
    .filter(
      (event) =>
        event.type === "session.inbox.enqueued" &&
        event.sessionID === sessionID &&
        event.itemType === "synthetic",
    )
    .filter((event) => {
      const id = typeof event.id === "string" ? event.id : "";
      if (seen.has(id)) return false;
      seen.add(id);
      return true;
    })
    .map((event) => ({
      at: event.at,
      eventID: event.id,
      instance: event.instance,
      metadata: event.itemMetadata,
      text: event.itemText,
    }));
}

/** Notices the subagent-intervene plugin posted to `sessionID` about a subagent waiting on a person. */
export const waitingNotices = (dir: string, sessionID: string) =>
  distinctNotices(dir, sessionID).filter(
    (notice) => metadataText(notice.metadata, "kind") === "subagent-waiting",
  );

/** OpenCode's own completion notices to `sessionID` about its subagent `childID`. */
export const completionNotices = (
  dir: string,
  sessionID: string,
  childID: string,
) =>
  distinctNotices(dir, sessionID).filter(
    (notice) =>
      metadataText(notice.metadata, "source") === "subagent" &&
      metadataText(notice.metadata, "childID") === childID,
  );

/** The `state` in a completion notice's metadata (`completed`, `cancelled`, ...). */
export const noticeState = (notice: { readonly metadata: unknown }) =>
  metadataText(notice.metadata, "state");

export interface PendingPermission {
  readonly id: string;
  readonly action: string;
  readonly resources: ReadonlyArray<string>;
}

/** Permission requests pending for `sessionID` in the probe instance's location. */
export const pendingPermissions = (instance: Instance, sessionID: string) =>
  call<ReadonlyArray<PendingPermission>>(instance, "permissions", {
    sessionID,
  });

/** Waits for a pending permission request for `action` in `sessionID`. */
export const waitPermission = (
  instance: Instance,
  sessionID: string,
  action: string,
  timeoutMs = 20_000,
): Promise<PendingPermission> =>
  until(
    `${action} permission request for ${sessionID}`,
    async () =>
      (await pendingPermissions(instance, sessionID)).find(
        (request) => request.action === action,
      ),
    timeoutMs,
  );

/** What subagent_send delivers for a message that needs no cleaning, sent by `from`. */
export const parentMessageText = (from: string, message: string) =>
  `<parent-message from="${from}">\n${message}\n</parent-message>`;

/** The `directory` that a `subagents.list` result reports for each listed session. */
export function listedDirectories(value: unknown): Map<string, string> {
  const directories = new Map<string, string>();
  const entries =
    isRecord(value) && Array.isArray(value.entries) ? value.entries : [];
  for (const entry of entries) {
    if (
      isRecord(entry) &&
      typeof entry.sessionID === "string" &&
      typeof entry.directory === "string"
    )
      directories.set(entry.sessionID, entry.directory);
  }
  return directories;
}

/** A one-shot latch that a scripted model response can wait on. */
export class Gate {
  private release: () => void = () => undefined;
  readonly opened: Promise<void> = new Promise<void>((resolve) => {
    this.release = resolve;
  });
  open() {
    this.release();
  }
}

/**
 * Takes the controlled tool call with model call ID `id`, failing the program when it does not
 * arrive within `timeoutMs`, so a missing call ends the run instead of blocking it.
 */
export const takeCall = <I, R>(
  calls: Tool.ControlledCalls<I, R>,
  id: string,
  timeoutMs = 20_000,
) =>
  calls.take(id).pipe(
    Effect.orDie,
    Effect.timeoutOption(timeoutMs),
    Effect.flatMap((found) =>
      Option.isSome(found)
        ? Effect.succeed(found.value)
        : Effect.die(new Error(`no ${id} tool call within ${timeoutMs} ms`)),
    ),
  );

/** One scripted model response that calls a single tool. */
export const toolCallResponse = (
  id: string,
  name: string,
  input: { readonly [key: string]: JsonValue },
) =>
  Stream.make(
    Llm.toolCall({ index: 0, id, name, input }),
    Llm.finish("tool-calls"),
  );

/**
 * Appends every tool result in a simulated-LLM request body to `tool-results.jsonl` the first time
 * its call ID appears, so a script can read what the model was told.
 */
export function captureToolResults(dir: string, body: unknown) {
  const file = join(dir, "tool-results.jsonl");
  const seen = new Set(readToolResults(dir).map((record) => record.id));
  const messages =
    isRecord(body) && Array.isArray(body.messages) ? body.messages : [];
  for (const message of messages) {
    if (!isRecord(message) || message.role !== "tool") continue;
    const id = message.tool_call_id;
    if (typeof id !== "string" || seen.has(id)) continue;
    seen.add(id);
    appendFileSync(
      file,
      `${JSON.stringify({ at: Date.now(), id, text: contentText(message.content) })}\n`,
    );
  }
}

export interface ToolResultRecord {
  readonly at: number;
  readonly id: string;
  readonly text: string;
}

export function readToolResults(dir: string): ToolResultRecord[] {
  const file = join(dir, "tool-results.jsonl");
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as ToolResultRecord);
}

/** The text of a tool result captured by `captureToolResults`. */
export const capturedToolResult = (
  dir: string,
  id: string,
): string | undefined =>
  readToolResults(dir).find((record) => record.id === id)?.text;

/**
 * Decodes the value a Code Mode program returned with `JSON.stringify`. The tool result may carry
 * it once more JSON-encoded as a string. `undefined` when the text is not JSON.
 */
export function codeModeValue(text: string): unknown {
  try {
    const value: unknown = JSON.parse(text);
    return typeof value === "string" ? JSON.parse(value) : value;
  } catch {
    return undefined;
  }
}

/** Code that returns `subagents.list` over the caller's subtree, for a scripted `execute` call. */
export const LIST_SUBTREE_CODE =
  "return JSON.stringify(await tools.subagents.list({ depth: 4 }));";

/**
 * The latch status (`active`, `lifted`, `gave_up`, `expired`) that a `subagents.list` result reports
 * for each listed session; `undefined` for a session with no latch record.
 */
export function listedLatches(value: unknown): Map<string, string | undefined> {
  const latches = new Map<string, string | undefined>();
  const entries =
    isRecord(value) && Array.isArray(value.entries) ? value.entries : [];
  for (const entry of entries) {
    if (!isRecord(entry) || typeof entry.sessionID !== "string") continue;
    const stopped = entry.stopped;
    latches.set(
      entry.sessionID,
      isRecord(stopped) && typeof stopped.latch === "string"
        ? stopped.latch
        : undefined,
    );
  }
  return latches;
}

/**
 * Messages the subagent-intervene plugin printed (`[subagent-intervene] ...`) in the Drive server's
 * logs under `artifacts`, oldest first within each file. The console prints a message's data object
 * over several lines; they are joined into one entry.
 */
export function pluginConsole(artifacts: string): string[] {
  const logs = join(artifacts, "logs");
  if (!existsSync(logs)) return [];
  const messages: string[] = [];
  for (const name of readdirSync(logs, { recursive: true, encoding: "utf8" })) {
    if (!name.endsWith(".log")) continue;
    let open: string[] | undefined;
    for (const line of readFileSync(join(logs, name), "utf8").split("\n")) {
      if (open !== undefined) {
        open.push(line.trim());
        if (line.trim() === "}") {
          messages.push(open.join(" "));
          open = undefined;
        }
        continue;
      }
      const start = line.indexOf("[subagent-intervene]");
      if (start === -1) continue;
      const message = line.slice(start);
      if (message.trimEnd().endsWith("{")) open = [message.trimEnd()];
      else messages.push(message);
    }
    if (open !== undefined) messages.push(open.join(" "));
  }
  return messages;
}

/**
 * Ends a scenario: writes `result.json`, logs the evidence and checks, and fails the Drive program
 * when any check is false.
 */
export const finishScenario = (
  dir: string,
  name: string,
  evidence: unknown,
  checks: Readonly<Record<string, boolean>>,
) =>
  Effect.gen(function* () {
    writeLine(dir, "result.json", { evidence, checks });
    yield* Effect.log(`RESULT ${JSON.stringify({ evidence, checks })}`);
    const failed = Object.entries(checks)
      .filter(([, ok]) => !ok)
      .map(([check]) => check);
    if (failed.length > 0)
      return yield* Effect.die(
        new Error(`${name} checks failed: ${failed.join(", ")}`),
      );
    yield* Effect.log(
      `${name} OK (${Object.keys(checks).length} checks) ${dir}`,
    );
  });

/** Resolves once `sessionID` is idle, polling the probe's `wait` operation with a short timeout. */
export function waitIdle(
  instance: Instance,
  sessionID: string,
  timeoutMs = 20_000,
): Promise<true> {
  return until(
    `${sessionID} idle`,
    async () => {
      const result = await call<{ outcome: string }>(instance, "wait", {
        sessionID,
        timeoutMs: 100,
      });
      return result.outcome === "resolved" ? true : undefined;
    },
    timeoutMs,
  );
}

/** Whether the probe's `wait` operation still finds `sessionID` busy after `timeoutMs`. */
export async function isBusy(
  instance: Instance,
  sessionID: string,
  timeoutMs = 300,
): Promise<boolean> {
  const result = await call<{ outcome: string }>(instance, "wait", {
    sessionID,
    timeoutMs,
  });
  return result.outcome === "timeout";
}

/** Whether `text` holds a UTF-16 surrogate without its pair. */
export const hasLoneSurrogate = (text: string): boolean =>
  /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/.test(
    text,
  );
