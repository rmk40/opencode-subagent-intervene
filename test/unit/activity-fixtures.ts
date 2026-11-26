// Typed builders for the events that show a session making progress: steps, streamed text,
// reasoning and tool input, tool calls and their ends, and retry delays. Every builder takes the
// event's creation time, which is what activity tracking records.

import type { OpenCodeEvent, SessionID } from "@/core/ports";
import type { EventOf } from "./fixtures";

/** The assistant message the builders attach events to unless told otherwise. */
export const MESSAGE = "msg_assistant";

let counter = 0;

function envelope(created: number): { id: string; created: number } {
  counter++;
  return { id: `activity-event-${counter}`, created };
}

function durable(sessionID: SessionID) {
  return { aggregateID: sessionID, seq: counter, version: 1 } as const;
}

export function stepStarted(
  sessionID: SessionID,
  created: number,
  options: { readonly started?: number; readonly message?: string } = {},
): EventOf<"session.step.started"> {
  const base = envelope(created);
  return {
    ...base,
    type: "session.step.started",
    durable: durable(sessionID),
    data: {
      sessionID,
      assistantMessageID: options.message ?? MESSAGE,
      agent: "general",
      model: { id: "model", providerID: "provider" },
      started: options.started ?? created,
    },
  };
}

export function stepStreamed(
  sessionID: SessionID,
  created: number,
  message = MESSAGE,
): EventOf<"session.step.streamed"> {
  const base = envelope(created);
  return {
    ...base,
    type: "session.step.streamed",
    durable: durable(sessionID),
    data: { sessionID, assistantMessageID: message },
  };
}

export function stepEnded(
  sessionID: SessionID,
  created: number,
  message = MESSAGE,
): EventOf<"session.step.ended"> {
  const base = envelope(created);
  return {
    ...base,
    type: "session.step.ended",
    durable: durable(sessionID),
    data: {
      sessionID,
      assistantMessageID: message,
      finish: "tool-calls",
      cost: 0,
      tokens: {
        input: 0,
        output: 0,
        reasoning: 0,
        cache: { read: 0, write: 0 },
      },
    },
  };
}

export function stepFailed(
  sessionID: SessionID,
  created: number,
  message = MESSAGE,
): EventOf<"session.step.failed"> {
  const base = envelope(created);
  return {
    ...base,
    type: "session.step.failed",
    durable: durable(sessionID),
    data: {
      sessionID,
      assistantMessageID: message,
      error: { type: "ProviderError", message: "boom" },
    },
  };
}

export function textStarted(
  sessionID: SessionID,
  created: number,
): EventOf<"session.text.started"> {
  const base = envelope(created);
  return {
    ...base,
    type: "session.text.started",
    durable: durable(sessionID),
    data: { sessionID, assistantMessageID: MESSAGE, ordinal: 0 },
  };
}

export function textDelta(
  sessionID: SessionID,
  created: number,
): EventOf<"session.text.delta"> {
  return {
    ...envelope(created),
    type: "session.text.delta",
    data: { sessionID, assistantMessageID: MESSAGE, ordinal: 0, delta: "x" },
  };
}

export function textEnded(
  sessionID: SessionID,
  created: number,
): EventOf<"session.text.ended"> {
  const base = envelope(created);
  return {
    ...base,
    type: "session.text.ended",
    durable: durable(sessionID),
    data: { sessionID, assistantMessageID: MESSAGE, ordinal: 0, text: "x" },
  };
}

export function reasoningStarted(
  sessionID: SessionID,
  created: number,
): EventOf<"session.reasoning.started"> {
  const base = envelope(created);
  return {
    ...base,
    type: "session.reasoning.started",
    durable: durable(sessionID),
    data: { sessionID, assistantMessageID: MESSAGE, ordinal: 0 },
  };
}

export function reasoningDelta(
  sessionID: SessionID,
  created: number,
): EventOf<"session.reasoning.delta"> {
  return {
    ...envelope(created),
    type: "session.reasoning.delta",
    data: { sessionID, assistantMessageID: MESSAGE, ordinal: 0, delta: "x" },
  };
}

export function reasoningEnded(
  sessionID: SessionID,
  created: number,
): EventOf<"session.reasoning.ended"> {
  const base = envelope(created);
  return {
    ...base,
    type: "session.reasoning.ended",
    durable: durable(sessionID),
    data: { sessionID, assistantMessageID: MESSAGE, ordinal: 0, text: "x" },
  };
}

export function toolInputStarted(
  sessionID: SessionID,
  callID: string,
  created: number,
  options: { readonly name?: string; readonly message?: string } = {},
): EventOf<"session.tool.input.started"> {
  const base = envelope(created);
  return {
    ...base,
    type: "session.tool.input.started",
    durable: durable(sessionID),
    data: {
      sessionID,
      assistantMessageID: options.message ?? MESSAGE,
      id: callID,
      name: options.name ?? "shell",
    },
  };
}

export function toolInputDelta(
  sessionID: SessionID,
  callID: string,
  created: number,
): EventOf<"session.tool.input.delta"> {
  return {
    ...envelope(created),
    type: "session.tool.input.delta",
    data: { sessionID, assistantMessageID: MESSAGE, id: callID, delta: "{" },
  };
}

export function toolInputEnded(
  sessionID: SessionID,
  callID: string,
  created: number,
): EventOf<"session.tool.input.ended"> {
  const base = envelope(created);
  return {
    ...base,
    type: "session.tool.input.ended",
    durable: durable(sessionID),
    data: { sessionID, assistantMessageID: MESSAGE, id: callID, text: "{}" },
  };
}

export function toolCalled(
  sessionID: SessionID,
  callID: string,
  created: number,
  message = MESSAGE,
): EventOf<"session.tool.called"> {
  const base = envelope(created);
  return {
    ...base,
    type: "session.tool.called",
    durable: durable(sessionID),
    data: {
      sessionID,
      assistantMessageID: message,
      id: callID,
      input: {},
      executed: true,
    },
  };
}

/** Progress of a tool call, such as core's `subagent` tool naming the subagent it runs. */
export function toolProgressed(
  sessionID: SessionID,
  callID: string,
  created: number,
  metadata: Readonly<Record<string, string>> = {},
  message = MESSAGE,
): EventOf<"session.tool.progress"> {
  return {
    ...envelope(created),
    type: "session.tool.progress",
    data: { sessionID, assistantMessageID: message, id: callID, metadata },
  };
}

export function toolFinished(
  type: "session.tool.success" | "session.tool.failed",
  sessionID: SessionID,
  callID: string,
  created: number,
  message = MESSAGE,
): OpenCodeEvent {
  const base = envelope(created);
  const data = {
    sessionID,
    assistantMessageID: message,
    id: callID,
    executed: true,
  };
  const ended = { ...base, durable: { ...durable(sessionID), version: 2 } } as const;
  switch (type) {
    case "session.tool.success":
      return {
        ...ended,
        type,
        data: { ...data, content: [{ type: "text", text: "ok" }] },
      };
    case "session.tool.failed":
      return {
        ...ended,
        type,
        data: { ...data, error: { type: "ToolError", message: "boom" } },
      };
  }
}

/** A failed model request whose retry is due at `at`. */
export function retryScheduled(
  sessionID: SessionID,
  created: number,
  at: number,
): EventOf<"session.retry.scheduled"> {
  const base = envelope(created);
  return {
    ...base,
    type: "session.retry.scheduled",
    durable: durable(sessionID),
    data: {
      sessionID,
      assistantMessageID: MESSAGE,
      attempt: 1,
      at,
      error: { type: "ProviderError", message: "rate limited" },
    },
  };
}
