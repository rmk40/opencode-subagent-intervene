// Subagent controls, self-context tools, durable notices and the parent-stop latch.

import { Plugin } from "@opencode/plugin";
import { ActivityTracker } from "@/core/activity";
import { ContextNotices } from "@/core/context-notice";
import {
  type CompactionBuffer,
  DEFAULT_CONTEXT_WARNING_PERCENT,
  isCompactionBuffer,
} from "@/core/context-usage";
import { DEFAULT_LATCH_TTL_MS, Latch } from "@/core/latch";
import { DEFAULT_NOTICE_DELAY_MS, PromptNotices } from "@/core/notices";
import { type Logger, type OpenCodeEvent, PLUGIN_ID } from "@/core/ports";
import { RunStateTracker } from "@/core/run-state";
import { renderStopNote } from "@/core/sanitize";
import { DEFAULT_STALL_NOTICE_MS, StallNotices } from "@/core/stall";
import { DEFAULT_SETTLE_MS } from "@/core/stop";
import { consume } from "@/events";
import { consoleLogger, createHost } from "@/host";
import { contextCompactTool } from "@/tools/context-compact";
import { contextNotesTool } from "@/tools/context-notes";
import { contextStatusTool } from "@/tools/context-status";
import { inspectTool } from "@/tools/inspect";
import { listTool } from "@/tools/list";
import { sendTool } from "@/tools/send";
import { errorMessage, NAMESPACE, NAMESPACE_DESCRIPTION } from "@/tools/shared";
import { stopTool } from "@/tools/stop";

const HOUR_MS = 60 * 60 * 1000;
const MINUTE_MS = 60 * 1000;
const SECOND_MS = 1000;
export const MAX_PROMPT_NOTICE_SECONDS = 3600;
export const MAX_STALL_NOTICE_MINUTES = 1440;

/**
 * Every event type the run-state fold, the latch, the notices or activity tracking handle. The
 * subscription asks for these only. The step, text, reasoning and tool-input events show that a
 * session is making progress; they feed activity tracking alone, so they never queue up ahead of
 * the others (see `CONTROL_EVENT_TYPES`).
 */
export const EVENT_TYPES = [
  "session.created",
  "session.deleted",
  "session.execution.started",
  "session.execution.succeeded",
  "session.execution.failed",
  "session.execution.interrupted",
  "session.inbox.enqueued",
  "session.inbox.delivery.changed",
  "session.skill.activated",
  "session.revert.cleared",
  "permission.asked",
  "permission.replied",
  "form.created",
  "form.replied",
  "form.cancelled",
  "session.tool.progress",
  "session.tool.success",
  "session.tool.failed",
  "session.step.started",
  "session.step.streamed",
  "session.step.ended",
  "session.step.failed",
  "session.text.started",
  "session.text.delta",
  "session.text.ended",
  "session.reasoning.started",
  "session.reasoning.delta",
  "session.reasoning.ended",
  "session.tool.input.started",
  "session.tool.input.delta",
  "session.tool.input.ended",
  "session.tool.called",
  "session.retry.scheduled",
] as const satisfies ReadonlyArray<OpenCodeEvent["type"]>;

export interface Settings {
  /** Ask for the `subagent_stop` permission before stopping. */
  readonly confirmStop: boolean;
  /** Keep stopped sessions stopped. `false` makes a stop a plain subtree interrupt. */
  readonly latch: boolean;
  /** When a latch expires on its own. */
  readonly latchTtlHours: number;
  /** Prepend the stop note to the prompt that continues a stopped child. */
  readonly notifyChild: boolean;
  /** Settlement wait per round inside `subagent_stop`. */
  readonly settleMs: number;
  /** Tell a parent when its subagent waits on a permission prompt or a question. */
  readonly promptNotices: boolean;
  /** How long a prompt stays open before the parent is told; 0 tells it right away. */
  readonly promptNoticeSeconds: number;
  /** How long a running subagent shows no progress before its parent is told; 0 turns that off. */
  readonly stallNoticeMinutes: number;
  /** Admit durable context notices after successful local tools. */
  readonly contextNotices: boolean;
  /** Make the self-scoped compaction tool available. */
  readonly selfCompaction: boolean;
  /** Starting percentage of the current usable input window for context notices. */
  readonly contextWarningPercent: number;
  /**
   * Mirrors OpenCode's `compaction.buffer`, which plugins cannot read, for the automatic-compaction
   * estimate. Unset assumes OpenCode's default buffer.
   */
  readonly compactionBuffer?: CompactionBuffer;
}

