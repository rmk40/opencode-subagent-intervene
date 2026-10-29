// The plugin's event loop: one ordered subscription feeding the run-state fold, the latch, and the
// prompt notices, kept alive across subscription failures.

import type { Clock, Logger, OpenCodeEvent } from "@/core/ports";
import { errorMessage } from "@/tools/shared";

export const RESUBSCRIBE_MIN_MS = 500;
export const RESUBSCRIBE_MAX_MS = 30_000;

export interface EventHandlers {
  readonly runState: {
    onEvent(event: OpenCodeEvent): void;
    reset(): void;
  };
  readonly latch: { onEvent(event: OpenCodeEvent): Promise<void> } | undefined;
  /** Absent when prompt notices are off. */
  readonly notices?: {
    onEvent(event: OpenCodeEvent): void;
    reset(): void;
  };
  readonly logger: Logger;
  readonly clock: Clock;
  /** Runs after each resubscription, alongside consumption of the new subscription. */
  readonly afterGap?: () => Promise<void>;
}

/**
 * Feeds every event, strictly in order, to the run-state fold, to the latch when latching is on,
 * and to the prompt notices when they are on. A failing handler is logged and the loop moves on to
 * the next event. If the subscription ends or fails before `signal` aborts, it subscribes again
 * with a delay that doubles from 500 ms to 30 s and resets once a subscription delivers an event.
 * Folded run state and the notices' event-only state are reset across the gap, and `afterGap` runs
 * once the new subscription is open. The first subscription is opened synchronously when this is
 * called. Never rejects.
 */
export async function consume(
  subscribe: () => AsyncIterable<OpenCodeEvent>,
  handlers: EventHandlers,
  signal: AbortSignal,
): Promise<void> {
  const { runState, latch, notices, logger, clock, afterGap } = handlers;
  let delay = RESUBSCRIBE_MIN_MS;
  let events = open(subscribe, logger);
  while (!signal.aborted) {
    let failure: unknown;
    let received = false;
    try {
      for await (const event of events) {
        received = true;
        // Separate handlers, so a failure in one never keeps the event from the other.
        try {
          runState.onEvent(event);
        } catch (error) {
          logger.warn("run state: event handler failed", {
            type: event.type,
            error: errorMessage(error),
          });
        }
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
          try {
            notices.onEvent(event);
          } catch (error) {
            logger.warn("notices: event handler failed", {
              type: event.type,
              error: errorMessage(error),
            });
          }
        }
      }
    } catch (error) {
      failure = error;
    }
    if (signal.aborted) return;
    // A subscription that delivered events was healthy, so the next gap starts at the short delay.
    if (received) delay = RESUBSCRIBE_MIN_MS;
    logger.warn(
      `event subscription ended; subscribing again in ${delay} ms`,
      failure === undefined ? undefined : { error: errorMessage(failure) },
    );
    runState.reset();
    notices?.reset();
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
