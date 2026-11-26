import { Error as ToolError, type Info } from "@opencode/plugin/promise/tool";
import { Schema } from "effect";
import {
  ContextNotesError,
  NOTES_MAX_CODE_POINTS,
  NOTES_TOOL_NAME,
  parseNotesRequest,
  runContextNotes,
  type ContextNotesDeps,
  type NotesResult,
} from "@/core/context-notes";
import { formatCount } from "@/core/errors";

export const NAME = NOTES_TOOL_NAME;
export const DESCRIPTION = `Save, read or clear your own session's working notes without compacting. The latest saved notes stay in this session's context as agent-authored reference data, not instructions, and are kept through manual and automatic compaction until replaced or cleared. They go with every request, so keep them concise. save replaces the previous notes with 1 to ${formatCount(NOTES_MAX_CODE_POINTS)} characters, stored exactly as given. read returns the current notes. clear removes the active entry and announces its removal at the next step. The cleared state persists through compaction, though earlier copies can remain in the baseline, history or summaries. Changes append context updates; earlier versions stay in history. Saving does not request compaction or start work. Independent of context_compact's handoff.`;

export const Input = Schema.Struct({
  action: Schema.Literals(["read", "save", "clear"]),
  notes: Schema.optionalKey(Schema.String).annotate({
    description: `Required for save and rejected otherwise: 1 to ${formatCount(NOTES_MAX_CODE_POINTS)} characters that replace the current notes.`,
  }),
});

export const Output = Schema.Struct({
  sessionID: Schema.String,
  action: Schema.Literals(["read", "save", "clear"]),
  status: Schema.Literals(["empty", "present", "saved", "cleared"]),
  notes: Schema.optionalKey(Schema.String),
  revision: Schema.optionalKey(Schema.String),
  savedAt: Schema.optionalKey(Schema.Number),
  codePoints: Schema.optionalKey(Schema.Number),
  note: Schema.String,
});

const SAVED_NOTE =
  "The latest saved notes stay in this session's context as agent-authored reference data, including after manual or automatic compaction. Saving did not request compaction or start work. The update is announced at the next step; earlier versions stay in history.";
const CLEARED_NOTE =
  "The active notes entry is removed and its removal is announced at the next step. The cleared state persists through compaction, though earlier copies can remain in the baseline, history or summaries. Clearing when no notes are active changes nothing.";
const PRESENT_NOTE = "These are the latest saved notes.";
const EMPTY_NOTE = "No working notes are saved.";

export function contextNotesTool(
  deps: ContextNotesDeps,
): Info<typeof Input, typeof Output> {
  return {
    name: NAME,
    description: DESCRIPTION,
    input: Input,
    output: Output,
    options: { codemode: false, permission: NAME },
    execute: async (input, context) => {
      try {
        const result = await runContextNotes(
          deps,
          context,
          parseNotesRequest(input),
        );
        return { output: toOutput(result), content: render(result) };
      } catch (error) {
        if (error instanceof ContextNotesError) {
          throw new ToolError({ message: error.message });
        }
        throw error;
      }
    },
  };
}

function toOutput(result: NotesResult): typeof Output.Type {
  switch (result.status) {
    case "empty":
      return { ...result, note: EMPTY_NOTE };
    case "present":
      return { ...result, note: PRESENT_NOTE };
    case "saved":
      return { ...result, note: SAVED_NOTE };
    case "cleared":
      return { ...result, note: CLEARED_NOTE };
  }
}

function render(result: NotesResult): string {
  switch (result.status) {
    case "empty":
      return `No working notes are saved for ${result.sessionID}.`;
    case "present":
      return `Working notes for ${result.sessionID}, revision ${result.revision}, saved ${new Date(result.savedAt).toISOString()}:\n\n${result.notes}`;
    case "saved":
      return `Working notes saved for ${result.sessionID} as revision ${result.revision} (${result.codePoints} characters). ${SAVED_NOTE}`;
    case "cleared":
      return `Working notes cleared for ${result.sessionID}. ${CLEARED_NOTE}`;
  }
}
