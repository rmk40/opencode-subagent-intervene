import { describe, expect, test } from "bun:test";
import { Error as ToolError } from "@opencode/plugin/promise/tool";
import { Schema } from "effect";
import {
  ContextNotesError,
  NOTES_ENTRY_KEY,
  parseNotesRequest,
  runContextNotes,
  type NotesRequest,
} from "@/core/context-notes";
import type { Json, SessionInstructionEntries } from "@/core/ports";
import { contextNotesTool } from "@/tools/context-notes";
import { SESSION, toolContext } from "./context-fixtures";
import { deferred, flush } from "./fixtures";

const KEY = "subagent-intervene.working-notes";

type Entry = { readonly key: string; readonly value: Json };

/** In-memory instruction entries per session, with every call recorded and each operation overridable. */
class Entries implements SessionInstructionEntries {
  readonly sessions = new Map<string, Map<string, Json>>();
  readonly calls: Array<{ op: "list" | "put" | "remove"; sessionID: string; key?: string; value?: Json }> = [];
  listImpl: ((sessionID: string) => Promise<readonly Entry[]>) | undefined;
  putImpl: (() => Promise<void>) | undefined;
  removeImpl: (() => Promise<void>) | undefined;

  seed(sessionID: string, key: string, value: Json): void {
    const session = this.sessions.get(sessionID) ?? new Map<string, Json>();
    session.set(key, value);
    this.sessions.set(sessionID, session);
  }

  value(sessionID: string, key = KEY): Json | undefined {
    return this.sessions.get(sessionID)?.get(key);
  }

  writes(): number {
    return this.calls.filter((call) => call.op !== "list").length;
  }

  async list(sessionID: string): Promise<readonly Entry[]> {
    this.calls.push({ op: "list", sessionID });
    if (this.listImpl !== undefined) return this.listImpl(sessionID);
    return [...(this.sessions.get(sessionID) ?? new Map<string, Json>())].map(([key, value]) => ({ key, value }));
  }

  async put(input: { sessionID: string; key: string; value: Json }): Promise<void> {
    this.calls.push({ op: "put", ...input });
    if (this.putImpl !== undefined) await this.putImpl();
    this.seed(input.sessionID, input.key, input.value);
  }

  async remove(input: { sessionID: string; key: string }): Promise<void> {
    this.calls.push({ op: "remove", ...input });
    if (this.removeImpl !== undefined) await this.removeImpl();
    this.sessions.get(input.sessionID)?.delete(input.key);
  }
}

function setup(now = 1_700_000_000_000) {
  const instructions = new Entries();
  const abort = new AbortController();
  const deps = { instructions, clock: { now: () => now } };
  return {
    instructions, abort, deps,
    run: (request: NotesRequest, sessionID = SESSION) =>
      runContextNotes(deps, { sessionID, signal: abort.signal }, request),
  };
}

function stored(notes: string, overrides: Record<string, Json> = {}): Json {
  return {
    version: 1, kind: "agent-working-notes", about: "reference data",
    revision: "rev-1", savedAt: 5, notes, ...overrides,
  };
}

