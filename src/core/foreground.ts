// Which parents are blocked in a foreground `subagent` call on one of their subagents. A notice
// steered into such a parent is read only after the call returns, when it is stale, so the notices
// hold back while the call runs. The call is told from events: while a `subagent` call runs, its
// tool progress names the subagent, but the parent's context leaves that progress out.

import type { OpenCodeEvent, SessionID } from "@/core/ports";

/** A tool call running in a parent session, identified the way its terminal event names it. */
export interface RunningCall {
  readonly parentID: SessionID;
  readonly assistantMessageID: string;
  readonly callID: string;
}

export function sameCall(a: RunningCall, b: RunningCall): boolean {
  return (
    a.parentID === b.parentID &&
    a.assistantMessageID === b.assistantMessageID &&
    a.callID === b.callID
  );
}

/** Matches the calls an event ended, including ones no longer followed. */
export type EndedCalls = (call: RunningCall) => boolean;

export class ForegroundCalls {
  /** Running calls whose tool progress names a subagent, by that subagent's session ID. */
  private readonly calls = new Map<SessionID, RunningCall>();

  /**
   * Follows the calls that run subagents. When the event ends calls, forgets them and returns the
   * matcher, so a caller holding a notice back for a call can check it again. The matcher also
   * covers a call a newer one on the same subagent already replaced.
   */
  onEvent(event: OpenCodeEvent): EndedCalls | undefined {
    switch (event.type) {
      case "session.tool.progress": {
        // Core's `subagent` tool publishes `{ sessionID: <subagent>, status: "running" }` once
        // the subagent is chosen. A call that returns at once, launching in the background or
        // steering, ends straight after, which forgets it again.
        const subagentID = event.data.metadata["sessionID"];
        if (
          typeof subagentID !== "string" ||
          subagentID === event.data.sessionID
        ) {
          return undefined;
        }
        this.calls.set(subagentID, {
          parentID: event.data.sessionID,
          assistantMessageID: event.data.assistantMessageID,
          callID: event.data.id,
        });
        return undefined;
      }
      case "session.tool.success":
      case "session.tool.failed": {
        // Provider call IDs can repeat across messages, so the message ID is compared too.
        const ended: RunningCall = {
          parentID: event.data.sessionID,
          assistantMessageID: event.data.assistantMessageID,
          callID: event.data.id,
        };
        return this.end((call) => sameCall(call, ended));
      }
      // Every call a run makes ends with it.
      case "session.execution.succeeded":
      case "session.execution.failed":
      case "session.execution.interrupted": {
        const sessionID = event.data.sessionID;
        return this.end((call) => call.parentID === sessionID);
      }
      case "session.deleted": {
        const sessionID = event.data.sessionID;
        this.calls.delete(sessionID);
        return this.end((call) => call.parentID === sessionID);
      }
      default:
        return undefined;
    }
  }

  /** The parent's running call on the subagent, when the subagent's own parent made it. */
  blocking(subagentID: SessionID, parentID: SessionID): RunningCall | undefined {
    const call = this.calls.get(subagentID);
    return call?.parentID === parentID ? call : undefined;
  }

  /** Forgets every call. Call when events may have been missed, since their ends may have been. */
  clear(): void {
    this.calls.clear();
  }

  private end(matches: EndedCalls): EndedCalls {
    for (const [subagentID, call] of this.calls) {
      if (matches(call)) this.calls.delete(subagentID);
    }
    return matches;
  }
}
