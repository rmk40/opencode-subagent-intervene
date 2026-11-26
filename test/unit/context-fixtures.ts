import { CallID, type ToolContext } from "@opencode/plugin/promise/tool";
import { Brand } from "effect";
import type {
  ContextModel,
  ModelReader,
  SessionInfo,
  SessionMessageInfo,
} from "@/core/ports";
import {
  assistant,
  FakeSessionReader,
  RecordingLogger,
  RecordingMessenger,
  sessionInfo,
} from "./fixtures";

export const SESSION = "ses_context";
export const CURRENT = "msg_current";
export type UsageAssistant = Extract<SessionMessageInfo, { type: "assistant" }>;
export type Tokens = NonNullable<UsageAssistant["tokens"]>;

export function tokens(overrides: Partial<Tokens> = {}): Tokens {
  return { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 }, ...overrides };
}

export function measured(
  id = "msg_measured",
  counts = tokens({ input: 80 }),
  overrides: Partial<UsageAssistant> = {},
): UsageAssistant {
  return {
    ...assistant([]),
    id,
    time: { created: 10, completed: 20 },
    finish: "stop",
    tokens: counts,
    ...overrides,
  };
}

export function current(
  model: UsageAssistant["model"] = { providerID: "provider", id: "model" },
  id = CURRENT,
): UsageAssistant {
  return { ...assistant([]), id, model };
}

export function catalogModel(
  limit: ContextModel["limit"] = { context: 200, input: 100, output: 40 },
  model: UsageAssistant["model"] = { providerID: "provider", id: "model" },
): ContextModel {
  return { ...model, limit };
}

export class ContextReader extends FakeSessionReader {
  readonly gets: string[] = [];
  readonly contextReads: string[] = [];
  getImpl: ((sessionID: string) => Promise<SessionInfo | undefined>) | undefined;
  contextImpl: ((sessionID: string) => Promise<readonly SessionMessageInfo[]>) | undefined;

  override get(sessionID: string): Promise<SessionInfo | undefined> {
    this.gets.push(sessionID);
    return this.getImpl?.(sessionID) ?? super.get(sessionID);
  }

  override context(sessionID: string): Promise<readonly SessionMessageInfo[]> {
    this.contextReads.push(sessionID);
    return this.contextImpl?.(sessionID) ?? super.context(sessionID);
  }
}

export class ContextModels implements ModelReader {
  readonly reads: string[] = [];
  readonly catalogs = new Map<string, readonly ContextModel[]>([["/work", [catalogModel()]]]);
  impl: ((directory: string) => Promise<readonly ContextModel[]>) | undefined;

  list(directory: string): Promise<readonly ContextModel[]> {
    this.reads.push(directory);
    return this.impl?.(directory) ?? Promise.resolve(this.catalogs.get(directory) ?? []);
  }
}

export class ContextWorld {
  readonly reader = new ContextReader([sessionInfo(SESSION)]);
  readonly models = new ContextModels();
  readonly logger = new RecordingLogger();
  readonly messenger = new RecordingMessenger();

  constructor(messages: readonly SessionMessageInfo[] = [measured(), current()]) {
    this.reader.contexts.set(SESSION, messages);
  }
}

export function toolContext(
  sessionID = SESSION,
  signal = new AbortController().signal,
  messageID = CURRENT,
): ToolContext {
  return {
    sessionID: Brand.nominal<ToolContext["sessionID"]>()(sessionID),
    agent: Brand.nominal<ToolContext["agent"]>()("explore"),
    messageID: Brand.nominal<ToolContext["messageID"]>()(messageID),
    id: CallID.make("call_context"),
    signal,
    progress: async () => {},
  };
}