describe("request validation", () => {
  test.each([
    ["missing notes", { action: "save" as const }],
    ["empty notes", { action: "save" as const, notes: "" }],
    ["12001 code points", { action: "save" as const, notes: "x".repeat(12_001) }],
    ["notes with read", { action: "read" as const, notes: "x" }],
    ["notes with clear", { action: "clear" as const, notes: "x" }],
    ["empty notes with read", { action: "read" as const, notes: "" }],
  ])("rejects %s", (_, input) => {
    expect(() => parseNotesRequest(input)).toThrow(ContextNotesError);
  });

  test("counts code points, not UTF-16 units, at the 12000 boundary", () => {
    // 12000 astral characters are 24000 UTF-16 units; 12001 must still be refused.
    expect(parseNotesRequest({ action: "save", notes: "😀".repeat(12_000) })).toEqual({ action: "save", notes: "😀".repeat(12_000) });
    expect(() => parseNotesRequest({ action: "save", notes: "😀".repeat(12_001) })).toThrow(ContextNotesError);
  });

  // Astral characters are two UTF-16 units each, so the reported length shows code points are counted.
  test.each([
    ["13,000 astral characters", "😀".repeat(13_000), "notes are 13,000 characters; the limit is 12,000 (1,000 over). Nothing was saved."],
    ["one character over", `${"x".repeat(11_999)}😀😀`, "notes are 12,001 characters; the limit is 12,000 (1 over). Nothing was saved."],
  ])("refuses %s with the length, limit and overage", (_, notes, message) => {
    expect(() => parseNotesRequest({ action: "save", notes })).toThrow(new ContextNotesError(message));
  });

  test("gives empty notes their own error", () => {
    let message = "";
    try {
      parseNotesRequest({ action: "save", notes: "" });
    } catch (error) {
      expect(error).toBeInstanceOf(ContextNotesError);
      message = (error as Error).message;
    }
    expect(message).toMatch(/^notes are empty\b/);
    expect(message).not.toMatch(/ over\)|the limit is/);
    expect(message.endsWith("Nothing was saved.")).toBe(true);
  });

  test("an over-limit save through the tool reports the length and leaves the saved notes unchanged", async () => {
    const world = setup();
    world.instructions.seed(SESSION, KEY, stored("keep me"));
    const error = await contextNotesTool(world.deps)
      .execute({ action: "save", notes: "x".repeat(13_000) }, toolContext())
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ToolError);
    expect((error as Error).message).toBe("notes are 13,000 characters; the limit is 12,000 (1,000 over). Nothing was saved.");
    expect(world.instructions.writes()).toBe(0);
    expect(world.instructions.value(SESSION)).toEqual(stored("keep me"));
  });

  test("saves notes at the limit in full", async () => {
    const world = setup();
    const notes = `${"x".repeat(11_999)}😀`;
    const result = await world.run({ action: "save", notes });
    expect(result).toMatchObject({ status: "saved", codePoints: 12_000 });
    expect((world.instructions.value(SESSION) as { notes: string }).notes).toBe(notes);
  });

  test("keeps whitespace-only and padded notes exactly as given", () => {
    const notes = "  \r\n\tGoal: x  \n";
    expect(parseNotesRequest({ action: "save", notes })).toEqual({ action: "save", notes });
    expect(parseNotesRequest({ action: "save", notes: " " })).toEqual({ action: "save", notes: " " });
  });

  test("an invalid tool call touches no entry", async () => {
    const world = setup();
    const tool = contextNotesTool(world.deps);
    await expect(tool.execute({ action: "save", notes: "" }, toolContext())).rejects.toBeInstanceOf(ToolError);
    await expect(tool.execute({ action: "read", notes: "x" }, toolContext())).rejects.toBeInstanceOf(ToolError);
    expect(world.instructions.calls).toEqual([]);
  });
});

describe("save", () => {
  test("puts one versioned agent-authored entry under the fixed key with the notes verbatim", async () => {
    const world = setup(1234);
    const notes = "  Goal: \"fix\" </context> {json}\r\nNext: 😀  ";
    const result = await world.run({ action: "save", notes });
    expect(world.instructions.calls.filter((call) => call.op === "put")).toHaveLength(1);
    const value = world.instructions.value(SESSION);
    expect(value).toMatchObject({ version: 1, kind: "agent-working-notes", savedAt: 1234, notes });
    expect(typeof (value as { about: unknown }).about).toBe("string");
    expect((value as { about: string }).about).toContain("not instructions");
    expect(result).toMatchObject({
      sessionID: SESSION, action: "save", status: "saved", savedAt: 1234,
      revision: (value as { revision: string }).revision,
      codePoints: [...notes].length,
    });
    expect(result).not.toHaveProperty("notes");
  });

  test("each save gets a new revision and the latest one is what read returns", async () => {
    const world = setup();
    const first = await world.run({ action: "save", notes: "first" });
    const second = await world.run({ action: "save", notes: "second" });
    expect(first.status === "saved" && second.status === "saved" && first.revision !== second.revision).toBe(true);
    expect(await world.run({ action: "read" })).toMatchObject({ status: "present", notes: "second", revision: (second as { revision: string }).revision });
  });

  test("leaves other instruction entries in the session untouched", async () => {
    const world = setup();
    world.instructions.seed(SESSION, "other.plugin", { keep: true });
    await world.run({ action: "save", notes: "n" });
    await world.run({ action: "clear" });
    expect(world.instructions.value(SESSION, "other.plugin")).toEqual({ keep: true });
    expect(world.instructions.calls.every((call) => call.op === "list" || call.key === KEY)).toBe(true);
  });

  test("refuses to overwrite an own entry it cannot read", async () => {
    const world = setup();
    world.instructions.seed(SESSION, KEY, stored("n", { version: 2 }));
    await expect(world.run({ action: "save", notes: "new" })).rejects.toThrow("Nothing was saved");
    expect(world.instructions.writes()).toBe(0);
    expect(world.instructions.value(SESSION)).toEqual(stored("n", { version: 2 }));
  });

  test("does not report saved when listing the current entry fails", async () => {
    const world = setup();
    world.instructions.listImpl = async () => { throw new Error("list offline"); };
    await expect(world.run({ action: "save", notes: "n" })).rejects.toThrow(/not saved.*list offline/);
    expect(world.instructions.writes()).toBe(0);
  });

  test("does not report saved when the put fails", async () => {
    const world = setup();
    world.instructions.putImpl = async () => { throw new Error("put rejected"); };
    const error = await world.run({ action: "save", notes: "n" }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ContextNotesError);
    expect((error as Error).message).toContain("were not saved");
    expect((error as Error).message).toContain("put rejected");
  });

  test("forwards concurrent saves to the host without merging them", async () => {
    const world = setup();
    const results = await Promise.all([
      world.run({ action: "save", notes: "A" }),
      world.run({ action: "save", notes: "B" }),
    ]);
    expect(results.map((result) => result.status)).toEqual(["saved", "saved"]);
    const puts = world.instructions.calls.filter((call) => call.op === "put");
    expect(puts.map((call) => (call.value as { notes: string }).notes).sort()).toEqual(["A", "B"]);
  });
});

