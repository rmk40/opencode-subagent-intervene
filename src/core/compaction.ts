import { randomUUID } from "node:crypto";
import { errorMessage } from "@/core/errors";
import {
  PLUGIN_ID,
  type CompactionAdmission,
  type SessionCompactor,
  type SessionID,
  type SessionMessenger,
} from "@/core/ports";

export const COMPACT_TOOL_NAME = "context_compact";
export const HANDOFF_MAX_CODE_POINTS = 8000;
export const HANDOFF_KIND = "context-handoff";
const SELF_COMPACTION_PREFIX = `msg_${PLUGIN_ID}_self_compaction_`;

/** The marker is available to every plugin instance before the admission event is emitted. */
export function selfCompactionID(): string {
  return `${SELF_COMPACTION_PREFIX}${randomUUID()}`;
}

export function isSelfCompactionID(id: string): boolean {
  return id.startsWith(SELF_COMPACTION_PREFIX);
}

export class CompactionError extends Error {
  override name = "CompactionError";
}

export interface CompactionDeps {
  readonly compactor: SessionCompactor;
  readonly messenger: SessionMessenger;
}

export interface SelfCompactionResult extends CompactionAdmission {
  readonly sessionID: SessionID;
  readonly status: "requested";
  readonly handoff:
    | { readonly status: "omitted" }
    | { readonly status: "stored"; readonly messageID: string }
    | { readonly status: "failed"; readonly error: string };
  readonly note: string;
}

/** Admits compaction and optional working notes without waiting for the caller's step to end. */
export async function requestSelfCompaction(
  deps: CompactionDeps,
  call: { readonly sessionID: SessionID; readonly signal: AbortSignal },
  handoff?: string,
): Promise<SelfCompactionResult> {
  if (handoff !== undefined) {
    const length = [...handoff].length;
    if (length < 1 || length > HANDOFF_MAX_CODE_POINTS) {
      throw new CompactionError(
        `handoff must contain 1 to ${HANDOFF_MAX_CODE_POINTS} characters. Nothing was requested.`,
      );
    }
  }
  if (call.signal.aborted) {
    throw new CompactionError(
      "The call was cancelled. Compaction was not requested.",
    );
  }
  let admission: CompactionAdmission;
  try {
    admission = await deps.compactor.compact({
      sessionID: call.sessionID,
      id: selfCompactionID(),
      delivery: "steer",
    });
  } catch (error) {
    throw new CompactionError(`Compaction admission failed. ${errorMessage(error)}`);
  }

  let notes: SelfCompactionResult["handoff"] = { status: "omitted" };
  if (handoff !== undefined) {
    try {
      if (call.signal.aborted) {
        throw new Error("The call was cancelled before the notes could be stored.");
      }
      const message = await deps.messenger.synthetic({
        sessionID: call.sessionID,
        text: `Agent-written working notes for compaction ${admission.id}\n\n${handoff}`,
        description: "Agent-written compaction handoff",
        metadata: {
          plugin: PLUGIN_ID,
          kind: HANDOFF_KIND,
          compactionID: admission.id,
        },
        delivery: "steer",
        resume: false,
      });
      notes = { status: "stored", messageID: message.id };
    } catch (error) {
      // Admission already succeeded, so failing the whole tool would hide the pending compaction.
      notes = { status: "failed", error: errorMessage(error) };
    }
  }

  const scheduling = admission.delivery === "queue"
    ? "The existing request remains queued and waits for a queue boundary. It was not upgraded to steered delivery."
    : "Compaction normally runs at the next step boundary after all current tool calls settle. A pending location move can delay it.";
  const note = notes.status === "failed"
    ? `Compaction is already requested, but the notes were not stored. ${notes.error} Do not repeat the whole operation just to store the notes.`
    : notes.status === "omitted"
      ? "No handoff notes were supplied."
      : admission.delivery === "queue"
        ? "The notes are steered and can arrive before the queued compaction, which may summarize them. A pending location move can delay delivery."
        : "The steered notes normally arrive after the compaction checkpoint. They have ordinary context priority and later compactions can summarize them.";
  return {
    ...admission,
    sessionID: call.sessionID,
    status: "requested",
    handoff: notes,
    note: `${scheduling} Admission does not confirm completion. Summary generation can still fail. ${note}`,
  };
}
