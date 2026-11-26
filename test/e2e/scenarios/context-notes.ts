// Working notes through the released runtime. The plugin runs with self-compaction and notices
// off, so every compaction here is the host's own: manual through the plugin API and automatic
// from a reported measurement past the default threshold. The simulated summary never repeats the
// notes, so notes in a continuation request can only come from the session's instruction entries.
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { Effect, Stream } from "effect";
import { Llm, OpenCodeDriver, type OpenCode } from "opencode-drive";
import {
  call,
  captureToolResults,
  capturedToolResult,
  childOf,
  ControlError,
  finishScenario,
  type Instance,
  instanceFor,
  instances,
  listedLatches,
  readLlm,
  recordRequest,
  runDir,
  takeCall,
  toolCallResponse,
  until,
  waitIdle,
  writeLine,
} from "../harness";
import {
  compactionSummary,
  contextPlugins,
  effectiveNotes,
  isSystemUpdate,
  NOTES_KEY,
  notesBlocks,
  notesMentions,
  object,
  structuredResult,
  toolObservation,
  usage,
} from "../context-harness";

const dir = runDir("context-notes");
type InboxInput = Parameters<OpenCode["session"]["inbox"]["list"]>[0];

// Exact text: astral code points, a combining mark, CRLF and tabs, quotes, a backslash, and the
// closing tag of the block that renders it.
const FIRST =
  'NOTES-ONE goal: finish the probe 🚀 café\r\n\tnext: answer "CONTINUED" \\ </context> <context key="x">';
const SECOND = "NOTES-TWO 𝔘𝔫𝔦𝔠𝔬𝔡𝔢\nexact next action: read the stored notes.";
const THIRD = "NOTES-THREE saved right before a manual compaction";
const FOURTH = "NOTES-FOUR cleared right before a manual compaction";
const CHILD = "NOTES-CHILD stopped-child notes";
const IDLE = "NOTES-IDLE ü\n";

interface Captured {
  readonly index: number;
  readonly sessionID?: string;
  readonly compaction: boolean;
  readonly label: string;
  readonly body: unknown;
  readonly tools: readonly string[];
}

const messageList = (body: unknown): unknown[] => {
  const messages = object(body).messages;
  return Array.isArray(messages) ? messages : [];
};