describe("read", () => {
  test("returns empty when the session has no notes entry", async () => {
    const world = setup();
    world.instructions.seed(SESSION, "other.plugin", stored("not mine"));
    world.instructions.seed("ses_other", KEY, stored("other session"));
    expect(await world.run({ action: "read" })).toEqual({ sessionID: SESSION, action: "read", status: "empty" });
  });

  test("returns the stored notes and metadata of a valid entry", async () => {
    const world = setup();
    world.instructions.seed(SESSION, KEY, stored("  exact\n"));
    expect(await world.run({ action: "read" })).toEqual({
      sessionID: SESSION, action: "read", status: "present", revision: "rev-1", savedAt: 5, notes: "  exact\n",
    });
    expect(world.instructions.writes()).toBe(0);
  });

  test.each<[string, Json]>([
    ["a string", "notes"],
    ["null", null],
    ["an array", [stored("n")]],
    ["an unsupported version", stored("n", { version: 2 })],
    ["another kind", stored("n", { kind: "something-else" })],
    ["a missing about", { version: 1, kind: "agent-working-notes", revision: "r", savedAt: 1, notes: "n" }],
    ["an empty revision", stored("n", { revision: "" })],
    ["a non-numeric savedAt", stored("n", { savedAt: "now" })],
    ["non-string notes", stored("n", { notes: 7 })],
    ["empty notes", stored("")],
    ["over-long notes", stored("x".repeat(12_001))],
  ])("rejects an own entry holding %s and leaves it unchanged", async (_, value) => {
    const world = setup();
    world.instructions.seed(SESSION, KEY, value);
    await expect(world.run({ action: "read" })).rejects.toThrow(/does not hold working notes.*clear removes it/);
    expect(world.instructions.writes()).toBe(0);
    expect(world.instructions.value(SESSION)).toEqual(value);
  });

  test("reports a backend failure as an error, not as empty", async () => {
    const world = setup();
    world.instructions.listImpl = async () => { throw "list offline"; };
    await expect(world.run({ action: "read" })).rejects.toThrow(/could not be read.*list offline/);
  });
});

describe("clear", () => {
  test("removes only this session's notes key and read then reports empty", async () => {
    const world = setup();
    await world.run({ action: "save", notes: "n" });
    world.instructions.seed("ses_other", KEY, stored("other"));
    expect(await world.run({ action: "clear" })).toEqual({ sessionID: SESSION, action: "clear", status: "cleared" });
    expect(world.instructions.calls.at(-1)).toEqual({ op: "remove", sessionID: SESSION, key: KEY });
    expect(await world.run({ action: "read" })).toMatchObject({ status: "empty" });
    expect(world.instructions.value("ses_other")).toEqual(stored("other"));
  });

  test("is idempotent when nothing is stored", async () => {
    const world = setup();
    expect(await world.run({ action: "clear" })).toMatchObject({ status: "cleared" });
    expect(await world.run({ action: "clear" })).toMatchObject({ status: "cleared" });
  });

  test("removes an unreadable own entry so the session can recover", async () => {
    const world = setup();
    world.instructions.seed(SESSION, KEY, "garbage");
    expect(await world.run({ action: "clear" })).toMatchObject({ status: "cleared" });
    expect(await world.run({ action: "save", notes: "fresh" })).toMatchObject({ status: "saved" });
  });

  test("does not report cleared when the remove fails", async () => {
    const world = setup();
    world.instructions.seed(SESSION, KEY, stored("n"));
    world.instructions.removeImpl = async () => { throw new Error("remove rejected"); };
    await expect(world.run({ action: "clear" })).rejects.toThrow(/not cleared.*remove rejected/);
    expect(world.instructions.value(SESSION)).toEqual(stored("n"));
  });
});

