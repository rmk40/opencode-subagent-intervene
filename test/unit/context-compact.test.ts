import { describe, expect, test } from "bun:test";
import { Error as ToolError } from "@opencode/plugin/promise/tool";
import { Schema } from "effect";
import {
  CompactionError,
  isSelfCompactionID,
  requestSelfCompaction,
  selfCompactionID,
} from "@/core/compaction";
import type { CompactionAdmission, SessionCompactor, SyntheticMessage } from "@/core/ports";
import { contextCompactTool } from "@/tools/context-compact";
import { SESSION, toolContext } from "./context-fixtures";
import { deferred, flush, RecordingMessenger } from "./fixtures";

type Request = Parameters<SessionCompactor["compact"]>[0];

class Compactor implements SessionCompactor {
  readonly requests: Request[] = [];
  impl: (input: Request) => Promise<CompactionAdmission> = async () => ({ id: "msg_admitted", delivery: "steer" });

  compact(input: Request): Promise<CompactionAdmission> {
    this.requests.push(input);
    return this.impl(input);
  }
}

function setup() {
  const compactor = new Compactor();
  const messenger = new RecordingMessenger();
  const abort = new AbortController();
  return {
    compactor, messenger, abort,
    request: (handoff?: string) => requestSelfCompaction(
      { compactor, messenger }, { sessionID: SESSION, signal: abort.signal }, handoff,
    ),
  };
}

describe("self-compaction admission", () => {
  test("uses a fresh recognizable msg_ ID for every call", () => {
    const first = selfCompactionID();
    const second = selfCompactionID();
    expect(first).toMatch(/^msg_.+self_compaction_.+/);
    expect(second).not.toBe(first);
    expect(isSelfCompactionID(first)).toBe(true);
    expect(isSelfCompactionID(second)).toBe(true);
    expect(isSelfCompactionID("msg_external_compaction")).toBe(false);
    expect(isSelfCompactionID(`prefix_${first}`)).toBe(false);
  });

  test("returns the actual admitted request without adding a continuation message", async () => {
    const world = setup();
    const result = await world.request();
    expect(world.compactor.requests).toHaveLength(1);
    expect(world.compactor.requests[0]).toMatchObject({ sessionID: SESSION, delivery: "steer" });
    expect(isSelfCompactionID(world.compactor.requests[0]?.id ?? "")).toBe(true);
    expect(result).toMatchObject({ sessionID: SESSION, id: "msg_admitted", delivery: "steer", status: "requested", handoff: { status: "omitted" } });
    expect(world.messenger.posts).toEqual([]);
    expect(result.note).toContain("after all current tool calls settle");
    expect(result.note).toContain("Admission does not confirm completion");
    expect(result.note).toContain("Summary generation can still fail");
  });

  test("does not admit handoff notes until compaction admission resolves", async () => {
    const world = setup();
    const admission = deferred<CompactionAdmission>();
    world.compactor.impl = () => admission.promise;
    let settled = false;
    const result = world.request("Goal: fix imports.\nNext: run the unit suite.").then((value) => { settled = true; return value; });
    await flush();
    expect(world.compactor.requests).toHaveLength(1);
    expect(world.messenger.posts).toEqual([]);
    expect(settled).toBe(false);
    admission.resolve({ id: "msg_actual", delivery: "steer" });
    const output = await result;
    expect(output.handoff).toEqual({ status: "stored", messageID: "msg_posted_1" });
    expect(world.messenger.posts).toEqual([{
      sessionID: SESSION,
      text: "Agent-written working notes for compaction msg_actual\n\nGoal: fix imports.\nNext: run the unit suite.",
      description: "Agent-written compaction handoff",
      metadata: { plugin: "subagent-intervene", kind: "context-handoff", compactionID: "msg_actual" },
      delivery: "steer", resume: false,
    }]);
    expect(output.note).toContain("normally arrive after the compaction checkpoint");
    expect(output.note).toContain("ordinary context priority");
  });

  test("awaits note admission too, then returns without waiting for compaction execution", async () => {
    const world = setup();
    const notes = deferred<{ id: string; createdAt: number }>();
    const posts: SyntheticMessage[] = [];
    let settled = false;
    const pending = requestSelfCompaction({
      compactor: world.compactor,
      messenger: { synthetic: (post) => { posts.push(post); return notes.promise; } },
    }, { sessionID: SESSION, signal: world.abort.signal }, "Continue at import resolution").then((result) => { settled = true; return result; });
    await flush();
    expect(posts).toHaveLength(1);
    expect(settled).toBe(false);
    notes.resolve({ id: "msg_notes_admitted", createdAt: 100 });
    expect((await pending).handoff).toEqual({ status: "stored", messageID: "msg_notes_admitted" });
    expect(settled).toBe(true);
  });

  test.each([undefined, "Keep the next step"])(
    "preserves a coalesced queued request and explains its scheduling with handoff %p",
    async (handoff) => {
      const world = setup();
      world.compactor.impl = async () => ({ id: "msg_external_pending", delivery: "queue" });
      const result = await world.request(handoff);
      expect(result.id).toBe("msg_external_pending");
      expect(result.delivery).toBe("queue");
      expect(world.compactor.requests).toHaveLength(1);
      expect(result.note).toContain("existing request remains queued");
      expect(result.note).toContain("not upgraded");
      if (handoff !== undefined) {
        expect(world.messenger.posts[0]).toMatchObject({
          delivery: "steer", resume: false, metadata: { compactionID: "msg_external_pending" },
        });
        expect(result.note).toContain("can arrive before the queued compaction");
      }
    },
  );

  test("simultaneous calls preserve a host-coalesced ID without retrying or merging their notes", async () => {
    const world = setup();
    const admission = deferred<CompactionAdmission>();
    world.compactor.impl = () => admission.promise;
    const pending = [world.request("notes A"), world.request("notes B")];
    expect(world.compactor.requests).toHaveLength(2);
    expect(new Set(world.compactor.requests.map((request) => request.id)).size).toBe(2);
    admission.resolve({ id: "msg_one_pending", delivery: "queue" });
    const results = await Promise.all(pending);
    expect(results.map((result) => result.id)).toEqual(["msg_one_pending", "msg_one_pending"]);
    expect(world.messenger.posts).toHaveLength(2);
    expect(world.messenger.posts.every((post) => post.metadata["compactionID"] === "msg_one_pending")).toBe(true);
    expect(results.map((result) => result.handoff)).toEqual([
      { status: "stored", messageID: "msg_posted_1" }, { status: "stored", messageID: "msg_posted_2" },
    ]);
  });
});

