// Probe plugin for runtime checks against a live OpenCode. It records what a server plugin can
// observe (events, hooks, tool calls) to JSONL, exposes a loopback control server so Drive
// scripts can call plugin-side APIs, and simulates the stop latch on `session.execution.started`.
import { Plugin } from "@opencode/plugin";
import { Error as ToolError } from "@opencode/plugin/promise/tool";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

type Ctx = Plugin.Context;
type SessionID = Parameters<Ctx["session"]["get"]>[0]["sessionID"];
type Directory = Parameters<Ctx["session"]["move"]>[0]["directory"];
type CreateInput = NonNullable<Parameters<Ctx["session"]["create"]>[0]>;
type Delivery = NonNullable<
  Parameters<Ctx["session"]["prompt"]>[0]["delivery"]
>;

/** Event types read through a `types`-filtered subscription, the way the plugin under test subscribes. */
const TYPED_EVENTS = [
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
] as const;

/** High-volume streaming events whose payloads are not logged in full. */
const NOISY = new Set([
  "session.text.delta",
  "session.reasoning.delta",
  "session.tool.input.delta",
  "session.step.streamed",
  "session.compaction.delta",
]);

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const field = (value: unknown, key: string): unknown =>
  isRecord(value) ? value[key] : undefined;

const text = (value: unknown, key: string): string | undefined => {
  const found = field(value, key);
  return typeof found === "string" ? found : undefined;
};

const preview = (value: unknown, limit = 400): string => {
  const encoded = JSON.stringify(value) ?? "undefined";
  return encoded.length > limit ? `${encoded.slice(0, limit)}…` : encoded;
};

const message = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

