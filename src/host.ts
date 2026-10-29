// Adapters from the plugin context to the ports the core modules use. Plugin domain methods ignore
// abort signals, so nothing here takes one, and the one call that can stay pending indefinitely,
// `session.wait`, is shared per session instead of repeated.

import type { Plugin } from "@opencode/plugin";
import {
  type Clock,
  type Json,
  type Logger,
  type PermissionReader,
  PLUGIN_ID,
  type Scheduler,
  type SessionControl,
  type SessionID,
  type SessionMessenger,
  type SessionReader,
  type Store,
} from "@/core/ports";
import type { StopPermissionRequest } from "@/tools/stop";

/** Children per `session.list` page. */
export const LIST_PAGE_SIZE = 100;
/** Entries per storage scan page; the host caps a page at 1000. */
export const SCAN_PAGE_SIZE = 1000;
/** Permission action checked before a stop when `confirmStop` is on. */
export const STOP_PERMISSION = "subagent_stop";

export interface Host {
  readonly reader: SessionReader;
  readonly control: SessionControl;
  readonly permissions: PermissionReader;
  readonly messenger: SessionMessenger;
  readonly store: Store;
  readonly clock: Clock;
  readonly scheduler: Scheduler;
  readonly logger: Logger;
  /**
   * Asks for the `subagent_stop` permission on one root agent. Resolves when allowed; a deny rule
   * or a refusal rejects, and the rejection must propagate out of the tool.
   */
  readonly assertStop: (request: StopPermissionRequest) => Promise<void>;
}

export function createHost(ctx: Plugin.Context, logger: Logger): Host {
  return {
    reader: sessionReader(ctx),
    control: sessionControl(ctx),
    permissions: {
      async pendingRequestIDs(sessionID) {
        const requests = await ctx.permission.list({ sessionID });
        return requests.map((request) => request.id);
      },
    },
    messenger: sessionMessenger(ctx),
    store: pluginStore(ctx),
    clock: systemClock,
    scheduler: unrefScheduler,
    logger,
    assertStop: (request) =>
      ctx.permission.assert({
        action: STOP_PERMISSION,
        resources: [request.rootAgent],
        save: [request.rootAgent],
        sessionID: request.sessionID,
        agent: request.agent,
        source: {
          type: "tool",
          messageID: request.messageID,
          id: request.callID,
        },
      }),
  };
}

function sessionReader(ctx: Plugin.Context): SessionReader {
  return {
    async get(sessionID) {
      try {
        return await ctx.session.get({ sessionID });
      } catch (error) {
        if (isMissingSession(error)) return undefined;
        throw error;
      }
    },
    async children(parentID, cursor, order = "asc") {
      // Core pages by `time.updated` with a keyset cursor that keeps the order. In ascending order,
      // a child that is updated while the walk is paging moves past the cursor and appears on a
      // later page, so it can be listed twice (callers drop repeats) but never skipped, which
      // descending order allows.
      const page = await ctx.session.list({
        parentID,
        order,
        limit: LIST_PAGE_SIZE,
        ...(cursor === undefined ? {} : { cursor }),
      });
      // Core returns a `next` cursor for every non-empty page; a short page is the last one, so
      // stopping there saves a request that would come back empty.
      const next =
        page.data.length < LIST_PAGE_SIZE
          ? undefined
          : (page.cursor.next ?? undefined);
      return next === undefined
        ? { data: page.data }
        : { data: page.data, next };
    },
    context: (sessionID) => ctx.session.context({ sessionID }),
    async pendingPermissions(sessionID) {
      const requests = await ctx.permission.list({ sessionID });
      return requests.map((request) => request.action);
    },
  };
}

/**
 * The Promise adapter rejects with the host's typed failure itself. A missing session fails with
 * `Session.NotFoundError`; an ID that is not shaped like a session ID fails input decoding with a
 * `SchemaError` before any lookup. Neither can name one of the caller's sessions.
 */
const MISSING_SESSION_TAGS: ReadonlySet<string> = new Set([
  "Session.NotFoundError",
  "SchemaError",
]);

function isMissingSession(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "_tag" in error &&
    typeof error._tag === "string" &&
    MISSING_SESSION_TAGS.has(error._tag)
  );
}

function sessionControl(ctx: Plugin.Context): SessionControl {
  const waits = new Map<SessionID, Promise<void>>();
  return {
    async interrupt(sessionID) {
      const result = await ctx.session.interrupt({ sessionID, resume: false });
      return result.interrupted;
    },
    waitIdle(sessionID) {
      const pending = waits.get(sessionID);
      if (pending !== undefined) return pending;
      const wait: Promise<void> = ctx.session
        .wait({ sessionID })
        .finally(() => {
          if (waits.get(sessionID) === wait) waits.delete(sessionID);
        });
      waits.set(sessionID, wait);
      return wait;
    },
  };
}

function sessionMessenger(ctx: Plugin.Context): SessionMessenger {
  return {
    async synthetic(message) {
      const item = await ctx.session.synthetic({
        sessionID: message.sessionID,
        ...(message.id === undefined ? {} : { id: message.id }),
        text: message.text,
        description: message.description,
        metadata: message.metadata,
        delivery: message.delivery,
        resume: message.resume,
      });
      return { id: item.id, createdAt: item.time.created };
    },
  };
}

function pluginStore(ctx: Plugin.Context): Store {
  return {
    get: (key) => ctx.storage.get(key),
    set: (key, value: Json) => ctx.storage.set(key, value),
    remove: (key) => ctx.storage.remove(key),
    async scan(prefix) {
      const entries: Array<{ readonly key: string; readonly value: Json }> = [];
      let after: string | undefined;
      do {
        const page = await ctx.storage.scan({
          prefix,
          limit: SCAN_PAGE_SIZE,
          ...(after === undefined ? {} : { after }),
        });
        entries.push(...page.entries);
        after = page.next;
      } while (after !== undefined);
      return entries;
    },
  };
}

export const systemClock: Clock = {
  now: () => Date.now(),
  sleep: (ms, signal) =>
    new Promise<void>((resolve) => {
      if (signal?.aborted) {
        resolve();
        return;
      }
      const done = () => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", done);
        resolve();
      };
      const timer = setTimeout(done, ms);
      signal?.addEventListener("abort", done, { once: true });
    }),
};

export const unrefScheduler: Scheduler = {
  schedule(ms, task) {
    const timer = setTimeout(task, ms);
    timer.unref();
    return () => clearTimeout(timer);
  },
};

/** Writes to the console of the server process the plugin runs in. */
export function consoleLogger(prefix = `[${PLUGIN_ID}]`): Logger {
  return {
    info: (message, data) =>
      data === undefined
        ? console.info(prefix, message)
        : console.info(prefix, message, data),
    warn: (message, data) =>
      data === undefined
        ? console.warn(prefix, message)
        : console.warn(prefix, message, data),
  };
}
