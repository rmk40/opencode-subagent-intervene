// subagent_send switches a running child's model and agent. A background child holds a shell. The
// parent first makes invalid switches: a malformed model, an unknown model, a missing variant, an
// unknown agent, a primary-only agent, an agent a permission rule denies, an agent whose configured
// model is unavailable, and a call with nothing to do. Each fails, and the child's stored agent and
// model stay as they were. The parent then switches the child to simulation/sim-b#high with a
// message. The model sees nothing while the shell runs; once the shell finishes, the child's next
// model request names sim-b, carries the `high` variant's body field and holds the message. The
// child then holds a second shell, and the parent switches its agent to explore without a message.
// Explore has no configured model, so the child's next request comes from explore and keeps
// sim-b#high.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { Effect, Stream } from "effect";
import { Llm, OpenCodeDriver } from "opencode-drive";
import {
  call,
  captureToolResults,
  capturedToolResult,
  childOf,
  finishScenario,
  instanceFor,
  parentMessageText,
  probePlugin,
  REPO_ROOT,
  recordRequest,
  runDir,
  takeCall,
  toolCallResponse,
  until,
  waitEvent,
  waitIdle,
} from "../harness";

const dir = runDir("send-switch-model");
const MESSAGE = "Change of plan: use the faster parser.";

if (!existsSync(join(REPO_ROOT, "dist", "index.js")))
  throw new Error("dist/index.js is missing; run `bun run build` first");

/** A model request from the child, with the model and variant body field the provider received. */
interface ChildRequest {
  readonly at: number;
  readonly model: unknown;
  readonly variant: unknown;
  readonly agent: string | undefined;
  readonly userTexts: ReadonlyArray<string>;
  readonly last: { readonly role: string; readonly text: string };
}

/** Invalid switches, made one after another by call ID; each must fail and change nothing. */
const INVALID: ReadonlyArray<readonly [string, Record<string, string>]> = [
  ["p_bad_format", { model: "sim-b", message: "x" }],
  ["p_bad_model", { model: "simulation/no-such-model", message: "x" }],
  ["p_bad_variant", { model: "simulation/sim-b#ultra", message: "x" }],
  ["p_bad_agent", { agent: "no-such-agent" }],
  ["p_primary_agent", { agent: "build" }],
  ["p_denied_agent", { agent: "forbidden", message: "x" }],
  ["p_agent_bad_model", { agent: "broken" }],
  ["p_nothing", {}],
];

