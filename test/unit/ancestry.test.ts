import { describe, expect, test } from "bun:test";
import {
  assertDescendant,
  collectSubtree,
  collectSubtreeTruncated,
  difference,
  dropNested,
  MAX_ANCESTRY_HOPS,
  MAX_SCAN_SESSIONS,
  MAX_SUBTREE_DEPTH,
  MAX_SUBTREE_SESSIONS,
  NotDescendantError,
  postOrder,
  scanDirectChildren,
  SelfTargetError,
  SubtreeTooLargeError,
  type Descendant,
} from "@/core/ancestry";
import type { SessionInfo } from "@/core/ports";
import { FakeSessionReader, sessionInfo } from "./fixtures";

const CALLER = "caller";

/** A descendant as `assertDescendant` or a walk reports it. `ancestors` starts at the caller. */
function node(id: string, ancestors: readonly string[]): Descendant {
  const parentID = ancestors[ancestors.length - 1] ?? CALLER;
  return {
    id,
    info: sessionInfo(id, parentID),
    parentID,
    depth: ancestors.length,
    ancestors,
  };
}

/** `count` sessions, each the child of the one before, the first a child of `parentID`. */
function chain(count: number, parentID: string, prefix: string): SessionInfo[] {
  const sessions: SessionInfo[] = [];
  let parent = parentID;
  for (let index = 1; index <= count; index++) {
    const id = `${prefix}${index}`;
    sessions.push(sessionInfo(id, parent));
    parent = id;
  }
  return sessions;
}

function children(count: number, parentID: string): SessionInfo[] {
  return Array.from({ length: count }, (_, index) =>
    sessionInfo(`${parentID}-${index}`, parentID),
  );
}

/**
 * `count` children of the caller named `c1`, `c2`, … and updated in that order, so `c<count>` is
 * the most recently updated.
 */
function updatedChildren(count: number): SessionInfo[] {
  return Array.from({ length: count }, (_, index) =>
    sessionInfo(`c${index + 1}`, CALLER, { updated: index + 1 }),
  );
}

/** `c<from>`, `c<from - 1>`, … down to `c<to>`. */
function newestDown(from: number, to: number): string[] {
  return Array.from(
    { length: from - to + 1 },
    (_, index) => `c${from - index}`,
  );
}

async function rejection(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof Error) return error;
    throw new Error(`rejected with a non-Error: ${String(error)}`);
  }
  throw new Error("expected the promise to reject");
}

function ids(nodes: readonly Descendant[]): string[] {
  return nodes.map((entry) => entry.id);
}