describe("handoff validation and admission failures", () => {
  test.each([["empty", ""], ["too long", "x".repeat(16_001)]])("rejects a %s handoff before either admission", async (_, handoff) => {
    const world = setup();
    await expect(world.request(handoff)).rejects.toBeInstanceOf(CompactionError);
    expect(world.compactor.requests).toEqual([]);
    expect(world.messenger.posts).toEqual([]);
  });

  test.each([["one character", "x"], ["16000 astral characters", "😀".repeat(16_000)]])("accepts %s and preserves the handoff content", async (_, handoff) => {
    const world = setup();
    const result = await world.request(handoff);
    expect(result.handoff.status).toBe("stored");
    expect(world.messenger.posts[0]?.text.endsWith(`\n\n${handoff}`)).toBe(true);
  });

  // Astral characters are two UTF-16 units each, so the reported length shows code points are counted.
  test.each([
    ["21,105 astral characters", "😀".repeat(21_105), "handoff is 21,105 characters; the limit is 16,000 (5,105 over). Nothing was requested."],
    ["one character over", `${"x".repeat(15_999)}😀😀`, "handoff is 16,001 characters; the limit is 16,000 (1 over). Nothing was requested."],
  ])("refuses %s with the length, limit and overage", async (_, handoff, message) => {
    const world = setup();
    const error = await world.request(handoff).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(CompactionError);
    expect((error as Error).message).toBe(message);
    expect(world.compactor.requests).toEqual([]);
    expect(world.messenger.posts).toEqual([]);
  });

  test("gives an empty handoff its own error", async () => {
    const world = setup();
    const error = await world.request("").catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(CompactionError);
    expect((error as Error).message).toMatch(/^handoff is empty\b/);
    expect((error as Error).message).not.toMatch(/ over\)|the limit is/);
    expect((error as Error).message.endsWith("Nothing was requested.")).toBe(true);
  });

  test.each([new Error("host unavailable"), "host unavailable"])(
    "reports compaction admission failure %p without admitting notes or retrying",
    async (error) => {
      const world = setup();
      world.compactor.impl = async () => { throw error; };
      await expect(world.request("notes")).rejects.toThrow("Compaction admission failed. host unavailable");
      expect(world.compactor.requests).toHaveLength(1);
      expect(world.messenger.posts).toEqual([]);
    },
  );

  test("reports a successful partial result when compaction was admitted but notes failed", async () => {
    const world = setup();
    world.messenger.failing = true;
    const result = await world.request("notes");
    expect(result).toMatchObject({
      status: "requested", id: "msg_admitted", delivery: "steer",
      handoff: { status: "failed", error: "synthetic failed" },
    });
    expect(result.note).toContain("Compaction is already requested, but the notes were not stored");
    expect(result.note).toContain("Do not repeat the whole operation");
    expect(world.compactor.requests).toHaveLength(1);
  });
});

