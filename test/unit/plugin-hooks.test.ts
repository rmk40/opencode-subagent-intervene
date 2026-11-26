import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import type { Plugin } from "@opencode/plugin";
import plugin from "@/index";
import { flush, inboxEnqueued } from "./fixtures";

type Hook = (event: { readonly sessionID: string }) => unknown;

/**
 * The parts of the plugin context that setup and the latch's hooks touch. Storage holds no stop
 * records and fails every read but the startup scan; reading a session fails. The event stream
 * delivers one event, so the latch has seen the stream, and stays open until cleanup.
 */
function fakeContext(options: Readonly<Record<string, unknown>>) {
  const hooks = new Map<string, Hook>();
  const registration = { dispose: async () => {} };
  const ctx = {
    options,
    session: {
      wait: async () => {},
      get: async () => {
        throw new Error("session read failed");
      },
      hook: async (name: string, hook: Hook) => {
        hooks.set(name, hook);
        return registration;
      },
    },
    event: {
      subscribe: ({ signal }: { readonly signal: AbortSignal }) =>
        (async function* () {
          yield inboxEnqueued("ses_child", "synthetic", Date.now());
          await new Promise<void>((resolve) =>
            signal.addEventListener("abort", () => resolve(), { once: true }),
          );
        })(),
    },
    storage: {
      scan: async ({ prefix }: { readonly prefix: string }) => {
        if (prefix !== "latch/") throw new Error("storage unavailable");
        return { entries: [] };
      },
      get: async () => {
        throw new Error("storage unavailable");
      },
      set: async () => {},
      remove: async () => {},
    },
    tool: {
      transform: async () => registration,
      hook: async () => registration,
    },
  };
  return { ctx: ctx as unknown as Plugin.Context, hooks };
}

async function load(options: Readonly<Record<string, unknown>>) {
  const { ctx, hooks } = fakeContext(options);
  const cleanup = await plugin.setup(ctx);
  await flush();
  return {
    hooks,
    unload: async () => {
      if (typeof cleanup === "function") await cleanup();
    },
  };
}

describe("the session hooks the plugin registers", () => {
  // The plugin logs to the console; keep test output quiet.
  let spies: Array<{ mockRestore(): void }> = [];
  beforeEach(() => {
    spies = [
      spyOn(console, "info").mockImplementation(() => {}),
      spyOn(console, "warn").mockImplementation(() => {}),
    ];
  });
  afterEach(() => {
    for (const spy of spies) spy.mockRestore();
  });

  test("registers the context hook when the latch is on, and never a title hook", async () => {
    const { hooks, unload } = await load({});
    expect(hooks.has("context")).toBe(true);
    expect(hooks.has("title")).toBe(false);
    await unload();
  });

  test("registers no context hook when the latch is off", async () => {
    const { hooks, unload } = await load({ latch: false });
    expect(hooks.has("context")).toBe(false);
    expect(hooks.has("title")).toBe(false);
    await unload();
  });

  test("the context hook resolves when storage and session reads fail", async () => {
    const { hooks, unload } = await load({});
    const hook = hooks.get("context");
    expect(hook).toBeDefined();
    await expect(
      Promise.resolve(hook?.({ sessionID: "ses_child" })),
    ).resolves.toBeUndefined();
    await unload();
  });
});