describe("assertDescendant", () => {
  // top ─┬─ caller ── child ── grandchild
  //      └─ sibling ── nephew
  // stranger (no parent)
  const family = () =>
    new FakeSessionReader([
      sessionInfo("top"),
      sessionInfo(CALLER, "top"),
      sessionInfo("sibling", "top"),
      sessionInfo("nephew", "sibling"),
      sessionInfo("child", CALLER),
      sessionInfo("grandchild", "child"),
      sessionInfo("stranger"),
    ]);

  test("accepts a direct child", async () => {
    const result = await assertDescendant(family(), "child", CALLER);
    expect(result).toEqual({
      id: "child",
      info: sessionInfo("child", CALLER),
      parentID: CALLER,
      depth: 1,
      ancestors: [CALLER],
    });
  });

  test("accepts a grandchild and reports its chain from the caller", async () => {
    const result = await assertDescendant(family(), "grandchild", CALLER);
    expect(result).toMatchObject({
      id: "grandchild",
      parentID: "child",
      depth: 2,
      ancestors: [CALLER, "child"],
    });
  });

  test("rejects the caller itself with SelfTargetError", async () => {
    const error = await rejection(assertDescendant(family(), CALLER, CALLER));
    expect(error).toBeInstanceOf(SelfTargetError);
  });

  test.each([
    ["a sibling", "sibling"],
    ["a sibling's child", "nephew"],
    ["the caller's own parent", "top"],
    ["an unrelated session", "stranger"],
    ["a missing session", "missing"],
  ])("rejects %s with NotDescendantError", async (_, target) => {
    const error = await rejection(assertDescendant(family(), target, CALLER));
    expect(error).toBeInstanceOf(NotDescendantError);
  });

  test("gives a missing session the same message as one that exists but is not a descendant", async () => {
    const missing = await rejection(
      assertDescendant(new FakeSessionReader([]), "target", CALLER),
    );
    const unrelated = await rejection(
      assertDescendant(
        new FakeSessionReader([sessionInfo("target", "someone-else")]),
        "target",
        CALLER,
      ),
    );
    expect(missing.message).toBe(unrelated.message);
  });

  test("rejects a target whose chain breaks at a missing ancestor", async () => {
    const reader = new FakeSessionReader([sessionInfo("orphan", "gone")]);
    const error = await rejection(assertDescendant(reader, "orphan", CALLER));
    expect(error).toBeInstanceOf(NotDescendantError);
  });

  test.each([
    ["a two-session cycle", [sessionInfo("a", "b"), sessionInfo("b", "a")]],
    ["a session that is its own parent", [sessionInfo("a", "a")]],
    [
      "a cycle above the target",
      [sessionInfo("a", "b"), sessionInfo("b", "c"), sessionInfo("c", "b")],
    ],
  ])("rejects %s instead of looping", async (_, sessions) => {
    const error = await rejection(
      assertDescendant(new FakeSessionReader(sessions), "a", CALLER),
    );
    expect(error).toBeInstanceOf(NotDescendantError);
  });

  test("accepts a target 32 hops below the caller", async () => {
    const sessions = chain(MAX_ANCESTRY_HOPS, CALLER, "n");
    const result = await assertDescendant(
      new FakeSessionReader(sessions),
      `n${MAX_ANCESTRY_HOPS}`,
      CALLER,
    );
    expect(result.depth).toBe(32);
    expect(result.ancestors[0]).toBe(CALLER);
    expect(result.parentID).toBe("n31");
  });

  test("rejects a target 33 hops below the caller", async () => {
    const sessions = chain(MAX_ANCESTRY_HOPS + 1, CALLER, "n");
    const error = await rejection(
      assertDescendant(new FakeSessionReader(sessions), "n33", CALLER),
    );
    expect(error).toBeInstanceOf(NotDescendantError);
  });
});

describe("scanDirectChildren", () => {
  test("pages through every direct child and returns them most recently updated first", async () => {
    const reader = new FakeSessionReader(
      [...updatedChildren(5), sessionInfo("grandchild", "c1")],
      2,
    );
    const result = await scanDirectChildren(reader, CALLER);
    expect(ids(result.nodes)).toEqual(newestDown(5, 1));
    expect(result.truncated).toBe(false);
    for (const entry of result.nodes) {
      expect(entry).toMatchObject({
        parentID: CALLER,
        depth: 1,
        ancestors: [CALLER],
      });
    }
  });

  test("reads the children once, oldest first, when there are exactly maxSessions", async () => {
    const reader = new FakeSessionReader(updatedChildren(3));
    const result = await scanDirectChildren(reader, CALLER, {
      maxSessions: 3,
    });
    expect(reader.reads).toEqual([{ parentID: CALLER, order: "asc" }]);
    expect(result.truncated).toBe(false);
    expect(ids(result.nodes)).toEqual(newestDown(3, 1));
  });

  test("keeps the maxSessions most recently updated children when there are more, and reports the cut", async () => {
    // Read oldest first, the scan stops at c4, so c7 to c5 can only come from a newest-first read.
    const reader = new FakeSessionReader(updatedChildren(7), 2);
    const result = await scanDirectChildren(reader, CALLER, {
      maxSessions: 3,
    });
    expect(ids(result.nodes)).toEqual(newestDown(7, 5));
    expect(result.truncated).toBe(true);
  });

  test(`reads ${MAX_SCAN_SESSIONS} children by default without a cut`, async () => {
    const reader = new FakeSessionReader(updatedChildren(MAX_SCAN_SESSIONS));
    const result = await scanDirectChildren(reader, CALLER);
    expect(result.nodes).toHaveLength(MAX_SCAN_SESSIONS);
    expect(result.truncated).toBe(false);
  });

  test(`drops the least recently updated of ${MAX_SCAN_SESSIONS + 1} children by default`, async () => {
    const reader = new FakeSessionReader(
      updatedChildren(MAX_SCAN_SESSIONS + 1),
    );
    const result = await scanDirectChildren(reader, CALLER);
    expect(result.truncated).toBe(true);
    expect(ids(result.nodes)).toEqual(newestDown(MAX_SCAN_SESSIONS + 1, 2));
  });

  test("lists a child once when it shows up on two pages, and counts it once toward the cap", async () => {
    const reader = new FakeSessionReader([]);
    const a = sessionInfo("a", CALLER);
    const b = sessionInfo("b", CALLER);
    reader.listings.set(CALLER, (cursor) =>
      cursor === undefined ? { data: [a, b], next: "2" } : { data: [b] },
    );
    const result = await scanDirectChildren(reader, CALLER, {
      maxSessions: 2,
    });
    expect(ids(result.nodes)).toEqual(["a", "b"]);
    expect(result.truncated).toBe(false);
  });

  test("skips listing entries whose parent is another session, and does not count them toward the cap", async () => {
    const reader = new FakeSessionReader([]);
    reader.listings.set(CALLER, () => ({
      data: [
        sessionInfo("mine", CALLER),
        sessionInfo("theirs", "someone-else"),
      ],
    }));
    const result = await scanDirectChildren(reader, CALLER, {
      maxSessions: 1,
    });
    expect(ids(result.nodes)).toEqual(["mine"]);
    expect(result.truncated).toBe(false);
  });

  test("ends the listing when a cursor repeats", async () => {
    const reader = new FakeSessionReader([]);
    let page = 0;
    reader.listings.set(CALLER, () => {
      page++;
      return { data: [sessionInfo(`page-${page}`, CALLER)], next: "same" };
    });
    expect(ids((await scanDirectChildren(reader, CALLER)).nodes)).toEqual([
      "page-1",
      "page-2",
    ]);
  });
});

