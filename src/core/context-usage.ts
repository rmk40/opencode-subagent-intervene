import { errorMessage } from "@/core/errors";
import type {
  ContextModel,
  Logger,
  ModelReader,
  SessionID,
  SessionInfo,
  SessionMessageInfo,
  SessionReader,
} from "@/core/ports";
import { sinceCompaction } from "@/core/summarize";

export const DEFAULT_CONTEXT_WARNING_PERCENT = 50;
export const MEASUREMENT_SCOPE =
  "Later messages and pending tool or subagent results are not included in this measurement.";
const COMPACTION_BUFFER_HINT =
  "if compaction.buffer is set in OpenCode, set the plugin's compactionBuffer option to match";

/**
 * OpenCode's `compaction.buffer`, the room kept free below the window before automatic compaction:
 * a share of the window from "1%" to under "100%", or a token count.
 */
export type CompactionBuffer = string | number;

/** The pattern OpenCode's config schema accepts for a percentage buffer. */
const COMPACTION_BUFFER_PERCENT = /^([1-9]\d?(\.\d+)?)%$/u;

/** Accepts the same forms as OpenCode's `compaction.buffer`: a percentage string or a non-negative integer. */
export function isCompactionBuffer(value: unknown): value is CompactionBuffer {
  return typeof value === "string"
    ? COMPACTION_BUFFER_PERCENT.test(value)
    : typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

type Assistant = Extract<SessionMessageInfo, { type: "assistant" }>;
type Model = Assistant["model"];
type Compaction = Extract<SessionMessageInfo, { type: "compaction" }>;

export interface ContextMeasurement {
  readonly messageID: string;
  readonly measuredAt?: number;
  readonly model: Model;
  readonly tokens: NonNullable<Assistant["tokens"]>;
  readonly reportedTokens: number;
}

export interface ContextUsage {
  readonly sessionID: SessionID;
  readonly model?: Model;
  readonly limits: {
    readonly context?: number;
    readonly input?: number;
    readonly output?: number;
  };
  readonly usableInputWindow?: number;
  readonly status:
    | "available"
    | "missing"
    | "awaiting-post-compaction"
    | "different-model"
    | "model-unknown"
    | "revert-boundary-unavailable";
  readonly measurement?: ContextMeasurement;
  readonly reportedContextPercent?: number;
  readonly reportedWindowPercent?: number;
  /** Usable input window minus reported tokens; negative when the measurement overruns it. */
  readonly inputHeadroomTokens?: number;
  /** Automatic-compaction estimate minus reported tokens; negative once past it. */
  readonly autoCompactionHeadroomTokens?: number;
  readonly completedCompactionID?: string;
  readonly latestCompaction?: {
    readonly id: string;
    readonly status: Compaction["status"];
    readonly failureMessage?: string;
  };
  readonly historyBoundary: "active" | "before-revert" | "revert-marker-missing";
  readonly revertMessageID?: string;
  /**
   * Where OpenCode starts automatic compaction in the usable window, assuming it is on. `configured`
   * comes from the plugin's `compactionBuffer` option; `default` assumes OpenCode's default buffer.
   * `configured-ignored`: the configured buffer leaves no room in this window, so OpenCode ignores
   * it and the estimate uses the default buffer.
   */
  readonly autoCompactionEstimate?: {
    readonly tokens: number;
    readonly percent: number;
    readonly source: "configured" | "configured-ignored" | "default";
  };
  readonly contextWarningPercent: number;
  readonly measurementScope: string;
}

export interface ContextUsageOptions {
  readonly warningPercent?: number;
  readonly compactionBuffer?: CompactionBuffer;
}

export interface ContextUsageDeps {
  readonly reader: Pick<SessionReader, "get" | "context">;
  readonly models: ModelReader;
  readonly logger: Logger;
}

export interface ContextUsageInput extends ContextUsageOptions {
  readonly sessionID: SessionID;
  readonly messageID: string;
  readonly messages: readonly SessionMessageInfo[];
  readonly models: readonly ContextModel[];
  readonly revert?: SessionInfo["revert"];
}

/** Reads the caller's history and the catalog for its own directory without caching either. */
export async function readContextUsage(
  deps: ContextUsageDeps,
  call: { readonly sessionID: SessionID; readonly messageID: string },
  options: ContextUsageOptions = {},
): Promise<{
  readonly session: SessionInfo;
  readonly messages: readonly SessionMessageInfo[];
  readonly usage: ContextUsage;
}> {
  const [session, messages] = await Promise.all([
    deps.reader.get(call.sessionID),
    deps.reader.context(call.sessionID),
  ]);
  if (session === undefined) {
    throw new Error(`Session ${call.sessionID} is unavailable.`);
  }
  let models: readonly ContextModel[] = [];
  try {
    models = await deps.models.list(session.location.directory);
  } catch (error) {
    deps.logger.warn("context: could not read model limits", {
      sessionID: call.sessionID,
      error: errorMessage(error),
    });
  }
  return {
    session,
    messages,
    usage: selectContextUsage({
      ...call, messages, models, revert: session.revert, ...options,
    }),
  };
}

/** Selects one completed response measurement, never a sum or compaction-request usage. */
export function selectContextUsage(input: ContextUsageInput): ContextUsage {
  const boundary = activeHistory(input.messages, input.revert);
  const caller = boundary.messages.find(
    (message): message is Assistant =>
      message.id === input.messageID && message.type === "assistant",
  );
  const model = caller?.model;
  const catalogModel = model === undefined
    ? undefined
    : input.models.find(
        (entry) => entry.providerID === model.providerID && entry.id === model.id,
      );
  const context = positiveLimit(catalogModel?.limit.context);
  const inputLimit = positiveLimit(catalogModel?.limit.input);
  const output = positiveLimit(catalogModel?.limit.output);
  const usableInputWindow = context === undefined
    ? inputLimit
    : inputLimit === undefined ? context : Math.min(context, inputLimit);
  const autoEstimate = autoCompactionEstimate(usableInputWindow, input.compactionBuffer);
  const { compaction, assistants } = sinceCompaction(boundary.messages);
  const latestCompaction = boundary.messages.findLast(
    (message): message is Compaction => message.type === "compaction",
  );
  // A finish reason is also persisted at step settlement and can survive without a timestamp.
  const measured = assistants.findLast(
    (message) =>
      message.id !== input.messageID &&
      message.error === undefined && message.finish !== "error" &&
      (message.time.completed !== undefined || message.finish !== undefined) &&
      hasUsage(message.tokens),
  );
  const measurement = measured?.tokens === undefined
    ? undefined
    : {
        messageID: measured.id,
        ...(measured.time.completed === undefined
          ? {} : { measuredAt: measured.time.completed }),
        model: measured.model,
        tokens: measured.tokens,
        reportedTokens:
          measured.tokens.input + measured.tokens.output + measured.tokens.reasoning +
          measured.tokens.cache.read + measured.tokens.cache.write,
      };
  const status: ContextUsage["status"] = boundary.status === "revert-marker-missing"
    ? "revert-boundary-unavailable"
    : measurement === undefined
      ? compaction === undefined ? "missing" : "awaiting-post-compaction"
      : model === undefined
        ? "model-unknown"
        : measurement.model.providerID !== model.providerID || measurement.model.id !== model.id
          ? "different-model" : "available";
  // Headroom is only meaningful for a current-model measurement against a known window.
  const current = status === "available" && usableInputWindow !== undefined
    ? measurement : undefined;
  return {
    sessionID: input.sessionID,
    ...(model === undefined ? {} : { model }),
    limits: {
      ...(context === undefined ? {} : { context }),
      ...(inputLimit === undefined ? {} : { input: inputLimit }),
      ...(output === undefined ? {} : { output }),
    },
    ...(usableInputWindow === undefined ? {} : { usableInputWindow }),
    status,
    ...(measurement === undefined ? {} : { measurement }),
    ...(status === "available" && measurement !== undefined && context !== undefined
      ? { reportedContextPercent: measurement.reportedTokens / context * 100 }
      : {}),
    ...(status === "available" && measurement !== undefined && usableInputWindow !== undefined
      ? { reportedWindowPercent: measurement.reportedTokens / usableInputWindow * 100 }
      : {}),
    ...(current === undefined || usableInputWindow === undefined
      ? {} : { inputHeadroomTokens: usableInputWindow - current.reportedTokens }),
    ...(current === undefined || autoEstimate === undefined
      ? {}
      : { autoCompactionHeadroomTokens: autoEstimate.tokens - current.reportedTokens }),
    ...(compaction === undefined ? {} : { completedCompactionID: compaction.id }),
    ...(latestCompaction === undefined
      ? {}
      : {
          latestCompaction: {
            id: latestCompaction.id,
            status: latestCompaction.status,
            ...(latestCompaction.status === "failed"
              ? { failureMessage: latestCompaction.error.message } : {}),
          },
        }),
    historyBoundary: boundary.status,
    ...(input.revert === undefined ? {} : { revertMessageID: input.revert.messageID }),
    ...(autoEstimate === undefined ? {} : { autoCompactionEstimate: autoEstimate }),
    contextWarningPercent: input.warningPercent ?? DEFAULT_CONTEXT_WARNING_PERCENT,
    measurementScope: MEASUREMENT_SCOPE,
  };
}

function activeHistory(
  messages: readonly SessionMessageInfo[],
  revert: SessionInfo["revert"],
): {
  readonly messages: readonly SessionMessageInfo[];
  readonly status: ContextUsage["historyBoundary"];
} {
  if (revert === undefined) return { messages, status: "active" };
  const index = messages.findIndex((message) => message.id === revert.messageID);
  // A missing marker cannot prove that the returned measurements precede the staged revert.
  if (index === -1) return { messages: [], status: "revert-marker-missing" };
  return { messages: messages.slice(0, index), status: "before-revert" };
}

function positiveLimit(value: number | undefined): number | undefined {
  return value !== undefined && Number.isFinite(value) && value > 0
    ? value : undefined;
}

/**
 * Mirrors OpenCode's trigger. A configured buffer is kept free as given, with no minimum, and one
 * that leaves no room is ignored for that window. The default keeps 15% free, or 16k when that is
 * more on windows of at least 32k.
 */
function autoCompactionEstimate(
  window: number | undefined,
  buffer: CompactionBuffer | undefined,
): ContextUsage["autoCompactionEstimate"] {
  if (window === undefined) return undefined;
  const reserved = typeof buffer === "string"
    ? Math.round(window * Number.parseFloat(buffer) / 100)
    : buffer;
  const fits = reserved !== undefined && reserved < window;
  const tokens = fits
    ? window - reserved
    : window - Math.max(Math.floor(window * 0.15), window >= 32_000 ? 16_000 : 0);
  return {
    tokens,
    percent: tokens / window * 100,
    source: buffer === undefined ? "default" : fits ? "configured" : "configured-ignored",
  };
}

const ESTIMATE_LABELS: Readonly<
  Record<NonNullable<ContextUsage["autoCompactionEstimate"]>["source"], string>
> = {
  configured: "configured auto",
  "configured-ignored": "configured buffer ignored, default auto",
  default: "assumed default auto",
};

function hasUsage(tokens: Assistant["tokens"]): boolean {
  if (tokens === undefined) return false;
  return (
    [tokens.input, tokens.output, tokens.reasoning, tokens.cache.read, tokens.cache.write]
      .every((value) => Number.isFinite(value) && value >= 0) &&
    tokens.input + tokens.cache.read + tokens.cache.write > 0
  );
}

/** Shared measurement wording for the direct tool and durable notices. */
export function renderMeasurement(usage: ContextUsage): string {
  const measurement = usage.measurement;
  if (measurement === undefined) {
    const window = usage.usableInputWindow === undefined
      ? "input window unknown" : `input window ${formatTokens(usage.usableInputWindow)}`;
    const model = usage.model === undefined ? " · current model unknown" : "";
    if (usage.status === "revert-boundary-unavailable") {
      return "Usage unavailable · staged-revert boundary missing";
    }
    if (usage.status === "awaiting-post-compaction") {
      return `Awaiting post-compaction measurement · ${window}${model}`;
    }
    return `No completed response measurement · ${window}${model}`;
  }
  const count = formatTokens(measurement.reportedTokens);
  const measuredAt = measurement.measuredAt === undefined
    ? "measurement time unavailable"
    : `measured ${new Date(measurement.measuredAt).toISOString().replace(/\.\d{3}Z$/, "Z")}`;
  if (usage.status === "different-model") {
    return `${count} historical (${measurement.model.providerID}/${measurement.model.id}) · current-model usage unavailable · ${measuredAt}`;
  }
  if (usage.status === "model-unknown") {
    return `${count} reported · current model unknown · ${measuredAt}`;
  }
  if (
    usage.reportedWindowPercent !== undefined && usage.usableInputWindow !== undefined
  ) {
    const contextUsage =
      usage.reportedContextPercent !== undefined && usage.limits.context !== undefined &&
      usage.limits.context !== usage.usableInputWindow
        ? ` · UI/context ${Number(usage.reportedContextPercent.toFixed(2))}% of ${formatTokens(usage.limits.context)}`
        : "";
    const headroom = usage.inputHeadroomTokens === undefined
      ? ""
      : usage.inputHeadroomTokens < 0
        ? ` · ${formatTokens(-usage.inputHeadroomTokens)} over input window`
        : ` · ${formatTokens(usage.inputHeadroomTokens)} remaining`;
    return `${count} / ${formatTokens(usage.usableInputWindow)} input (${Number(usage.reportedWindowPercent.toFixed(2))}%)${headroom}${contextUsage} · ${measuredAt}`;
  }
  return `${count} reported · input window unknown · ${measuredAt}`;
}

function formatTokens(tokens: number): string {
  if (tokens >= 1_000_000) return `${Number((tokens / 1_000_000).toFixed(2))}M`;
  if (tokens >= 1000) {
    const thousands = Number((tokens / 1000).toFixed(1));
    return thousands >= 1000 ? "1M" : `${thousands}k`;
  }
  return String(tokens);
}

/** Distance appears only with a current-model measurement; the estimate alone does not need one. */
export function renderAutoCompactionEstimate(usage: ContextUsage): readonly string[] {
  const estimate = usage.autoCompactionEstimate;
  if (estimate === undefined) return [];
  const label = `${ESTIMATE_LABELS[estimate.source]} ~${formatTokens(estimate.tokens)}`;
  const headroom = usage.autoCompactionHeadroomTokens;
  if (headroom === undefined) return [label];
  return [
    headroom < 0
      ? `${label} (${formatTokens(-headroom)} past estimate)`
      : `${label} (${formatTokens(headroom)} away)`,
  ];
}

export function renderContextUsage(
  usage: ContextUsage,
  warningsEnabled = true,
): string {
  const compaction = usage.latestCompaction;
  return [
    renderMeasurement(usage),
    warningsEnabled ? `notices from ${usage.contextWarningPercent}%` : "notices disabled",
    ...renderAutoCompactionEstimate(usage),
    ...(usage.autoCompactionEstimate?.source === "default" ? [COMPACTION_BUFFER_HINT] : []),
    compaction === undefined
      ? "no visible compaction"
      : `last compaction ${compaction.status}${compaction.failureMessage === undefined ? "" : ` (${compaction.failureMessage.replace(/\s+/g, " ").trim()})`}`,
    ...(usage.historyBoundary === "before-revert"
      ? [`history before staged revert ${usage.revertMessageID}`]
      : []),
  ].join(" · ");
}