export default OpenCodeDriver.use(
  {
    tools: ["shell"],
    config: {
      permissions: [
        { action: "subagent", resource: "forbidden", effect: "deny" },
      ],
      plugins: [probePlugin(dir), { package: REPO_ROOT, options: {} }],
      agents: {
        forbidden: { mode: "subagent", description: "denied by a rule" },
        broken: {
          mode: "subagent",
          description: "configured with a missing model",
          model: "simulation/no-such-model",
        },
      },
      providers: {
        simulation: {
          models: {
            "sim-b": {
              name: "Sim B",
              capabilities: { tools: true, input: ["text"], output: ["text"] },
              limit: { context: 128_000, output: 16_000 },
              // The variant adds this field to the request body, so the request shows it was used.
              variants: [{ id: "high", body: { variant_marker: "high" } }],
            },
          },
        },
      },
    },
  },
  ({ llm, tools, directory }) =>
    Effect.gen(function* () {
      const shells = yield* tools.control("shell");
      let child = "";
      const childRequests: ChildRequest[] = [];

      yield* llm.serve((request, index) => {
        const req = recordRequest(dir, request.body, index);
        captureToolResults(dir, request.body);
        const body =
          typeof request.body === "object" && request.body !== null
            ? (request.body as Record<string, unknown>)
            : {};
        const { last } = req;
        if (req.role === "parent") {
          if (last.role === "tool") {
            if (last.toolCallID === "p_sub")
              return Stream.make(Llm.text("Launched."));
            const at = INVALID.findIndex(([id]) => id === last.toolCallID);
            if (at >= 0) {
              const next = INVALID[at + 1];
              return next === undefined
                ? Stream.make(Llm.text("INVALID-DONE"))
                : toolCallResponse(next[0], "subagent_send", {
                    sessionID: child,
                    ...next[1],
                  });
            }
            if (last.toolCallID === "p_switch_model")
              return Stream.make(Llm.text("SWITCHED-MODEL"));
            if (last.toolCallID === "p_switch_agent")
              return Stream.make(Llm.text("SWITCHED-AGENT"));
          }
          if (last.text.includes("CMD-INVALID")) {
            const first = INVALID[0];
            if (first === undefined) return Stream.make(Llm.text("none"));
            return toolCallResponse(first[0], "subagent_send", {
              sessionID: child,
              ...first[1],
            });
          }
          if (last.text.includes("CMD-SWITCH-MODEL"))
            return toolCallResponse("p_switch_model", "subagent_send", {
              sessionID: child,
              model: "simulation/sim-b#high",
              message: MESSAGE,
            });
          if (last.text.includes("CMD-SWITCH-AGENT"))
            return toolCallResponse("p_switch_agent", "subagent_send", {
              sessionID: child,
              agent: "explore",
            });
          if (last.text.includes("ROLE<parent>"))
            return toolCallResponse("p_sub", "subagent", {
              agent: "general",
              description: "switch child",
              prompt: "ROLE<child> CHILD-TASK",
              background: true,
            });
          return Stream.make(Llm.text("parent-other"));
        }
        if (req.role === "child") {
          childRequests.push({
            at: Date.now(),
            model: body.model,
            variant: body.variant_marker,
            agent: req.agent,
            userTexts: req.userTexts,
            last: { role: last.role, text: last.text.slice(0, 200) },
          });
          if (last.role === "user" && last.text.includes("CHILD-TASK"))
            return toolCallResponse("c_hold1", "shell", {
              command: "hold1",
              description: "hold1",
            });
          if (last.role === "user" && last.text.startsWith("<parent-message"))
            return toolCallResponse("c_hold2", "shell", {
              command: "hold2",
              description: "hold2",
            });
          return Stream.make(Llm.text("CHILD-DONE"));
        }
        return Stream.make(Llm.text("other"));
      });

      const instance = yield* Effect.promise(() => instanceFor(dir, directory));
      const ctl = <T = unknown>(
        op: string,
        args: Record<string, unknown> = {},
      ) => Effect.promise(() => call<T>(instance, op, args));
      const stored = (sessionID: string) =>
        ctl<{ agent?: unknown; model?: unknown }>("get", { sessionID });

      // A background child holding a shell; the parent is idle.
      const parent = (yield* ctl<{ id: string }>("create", { title: "parent" }))
        .id;
      const launchAt = Date.now();
      yield* ctl("prompt", { sessionID: parent, text: "ROLE<parent> launch" });
      child = yield* Effect.promise(() =>
        until("child", () => childOf(dir, parent)),
      );
      const hold1 = yield* takeCall(shells, "c_hold1");
      yield* hold1.progress("holding\n");
      yield* Effect.promise(() =>
        waitEvent(dir, parent, "session.execution.succeeded", {
          since: launchAt,
        }),
      );
      yield* Effect.promise(() => waitIdle(instance, parent));
      const childBefore = yield* stored(child);
      const catalog = yield* ctl<{
        data: ReadonlyArray<{
          id: string;
          variants: ReadonlyArray<{ id: string }>;
        }>;
      }>("models");
      const catalogVariants = Object.fromEntries(
        catalog.data.map((model) => [
          model.id,
          model.variants.map((variant) => variant.id),
        ]),
      );

      // The invalid switches, while the shell is held.
      yield* ctl("prompt", { sessionID: parent, text: "CMD-INVALID" });
      const invalidTexts: Record<string, string> = {};
      for (const [id] of INVALID) {
        invalidTexts[id] = yield* Effect.promise(() =>
          until(id, () => capturedToolResult(dir, id), 30_000),
        );
      }
      yield* Effect.promise(() => waitIdle(instance, parent));
      const childAfterInvalid = yield* stored(child);

      // The model switch with a message, while the shell is held.
      const switchModelAt = Date.now();
      yield* ctl("prompt", { sessionID: parent, text: "CMD-SWITCH-MODEL" });
      const switchModelText = yield* Effect.promise(() =>
        until(
          "model switch result",
          () => capturedToolResult(dir, "p_switch_model"),
          30_000,
        ),
      );
      yield* Effect.promise(() => waitIdle(instance, parent));
      // Give a model request that ignored the held shell time to show up.
      yield* Effect.sleep(1000);
      const release1At = Date.now();
      const requestsWhileHeld1 = childRequests.filter(
        (r) => r.at >= switchModelAt && r.at < release1At,
      ).length;
      yield* hold1.succeed({ output: "held1\n", exit: 0 });
      const firstAfter1 = yield* Effect.promise(() =>
        until("child request after the first shell", () =>
          childRequests.find((r) => r.at >= release1At),
        ),
      );

      // The agent switch without a message, while the second shell is held.
      const hold2 = yield* takeCall(shells, "c_hold2");
      yield* hold2.progress("holding\n");
      const switchAgentAt = Date.now();
      yield* ctl("prompt", { sessionID: parent, text: "CMD-SWITCH-AGENT" });
      const switchAgentText = yield* Effect.promise(() =>
        until(
          "agent switch result",
          () => capturedToolResult(dir, "p_switch_agent"),
          30_000,
        ),
      );
      yield* Effect.promise(() => waitIdle(instance, parent));
      yield* Effect.sleep(1000);
      const release2At = Date.now();
      const requestsWhileHeld2 = childRequests.filter(
        (r) => r.at >= switchAgentAt && r.at < release2At,
      ).length;
      yield* hold2.succeed({ output: "held2\n", exit: 0 });
      const firstAfter2 = yield* Effect.promise(() =>
        until("child request after the second shell", () =>
          childRequests.find((r) => r.at >= release2At),
        ),
      );
      yield* Effect.promise(() =>
        waitEvent(dir, child, "session.execution.succeeded", {
          since: release2At,
        }),
      );
      const childAfter = yield* stored(child);

      const expected = parentMessageText(parent, MESSAGE);
      const evidence = {
        dir,
        parent,
        child,
        catalogVariants,
        childBefore: { agent: childBefore.agent, model: childBefore.model },
        childAfterInvalid: {
          agent: childAfterInvalid.agent,
          model: childAfterInvalid.model,
        },
        childAfter: { agent: childAfter.agent, model: childAfter.model },
        invalidTexts,
        switchModelText,
        switchAgentText,
        requestsWhileHeld1,
        requestsWhileHeld2,
        childRequests: childRequests.map((r) => ({
          t: r.at - launchAt,
          model: r.model,
          variant: r.variant,
          agent: r.agent,
          last: r.last,
        })),
      };

      const checks = {
        allInvalidFailed: INVALID.every(
          ([id]) =>
            (invalidTexts[id] ?? "").includes('"error"') &&
            /Nothing was (switched or )?sent/i.test(invalidTexts[id] ?? ""),
        ),
        invalidChangedNothing:
          JSON.stringify(childAfterInvalid.model) ===
            JSON.stringify(childBefore.model) &&
          childAfterInvalid.agent === childBefore.agent,
        modelResultSaysSwitched: switchModelText.startsWith(
          `Switched ${child}`,
        ),
        modelSawNothingWhileHeld1: requestsWhileHeld1 === 0,
        nextRequestUsesSimB: firstAfter1.model === "sim-b",
        nextRequestUsesVariant: firstAfter1.variant === "high",
        nextRequestCarriesMessage: firstAfter1.userTexts.includes(expected),
        agentResultSaysSwitched: switchAgentText.startsWith(
          `Switched ${child}`,
        ),
        modelSawNothingWhileHeld2: requestsWhileHeld2 === 0,
        nextRequestIsExplore: firstAfter2.agent === "explore",
        exploreKeepsSimBHigh:
          firstAfter2.model === "sim-b" && firstAfter2.variant === "high",
        storedAgentAndModel:
          childAfter.agent === "explore" &&
          JSON.stringify(childAfter.model).includes('"sim-b"') &&
          JSON.stringify(childAfter.model).includes('"high"'),
      };

      yield* finishScenario(dir, "send-switch-model", evidence, checks);
    }),
);