describe("collectSubtree", () => {
  // caller ─┬─ A ─┬─ A1 ── A1a
  //         │     └─ A2
  //         └─ B ── B1
  const tree = (pageSize = 100) =>
    new FakeSessionReader(
      [
        sessionInfo("A", CALLER),
        sessionInfo("B", CALLER),
        sessionInfo("A1", "A"),
        sessionInfo("A2", "A"),
        sessionInfo("A1a", "A1"),
        sessionInfo("B1", "B"),
      ],
      pageSize,
    );
  const rootA = node("A", [CALLER]);
  const rootB = node("B", [CALLER]);

  test("returns the roots and everything below them, level by level", async () => {
    const result = await collectSubtree(tree(), [rootA, rootB]);
    expect(ids(result)).toEqual(["A", "B", "A1", "A2", "B1", "A1a"]);
    expect(result.find((entry) => entry.id === "A1a")).toMatchObject({
      parentID: "A1",
      depth: 3,
      ancestors: [CALLER, "A", "A1"],
    });
  });

  test("stopAt includes a session but does not list its children", async () => {
    const result = await collectSubtree(tree(), [rootA, rootB], {
      stopAt: new Set(["A1", "B"]),
    });
    expect(ids(result)).toEqual(["A", "B", "A1", "A2"]);
  });

  test("maxDepth stops descending without reading the levels below", async () => {
    const reader = tree();
    // A listing below depth 2 would throw, so the walk must not read one.
    reader.listings.set("A1", () => {
      throw new Error("listed below maxDepth");
    });
    const result = await collectSubtree(reader, [rootA, rootB], {
      maxDepth: 2,
    });
    expect(ids(result)).toEqual(["A", "B", "A1", "A2", "B1"]);
  });

  test("maxDepth keeps a tree deeper than the cap from failing the walk", async () => {
    const reader = new FakeSessionReader(
      chain(MAX_SUBTREE_DEPTH + 2, "A", "d"),
    );
    const result = await collectSubtree(reader, [rootA], { maxDepth: 3 });
    expect(ids(result)).toEqual(["A", "d1", "d2"]);
  });

  test("pages through each session's children", async () => {
    const reader = new FakeSessionReader(
      [...children(5, "A"), ...children(3, "A-4")],
      2,
    );
    const result = await collectSubtree(reader, [rootA]);
    expect(result).toHaveLength(1 + 5 + 3);
  });

  test("lists each session once when roots repeat or nest", async () => {
    const result = await collectSubtree(tree(), [
      rootA,
      rootA,
      node("A1", [CALLER, "A"]),
    ]);
    expect(ids(result)).toEqual(["A", "A1", "A2", "A1a"]);
  });

  test("does not walk a child listing that points back up the tree", async () => {
    const reader = tree();
    reader.listings.set("A1", () => ({
      data: [
        sessionInfo(CALLER, "A1"),
        sessionInfo("A", "A1"),
        sessionInfo("A1a", "A1"),
      ],
    }));
    const result = await collectSubtree(reader, [rootA]);
    expect(ids(result)).toEqual(["A", "A1", "A2", "A1a"]);
  });

  test("accepts a subtree 8 levels deep, counting the root", async () => {
    const reader = new FakeSessionReader(
      chain(MAX_SUBTREE_DEPTH - 1, "d0", "d"),
    );
    const result = await collectSubtree(reader, [node("d0", [CALLER])]);
    expect(result).toHaveLength(8);
    expect(result.at(-1)?.depth).toBe(8);
  });

  test("rejects a subtree with a ninth level", async () => {
    const reader = new FakeSessionReader(chain(MAX_SUBTREE_DEPTH, "d0", "d"));
    const error = await rejection(
      collectSubtree(reader, [node("d0", [CALLER])]),
    );
    expect(error).toBeInstanceOf(SubtreeTooLargeError);
    expect(error).toMatchObject({ limit: "depth" });
  });

  test("measures depth from each root, not from the caller", async () => {
    const reader = new FakeSessionReader(
      chain(MAX_SUBTREE_DEPTH - 1, "deep", "d"),
    );
    const root = node("deep", [CALLER, "x", "y"]);
    const result = await collectSubtree(reader, [root]);
    expect(result).toHaveLength(8);
  });

  test("accepts 200 sessions, roots included", async () => {
    const reader = new FakeSessionReader(
      children(MAX_SUBTREE_SESSIONS - 1, "A"),
    );
    expect(await collectSubtree(reader, [rootA])).toHaveLength(200);
  });

  test("rejects a walk that finds a 201st session, naming the 200 cap", async () => {
    const reader = new FakeSessionReader(children(MAX_SUBTREE_SESSIONS, "A"));
    const error = await rejection(collectSubtree(reader, [rootA]));
    expect(error).toBeInstanceOf(SubtreeTooLargeError);
    expect(error).toMatchObject({ limit: "sessions" });
    expect(error.message).toBe(
      "The subagent tree has more than 200 sessions; nothing was changed.",
    );
  });

  test("rejects more than 200 roots", async () => {
    const roots = Array.from({ length: MAX_SUBTREE_SESSIONS + 1 }, (_, index) =>
      node(`root-${index}`, [CALLER]),
    );
    const error = await rejection(
      collectSubtree(new FakeSessionReader([]), roots),
    );
    expect(error).toMatchObject({ limit: "sessions" });
  });

  describe("with maxSessions", () => {
    test("accepts that many sessions, roots included", async () => {
      const reader = new FakeSessionReader(children(2, "A"));
      const result = await collectSubtree(reader, [rootA], { maxSessions: 3 });
      expect(ids(result)).toEqual(["A", "A-0", "A-1"]);
    });

    test("rejects a walk that finds one more, naming that cap", async () => {
      const reader = new FakeSessionReader(children(3, "A"));
      const error = await rejection(
        collectSubtree(reader, [rootA], { maxSessions: 3 }),
      );
      expect(error).toBeInstanceOf(SubtreeTooLargeError);
      expect(error).toMatchObject({ limit: "sessions" });
      expect(error.message).toBe(
        "The subagent tree has more than 3 sessions; nothing was changed.",
      );
    });

    test("rejects more roots than the cap, naming that cap", async () => {
      const roots = ["r1", "r2", "r3", "r4"].map((id) => node(id, [CALLER]));
      const error = await rejection(
        collectSubtree(new FakeSessionReader([]), roots, { maxSessions: 3 }),
      );
      expect(error).toMatchObject({ limit: "sessions" });
      expect(error.message).toBe(
        "The subagent tree has more than 3 sessions; nothing was changed.",
      );
    });

    test("lets a walk go past 200 sessions", async () => {
      const reader = new FakeSessionReader(
        children(MAX_SUBTREE_SESSIONS + 50, "A"),
      );
      const result = await collectSubtree(reader, [rootA], {
        maxSessions: MAX_SCAN_SESSIONS,
      });
      expect(result).toHaveLength(MAX_SUBTREE_SESSIONS + 51);
    });
  });
});