describe("cancellation at admission boundaries", () => {
  test("a pre-aborted call admits neither compaction nor notes", async () => {
    const world = setup();
    world.abort.abort();
    await expect(world.request("notes")).rejects.toThrow("Compaction was not requested");
    expect(world.compactor.requests).toEqual([]);
    expect(world.messenger.posts).toEqual([]);
  });

  test("an abort during compaction admission retains its ID and fails only the handoff", async () => {
    const world = setup();
    const admission = deferred<CompactionAdmission>();
    world.compactor.impl = () => admission.promise;
    const pending = world.request("notes");
    world.abort.abort();
    admission.resolve({ id: "msg_already_admitted", delivery: "steer" });
    const result = await pending;
    expect(result).toMatchObject({ status: "requested", id: "msg_already_admitted", handoff: { status: "failed" } });
    expect(result.note).toContain("cancelled before the notes could be stored");
    expect(world.messenger.posts).toEqual([]);
  });

  test("an abort after admission without notes still returns the accepted request", async () => {
    const world = setup();
    world.compactor.impl = async () => { world.abort.abort(); return { id: "msg_accepted", delivery: "queue" }; };
    const result = await world.request();
    expect(result).toMatchObject({ status: "requested", id: "msg_accepted", handoff: { status: "omitted" } });
  });

  test("does not misreport already admitted notes when cancellation arrives during their admission", async () => {
    const world = setup();
    const result = await requestSelfCompaction({
      compactor: world.compactor,
      messenger: { synthetic: async (post) => {
        world.abort.abort();
        return world.messenger.synthetic(post);
      } },
    }, { sessionID: SESSION, signal: world.abort.signal }, "next step");
    expect(result.handoff).toEqual({ status: "stored", messageID: "msg_posted_1" });
    expect(world.messenger.posts).toHaveLength(1);
  });
});

describe("the direct compaction tool", () => {
  test("derives its target only from the tool context and has its own direct permission", async () => {
    const world = setup();
    const tool = contextCompactTool(world);
    const input = { handoff: "next step", sessionID: "ses_foreign" };
    const result = await tool.execute(input, toolContext());
    expect(world.compactor.requests[0]?.sessionID).toBe(SESSION);
    expect(world.messenger.posts[0]?.sessionID).toBe(SESSION);
    expect(result.output?.sessionID).toBe(SESSION);
    expect(tool.options).toMatchObject({ codemode: false, permission: "context_compact" });
    expect(result.content).toContain("msg_admitted");
    expect(result.content).toContain("msg_posted_1");
  });

  test("refuses an over-limit handoff as a tool error with the length message and requests nothing", async () => {
    const world = setup();
    const error = await contextCompactTool(world).execute({ handoff: "x".repeat(21_105) }, toolContext()).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ToolError);
    expect((error as Error).message).toBe("handoff is 21,105 characters; the limit is 16,000 (5,105 over). Nothing was requested.");
    expect(world.compactor.requests).toEqual([]);
    expect(world.messenger.posts).toEqual([]);
  });

  test("states the 16,000-character handoff limit in the input description", () => {
    const schema = Schema.toJsonSchemaDocument(contextCompactTool(setup()).input).schema;
    expect(schema).toMatchObject({ properties: { handoff: { description: expect.stringContaining("1 to 16,000 characters") } } });
  });

  test("turns admission failure into a tool error", async () => {
    const world = setup();
    world.compactor.impl = async () => { throw new Error("admission offline"); };
    await expect(contextCompactTool(world).execute({}, toolContext())).rejects.toBeInstanceOf(ToolError);
    expect(world.messenger.posts).toEqual([]);
  });

  test("keeps a note-admission failure as successful structured partial output", async () => {
    const world = setup();
    world.messenger.failing = true;
    const result = await contextCompactTool(world).execute({ handoff: "next step" }, toolContext());
    expect(result.output).toMatchObject({ id: "msg_admitted", status: "requested", handoff: { status: "failed" } });
    expect(result.content).toContain("notes were not stored");
  });
});