export default OpenCodeDriver.use(
  {
    tools: ["shell"],
    config: {
      permissions: [],
      plugins: contextPlugins(dir, {
        selfCompaction: false,
        contextNotices: false,
      }),
      compaction: { auto: true },
      providers: {
        simulation: {
          models: {
            "gpt-sim-model": {
              limit: { context: 20000, input: 20000, output: 4000 },
            },
          },
        },
      },
    },
  },
  ({ llm, tools, directory, opencode }) =>
    Effect.gen(function* () {
      const shells = yield* tools.control("shell");
      const captured: Captured[] = [];
      let child = "";
      yield* llm.serve((request, index) => {
        const parsed = recordRequest(dir, request.body, index);
        // An instruction update can follow the tool result as a system message; route on the
        // newest conversation message instead.
        const turn = object(
          messageList(request.body).findLast(
            (message, index) =>
              object(message).role !== "system" &&
              !isSystemUpdate(request.body, index),
          ),
        );
        const req = {
          ...parsed,
          last: {
            role: String(turn.role ?? ""),
            text:
              typeof turn.content === "string"
                ? turn.content
                : Array.isArray(turn.content)
                  ? turn.content.map((part) => String(object(part).text ?? "")).join("\n")
                  : "",
            toolCallID:
              typeof turn.tool_call_id === "string" ? turn.tool_call_id : undefined,
          },
        };
        captureToolResults(dir, request.body);
        const compaction = req.system.includes("PROBE-COMPACTION");
        const label =
          req.last.role === "tool"
            ? `after:${req.last.toolCallID ?? ""}`
            : (req.last.text.split(/\s/)[0] ?? "");
        captured.push({
          index,
          sessionID:
            /PROBE-COMPACTION<([^>]+)>/.exec(req.system)?.[1] ?? req.sessionID,
          compaction,
          label: compaction ? "compaction" : label,
          body: request.body,
          tools: req.tools,
        });
        writeLine(dir, "requests.jsonl", {
          index,
          sessionID: req.sessionID,
          compaction,
          label,
          body: request.body,
        });
        if (compaction)
          return Stream.make(Llm.text(compactionSummary), usage(1000));
        if (req.role === "parent") {
          if (req.last.role === "tool")
            return Stream.make(Llm.text("PARENT-DONE"));
          if (req.last.text.includes("CMD-STOP"))
            return toolCallResponse("parent_stop", "subagent_stop", {
              sessionIDs: [child],
              reason: "notes stop check",
            });
          return toolCallResponse("parent_launch", "subagent", {
            agent: "general",
            prompt: "ROLE<child> wait",
            description: "notes stop probe",
            background: true,
          });
        }
        if (req.role === "child") {
          if (req.last.text.includes("CMD-HOLD"))
            return toolCallResponse("child_hold", "shell", {
              command: "hold",
              description: "hold",
            });
          if (req.last.text.includes("ROLE<child>"))
            return Stream.make(Llm.text("CHILD-READY"), usage(1000));
          return Stream.make(Llm.text("UNEXPECTED-CHILD-CONTINUATION"));
        }
        if (req.last.role === "tool")
          return Stream.make(
            Llm.text(`DONE-${req.last.toolCallID ?? ""}`),
            usage(1000),
          );
        const text = req.last.text;
        if (text.includes("NOTES-SAVE-1"))
          return Stream.make(
            Llm.toolCall({
              index: 0,
              id: "notes_save_1",
              name: "context_notes",
              input: { action: "save", notes: FIRST },
            }),
            usage(1000),
            Llm.finish("tool-calls"),
          );
        if (text.includes("NOTES-SAVE-2"))
          return Stream.make(
            Llm.toolCall({
              index: 0,
              id: "notes_save_2",
              name: "context_notes",
              input: { action: "save", notes: SECOND },
            }),
            usage(1000),
            Llm.finish("tool-calls"),
          );
        if (text.includes("NOTES-CLEAR"))
          return Stream.make(
            Llm.toolCall({
              index: 0,
              id: "notes_clear",
              name: "context_notes",
              input: { action: "clear" },
            }),
            usage(1000),
            Llm.finish("tool-calls"),
          );
        // Reported past the default threshold of 17k for a 20k window.
        if (text.includes("SEED-AUTO"))
          return Stream.make(Llm.text("SEEDED-AUTO"), usage(18500));
        return Stream.make(Llm.text(`REPLY-${text.split(/\s/)[0]}`), usage(1000));
      });

      let a: Instance = yield* Effect.promise(() =>
        instanceFor(dir, directory),
      );
      const ctl = <T = unknown>(op: string, args: Record<string, unknown> = {}) =>
        Effect.promise(() => call<T>(a, op, args));
      const history = (sessionID: string) =>
        ctl<unknown[]>("context", { sessionID });
      const lastAssistant = (sessionID: string) =>
        Effect.map(history(sessionID), (items) =>
          items
            .map(object)
            .filter((item) => item.type === "assistant")
            .at(-1),
        );
      const runNotes = (
        sessionID: string,
        input: Record<string, unknown>,
        via: Instance = a,
      ) =>
        Effect.gen(function* () {
          const caller = yield* lastAssistant(sessionID);
          return yield* Effect.promise(() =>
            call(via, "tool.run", {
              sessionID,
              messageID: caller?.id,
              tool: "context_notes",
              input,
            }).then(
              (value) => ({ ok: true as const, value: object(value) }),
              (error: unknown) => ({
                ok: false as const,
                error: error instanceof ControlError ? error.message : String(error),
              }),
            ),
          );
        });
      const prompt = (sessionID: string, text: string, via: Instance = a) =>
        Effect.promise(async () => {
          await call(via, "prompt", { sessionID, text });
          await waitIdle(via, sessionID, 30000);
        });
      // Session context starts at the latest compaction, so its ID identifies the epoch.
      const latestCompaction = (items: readonly unknown[]) =>
        items
          .map(object)
          .filter((item) => item.type === "compaction" && item.status === "completed")
          .at(-1);
      const manualCompact = (sessionID: string) =>
        Effect.gen(function* () {
          const before = latestCompaction(yield* history(sessionID))?.id;
          yield* ctl("compact", { sessionID });
          const after = yield* Effect.promise(() =>
            until(
              "manual compaction completed",
              async () => {
                const found = latestCompaction(
                  await call<unknown[]>(a, "context", { sessionID }),
                );
                return found !== undefined && found.id !== before ? found : undefined;
              },
              30000,
            ),
          );
          yield* Effect.promise(() => waitIdle(a, sessionID, 30000));
          return after;
        });
      const forSession = (sessionID: string) =>
        captured.filter((item) => item.sessionID === sessionID);
      const firstAfter = (sessionID: string, label: string, from: number) =>
        captured.find(
          (item) =>
            item.sessionID === sessionID &&
            !item.compaction &&
            item.label === label &&
            item.index > from,
        );
      const summaryAfter = (sessionID: string, from: number) =>
        captured.find(
          (item) => item.sessionID === sessionID && item.compaction && item.index > from,
        );
      /** The first model request of the session after its compaction summary request. */
      const continuationAfter = (sessionID: string, from: number) => {
        const summary = summaryAfter(sessionID, from);
        return summary === undefined
          ? undefined
          : captured.find(
              (item) =>
                item.sessionID === sessionID &&
                !item.compaction &&
                item.index > summary.index,
            );
      };
      const lastIndex = () => captured.at(-1)?.index ?? -1;

      const main = yield* ctl<{ id: string }>("create", { title: "notes" });
      const A = main.id;

      // Save through a model tool call; the update reaches the next step.
      yield* prompt(A, "ROLE<main> NOTES-SAVE-1");
      const saved1 = structuredResult(dir, "notes_save_1");
      const afterSave1 = firstAfter(A, "after:notes_save_1", -1);

      // Manual compaction, then the first continuation.
      const beforeManual = lastIndex();
      yield* manualCompact(A);
      const manualSummary = summaryAfter(A, beforeManual);
      yield* prompt(A, "CONTINUE-MANUAL");
      const afterManual = continuationAfter(A, beforeManual);

      // Replace the notes, then let the host compact automatically.
      yield* prompt(A, "NOTES-SAVE-2");
      const saved2 = structuredResult(dir, "notes_save_2");
      const afterSave2 = firstAfter(A, "after:notes_save_2", -1);
      yield* prompt(A, "SEED-AUTO");
      const beforeAuto = lastIndex();
      const epochBeforeAuto = latestCompaction(yield* history(A))?.id;
      yield* prompt(A, "CONTINUE-AUTO");
      const autoSummary = summaryAfter(A, beforeAuto);
      const afterAuto = continuationAfter(A, beforeAuto);
      const autoCompaction = latestCompaction(yield* history(A));

      // A second manual compaction keeps the same latest notes.
      const beforeRepeat = lastIndex();
      yield* manualCompact(A);
      yield* prompt(A, "CONTINUE-REPEAT");
      const afterRepeat = continuationAfter(A, beforeRepeat);

      // Save and immediately compact, with no model step between them.
      const immediateSave = yield* runNotes(A, { action: "save", notes: THIRD });
      const beforeImmediate = lastIndex();
      yield* manualCompact(A);
      yield* prompt(A, "CONTINUE-IMMEDIATE");
      const afterImmediate = continuationAfter(A, beforeImmediate);
      yield* prompt(A, "CONTINUE-IMMEDIATE-NEXT");
      const beforeImmediateSettled = lastIndex();
      yield* manualCompact(A);
      yield* prompt(A, "CONTINUE-IMMEDIATE-SETTLED");
      const afterImmediateSettled = continuationAfter(A, beforeImmediateSettled);

      // Plugin reload: another location keeps a control endpoint while this one is evicted.
      const bDir = resolve(directory, "..", "notes-control");
      mkdirSync(bDir, { recursive: true });
      const control = yield* ctl<{ id: string }>("create", { title: "control" });
      yield* ctl("move", { sessionID: control.id, directory: bDir });
      const b = yield* Effect.promise(() => instanceFor(dir, bDir));
      const originalInstance = a.instance;
      yield* opencode.debug.location
        .evict({ location: { directory } })
        .pipe(Effect.orDie);
      const beforeReload = lastIndex();
      yield* Effect.promise(() =>
        call(b, "prompt", { sessionID: A, text: "CONTINUE-RELOAD" }),
      );
      a = yield* Effect.promise(() =>
        until("reloaded plugin", () =>
          instances(dir).find(
            (item) =>
              item.location === directory && item.instance !== originalInstance,
          ),
        ),
      );
      yield* Effect.promise(() => waitIdle(a, A, 30000));
      const afterReload = firstAfter(A, "CONTINUE-RELOAD", beforeReload);
      const readAfterReload = yield* runNotes(A, { action: "read" });

      // Clear through the model, then compact: nothing carries forward.
      yield* prompt(A, "NOTES-CLEAR");
      const cleared = structuredResult(dir, "notes_clear");
      const afterClear = firstAfter(A, "after:notes_clear", -1);
      const readAfterClear = yield* runNotes(A, { action: "read" });
      const beforeClearedCompaction = lastIndex();
      yield* manualCompact(A);
      yield* prompt(A, "CONTINUE-CLEARED");
      const afterCleared = continuationAfter(A, beforeClearedCompaction);

      // Clear and immediately compact, with no model step between them.
      const fourthSave = yield* runNotes(A, { action: "save", notes: FOURTH });
      yield* prompt(A, "SETTLE-FOURTH");
      const settledFourth = firstAfter(A, "SETTLE-FOURTH", -1);
      const immediateClear = yield* runNotes(A, { action: "clear" });
      const beforeImmediateClear = lastIndex();
      yield* manualCompact(A);
      yield* prompt(A, "CONTINUE-IMMEDIATE-CLEAR");
      const afterImmediateClear = continuationAfter(A, beforeImmediateClear);
      const finalEntries = yield* ctl<unknown[]>("instructions.list", {
        sessionID: A,
      });

      // Another session never sees this session's notes.
      const other = yield* ctl<{ id: string }>("create", { title: "other" });
      yield* prompt(other.id, "OTHER-1");
      const otherRead = yield* runNotes(other.id, { action: "read" });

      // Saving on an idle session starts nothing and leaves its history alone.
      const idle = yield* ctl<{ id: string }>("create", { title: "idle" });
      yield* prompt(idle.id, "IDLE-SEED");
      const idleHistoryBefore = yield* history(idle.id);
      const idleRequestsBefore = forSession(idle.id).length;
      const idleSave = yield* runNotes(idle.id, { action: "save", notes: IDLE });
      yield* Effect.sleep(1500);
      const idleHistoryAfterSave = yield* history(idle.id);
      const idleRequestsAfterSave = forSession(idle.id).length;
      const idleInbox = yield* opencode.session.inbox
        .list({ sessionID: idle.id as InboxInput["sessionID"] })
        .pipe(Effect.orDie);
      const idleRead = yield* runNotes(idle.id, { action: "read" });
      const maxNotes = "🙂".repeat(8000);
      const atLimit = yield* runNotes(idle.id, { action: "save", notes: maxNotes });
      const readAtLimit = yield* runNotes(idle.id, { action: "read" });
      const overLimit = yield* runNotes(idle.id, {
        action: "save",
        notes: `${maxNotes}x`,
      });
      const emptyNotes = yield* runNotes(idle.id, { action: "save", notes: "" });
      const readWithNotes = yield* runNotes(idle.id, {
        action: "read",
        notes: "x",
      });
      const readAfterRejects = yield* runNotes(idle.id, { action: "read" });
      const idleClear = yield* runNotes(idle.id, { action: "clear" });
      const idleClearAgain = yield* runNotes(idle.id, { action: "clear" });
      const idleReadCleared = yield* runNotes(idle.id, { action: "read" });
      yield* Effect.sleep(500);
      const idleRequestsAfterAll = forSession(idle.id).length;

      // An entry under the key in a format this version does not read blocks read and save.
      const foreign = yield* ctl<{ id: string }>("create", { title: "foreign" });
      yield* prompt(foreign.id, "FOREIGN-SEED");
      yield* ctl("instructions.put", {
        sessionID: foreign.id,
        key: NOTES_KEY,
        value: { version: 99, notes: "FOREIGN-VALUE" },
      });
      const foreignRead = yield* runNotes(foreign.id, { action: "read" });
      const foreignSave = yield* runNotes(foreign.id, {
        action: "save",
        notes: "replacement",
      });
      const foreignEntries = yield* ctl<unknown[]>("instructions.list", {
        sessionID: foreign.id,
      });
      const foreignClear = yield* runNotes(foreign.id, { action: "clear" });
      const foreignAfterClear = yield* runNotes(foreign.id, { action: "read" });

      // Notes in a stopped child neither lift the parent's stop nor wake the child.
      const parent = yield* ctl<{ id: string }>("create", { title: "parent" });
      yield* ctl("prompt", { sessionID: parent.id, text: "ROLE<parent> launch" });
      child = yield* Effect.promise(() =>
        until("child", () => childOf(dir, parent.id)),
      );
      yield* Effect.promise(() => waitIdle(a, child));
      yield* Effect.promise(() => waitIdle(a, parent.id));
      yield* ctl("prompt", { sessionID: child, text: "CMD-HOLD" });
      const hold = yield* takeCall(shells, "child_hold");
      yield* hold.progress("holding\n");
      yield* ctl("prompt", { sessionID: parent.id, text: "CMD-STOP" });
      yield* Effect.promise(() =>
        until("parent stopped child", () => toolObservation(dir, "parent_stop"), 30000),
      );
      yield* Effect.promise(() => waitIdle(a, parent.id));
      yield* Effect.promise(() => waitIdle(a, child));
      const latch = () =>
        Effect.promise(async () => {
          const result = await call(a, "tool.run", {
            sessionID: parent.id,
            messageID: toolObservation(dir, "parent_stop")?.messageID,
            tool: "subagents_list",
            input: { depth: 4 },
          });
          return listedLatches(object(result).output).get(child);
        });
      const latchBefore = yield* latch();
      const childRequestsBefore = forSession(child).length;
      const childSave = yield* runNotes(child, { action: "save", notes: CHILD });
      const childRead = yield* runNotes(child, { action: "read" });
      const childClear = yield* runNotes(child, { action: "clear" });
      yield* Effect.sleep(1500);
      const latchAfter = yield* latch();
      const childRequestsAfter = forSession(child).length;
      const parentRead = yield* runNotes(parent.id, { action: "read" });

      // Checks.
      const blocks = (item: Captured | undefined) =>
        item === undefined ? [] : notesBlocks(item.body);
      const baseline = (item: Captured | undefined) =>
        blocks(item).filter((block) => block.leading);
      const raw = (item: Captured | undefined) =>
        item === undefined ? "" : JSON.stringify(item.body);
      // Conversation messages other than instruction updates, such as the compaction checkpoint.
      const conversationHas = (item: Captured, text: string) =>
        messageList(item.body).some(
          (message, index) =>
            object(message).role !== "system" &&
            !isSystemUpdate(item.body, index) &&
            JSON.stringify(object(message).content).includes(text),
        );
      const onlyLatest = (
        item: Captured | undefined,
        notes: string,
        revision: unknown,
      ) => {
        const all = blocks(item);
        const lead = baseline(item);
        return (
          lead.length === 1 &&
          all.length === 1 &&
          lead[0]?.value.notes === notes &&
          lead[0]?.value.revision === revision &&
          lead[0]?.value.kind === "agent-working-notes" &&
          lead[0]?.value.version === 1 &&
          typeof lead[0]?.value.about === "string" &&
          /reference data, not instructions/.test(String(lead[0]?.value.about))
        );
      };
      // Within one epoch every request extends the previous one; compaction resets the prefix.
      const epochPairs: { from: number; to: number; extends: boolean }[] = [];
      const mainRequests = forSession(A);
      for (let i = 1; i < mainRequests.length; i++) {
        const previous = mainRequests[i - 1];
        const next = mainRequests[i];
        if (!previous || !next || previous.compaction || next.compaction) continue;
        const crossed = captured.some(
          (item) =>
            item.sessionID === A &&
            item.compaction &&
            item.index > previous.index &&
            item.index < next.index,
        );
        if (crossed) continue;
        const before = messageList(previous.body).map((m) => JSON.stringify(m));
        const after = messageList(next.body).map((m) => JSON.stringify(m));
        epochPairs.push({
          from: previous.index,
          to: next.index,
          extends:
            after.length > before.length &&
            before.every((message, index) => after[index] === message),
        });
      }
      const save1Pair = epochPairs.find((pair) => pair.to === afterSave1?.index);
      const save2Pair = epochPairs.find((pair) => pair.to === afterSave2?.index);
      const clearPair = epochPairs.find((pair) => pair.to === afterClear?.index);
      const save1Update = blocks(afterSave1).filter((block) => !block.leading);
      const save2Update = blocks(afterSave2).filter((block) => !block.leading);
      const output = (result: { ok: boolean; value?: Record<string, unknown> }) =>
        object(result.ok ? result.value?.output : undefined);
      const errorText = (result: { ok: boolean; error?: string }) =>
        result.ok ? "" : (result.error ?? "");
      const allNonNotesSessions = captured.filter(
        (item) => item.sessionID !== A && item.sessionID !== idle.id && item.sessionID !== child,
      );

      const checks: Record<string, boolean> = {
        toolOfferedWithSelfCompactionAndNoticesOff: mainRequests
          .filter((item) => !item.compaction)
          .every(
            (item) =>
              item.tools.includes("context_notes") &&
              !item.tools.includes("context_compact") &&
              item.tools.includes("context_status"),
          ),
        modelSaveReturnsRevision:
          saved1.status === "saved" &&
          saved1.action === "save" &&
          saved1.sessionID === A &&
          typeof saved1.revision === "string" &&
          saved1.codePoints === [...FIRST].length &&
          typeof saved1.savedAt === "number" &&
          saved1.notes === undefined,
        saveTextDoesNotEchoNotes:
          !(capturedToolResult(dir, "notes_save_1") ?? "").includes("NOTES-ONE"),
        updateArrivesAtNextStepExactly:
          save1Update.length === 1 &&
          save1Update[0]?.value.notes === FIRST &&
          save1Update[0]?.value.revision === saved1.revision &&
          afterSave1 !== undefined &&
          isSystemUpdate(afterSave1.body, save1Update[0]?.index ?? -1) &&
          baseline(afterSave1).length === 0,
        updateAppendsWithoutRewritingPrefix: save1Pair?.extends === true,
        allSameEpochRequestsExtendPrefix:
          epochPairs.length > 0 && epochPairs.every((pair) => pair.extends),
        manualCheckpointOmitsNotes:
          manualSummary !== undefined &&
          afterManual !== undefined &&
          !conversationHas(afterManual, "NOTES-ONE"),
        manualContinuationCarriesExactNotes: onlyLatest(
          afterManual,
          FIRST,
          saved1.revision,
        ),
        replacementGetsNewRevision:
          saved2.status === "saved" &&
          typeof saved2.revision === "string" &&
          saved2.revision !== saved1.revision,
        replacementUpdateSupersedes:
          save2Update.length === 1 &&
          save2Update[0]?.value.notes === SECOND &&
          save2Update[0]?.value.revision === saved2.revision &&
          /changed and supersedes/.test(notesMentions(afterSave2?.body).join("\n")) &&
          effectiveNotes(afterSave2?.body)?.notes === SECOND &&
          save2Pair?.extends === true,
        autoCompactionRan:
          autoSummary !== undefined &&
          autoCompaction !== undefined &&
          autoCompaction.id !== epochBeforeAuto &&
          autoCompaction.reason === "auto",
        autoContinuationCarriesOnlyLatestNotes:
          onlyLatest(afterAuto, SECOND, saved2.revision) &&
          !raw(afterAuto).includes("NOTES-ONE") &&
          afterAuto !== undefined &&
          !conversationHas(afterAuto, "NOTES-TWO"),
        repeatedCompactionKeepsLatestNotes:
          onlyLatest(afterRepeat, SECOND, saved2.revision) &&
          !raw(afterRepeat).includes("NOTES-ONE"),
        immediateSaveIsLatestInFirstContinuation:
          output(immediateSave).status === "saved" &&
          effectiveNotes(afterImmediate?.body)?.notes === THIRD &&
          effectiveNotes(afterImmediate?.body)?.revision ===
            output(immediateSave).revision,
        immediateSaveSettlesIntoBaseline: onlyLatest(
          afterImmediateSettled,
          THIRD,
          output(immediateSave).revision,
        ),
        reloadedPluginServesSameNotes:
          a.instance !== originalInstance &&
          onlyLatest(afterReload, THIRD, output(immediateSave).revision) &&
          output(readAfterReload).status === "present" &&
          output(readAfterReload).notes === THIRD &&
          output(readAfterReload).revision === output(immediateSave).revision,
        clearAnnouncesRemoval:
          cleared.status === "cleared" &&
          effectiveNotes(afterClear?.body) === undefined &&
          notesMentions(afterClear?.body).some((text) =>
            /no longer applies/.test(text),
          ) &&
          clearPair?.extends === true,
        readAfterClearIsEmpty:
          output(readAfterClear).status === "empty" &&
          output(readAfterClear).notes === undefined,
        clearedNotesDoNotSurviveCompaction:
          afterCleared !== undefined &&
          blocks(afterCleared).length === 0 &&
          effectiveNotes(afterCleared.body) === undefined,
        immediateClearIsEffectiveInFirstContinuation:
          output(fourthSave).status === "saved" &&
          effectiveNotes(settledFourth?.body)?.notes === FOURTH &&
          output(immediateClear).status === "cleared" &&
          afterImmediateClear !== undefined &&
          effectiveNotes(afterImmediateClear.body) === undefined &&
          (baseline(afterImmediateClear).length === 0 ||
            notesMentions(afterImmediateClear.body).some((text) =>
              /no longer applies/.test(text),
            )) &&
          !finalEntries.some((entry) => object(entry).key === NOTES_KEY),
        otherSessionsNeverSeeNotes:
          allNonNotesSessions.every((item) => blocks(item).length === 0) &&
          output(otherRead).status === "empty" &&
          output(parentRead).status === "empty",
        idleSaveStartsNothing:
          output(idleSave).status === "saved" &&
          idleRequestsAfterSave === idleRequestsBefore &&
          idleRequestsAfterAll === idleRequestsBefore &&
          JSON.stringify(idleHistoryAfterSave) ===
            JSON.stringify(idleHistoryBefore) &&
          idleInbox.length === 0,
        readReturnsExactNotes:
          output(idleRead).status === "present" &&
          output(idleRead).notes === IDLE &&
          output(idleRead).revision === output(idleSave).revision,
        limitCountsCodePoints:
          output(atLimit).status === "saved" &&
          output(atLimit).codePoints === 8000 &&
          output(readAtLimit).notes === maxNotes,
        invalidInputChangesNothing:
          !overLimit.ok &&
          /1 to 8000/.test(errorText(overLimit)) &&
          !emptyNotes.ok &&
          !readWithNotes.ok &&
          output(readAfterRejects).revision === output(atLimit).revision,
        clearIsRepeatable:
          output(idleClear).status === "cleared" &&
          output(idleClearAgain).status === "cleared" &&
          output(idleReadCleared).status === "empty",
        foreignFormatBlocksReadAndSave:
          !foreignRead.ok &&
          !foreignSave.ok &&
          /Nothing was saved/.test(errorText(foreignSave)) &&
          foreignEntries.some(
            (entry) =>
              object(entry).key === NOTES_KEY &&
              object(object(entry).value).notes === "FOREIGN-VALUE",
          ),
        clearRecoversForeignEntry:
          output(foreignClear).status === "cleared" &&
          output(foreignAfterClear).status === "empty",
        stoppedChildBeforeNotes: latchBefore === "active",
        childNotesWorkAndDoNotLiftStop:
          output(childSave).status === "saved" &&
          output(childRead).notes === CHILD &&
          output(childClear).status === "cleared" &&
          latchAfter === "active",
        childNotesDoNotWake: childRequestsAfter === childRequestsBefore,
      };
      yield* finishScenario(
        dir,
        "context-notes",
        {
          sessionID: A,
          saved1,
          saved2,
          cleared,
          labels: captured.map((item) => ({
            index: item.index,
            sessionID: item.sessionID,
            label: item.label,
            compaction: item.compaction,
            blocks: blocks(item).map((block) => ({
              role: block.role,
              leading: block.leading,
              revision: block.value.revision,
            })),
          })),
          epochPairs,
          autoCompaction,
          immediateSave,
          immediateEffective: effectiveNotes(afterImmediate?.body),
          immediateBaseline: baseline(afterImmediate).map((block) => block.value.revision),
          immediateClear,
          immediateClearEffective: effectiveNotes(afterImmediateClear?.body),
          readAfterReload,
          readAfterClear,
          otherRead,
          idleSave,
          idleRead,
          overLimit,
          emptyNotes,
          readWithNotes,
          foreignRead,
          foreignSave,
          foreignClear,
          latchBefore,
          latchAfter,
          childSave,
          childRequestsBefore,
          childRequestsAfter,
          finalEntries,
          llmCount: readLlm(dir).length,
        },
        checks,
      );
    }),
);