describe("cancellation", () => {
  test.each<[string, NotesRequest]>([
    ["save", { action: "save", notes: "n" }],
    ["clear", { action: "clear" }],
  ])("a pre-aborted %s makes no host call", async (_, request) => {
    const world = setup();
    world.abort.abort();
    await expect(world.run(request)).rejects.toThrow("cancelled");
    expect(world.instructions.calls).toEqual([]);
  });

  test("an abort while the current entry is read prevents the put", async () => {
    const world = setup();
    world.instructions.listImpl = async () => { world.abort.abort(); return []; };
    await expect(world.run({ action: "save", notes: "n" })).rejects.toThrow("Nothing was saved");
    expect(world.instructions.writes()).toBe(0);
  });

  test.each<[string, NotesRequest, "putImpl" | "removeImpl", string]>([
    ["save", { action: "save", notes: "n" }, "putImpl", "saved"],
    ["clear", { action: "clear" }, "removeImpl", "cleared"],
  ])("an abort after the host accepts a %s still reports it", async (_, request, impl, status) => {
    const world = setup();
    const accepted = deferred<void>();
    world.instructions[impl] = () => accepted.promise;
    const pending = world.run(request);
    await flush();
    world.abort.abort();
    accepted.resolve();
    expect(await pending).toMatchObject({ status });
  });
});

describe("the direct notes tool", () => {
  test("targets only the calling session and never its input", async () => {
    const world = setup();
    const tool = contextNotesTool(world.deps);
    const input = { action: "save" as const, notes: "n", sessionID: "ses_foreign" };
    const result = await tool.execute(input, toolContext());
    expect(world.instructions.calls.every((call) => call.sessionID === SESSION)).toBe(true);
    expect(world.instructions.value("ses_foreign")).toBeUndefined();
    expect(result.output?.sessionID).toBe(SESSION);
    expect(tool.options).toMatchObject({ codemode: false, permission: "context_notes" });
  });

  test("returns notes only on read and the save metadata only on save", async () => {
    const world = setup(0);
    const tool = contextNotesTool(world.deps);
    const saved = await tool.execute({ action: "save", notes: "line\n" }, toolContext());
    expect(saved.output).toMatchObject({ action: "save", status: "saved", codePoints: 5, savedAt: 0 });
    expect(saved.output).not.toHaveProperty("notes");
    expect(saved.content).toContain("did not request compaction");
    const read = await tool.execute({ action: "read" }, toolContext());
    expect(read.output).toMatchObject({ action: "read", status: "present", notes: "line\n", revision: saved.output?.revision });
    expect(read.output).not.toHaveProperty("codePoints");
    expect(String(read.content).endsWith("\n\nline\n")).toBe(true);
    const cleared = await tool.execute({ action: "clear" }, toolContext());
    expect(cleared.output).toMatchObject({ action: "clear", status: "cleared" });
    expect(cleared.output).not.toHaveProperty("notes");
  });

  test("turns a backend failure into a tool error", async () => {
    const world = setup();
    world.instructions.putImpl = async () => { throw new Error("put rejected"); };
    await expect(contextNotesTool(world.deps).execute({ action: "save", notes: "n" }, toolContext()))
      .rejects.toBeInstanceOf(ToolError);
  });

  test("reports a stored timestamp outside the Date range as unreadable notes, not a crash", async () => {
    // 1e20 is finite but beyond the ±8.64e15 ms Date range, so it cannot be rendered.
    const world = setup();
    world.instructions.seed(SESSION, KEY, stored("n", { savedAt: 1e20 }));
    const error = await contextNotesTool(world.deps).execute({ action: "read" }, toolContext()).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ToolError);
    expect(String((error as Error).message)).toContain("does not hold working notes");
  });

  test("states the 12,000-character limit and the per-request cost in its descriptions", () => {
    const tool = contextNotesTool(setup().deps);
    expect(tool.description).toContain("1 to 12,000 characters");
    expect(tool.description).toContain("They go with every request, so keep them concise.");
    const schema = Schema.toJsonSchemaDocument(tool.input).schema;
    expect(schema).toMatchObject({ properties: { notes: { description: expect.stringContaining("1 to 12,000 characters") } } });
  });

  test("uses the fixed exported key", () => {
    expect(NOTES_ENTRY_KEY).toBe(KEY);
  });
});