export const DEFAULT_SETTINGS: Settings = {
  confirmStop: false,
  latch: true,
  latchTtlHours: DEFAULT_LATCH_TTL_MS / HOUR_MS,
  notifyChild: true,
  settleMs: DEFAULT_SETTLE_MS,
  promptNotices: true,
  promptNoticeSeconds: DEFAULT_NOTICE_DELAY_MS / SECOND_MS,
  stallNoticeMinutes: DEFAULT_STALL_NOTICE_MS / MINUTE_MS,
  contextNotices: true,
  selfCompaction: true,
  contextWarningPercent: DEFAULT_CONTEXT_WARNING_PERCENT,
};

/** Reads plugin options over the defaults. Invalid values and unknown keys are ignored with a warning. */
export function parseOptions(
  options: Readonly<Record<string, unknown>>,
  logger: Logger,
): Settings {
  let {
    confirmStop,
    latch,
    latchTtlHours,
    notifyChild,
    settleMs,
    promptNotices,
    promptNoticeSeconds,
    stallNoticeMinutes,
    contextNotices,
    selfCompaction,
    contextWarningPercent,
    compactionBuffer,
  } = DEFAULT_SETTINGS;
  const ignore = (option: string, value: unknown, expected: string) =>
    logger.warn(`ignoring option ${option}: expected ${expected}`, {
      value: String(value),
    });
  for (const [option, value] of Object.entries(options)) {
    switch (option) {
      case "confirmStop":
        if (typeof value === "boolean") confirmStop = value;
        else ignore(option, value, "a boolean");
        break;
      case "latch":
        if (typeof value === "boolean") latch = value;
        else ignore(option, value, "a boolean");
        break;
      case "notifyChild":
        if (typeof value === "boolean") notifyChild = value;
        else ignore(option, value, "a boolean");
        break;
      case "latchTtlHours":
        if (isFiniteNumber(value) && value > 0) latchTtlHours = value;
        else ignore(option, value, "a positive number");
        break;
      case "settleMs":
        if (isFiniteNumber(value) && value >= 0) settleMs = value;
        else ignore(option, value, "a number of milliseconds, 0 or more");
        break;
      case "promptNotices":
        if (typeof value === "boolean") promptNotices = value;
        else ignore(option, value, "a boolean");
        break;
      case "promptNoticeSeconds":
        if (
          isFiniteNumber(value) &&
          value >= 0 &&
          value <= MAX_PROMPT_NOTICE_SECONDS
        ) {
          promptNoticeSeconds = value;
        } else {
          ignore(
            option,
            value,
            `a number of seconds from 0 to ${MAX_PROMPT_NOTICE_SECONDS}`,
          );
        }
        break;
      case "stallNoticeMinutes":
        if (
          isFiniteNumber(value) &&
          value >= 0 &&
          value <= MAX_STALL_NOTICE_MINUTES
        ) {
          stallNoticeMinutes = value;
        } else {
          ignore(
            option,
            value,
            `a number of minutes from 0 to ${MAX_STALL_NOTICE_MINUTES}`,
          );
        }
        break;
      case "contextNotices":
        if (typeof value === "boolean") contextNotices = value;
        else ignore(option, value, "a boolean");
        break;
      case "selfCompaction":
        if (typeof value === "boolean") selfCompaction = value;
        else ignore(option, value, "a boolean");
        break;
      case "contextWarningPercent":
        if (isFiniteNumber(value) && value > 0 && value < 100) {
          contextWarningPercent = value;
        } else {
          ignore(option, value, "a finite number greater than 0 and less than 100");
        }
        break;
      case "compactionBuffer":
        if (isCompactionBuffer(value)) {
          compactionBuffer = value;
        } else {
          ignore(
            option,
            value,
            'a percentage string from "1%" to below "100%", such as "10%" or "12.5%", or a whole number of tokens, 0 or more',
          );
        }
        break;
      default:
        logger.warn(`ignoring unknown option ${option}`);
    }
  }
  return {
    confirmStop,
    latch,
    latchTtlHours,
    notifyChild,
    settleMs,
    promptNotices,
    promptNoticeSeconds,
    stallNoticeMinutes,
    contextNotices,
    selfCompaction,
    contextWarningPercent,
    ...(compactionBuffer === undefined ? {} : { compactionBuffer }),
  };
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

export default Plugin.define({
  id: PLUGIN_ID,
  async setup(ctx) {
    const logger = consoleLogger();
    const settings = parseOptions(ctx.options, logger);
    const host = createHost(ctx, logger);
    const activity = new ActivityTracker();
    const runState = new RunStateTracker(
      {
        control: host.control,
        clock: host.clock,
        activity,
        reader: host.reader,
      },
      { reconcile: host.waitAvailable },
    );
    const latch = new Latch(
      {
        store: host.store,
        control: host.control,
        clock: host.clock,
        logger,
        renderNote: renderStopNote,
        reader: host.reader,
        scheduler: host.scheduler,
      },
      { ttlMs: settings.latchTtlHours * HOUR_MS },
    );
    const notices = settings.promptNotices
      ? new PromptNotices(
          {
            reader: host.reader,
            permissions: host.permissions,
            messenger: host.messenger,
            ...(settings.latch ? { latch } : {}),
            scheduler: host.scheduler,
            clock: host.clock,
            logger,
          },
          { delayMs: settings.promptNoticeSeconds * SECOND_MS },
        )
      : undefined;
    // A stall notice must confirm the session's state with `session.wait` before it is posted.
    const stallNotices =
      settings.stallNoticeMinutes > 0 && host.waitAvailable
        ? new StallNotices(
            {
              activity,
              runState,
              reader: host.reader,
              messenger: host.messenger,
              ...(settings.latch ? { latch } : {}),
              scheduler: host.scheduler,
              clock: host.clock,
              logger,
            },
            { thresholdMs: settings.stallNoticeMinutes * MINUTE_MS },
          )
        : undefined;
    const contextNotices = settings.contextNotices
      ? new ContextNotices(
          {
            reader: host.reader,
            models: host.models,
            messenger: host.messenger,
            ...(settings.latch ? { latch } : {}),
            logger,
          },
          {
            warningPercent: settings.contextWarningPercent,
            compactionBuffer: settings.compactionBuffer,
          },
        )
      : undefined;

    // An unknown state counts as running, so a failed probe exempts a run instead of interrupting
    // work the instance may have missed being admitted.
    const startupPass = () =>
      latch.startup(
        async (sessionID) =>
          (await runState.observe(sessionID)).state !== "idle",
      );

    // Consumption starts first, so the bus subscription is requested before the startup pass reads
    // storage. Events are consumed while the pass runs, so it can tell a run this instance saw
    // start from one already in progress when it loaded.
    const subscription = new AbortController();
    const consuming = consume(
      () =>
        ctx.event.subscribe({
          types: EVENT_TYPES,
          signal: subscription.signal,
        }),
      {
        activity,
        runState,
        latch: settings.latch ? latch : undefined,
        ...(notices === undefined ? {} : { notices }),
        ...(stallNotices === undefined ? {} : { stall: stallNotices }),
        logger,
        clock: host.clock,
        // Events missed during the gap may have started or ended runs, so the startup pass runs
        // again, the same as when the instance loads.
        ...(settings.latch ? { afterGap: startupPass } : {}),
      },
      subscription.signal,
    );

    const registrations: Array<{ readonly dispose: () => Promise<void> }> = [];
    try {
      if (settings.latch) {
        await startupPass();
        registrations.push(
          await ctx.session.hook("prompt", async (event) => {
            // A rejected prompt hook fails the user's prompt, so this hook never rejects.
            try {
              const note = await latch.onPrompt(
                event.sessionID,
                host.clock.now(),
              );
              if (note !== undefined) {
                event.prompt.text = `${note}${event.prompt.text}`;
              }
            } catch (error) {
              logger.warn("prompt hook failed; prompt left unchanged", {
                sessionID: event.sessionID,
                error: errorMessage(error),
              });
            }
          }),
        );
        // OpenCode runs this hook inside a run's step, before each primary model request, and only
        // in the copy for the session's location. A woken run of a stopped session is held here
        // until the latch has interrupted it. Session hooks have no failure channel, so a rejection
        // would fail the run; this hook never rejects.
        registrations.push(
          await ctx.session.hook("context", async (event) => {
            try {
              await latch.beforeRequest(event.sessionID);
            } catch (error) {
              logger.warn("context hook failed; the request was left alone", {
                sessionID: event.sessionID,
                error: errorMessage(error),
              });
            }
          }),
        );
      }
      registrations.push(
        await ctx.tool.transform((editor) => {
          editor.add(
            contextStatusTool(
              { reader: host.reader, models: host.models, logger },
              {
                warningPercent: settings.contextWarningPercent,
                warningsEnabled: settings.contextNotices,
                compactionBuffer: settings.compactionBuffer,
              },
            ),
          );
          editor.add(
            contextNotesTool({
              instructions: host.instructions,
              clock: host.clock,
            }),
          );
          if (settings.selfCompaction) {
            editor.add(
              contextCompactTool({
                compactor: host.compactor,
                messenger: host.messenger,
              }),
            );
          }
          editor.namespace({
            name: NAMESPACE,
            description: NAMESPACE_DESCRIPTION,
          });
          editor.add(
            stopTool(
              {
                reader: host.reader,
                control: host.control,
                latch,
                runState,
                clock: host.clock,
                logger,
              },
              {
                latch: settings.latch,
                notifyChild: settings.notifyChild,
                settleMs: settings.settleMs,
                ...(settings.confirmStop ? { confirm: host.assertStop } : {}),
              },
            ),
          );
          editor.add(
            sendTool(
              {
                reader: host.reader,
                messenger: host.messenger,
                latch,
                runState,
                clock: host.clock,
                activity,
                logger,
              },
              { latch: settings.latch },
            ),
          );
          editor.add(
            listTool(
              {
                reader: host.reader,
                latch,
                runState,
                clock: host.clock,
                activity,
                logger,
              },
              { latch: settings.latch },
            ),
          );
          editor.add(
            inspectTool(
              {
                reader: host.reader,
                latch,
                runState,
                clock: host.clock,
                activity,
                logger,
              },
              { latch: settings.latch },
            ),
          );
        }),
      );
      if (contextNotices !== undefined) {
        registrations.push(
          await ctx.tool.hook("execute.after", (event) =>
            contextNotices.afterTool(event),
          ),
        );
      }
      stallNotices?.start();
    } catch (error) {
      subscription.abort();
      latch.dispose();
      notices?.dispose();
      stallNotices?.dispose();
      contextNotices?.dispose();
      await disposeAll(registrations, logger);
      throw error;
    }

    return async () => {
      subscription.abort();
      latch.dispose();
      notices?.dispose();
      stallNotices?.dispose();
      contextNotices?.dispose();
      await disposeAll(registrations, logger);
      await consuming;
    };
  },
});

async function disposeAll(
  registrations: ReadonlyArray<{ readonly dispose: () => Promise<void> }>,
  logger: Logger,
): Promise<void> {
  const results = await Promise.allSettled(
    registrations.map((registration) => registration.dispose()),
  );
  for (const result of results) {
    if (result.status === "rejected") {
      logger.warn("could not dispose a registration", {
        error: errorMessage(result.reason),
      });
    }
  }
}
