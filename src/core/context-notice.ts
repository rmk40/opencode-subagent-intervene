import { createHash } from "node:crypto";
import { COMPACT_TOOL_NAME } from "@/core/compaction";
import {
  DEFAULT_CONTEXT_WARNING_PERCENT,
  readContextUsage,
  renderAutoCompactionEstimate,
  renderMeasurement,
  type CompactionBuffer,
  type ContextUsage,
  type ContextUsageDeps,
} from "@/core/context-usage";
import { errorMessage } from "@/core/errors";
import type { Latch } from "@/core/latch";
import {
  PLUGIN_ID,
  type SessionMessageInfo,
  type SessionMessenger,
} from "@/core/ports";

export const CONTEXT_NOTICE_KIND = "context-warning";

export interface ContextNoticeDeps extends ContextUsageDeps {
  readonly messenger: SessionMessenger;
  readonly latch?: Pick<Latch, "isActive">;
}

export interface ContextNoticeOptions {
  readonly warningPercent?: number;
  readonly compactionBuffer?: CompactionBuffer;
}

export interface ContextToolCompletion {
  readonly sessionID: string;
  readonly messageID: string;
  readonly tool: string;
  readonly status: "completed" | "error";
}

export interface ContextWarningKey {
  readonly sessionID: string;
  readonly epoch: string;
  readonly providerID: string;
  readonly modelID: string;
  readonly threshold: number;
  readonly milestone: number;
}

export class ContextNotices {
  private readonly inFlight = new Map<string, Promise<void>>();
  private disposed = false;

  constructor(
    private readonly deps: ContextNoticeDeps,
    private readonly options: ContextNoticeOptions = {},
  ) {}

  /** Shares concurrent callbacks from one assistant step and never changes their tool results. */
  afterTool(event: ContextToolCompletion): Promise<void> {
    if (
      this.disposed || event.status !== "completed" || event.tool === COMPACT_TOOL_NAME
    ) return Promise.resolve();
    const key = JSON.stringify([event.sessionID, event.messageID]);
    const pending = this.inFlight.get(key);
    if (pending !== undefined) return pending;
    const evaluation = this.evaluate(event)
      .catch((error: unknown) => {
        this.deps.logger.warn("context: warning hook failed", {
          sessionID: event.sessionID,
          messageID: event.messageID,
          error: errorMessage(error),
        });
      })
      .finally(() => {
        if (this.inFlight.get(key) === evaluation) this.inFlight.delete(key);
      });
    this.inFlight.set(key, evaluation);
    return evaluation;
  }

  dispose(): void {
    this.disposed = true;
  }

  private async evaluate(event: ContextToolCompletion): Promise<void> {
    const threshold =
      this.options.warningPercent ?? DEFAULT_CONTEXT_WARNING_PERCENT;
    const { session, messages, usage } = await readContextUsage(this.deps, event, {
      warningPercent: threshold,
      compactionBuffer: this.options.compactionBuffer,
    });
    if (
      this.disposed || session.revert !== undefined ||
      usage.status !== "available" || usage.model === undefined
    ) return;
    const milestone = reachedMilestone(usage.reportedWindowPercent, threshold);
    if (milestone === undefined || usage.measurement === undefined) return;
    const key: ContextWarningKey = {
      sessionID: event.sessionID,
      epoch: usage.completedCompactionID ?? "initial",
      providerID: usage.model.providerID,
      modelID: usage.model.id,
      threshold,
      milestone,
    };
    if (highestDeliveredMilestone(messages, key) >= milestone) return;
    if (
      this.deps.latch !== undefined &&
      await this.deps.latch.isActive(event.sessionID)
    ) return;
    if (this.disposed) return;
    await this.deps.messenger.synthetic({
      sessionID: event.sessionID,
      id: contextWarningID(key),
      text: renderContextWarning(usage),
      description: `Context usage reached the ${milestone}% milestone`,
      metadata: {
        plugin: PLUGIN_ID,
        kind: CONTEXT_NOTICE_KIND,
        sessionID: key.sessionID,
        epoch: key.epoch,
        providerID: key.providerID,
        modelID: key.modelID,
        threshold: String(threshold),
        milestone: String(milestone),
        measurementID: usage.measurement.messageID,
      },
      delivery: "steer",
      resume: false,
    });
  }
}

/** Milestones rise by 10 below 80 and by 5 from 80. A jump emits only its highest milestone. */
export function reachedMilestone(
  percent: number | undefined,
  threshold: number,
): number | undefined {
  if (percent === undefined || !Number.isFinite(percent) || percent < threshold) {
    return undefined;
  }
  for (let milestone = 100; milestone >= 80; milestone -= 5) {
    if (milestone >= threshold && percent >= milestone) return milestone;
  }
  // Add integer offsets to the shortest decimal spelling before rounding to a number.
  // Thresholds are between 0 and 100, so exponent notation only has negative exponents.
  const [coefficient = "0", exponent] = String(threshold).split("e-");
  const [whole = "0", fraction = ""] = coefficient.split(".");
  const integer = exponent === undefined ? Number(whole) : 0;
  const decimals = exponent === undefined
    ? fraction
    : "0".repeat(Number(exponent) - 1) + coefficient.replace(".", "");
  for (let offset = 70; offset > 0; offset -= 10) {
    const milestone = Number(`${integer + offset}.${decimals}`);
    if (milestone < 80 && percent >= milestone) return milestone;
  }
  return threshold;
}

/** Uses a separate marker and key space from prompt notices and self-compaction admissions. */
export function contextWarningID(key: ContextWarningKey): string {
  const digest = createHash("sha256")
    .update(JSON.stringify([
      key.sessionID, key.epoch, key.providerID, key.modelID,
      key.threshold, key.milestone,
    ]))
    .digest("hex");
  return `msg_${PLUGIN_ID}_context_warning_${digest}`;
}

function highestDeliveredMilestone(
  messages: readonly SessionMessageInfo[],
  key: ContextWarningKey,
): number {
  let highest = 0;
  for (const message of messages) {
    if (message.type !== "synthetic") continue;
    const metadata = message.metadata;
    if (
      metadata?.plugin !== PLUGIN_ID ||
      metadata.kind !== CONTEXT_NOTICE_KIND ||
      metadata.sessionID !== key.sessionID || metadata.epoch !== key.epoch ||
      metadata.providerID !== key.providerID || metadata.modelID !== key.modelID ||
      metadata.threshold !== String(key.threshold) ||
      typeof metadata.milestone !== "string"
    ) continue;
    const milestone = Number(metadata.milestone);
    if (Number.isFinite(milestone) && milestone > highest && milestone <= 100) {
      highest = milestone;
    }
  }
  return highest;
}

export function renderContextWarning(usage: ContextUsage): string {
  const epoch = usage.completedCompactionID === undefined
    ? "initial context (no completed compaction)"
    : `after compaction ${usage.completedCompactionID}`;
  const model = usage.model === undefined
    ? "model unknown" : `${usage.model.providerID}/${usage.model.id}`;
  return [
    renderMeasurement(usage),
    ...renderAutoCompactionEstimate(usage),
    "Context planning update. " +
      "Continue while the next step and its expected output fit before the automatic-compaction point, leaving room for results not yet measured, and narrow large results when possible. " +
      "This notice alone is not a reason to compact.",
    `${model}, ${epoch}`,
    usage.measurementScope,
  ].join(" · ");
}
