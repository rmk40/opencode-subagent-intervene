// Close matches for a session ID that is not one of the caller's subagents. Mistyped IDs are near
// misses: cut short, with a stray space, or with the right start and an invented tail. Suggestions
// come only from the caller's own direct children, and nothing acts on them.

import { type Descendant, scanDirectChildren } from "@/core/ancestry";
import type {
  RunObservation,
  SessionID,
  SessionInfo,
  SessionReader,
} from "@/core/ports";
import type { RunStateTracker } from "@/core/run-state";

export const MAX_SUGGESTIONS = 3;
/** Characters after `ses_` a suggestion must share with the input, unless it matches exactly. */
export const MIN_SHARED_PREFIX = 8;
const SESSION_PREFIX = "ses_";
const WHITESPACE = /\s+/g;

export interface Suggestion {
  readonly sessionID: SessionID;
  readonly title?: string;
  readonly agent?: string;
  readonly state: RunObservation["state"];
  readonly noRecordedEnd?: true;
}

/** The caller's direct children to rank, whether they were all read, and whether the read failed. */
export interface SuggestionPool {
  readonly children: readonly Descendant[];
  readonly complete: boolean;
  readonly failed?: true;
}

/**
 * The caller's direct children, the most recently updated first, up to the scan cap. A failed
 * read yields no children, counts as incomplete and is marked failed.
 */
export async function suggestionPool(
  reader: SessionReader,
  callerID: SessionID,
): Promise<SuggestionPool> {
  try {
    const scan = await scanDirectChildren(reader, callerID);
    return { children: scan.nodes, complete: !scan.truncated };
  } catch {
    return { children: [], complete: false, failed: true };
  }
}

/**
 * Up to three children whose IDs are close to `input`, best first. A child whose ID equals the
 * input with its whitespace removed comes first; the rest share at least eight characters after
 * `ses_` with that input and are ranked by the longest shared prefix, then by edit distance.
 */
export function closestChildren(
  children: readonly Descendant[],
  input: string,
): Descendant[] {
  const compact = input.replace(WHITESPACE, "");
  if (compact === "") return [];
  const typed = afterPrefix(compact);
  const ranked: Array<{
    readonly child: Descendant;
    readonly exact: boolean;
    readonly prefix: number;
    readonly distance: number;
  }> = [];
  for (const child of children) {
    if (child.id === compact) {
      ranked.push({ child, exact: true, prefix: compact.length, distance: 0 });
      continue;
    }
    const prefix = sharedPrefix(afterPrefix(child.id), typed);
    if (prefix < MIN_SHARED_PREFIX) continue;
    ranked.push({
      child,
      exact: false,
      prefix,
      distance: editDistance(compact, child.id),
    });
  }
  return ranked
    .toSorted(
      (a, b) =>
        Number(b.exact) - Number(a.exact) ||
        b.prefix - a.prefix ||
        a.distance - b.distance,
    )
    .slice(0, MAX_SUGGESTIONS)
    .map(({ child }) => child);
}

/** The suggested children with their current run state. Never rejects. */
export async function describeSuggestions(
  runState: Pick<RunStateTracker, "observeAll">,
  children: readonly Descendant[],
): Promise<Suggestion[]> {
  const observed = await runState.observeAll(
    children.map((child) => child.id),
    new Map<SessionID, SessionInfo>(
      children.map((child) => [child.id, child.info]),
    ),
  );
  return children.map((child) => {
    const observation = observed.get(child.id);
    return {
      sessionID: child.id,
      ...(child.info.title === undefined ? {} : { title: child.info.title }),
      ...(child.info.agent === undefined ? {} : { agent: child.info.agent }),
      state: observation?.state ?? "unknown",
      ...(observation?.noRecordedEnd === true
        ? { noRecordedEnd: true as const }
        : {}),
    };
  });
}

function afterPrefix(id: string): string {
  return id.startsWith(SESSION_PREFIX) ? id.slice(SESSION_PREFIX.length) : id;
}

function sharedPrefix(a: string, b: string): number {
  const length = Math.min(a.length, b.length);
  let shared = 0;
  while (shared < length && a[shared] === b[shared]) shared++;
  return shared;
}

/** Levenshtein distance over UTF-16 code units, which is exact for session IDs. */
function editDistance(a: string, b: string): number {
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    for (let j = 1; j <= b.length; j++) {
      const substitution = (previous[j - 1] ?? 0) + (a[i - 1] === b[j - 1] ? 0 : 1);
      current.push(
        Math.min((previous[j] ?? 0) + 1, (current[j - 1] ?? 0) + 1, substitution),
      );
    }
    previous = current;
  }
  return previous[b.length] ?? 0;
}
