// The plugin's event loop: one subscription, kept alive across subscription failures, that records
// activity as each event arrives and feeds the run-state fold, the latch and the notices in order.

import type { Clock, Logger, OpenCodeEvent } from "@/core/ports";
import { errorMessage } from "@/tools/shared";

export const RESUBSCRIBE_MIN_MS = 500;
export const RESUBSCRIBE_MAX_MS = 30_000;

/**
 * The event types the ordered handlers act on. The rest of the subscription, streaming events
 * among them, only feeds activity, so it never queues behind the latch's storage I/O.
 */
export const CONTROL_EVENT_TYPES: ReadonlySet<OpenCodeEvent["type"]> = new Set<
  OpenCodeEvent["type"]
>([
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
]);

interface ResettableHandler {
  onEvent(event: OpenCodeEvent): void;
  reset(): void;
}

export interface EventHandlers {
  /** Sees every event as soon as it arrives, ahead of the ordered handlers. */
  readonly activity?: ResettableHandler;
  readonly runState: ResettableHandler;
  readonly latch:
    | {
        onEvent(event: OpenCodeEvent): Promise<void>;
        /** Forgets the run starts it handled, since the gap may have hidden some. */
        reset?(): void;
      }
    | undefined;
  /** Absent when prompt notices are off. */
  readonly notices?: ResettableHandler;
  /** Absent when stall notices are off. */
  readonly stall?: ResettableHandler;
  readonly logger: Logger;
  readonly clock: Clock;
  /** Runs after each resubscription, alongside consumption of the new subscription. */
  readonly afterGap?: () => Promise<void>;
}

/**
 * Feeds each event to the activity handler as soon as it arrives. Events of the control types then
 * go, strictly in order, to the run-state fold, to the latch when latching is on, and to the
 * notices that are on; the latch's storage I/O delays only those. A failing handler is logged and
 * the loop moves on. If the subscription ends or fails before `signal` aborts, it subscribes again
 * with a delay that doubles from 500 ms to 30 s and resets once a subscription delivers an event.
 * Activity is reset as soon as the subscription ends, and folded run state, the latch's handled run
 * starts and the notices' event-only state once the events before the gap are handled; `afterGap`
 * runs once the new subscription is open. The first subscription is opened synchronously when this
 * is called. Never rejects.
 */
export async function consume(
  subscribe: () => AsyncIterable<OpenCodeEvent>,
  handlers: EventHandlers,
  signal: AbortSignal,
): Promise<void> {
  const { activity, runState, notices, stall, logger, clock, afterGap } =
    handlers;
  let delay = RESUBSCRIBE_MIN_MS;
  let events = open(subscribe, logger);
  while (!signal.aborted) {
    let failure: unknown;
    let received = false;
    // Ordered handling runs on its own chain, so reading the next event never waits for it.
    let ordered: Promise<void> = Promise.resolve();
    try {
      for await (const event of events) {
        received = true;
        if (activity !== undefined) {
          guard(logger, "activity", event, () => activity.onEvent(event));
        }
        if (!CONTROL_EVENT_TYPES.has(event.type)) continue;
        ordered = ordered.then(() => handleInOrder(handlers, event));
      }
    } catch (error) {
      failure = error;
    }
    if (!signal.aborted) activity?.reset();
    await ordered;
    if (signal.aborted) return;
    // A subscription that delivered events was healthy, so the next gap starts at the short delay.
    if (received) delay = RESUBSCRIBE_MIN_MS;
    logger.warn(
      `event subscription ended; subscribing again in ${delay} ms`,
      failure === undefined ? undefined : { error: errorMessage(failure) },
    );
    runState.reset();
    handlers.latch?.reset?.();
    notices?.reset();
    stall?.reset();
    await clock.sleep(delay, signal);
    if (signal.aborted) return;
    delay = Math.min(delay * 2, RESUBSCRIBE_MAX_MS);
    events = open(subscribe, logger);
    if (afterGap !== undefined) {
      // The pass watches for execution events, so it runs alongside consumption, not before it.
      void afterGap().catch((error: unknown) => {
        logger.warn("startup pass after a gap failed", {
          error: errorMessage(error),
        });
      });
    }
  }
}

/** One event through the ordered handlers; separate guards, so one failure never skips another. */
async function handleInOrder(
  handlers: EventHandlers,
  event: OpenCodeEvent,
): Promise<void> {
  const { runState, latch, notices, stall, logger } = handlers;
  guard(logger, "run state", event, () => runState.onEvent(event));
  if (latch !== undefined) {
    try {
      await latch.onEvent(event);
    } catch (error) {
      logger.warn("latch: event handler failed", {
        type: event.type,
        error: errorMessage(error),
      });
    }
  }
  if (notices !== undefined) {
    guard(logger, "notices", event, () => notices.onEvent(event));
  }
  if (stall !== undefined) {
    guard(logger, "stall notices", event, () => stall.onEvent(event));
  }
}

function guard(
  logger: Logger,
  name: string,
  event: OpenCodeEvent,
  handle: () => void,
): void {
  try {
    handle();
  } catch (error) {
    logger.warn(`${name}: event handler failed`, {
      type: event.type,
      error: errorMessage(error),
    });
  }
}

/** Opens a subscription; a synchronous failure becomes an empty one, so the loop retries it. */
function open(
  subscribe: () => AsyncIterable<OpenCodeEvent>,
  logger: Logger,
): AsyncIterable<OpenCodeEvent> {
  try {
    return subscribe();
  } catch (error) {
    logger.warn("could not subscribe to events", {
      error: errorMessage(error),
    });
    return (async function* () {})();
  }
}
