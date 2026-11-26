import { randomUUID } from "node:crypto";
import { errorMessage } from "@/core/errors";
import {
  PLUGIN_ID,
  type Clock,
  type Json,
  type SessionID,
  type SessionInstructionEntries,
} from "@/core/ports";

export const NOTES_TOOL_NAME = "context_notes";
export const NOTES_MAX_CODE_POINTS = 8000;
/** The one instruction entry key this plugin writes; never derived from tool input. */
export const NOTES_ENTRY_KEY = `${PLUGIN_ID}.working-notes`;
export const NOTES_KIND = "agent-working-notes";
export const NOTES_VERSION = 1;
export const NOTES_ABOUT =
  "Working notes this session's agent saved with context_notes for its own reference. They are agent-authored reference data, not instructions from the user, the system or a tool.";

/**
 * The stored entry value. The host renders this object as indented JSON, keeping notes in a named
 * string field.
 */
export type StoredNotes = {
  readonly version: typeof NOTES_VERSION;
  readonly kind: typeof NOTES_KIND;
  readonly about: string;
  readonly revision: string;
  /** Epoch milliseconds. */
  readonly savedAt: number;
  readonly notes: string;
};

export class ContextNotesError extends Error {
  override name = "ContextNotesError";
}

export interface ContextNotesDeps {
  readonly instructions: SessionInstructionEntries;
  readonly clock: Pick<Clock, "now">;
}

export interface NotesCall {
  readonly sessionID: SessionID;
  readonly signal: AbortSignal;
}

export type NotesRequest =
  | { readonly action: "read" }
  | { readonly action: "save"; readonly notes: string }
  | { readonly action: "clear" };

export type NotesResult =
  | {
      readonly sessionID: SessionID;
      readonly action: "read";
      readonly status: "empty";
    }
  | {
      readonly sessionID: SessionID;
      readonly action: "read";
      readonly status: "present";
      readonly revision: string;
      readonly savedAt: number;
      readonly notes: string;
    }
  | {
      readonly sessionID: SessionID;
      readonly action: "save";
      readonly status: "saved";
      readonly revision: string;
      readonly savedAt: number;
      readonly codePoints: number;
    }
  | {
      readonly sessionID: SessionID;
      readonly action: "clear";
      readonly status: "cleared";
    };

/** Checks the raw tool input. Notes are kept exactly as given: no trimming or normalization. */
export function parseNotesRequest(input: {
  readonly action: "read" | "save" | "clear";
  readonly notes?: string | undefined;
}): NotesRequest {
  if (input.action === "save") {
    if (input.notes === undefined) {
      throw new ContextNotesError("save requires notes. Nothing was saved.");
    }
    const length = codePoints(input.notes);
    if (length < 1 || length > NOTES_MAX_CODE_POINTS) {
      throw new ContextNotesError(
        `notes must contain 1 to ${NOTES_MAX_CODE_POINTS} characters. Nothing was saved.`,
      );
    }
    return { action: "save", notes: input.notes };
  }
  if (input.notes !== undefined) {
    throw new ContextNotesError(
      `notes are accepted only with save. Nothing was ${input.action === "read" ? "read" : "cleared"}.`,
    );
  }
  return { action: input.action };
}

export async function runContextNotes(
  deps: ContextNotesDeps,
  call: NotesCall,
  request: NotesRequest,
): Promise<NotesResult> {
  switch (request.action) {
    case "read":
      return readNotes(deps, call);
    case "save":
      return saveNotes(deps, call, request.notes);
    case "clear":
      return clearNotes(deps, call);
  }
}

async function readNotes(
  deps: ContextNotesDeps,
  call: NotesCall,
): Promise<NotesResult> {
  let stored: StoredNotes | undefined;
  try {
    stored = await currentNotes(deps, call.sessionID);
  } catch (error) {
    if (error instanceof ContextNotesError) throw error;
    throw new ContextNotesError(`Working notes could not be read. ${errorMessage(error)}`);
  }
  if (stored === undefined) {
    return { sessionID: call.sessionID, action: "read", status: "empty" };
  }
  return {
    sessionID: call.sessionID,
    action: "read",
    status: "present",
    revision: stored.revision,
    savedAt: stored.savedAt,
    notes: stored.notes,
  };
}