describe("truncating walks", () => {
  test("collectSubtreeTruncated stops at the session cap", async () => {
    const reader = new FakeSessionReader(children(MAX_SUBTREE_SESSIONS, "A"));
    const result = await collectSubtreeTruncated(
      reader,
      [node("A", [CALLER])],
      {
        truncate: true,
      },
    );
    expect(result.nodes).toHaveLength(MAX_SUBTREE_SESSIONS);
    expect(result.truncated).toBe(true);
  });

  test("collectSubtreeTruncated leaves out levels past the depth cap", async () => {
    const reader = new FakeSessionReader(chain(MAX_SUBTREE_DEPTH, "d0", "d"));
    const result = await collectSubtreeTruncated(
      reader,
      [node("d0", [CALLER])],
      {
        truncate: true,
      },
    );
    expect(result.nodes).toHaveLength(MAX_SUBTREE_DEPTH);
    expect(result.truncated).toBe(true);
  });

  test("collectSubtreeTruncated with truncateDepth: false rejects a tree past the depth cap", async () => {
    const reader = new FakeSessionReader(chain(MAX_SUBTREE_DEPTH, "d0", "d"));
    const error = await rejection(
      collectSubtreeTruncated(reader, [node("d0", [CALLER])], {
        truncate: true,
        truncateDepth: false,
      }),
    );
    expect(error).toBeInstanceOf(SubtreeTooLargeError);
    expect(error).toMatchObject({ limit: "depth" });
  });

  test("collectSubtreeTruncated reports no cut for a tree within the caps", async () => {
    const reader = new FakeSessionReader(chain(3, "A", "c"));
    const result = await collectSubtreeTruncated(
      reader,
      [node("A", [CALLER])],
      {
        truncate: true,
      },
    );
    expect(ids(result.nodes)).toEqual(["A", "c1", "c2", "c3"]);
    expect(result.truncated).toBe(false);
  });

  test("collectSubtreeTruncated keeps the first maxSessions sessions found and reports the cut", async () => {
    const reader = new FakeSessionReader(children(5, "A"));
    const result = await collectSubtreeTruncated(
      reader,
      [node("A", [CALLER])],
      { truncate: true, maxSessions: 3 },
    );
    expect(ids(result.nodes)).toEqual(["A", "A-0", "A-1"]);
    expect(result.truncated).toBe(true);
  });

  test("collectSubtreeTruncated reports no cut for a walk past 200 sessions within maxSessions", async () => {
    const reader = new FakeSessionReader(
      children(MAX_SUBTREE_SESSIONS + 50, "A"),
    );
    const result = await collectSubtreeTruncated(
      reader,
      [node("A", [CALLER])],
      { truncate: true, maxSessions: MAX_SCAN_SESSIONS },
    );
    expect(result.nodes).toHaveLength(MAX_SUBTREE_SESSIONS + 51);
    expect(result.truncated).toBe(false);
  });
});

describe("dropNested", () => {
  test("drops duplicate roots and roots inside another root's subtree, keeping order", () => {
    const a = node("A", [CALLER]);
    const b = node("B", [CALLER]);
    const result = dropNested([
      b,
      node("A1a", [CALLER, "A", "A1"]),
      a,
      b,
      node("A1", [CALLER, "A"]),
    ]);
    expect(ids(result)).toEqual(["B", "A"]);
  });
});

describe("postOrder", () => {
  test("puts deeper sessions first and keeps the order within a level", () => {
    const result = postOrder([
      node("A", [CALLER]),
      node("A1", [CALLER, "A"]),
      node("B", [CALLER]),
      node("A1a", [CALLER, "A", "A1"]),
      node("B1", [CALLER, "B"]),
    ]);
    expect(ids(result)).toEqual(["A1a", "A1", "B1", "A", "B"]);
  });
});

describe("difference", () => {
  test("keeps the nodes whose session ID is not among the known ones, in order", () => {
    const result = difference(
      [node("A", [CALLER]), node("B", [CALLER]), node("C", [CALLER])],
      [node("B", [CALLER])],
    );
    expect(ids(result)).toEqual(["A", "C"]);
  });
});
