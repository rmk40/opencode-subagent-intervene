// Entry point of the `subagent-intervene` server plugin: subagent_stop, subagent_send,
// subagents.list, and subagents.inspect, plus the stop latch that keeps stopped subagents stopped
// and the notices that tell a parent its subagent is waiting on a person.

import { Plugin } from "@opencode/plugin";
import { DEFAULT_LATCH_TTL_MS, Latch } from "@/core/latch";
import { DEFAULT_NOTICE_DELAY_MS, PromptNotices } from "@/core/notices";
import { type Logger, type OpenCodeEvent, PLUGIN_ID } from "@/core/ports";
import { RunStateTracker } from "@/core/run-state";
import { renderStopNote } from "@/core/sanitize";
import { DEFAULT_SETTLE_MS } from "@/core/stop";
import { consume } from "@/events";
import { consoleLogger, createHost } from "@/host";
import { inspectTool } from "@/tools/inspect";
import { listTool } from "@/tools/list";
import { sendTool } from "@/tools/send";
import { errorMessage, NAMESPACE, NAMESPACE_DESCRIPTION } from "@/tools/shared";
import { stopTool } from "@/tools/stop";

const HOUR_MS = 60 * 60 * 1000;
const SECOND_MS = 1000;
export const MAX_PROMPT_NOTICE_SECONDS = 3600;

/**
 * Every event type the run-state fold, the latch, or the prompt notices handle. The subscription
 * asks for these only, so streaming events from busy sessions never queue up ahead of them.
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
}

export const DEFAULT_SETTINGS: Settings = {
  confirmStop: false,
  latch: true,
  latchTtlHours: DEFAULT_LATCH_TTL_MS / HOUR_MS,
  notifyChild: true,
  settleMs: DEFAULT_SETTLE_MS,
  promptNotices: true,
  promptNoticeSeconds: DEFAULT_NOTICE_DELAY_MS / SECOND_MS,
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
    const runState = new RunStateTracker({
      control: host.control,
      clock: host.clock,
    });
    const latch = new Latch(
      {
        store: host.store,
        control: host.control,
        clock: host.clock,
        logger,
        renderNote: renderStopNote,
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
        runState,
        latch: settings.latch ? latch : undefined,
        ...(notices === undefined ? {} : { notices }),
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
      }
      registrations.push(
        await ctx.tool.transform((editor) => {
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
                logger,
              },
              { latch: settings.latch },
            ),
          );
          editor.add(
            listTool(
              { reader: host.reader, latch, runState, logger },
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
                logger,
              },
              { latch: settings.latch },
            ),
          );
        }),
      );
    } catch (error) {
      subscription.abort();
      notices?.dispose();
      await disposeAll(registrations, logger);
      throw error;
    }

    return async () => {
      subscription.abort();
      notices?.dispose();
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