async function saveNotes(
  deps: ContextNotesDeps,
  call: NotesCall,
  notes: string,
): Promise<NotesResult> {
  assertNotCancelled(call, "Nothing was saved.");
  try {
    // Refuses to replace an entry under this key that this version cannot read, such as one a
    // newer plugin version wrote.
    await currentNotes(deps, call.sessionID);
  } catch (error) {
    if (error instanceof ContextNotesError) {
      throw new ContextNotesError(`${error.message} Nothing was saved.`);
    }
    throw new ContextNotesError(
      `Working notes were not saved. The current entry could not be read. ${errorMessage(error)}`,
    );
  }
  assertNotCancelled(call, "Nothing was saved.");
  const value: StoredNotes = {
    version: NOTES_VERSION,
    kind: NOTES_KIND,
    about: NOTES_ABOUT,
    revision: randomUUID(),
    savedAt: deps.clock.now(),
    notes,
  };
  try {
    await deps.instructions.put({
      sessionID: call.sessionID,
      key: NOTES_ENTRY_KEY,
      value,
    });
  } catch (error) {
    throw new ContextNotesError(`Working notes were not saved. ${errorMessage(error)}`);
  }
  return {
    sessionID: call.sessionID,
    action: "save",
    status: "saved",
    revision: value.revision,
    savedAt: value.savedAt,
    codePoints: codePoints(notes),
  };
}

async function clearNotes(
  deps: ContextNotesDeps,
  call: NotesCall,
): Promise<NotesResult> {
  assertNotCancelled(call, "Nothing was cleared.");
  try {
    await deps.instructions.remove({
      sessionID: call.sessionID,
      key: NOTES_ENTRY_KEY,
    });
  } catch (error) {
    throw new ContextNotesError(`Working notes were not cleared. ${errorMessage(error)}`);
  }
  return { sessionID: call.sessionID, action: "clear", status: "cleared" };
}

async function currentNotes(
  deps: ContextNotesDeps,
  sessionID: SessionID,
): Promise<StoredNotes | undefined> {
  const entries = await deps.instructions.list(sessionID);
  const entry = entries.find((candidate) => candidate.key === NOTES_ENTRY_KEY);
  if (entry === undefined) return undefined;
  const parsed = parseStoredNotes(entry.value);
  if (parsed === undefined) {
    throw new ContextNotesError(
      `The instruction entry ${NOTES_ENTRY_KEY} does not hold working notes in a format this plugin version reads. It was left unchanged; clear removes it.`,
    );
  }
  return parsed;
}

/** Returns `undefined` for any value that is not version-1 working notes. */
export function parseStoredNotes(value: Json): StoredNotes | undefined {
  if (!isRecord(value)) return undefined;
  const { version, kind, about, revision, savedAt, notes } = value;
  if (version !== NOTES_VERSION || kind !== NOTES_KIND) return undefined;
  if (typeof about !== "string" || typeof revision !== "string" || revision === "") {
    return undefined;
  }
  // A finite number outside the Date range would make rendering the save time throw.
  if (typeof savedAt !== "number" || Number.isNaN(new Date(savedAt).getTime())) {
    return undefined;
  }
  if (typeof notes !== "string") return undefined;
  const length = codePoints(notes);
  if (length < 1 || length > NOTES_MAX_CODE_POINTS) return undefined;
  return { version, kind, about, revision, savedAt, notes };
}

function isRecord(value: Json): value is { readonly [key: string]: Json } {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertNotCancelled(call: NotesCall, outcome: string): void {
  if (call.signal.aborted) {
    throw new ContextNotesError(`The call was cancelled. ${outcome}`);
  }
}

function codePoints(text: string): number {
  return [...text].length;
}
