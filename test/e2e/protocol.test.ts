import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import {
  LLMRequest,
  Message,
  ToolCallID,
  type LanguageModel,
} from "@opencode/ai/effect";
import { compileRequest } from "@opencode/ai/testing";
import { provider as anthropic } from "@opencode/ai/providers/anthropic";
import { route as responses } from "@opencode/ai/protocols/openai-responses";
import type {
  ChannelCheckpoint,
  WebSocketChannelExecutor,
} from "@opencode/ai/route";

const warning =
  "160k / 200k input (80%) · 40k remaining · UI/context 64% of 250k · measured 2026-11-01T22:00:00Z · assumed default auto ~170k (10k away) · Context planning update. Continue while the next step and its expected output fit before the automatic-compaction point, leaving room for results not yet measured, and narrow large results when possible. This notice alone is not a reason to compact. · openai/gpt-5, initial context (no completed compaction) · Later messages and pending tool or subagent results are not included in this measurement.";
const toolID = ToolCallID.make("call_read");
const history = [
  Message.user("Review the source and continue with the next file."),
  Message.assistant([
    {
      type: "tool-call",
      id: toolID,
      name: "read",
      input: { path: "source.ts" },
    },
  ]),
  Message.tool({
    id: toolID,
    name: "read",
    result: { type: "text", value: "export const value = 1" },
  }),
];

const request = (model: LanguageModel, messages: readonly Message[]) =>
  new LLMRequest({
    model,
    messages,
    system: [{ type: "text", text: "Stable session instructions." }],
    tools: [],
    cache: { system: true, messages: { tail: 2 } },
  });

const record = (value: unknown): Record<string, unknown> => {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error("expected object");
  return value as Record<string, unknown>;
};
const list = (value: unknown): unknown[] => {
  if (!Array.isArray(value)) throw new Error("expected array");
  return value;
};

describe("durable context warnings through released provider serializers", () => {
  test("keeps the existing Anthropic tool-result cache breakpoint and warning bytes on later requests", async () => {
    const model = anthropic
      .configure({ apiKey: "fixture-no-network" })
      .model("claude-sonnet-4-5");
    const compile = async (messages: readonly Message[]) =>
      record(
        (await Effect.runPromise(compileRequest(request(model, messages))))
          .body as unknown,
      );
    const before = await compile(history);
    const withWarning = await compile([...history, Message.user(warning)]);
    const later = await compile([
      ...history,
      Message.user(warning),
      Message.assistant("Proceeding."),
      Message.user("Next file."),
    ]);
    const content = (body: Record<string, unknown>) =>
      list(body.messages).flatMap((message) => list(record(message).content));
    const findResult = (body: Record<string, unknown>) =>
      content(body).find((part) => record(part).type === "tool_result");
    expect(record(findResult(before)).cache_control).toEqual({
      type: "ephemeral",
    });
    expect(findResult(withWarning)).toEqual(findResult(before));
    const findWarning = (body: Record<string, unknown>) =>
      content(body).filter((part) => record(part).text === warning);
    expect(findWarning(withWarning)).toHaveLength(1);
    expect(findWarning(later)).toHaveLength(1);
    expect(record(findWarning(later)[0]).text).toBe(
      record(findWarning(withWarning)[0]).text,
    );
    expect(
      content(withWarning).find((part) => record(part).type === "tool_use"),
    ).toMatchObject({ id: "call_read", name: "read" });
    expect(record(findResult(withWarning)).tool_use_id).toBe("call_read");
  });

  test("uses incremental Responses continuation after durable append and falls back after rewriting history", async () => {
    const model = responses.model({ id: "gpt-5", provider: "openai" });
    const websocket: WebSocketChannelExecutor = {
      execute: () =>
        Effect.die("fixture uses the public prepared driver directly"),
    };
    const prepare = async (messages: readonly Message[]) => {
      const req = request(model, messages);
      const body = await Effect.runPromise(responses.body.from(req));
      const prepared = await Effect.runPromise(
        responses.prepareTransport(body, req, { webSocket: websocket }),
      );
      if (!prepared.channel)
        throw new Error("Responses channel was not prepared");
      return prepared.channel.driver;
    };
    const first = await prepare(history);
    const create = await Effect.runPromise(first.create(undefined));
    expect(create.mode).toBe("full");
    await Effect.runPromise(
      first.observe(
        create,
        JSON.stringify({
          type: "response.created",
          response: { id: "resp_1" },
        }),
      ),
    );
    const completed = await Effect.runPromise(
      first.observe(
        create,
        JSON.stringify({
          type: "response.completed",
          response: {
            id: "resp_1",
            output: [
              {
                type: "message",
                id: "msg_reply",
                role: "assistant",
                content: [{ type: "output_text", text: "Proceeding." }],
              },
            ],
          },
        }),
      ),
    );
    expect(completed.type).toBe("completed");
    const checkpoint: ChannelCheckpoint | undefined =
      completed.type === "completed" ? completed.checkpoint : undefined;
    expect(checkpoint).toBeDefined();

    const stableHistory = [
      ...history,
      Message.assistant("Proceeding."),
      Message.user(warning),
    ];
    const second = await prepare(stableHistory);
    const append = await Effect.runPromise(second.create(checkpoint));
    expect(append.mode).toBe("incremental");
    const frame = record(JSON.parse(append.message) as unknown);
    expect(frame.previous_response_id).toBe("resp_1");
    expect(list(frame.input)).toHaveLength(1);
    expect(JSON.stringify(frame.input)).toContain(warning);

    await Effect.runPromise(
      second.observe(
        append,
        JSON.stringify({
          type: "response.created",
          response: { id: "resp_2" },
        }),
      ),
    );
    const next = await Effect.runPromise(
      second.observe(
        append,
        JSON.stringify({
          type: "response.completed",
          response: {
            id: "resp_2",
            output: [
              {
                type: "message",
                role: "assistant",
                content: [{ type: "output_text", text: "Next." }],
              },
            ],
          },
        }),
      ),
    );
    const nextCheckpoint =
      next.type === "completed" ? next.checkpoint : undefined;
    const third = await prepare([
      ...stableHistory,
      Message.assistant("Next."),
      Message.user("Continue."),
    ]);
    const thirdSend = await Effect.runPromise(third.create(nextCheckpoint));
    expect(thirdSend.mode).toBe("incremental");
    expect(
      list(record(JSON.parse(thirdSend.message) as unknown).input),
    ).toHaveLength(1);
    const rewritten = await prepare([
      ...history,
      Message.assistant("Proceeding."),
      Message.user(warning.replace("80%", "90%")),
      Message.assistant("Next."),
      Message.user("Continue."),
    ]);
    expect(
      (await Effect.runPromise(rewritten.create(nextCheckpoint))).mode,
    ).toBe("full");
    expect(
      [create, append, thirdSend].filter((send) => send.mode === "full"),
    ).toHaveLength(1);
    expect(
      [create, append, thirdSend].filter((send) => send.mode === "incremental"),
    ).toHaveLength(2);
  });
});