export default Plugin.define({
  id: "probe",
  async setup(ctx) {
    const dir =
      typeof ctx.options.dir === "string" ? ctx.options.dir : undefined;
    if (dir === undefined) return;
    const instance = `${process.pid}-${crypto.randomUUID().slice(0, 8)}`;
    const location = ctx.location.directory;
    mkdirSync(join(dir, "instances"), { recursive: true });
    const logFile = join(dir, `log-${instance}.jsonl`);
    let seq = 0;
    const log = (kind: string, record: Record<string, unknown>) => {
      appendFileSync(
        logFile,
        `${JSON.stringify({ kind, instance, location, seq: seq++, at: Date.now(), hr: performance.now(), ...record })}\n`,
      );
    };
    log("setup", { pid: process.pid, version: ctx.app.version });

    const controller = new AbortController();

    // Latch simulation: a stored `probe-latch/<id>` key is read on every decision.
    const latched = async (sessionID: string) =>
      (await ctx.storage.get(`probe-latch/${sessionID}`)) !== undefined;
    const enforce = async (
      sessionID: SessionID,
      created: number,
      received: number,
    ) => {
      const readStart = Date.now();
      const active = await latched(sessionID).catch(() => false);
      if (!active) return;
      const interruptStart = Date.now();
      const result = await ctx.session
        .interrupt({ sessionID, resume: false })
        .then((value) => ({ interrupted: value.interrupted }))
        .catch((error: unknown) => ({ error: message(error) }));
      log("enforce", {
        sessionID,
        eventCreated: created,
        received,
        readStart,
        interruptStart,
        interruptReturned: Date.now(),
        result,
      });
    };

    const record = (
      source: "typed" | "all",
      event: {
        readonly type: string;
        readonly id: string;
        readonly created: number;
        readonly data: unknown;
        readonly location?: unknown;
      },
    ) => {
      const data = event.data;
      const sessionID = text(data, "sessionID");
      const base = {
        source,
        type: event.type,
        id: event.id,
        created: event.created,
        sessionID,
        eventLocation: field(event.location, "directory"),
      };
      if (NOISY.has(event.type)) return log("event", base);
      const item = field(data, "item");
      log("event", {
        ...base,
        parentID: text(data, "parentID"),
        itemType: text(item, "type"),
        itemDelivery: text(item, "delivery"),
        itemText:
          text(field(item, "payload"), "text")?.slice(0, 300) ??
          text(item, "text")?.slice(0, 300),
        itemMetadata: field(field(item, "payload"), "metadata"),
        inboxID: text(data, "inboxID"),
        delivery: text(data, "delivery"),
        reason: text(data, "reason"),
        name: text(data, "name"),
        tool: text(data, "tool") ?? text(data, "name"),
        callID: text(data, "callID"),
        data: preview(data),
      });
    };

    // Unfiltered stream: full evidence of what a plugin sees, in delivery order.
    void (async () => {
      try {
        for await (const event of ctx.event.subscribe({
          signal: controller.signal,
        }))
          record("all", event);
      } catch (error) {
        if (!controller.signal.aborted)
          log("subscribe-error", { source: "all", error: message(error) });
      }
    })();

    // `types`-filtered stream, processed strictly in order.
    void (async () => {
      try {
        for await (const event of ctx.event.subscribe({
          types: [...TYPED_EVENTS],
          signal: controller.signal,
        })) {
          const received = Date.now();
          record("typed", event);
          if (event.type === "session.execution.started")
            await enforce(event.data.sessionID, event.created, received);
        }
      } catch (error) {
        if (!controller.signal.aborted)
          log("subscribe-error", { source: "typed", error: message(error) });
      }
    })();

    await ctx.session.hook("prompt", async (event) => {
      const before = event.prompt.text;
      const key = `probe-prepend/${event.sessionID}`;
      let prepended: string | undefined;
      try {
        const stored = await ctx.storage.get(key);
        if (typeof stored === "string") {
          prepended = stored;
          event.prompt.text = `${stored}${event.prompt.text}`;
          await ctx.storage.remove(key);
        }
        // A deliberate prompt lifts the simulated latch.
        if (await latched(event.sessionID)) {
          await ctx.storage.remove(`probe-latch/${event.sessionID}`);
          log("lift", { sessionID: event.sessionID, via: "prompt-hook" });
        }
      } catch (error) {
        log("prompt-hook-error", {
          sessionID: event.sessionID,
          error: message(error),
        });
      }
      log("prompt-hook", {
        sessionID: event.sessionID,
        messageID: event.messageID,
        delivery: event.delivery,
        before: before.slice(0, 300),
        prepended,
        metadata: event.metadata,
      });
    });

    await ctx.session.hook("context", (event) => {
      log("context-hook", {
        sessionID: event.sessionID,
        agent: event.agent,
        directTools: Object.keys(event.tools).sort(),
        messages: event.messages.length,
      });
      event.system.push({
        type: "text",
        text: `PROBE-SID<${event.sessionID}> PROBE-AGENT<${event.agent}>`,
      });
    });

    await ctx.tool.transform((editor) => {
      editor.namespace({
        name: "probens",
        description: "Probe namespace for Code Mode checks",
      });
      editor.add({
        name: "probe_direct",
        description: "Probe direct tool gated on the subagent permission.",
        input: { type: "object", properties: {}, additionalProperties: false },
        options: { codemode: false, permission: "subagent" },
        execute: async (_input, context) => {
          log("tool", {
            tool: "probe_direct",
            sessionID: context.sessionID,
            agent: context.agent,
          });
          return { content: "probe_direct ok" };
        },
      });
      editor.add({
        name: "ping",
        description:
          "Probe pinned Code Mode tool gated on the subagent permission.",
        input: { type: "object", properties: {}, additionalProperties: false },
        options: { namespace: "probens", pinned: true, permission: "subagent" },
        execute: async (_input, context) => {
          log("tool", {
            tool: "probens.ping",
            sessionID: context.sessionID,
            agent: context.agent,
          });
          return { content: "probens.ping ok" };
        },
      });
      editor.add({
        name: "probe_fail",
        description: "Probe tool that always fails with a Tool.Error.",
        input: { type: "object", properties: {}, additionalProperties: false },
        options: { codemode: false },
        execute: async (_input, context) => {
          log("tool", { tool: "probe_fail", sessionID: context.sessionID });
          throw new ToolError({
            message: "PROBE-FAILURE: deliberate failure from probe_fail",
          });
        },
      });
    });

    const handlers: Record<string, (args: unknown) => Promise<unknown>> = {
      info: async () => ({ instance, location, pid: process.pid }),
      get: async (args) => ctx.session.get({ sessionID: sid(args) }),
      list: async (args) => {
        const parentID = text(args, "parentID");
        return ctx.session.list(
          parentID === undefined
            ? { limit: 100 }
            : { parentID: parentID as SessionID, limit: 100 },
        );
      },
      context: async (args) => ctx.session.context({ sessionID: sid(args) }),
      create: async (args) =>
        ctx.session.create((isRecord(args) ? args : {}) as CreateInput),
      prompt: async (args) =>
        ctx.session.prompt({
          sessionID: sid(args),
          text: text(args, "text") ?? "",
          ...(text(args, "delivery") === undefined
            ? {}
            : { delivery: text(args, "delivery") as Delivery }),
          ...(typeof field(args, "resume") === "boolean"
            ? { resume: field(args, "resume") === true }
            : {}),
        }),
      synthetic: async (args) =>
        ctx.session.synthetic({
          sessionID: sid(args),
          text: text(args, "text") ?? "",
          ...(typeof field(args, "resume") === "boolean"
            ? { resume: field(args, "resume") === true }
            : {}),
        }),
      interrupt: async (args) => {
        const start = Date.now();
        const result = await ctx.session.interrupt({
          sessionID: sid(args),
          resume: field(args, "resume") === true,
        });
        return { ...result, start, end: Date.now() };
      },
      wait: async (args) => {
        const timeout =
          typeof field(args, "timeoutMs") === "number"
            ? Number(field(args, "timeoutMs"))
            : 150;
        const start = performance.now();
        const outcome = await Promise.race([
          ctx.session.wait({ sessionID: sid(args) }).then(
            () => "resolved" as const,
            (error: unknown) => `error: ${message(error)}`,
          ),
          Bun.sleep(timeout).then(() => "timeout" as const),
        ]);
        return { outcome, ms: performance.now() - start };
      },
      move: async (args) =>
        ctx.session.move({
          sessionID: sid(args),
          directory: (text(args, "directory") ?? "") as Directory,
        }),
      "storage.get": async (args) => ({
        value: (await ctx.storage.get(text(args, "key") ?? "")) ?? null,
      }),
      "storage.set": async (args) => {
        await ctx.storage.set(
          text(args, "key") ?? "",
          (field(args, "value") ?? null) as Json,
        );
        return { ok: true };
      },
      "storage.remove": async (args) => {
        await ctx.storage.remove(text(args, "key") ?? "");
        return { ok: true };
      },
      "storage.scan": async (args) =>
        ctx.storage.scan({ prefix: text(args, "prefix") ?? "" }),
      latch: async (args) => {
        await ctx.storage.set(`probe-latch/${sid(args)}`, { at: Date.now() });
        return { ok: true };
      },
      unlatch: async (args) => {
        await ctx.storage.remove(`probe-latch/${sid(args)}`);
        return { ok: true };
      },
      permissions: async (args) =>
        ctx.permission.list({ sessionID: sid(args) }),
    };

    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: async (request) => {
        const body: unknown = await request.json().catch(() => undefined);
        const op = text(body, "op") ?? "";
        const handler = handlers[op];
        if (handler === undefined)
          return Response.json({ error: `unknown op ${op}` }, { status: 404 });
        try {
          const result = await handler(field(body, "args"));
          return Response.json({ result: result ?? null });
        } catch (error) {
          return Response.json({ error: message(error) }, { status: 500 });
        }
      },
    });
    writeFileSync(
      join(dir, "instances", `${instance}.json`),
      JSON.stringify({
        instance,
        location,
        pid: process.pid,
        port: server.port,
      }),
    );
    log("ready", { port: server.port });

    return async () => {
      controller.abort();
      await server.stop(true);
      log("cleanup", {});
    };
  },
});

function sid(args: unknown): SessionID {
  const value = text(args, "sessionID");
  if (value === undefined) throw new Error("sessionID is required");
  return value as SessionID;
}
