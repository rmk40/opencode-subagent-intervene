import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import type { Plugin } from "@opencode/plugin";
import plugin from "@/index";
import { flush, inboxEnqueued } from "./fixtures";

type Hook = (event: { readonly sessionID: string }) => unknown;

interface AddedTool {
  readonly name: string;
  readonly options?: { readonly namespace?: string };
}

const CONTEXT_TOOLS = ["context_compact", "context_notes", "context_status"];
const SUBAGENT_TOOLS = [
  "subagent_send",
  "subagent_stop",
  "subagents.inspect",
  "subagents.list",
];

/**
 * The parts of the plugin context that setup and the latch's hooks touch. Storage holds no stop
 * records and fails every read but the startup scan; reading a session fails. The event stream
 * delivers one event, so the latch has seen the stream, and stays open until cleanup. Tool
 * transforms run against an editor that records each added tool by its effective name
 * (`namespace.name` for a namespaced tool) and each declared namespace.
 */
function fakeContext(options: Readonly<Record<string, unknown>>) {
  const hooks = new Map<string, Hook>();
  const toolHooks = new Set<string>();
  const tools: string[] = [];
  const namespaces: string[] = [];
  const registration = { dispose: async () => {} };
  const editor = {
    add: (tool: AddedTool) => {
      const namespace = tool.options?.namespace;
      tools.push(
        namespace === undefined ? tool.name : `${namespace}.${tool.name}`,
      );
    },
    namespace: (namespace: { readonly name: string }) => {
      namespaces.push(namespace.name);
    },
  };
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
      transform: async (callback: (input: typeof editor) => void) => {
        callback(editor);
        return registration;
      },
      hook: async (name: string) => {
        toolHooks.add(name);
        return registration;
      },
    },
  };
  return {
    ctx: ctx as unknown as Plugin.Context,
    hooks,
    toolHooks,
    tools,
    namespaces,
  };
}

async function load(options: Readonly<Record<string, unknown>>) {
  const { ctx, hooks, toolHooks, tools, namespaces } = fakeContext(options);
  const cleanup = await plugin.setup(ctx);
  await flush();
  return {
    hooks,
    toolHooks,
    tools,
    namespaces,
    unload: async () => {
      if (typeof cleanup === "function") await cleanup();
    },
  };
}

// Every context option set to a value that would offer a tool or a notice, or change one, if the
// context tools were on.
const CONTEXT_OPTIONS_ON = {
  contextNotices: true,
  selfCompaction: true,
  contextWarningPercent: 70,
  compactionBuffer: "10%",
} as const;

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

describe("the session hooks the plugin registers", () => {
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

  test("keeps the latch's prompt and context hooks when the context tools are off", async () => {
    const { hooks, unload } = await load({ contextTools: false });
    expect(hooks.has("prompt")).toBe(true);
    expect(hooks.has("context")).toBe(true);
    await unload();
  });
});

describe("the tools the plugin registers", () => {
  test("registers the three context tools and the subagent tools by default", async () => {
    const { tools, namespaces, unload } = await load({});
    expect(tools.toSorted()).toEqual([...CONTEXT_TOOLS, ...SUBAGENT_TOOLS]);
    expect(namespaces).toEqual(["subagents"]);
    await unload();
  });

  test("keeps context_status and context_notes without context_compact when selfCompaction is off", async () => {
    const { tools, unload } = await load({ selfCompaction: false });
    expect(tools.toSorted()).toEqual([
      "context_notes",
      "context_status",
      ...SUBAGENT_TOOLS,
    ]);
    await unload();
  });

  test("registers only the subagent tools and their namespace when the context tools are off, whatever the other context options say", async () => {
    const { tools, namespaces, unload } = await load({
      contextTools: false,
      ...CONTEXT_OPTIONS_ON,
    });
    expect(tools.toSorted()).toEqual(SUBAGENT_TOOLS);
    expect(namespaces).toEqual(["subagents"]);
    await unload();
  });
});

describe("the tool hook that drives context notices", () => {
  test("is registered by default", async () => {
    const { toolHooks, unload } = await load({});
    expect(toolHooks.has("execute.after")).toBe(true);
    await unload();
  });

  test("is not registered when contextNotices is off", async () => {
    const { toolHooks, unload } = await load({ contextNotices: false });
    expect(toolHooks.has("execute.after")).toBe(false);
    await unload();
  });

  test("is not registered when the context tools are off, even with contextNotices on", async () => {
    const { toolHooks, unload } = await load({
      contextTools: false,
      ...CONTEXT_OPTIONS_ON,
    });
    expect(toolHooks.has("execute.after")).toBe(false);
    await unload();
  });
});
