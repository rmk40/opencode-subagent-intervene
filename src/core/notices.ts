// Tells a parent when its subagent has been waiting a while on a permission prompt or a question.
// Only a person can answer either, and the parent may be the only one watching.
//
// Prompt events are live only, with no replay: a prompt already open when the instance loads, or
// opened during a subscription gap, gets no notice. Every instance sees every event, whatever
// location its session is in, so whether a prompt is still open is told from events: the
// permission list a plugin can read covers only its own location's requests. Only a permission
// prompt that stayed open across a gap is checked against that list, so one in another location
// is then dropped. Each instance schedules the same notice, so the notice's inbox item ID is
// derived from the prompt. Core admits the first item with an ID and returns that item for every
// later post of the same ID, delivered or not, so the parent gets one notice however many
// instances post it.
//
// A steered notice reaches a running parent only once its tool calls in flight finish. A parent
// blocked in a foreground `subagent` call on the waiting subagent would read it only after that
// subagent is done, when the notice is stale, so such a parent is not told while the call runs.
// The call is told from events too: while a `subagent` call runs, its tool progress names the
// subagent, but the parent's context leaves that progress out. The call can end with the prompt
// still open, when a person moves it to the background, so the prompt is checked again then.

import { createHash } from "node:crypto";
import type { Latch } from "@/core/latch";
import {
  type Clock,
  type Logger,
  type OpenCodeEvent,
  type PermissionReader,
  PLUGIN_ID,
  type Scheduler,
  type SessionID,
  type SessionMessenger,
  type SessionReader,
  type SyntheticMessage,
} from "@/core/ports";
import { sanitizeText } from "@/core/sanitize";
import { formatDuration } from "@/core/summarize";

export const DEFAULT_NOTICE_DELAY_MS = 60_000;
/**
 * How long after a blocking call ends a held-back prompt is checked again. An interrupted parent
 * can end its call before the interrupt it passes on to its subagent closes the prompt, and a
 * notice posted in between would wake the parent the person just stopped.
 */
export const RECHECK_DELAY_MS = 1000;
/** Shown to people in OpenCode next to the notice. */
export const NOTICE_DESCRIPTION = "Subagent waiting";
/** `kind` in the metadata of a notice. */
export const NOTICE_KIND = "subagent-waiting";
/** The owner core gives forms that belong to no session. */
export const GLOBAL_FORM_OWNER = "global";

/** Caps on each value quoted in a notice, in code points after escaping. */
const ID_MAX = 100;
const AGENT_MAX = 100;
const TITLE_MAX = 200;
const ACTION_MAX = 100;
const RESOURCE_MAX = 200;
/** Resources named in a notice; the rest are counted. */
const RESOURCES_SHOWN = 3;

export type PromptKind = "permission" | "question";

export type PromptDetails =
  | {
      readonly kind: "permission";
      readonly action: string;
      readonly resources: readonly string[];
    }
  | { readonly kind: "question"; readonly title: string };

interface Prompt {
  readonly sessionID: SessionID;
  /** The permission request ID or the form ID. */
  readonly requestID: string;
  /** When core published the prompt, in epoch milliseconds. */
  readonly askedAt: number;
  readonly details: PromptDetails;
}

interface TrackedPrompt {
  readonly prompt: Prompt;
  /** Cancels the pending check of the prompt. */
  cancel: () => void;
  /**
   * Set by a subscription gap: the event that closed the prompt may have been missed, so a
   * permission prompt is looked up before its notice is posted.
   */
  missedEvents: boolean;
  /**
   * The parent's call on the subagent that held the notice back. The prompt is checked again
   * once the call or the parent's run ends.
   */
  blockedBy: RunningCall | undefined;
}

/** A tool call running in a parent session, identified the way its terminal event names it. */
interface RunningCall {
  readonly parentID: SessionID;
  readonly assistantMessageID: string;
  readonly callID: string;
}

type Composed =
  | { readonly type: "post"; readonly notice: SyntheticMessage }
  | { readonly type: "skip" }
  | { readonly type: "blocked" };

export interface PromptNoticeDeps {
  readonly reader: Pick<SessionReader, "get">;
  /**
   * Read only for a permission prompt tracked across a subscription gap. It sees only the
   * instance's own location, so such a prompt in another location is dropped.
   */
  readonly permissions: PermissionReader;
  readonly messenger: SessionMessenger;
  /** Without it, the parent's stop latch is not checked. */
  readonly latch?: Pick<Latch, "isActive">;
  readonly scheduler: Scheduler;
  readonly clock: Pick<Clock, "now">;
  readonly logger: Logger;
}

export interface PromptNoticeOptions {
  /** How long a prompt stays open before the parent is told. Default 60 s; 0 tells it right away. */
  readonly delayMs?: number;
}

export class PromptNotices {
  private readonly deps: PromptNoticeDeps;
  private readonly delayMs: number;
  /**
   * Open prompts with a pending notice, by `promptKey`. A prompt is open from the event that asks
   * it until its reply or cancel event, the end of its session's run, or the session's deletion.
   */
  private readonly tracked = new Map<string, TrackedPrompt>();
  /** Running calls whose tool progress names a subagent, by that subagent's session ID. */
  private readonly calls = new Map<SessionID, RunningCall>();
  private disposed = false;

  constructor(deps: PromptNoticeDeps, options: PromptNoticeOptions = {}) {
    this.deps = deps;
    this.delayMs = options.delayMs ?? DEFAULT_NOTICE_DELAY_MS;
  }

  /**
   * Starts a notice timer when a prompt opens and cancels it when the prompt closes. Also follows
   * the calls that run subagents. Never throws.
   */
  onEvent(event: OpenCodeEvent): void {
    if (this.disposed) return;
    try {
      this.handle(event);
    } catch (error) {
      this.deps.logger.warn("notices: event handler failed", {
        type: event.type,
        error: errorMessage(error),
      });
    }
  }

  /**
   * Call when events may have been missed. Open questions are dropped, since only events tell
   * whether one is still open. Permission prompts are kept and looked up before their notices are
   * posted. Running calls are forgotten, since their end may have been missed, so a prompt a call
   * held back is checked again shortly and its notice is posted if it is still open.
   */
  reset(): void {
    for (const [key, entry] of this.tracked) {
      if (entry.prompt.details.kind !== "permission") {
        entry.cancel();
        this.tracked.delete(key);
        continue;
      }
      entry.missedEvents = true;
      if (entry.blockedBy !== undefined) {
        entry.blockedBy = undefined;
        entry.cancel();
        entry.cancel = this.deps.scheduler.schedule(RECHECK_DELAY_MS, () => {
          void this.fire(key, entry.prompt);
        });
      }
    }
    this.calls.clear();
  }

  /** Cancels every pending notice; notices being posted are dropped before they are sent. */
  dispose(): void {
    this.disposed = true;
    for (const entry of this.tracked.values()) entry.cancel();
    this.tracked.clear();
    this.calls.clear();
  }

  private handle(event: OpenCodeEvent): void {
    switch (event.type) {
      case "permission.asked":
        return this.track({
          sessionID: event.data.sessionID,
          requestID: event.data.id,
          askedAt: event.created,
          details: {
            kind: "permission",
            action: event.data.action,
            resources: event.data.resources,
          },
        });
      case "permission.replied":
        return this.untrack(
          promptKey(event.data.sessionID, "permission", event.data.requestID),
        );
      case "form.created": {
        const form = event.data.form;
        if (form.sessionID === GLOBAL_FORM_OWNER) return;
        return this.track({
          sessionID: form.sessionID,
          requestID: form.id,
          askedAt: event.created,
          details: { kind: "question", title: form.title },
        });
      }
      case "form.replied":
      case "form.cancelled":
        return this.untrack(
          promptKey(event.data.sessionID, "question", event.data.id),
        );
      case "session.tool.progress": {
        // Core's `subagent` tool publishes `{ sessionID: <subagent>, status: "running" }` once
        // the subagent is chosen. A call that returns at once, launching in the background or
        // steering, ends straight after, which forgets it again.
        const subagentID = event.data.metadata["sessionID"];
        if (
          typeof subagentID !== "string" ||
          subagentID === event.data.sessionID
        ) {
          return;
        }
        this.calls.set(subagentID, {
          parentID: event.data.sessionID,
          assistantMessageID: event.data.assistantMessageID,
          callID: event.data.id,
        });
        return;
      }
      case "session.tool.success":
      case "session.tool.failed": {
        // Provider call IDs can repeat across messages, so the message ID is compared too.
        const { sessionID, assistantMessageID, id } = event.data;
        return this.callsEnded(
          (call) =>
            call.parentID === sessionID &&
            call.assistantMessageID === assistantMessageID &&
            call.callID === id,
        );
      }
      // An interrupted run drops its permission prompts without a reply event, and every call
      // a run makes ends with it.
      case "session.execution.succeeded":
      case "session.execution.failed":
      case "session.execution.interrupted": {
        const sessionID = event.data.sessionID;
        this.untrackSession(sessionID);
        return this.callsEnded((call) => call.parentID === sessionID);
      }
      case "session.deleted": {
        const sessionID = event.data.sessionID;
        this.untrackSession(sessionID);
        this.calls.delete(sessionID);
        return this.callsEnded((call) => call.parentID === sessionID);
      }
      default:
        return;
    }
  }

  /**
   * Forgets the matching calls and schedules another check of every prompt one of them held
   * back. The prompt has been open longer than the delay by then, so only a short settling wait
   * comes before the check. A call that ends after its subagent's prompt was answered holds
   * nothing back, since answering closed the prompt.
   */
  private callsEnded(matches: (call: RunningCall) => boolean): void {
    for (const [subagentID, call] of this.calls) {
      if (matches(call)) this.calls.delete(subagentID);
    }
    for (const [key, entry] of this.tracked) {
      if (entry.blockedBy === undefined || !matches(entry.blockedBy)) continue;
      entry.blockedBy = undefined;
      entry.cancel();
      entry.cancel = this.deps.scheduler.schedule(RECHECK_DELAY_MS, () => {
        void this.fire(key, entry.prompt);
      });
    }
  }

  private track(prompt: Prompt): void {
    const key = promptKey(
      prompt.sessionID,
      prompt.details.kind,
      prompt.requestID,
    );
    this.untrack(key);
    const cancel = this.deps.scheduler.schedule(this.delayMs, () => {
      void this.fire(key, prompt);
    });
    this.tracked.set(key, {
      prompt,
      cancel,
      missedEvents: false,
      blockedBy: undefined,
    });
  }

  private untrack(key: string): void {
    const entry = this.tracked.get(key);
    if (entry === undefined) return;
    entry.cancel();
    this.tracked.delete(key);
  }

  private untrackSession(sessionID: SessionID): void {
    for (const [key, entry] of this.tracked) {
      if (entry.prompt.sessionID === sessionID) {
        entry.cancel();
        this.tracked.delete(key);
      }
    }
  }

  private isTracked(key: string, prompt: Prompt): boolean {
    return !this.disposed && this.tracked.get(key)?.prompt === prompt;
  }

  /**
   * Posts the notice if the prompt is still open and the parent can take it. A prompt the parent's
   * call holds back stays tracked for another check. Never rejects.
   */
  private async fire(key: string, prompt: Prompt): Promise<void> {
    let held = false;
    try {
      const composed = await this.compose(key, prompt);
      held = composed.type === "blocked";
      // The prompt may have been answered while the checks ran.
      if (composed.type !== "post" || !this.isTracked(key, prompt)) return;
      await this.deps.messenger.synthetic(composed.notice);
      this.deps.logger.info("notices: told a parent its subagent is waiting", {
        sessionID: prompt.sessionID,
        parentID: composed.notice.sessionID,
        requestID: prompt.requestID,
        kind: prompt.details.kind,
      });
    } catch (error) {
      this.deps.logger.warn("notices: could not post a notice", {
        sessionID: prompt.sessionID,
        requestID: prompt.requestID,
        error: errorMessage(error),
      });
    } finally {
      if (!held && this.isTracked(key, prompt)) this.tracked.delete(key);
    }
  }

  /**
   * The notice for the prompt's parent; `blocked` when the parent is blocked in a call on the
   * subagent; `skip` when none is due: the session is a root or gone, a permission prompt tracked
   * across a gap is no longer in the list, or the parent is gone or stopped.
   */
  private async compose(key: string, prompt: Prompt): Promise<Composed> {
    const skip = { type: "skip" } as const;
    const child = await this.deps.reader.get(prompt.sessionID);
    if (child?.parentID === undefined) return skip;
    // A parent blocked in a call on the child would read the notice only after the call returns.
    // The call is recorded on the prompt here, with no wait in between, so its end event cannot
    // arrive before the prompt is marked as held.
    const call = this.calls.get(child.id);
    if (call?.parentID === child.parentID) {
      const entry = this.tracked.get(key);
      if (entry?.prompt === prompt) entry.blockedBy = call;
      return { type: "blocked" };
    }
    if (
      prompt.details.kind === "permission" &&
      this.tracked.get(key)?.missedEvents === true
    ) {
      const pending = await this.deps.permissions.pendingRequestIDs(child.id);
      if (!pending.includes(prompt.requestID)) return skip;
    }
    const parent = await this.deps.reader.get(child.parentID);
    if (parent === undefined) return skip;
    if (
      this.deps.latch !== undefined &&
      (await this.deps.latch.isActive(parent.id))
    ) {
      return skip;
    }
    return {
      type: "post",
      notice: {
        sessionID: parent.id,
        id: noticeID(child.id, prompt),
        text: renderWaitingNotice({
          sessionID: child.id,
          ...(child.agent === undefined ? {} : { agent: child.agent }),
          ...(child.title === undefined ? {} : { title: child.title }),
          waitedMs: Math.max(0, this.deps.clock.now() - prompt.askedAt),
          prompt: prompt.details,
        }),
        description: NOTICE_DESCRIPTION,
        metadata: {
          plugin: PLUGIN_ID,
          kind: NOTICE_KIND,
          prompt: prompt.details.kind,
          sessionID: child.id,
          requestID: prompt.requestID,
        },
        delivery: "steer",
        resume: true,
      },
    };
  }
}

/**
 * The notice's inbox item ID: the same in every instance, and one per prompt. Whoever opens a
 * prompt may choose its request ID, so the ID hashes the prompt's kind, session ID, and request
 * ID, encoded as a JSON array so no two prompts share an encoding, and is hex after that. Core
 * requires only the `msg_` prefix, sets no length limit, and orders messages by sequence, not by
 * ID.
 */
export function noticeID(
  sessionID: SessionID,
  prompt: { readonly requestID: string; readonly details: PromptDetails },
): string {
  const digest = createHash("sha256")
    .update(JSON.stringify([prompt.details.kind, sessionID, prompt.requestID]))
    .digest("hex");
  return `msg_${PLUGIN_ID}_${digest}`;
}

export interface WaitingNotice {
  /** The waiting subagent. */
  readonly sessionID: SessionID;
  readonly agent?: string;
  readonly title?: string;
  readonly waitedMs: number;
  readonly prompt: PromptDetails;
}

/** The text the parent reads. Every quoted value is escaped and capped. */
export function renderWaitingNotice(notice: WaitingNotice): string {
  const id = clean(notice.sessionID, ID_MAX);
  const agent = clean(notice.agent ?? "", AGENT_MAX);
  const title = clean(notice.title ?? "", TITLE_MAX);
  const label = [
    ...(agent === "" ? [] : [agent]),
    ...(title === "" ? [] : [`"${title}"`]),
  ];
  const who = `Your subagent ${id}${label.length === 0 ? "" : ` (${label.join(", ")})`}`;
  const waiting =
    notice.waitedMs < 1000
      ? "is waiting"
      : `has been waiting ${formatDuration(notice.waitedMs)}`;
  return `<subagent-waiting sessionID="${id}" kind="${notice.prompt.kind}">${who} ${waiting} on ${describePrompt(notice.prompt)}. Only a person can answer it, in OpenCode. Tell the user, or stop it with subagent_stop. It continues on its own once someone answers.</subagent-waiting>`;
}

function describePrompt(prompt: PromptDetails): string {
  if (prompt.kind === "question") {
    const title = clean(prompt.title, TITLE_MAX);
    return title === "" ? "a question" : `a question: "${title}"`;
  }
  const action = clean(prompt.action, ACTION_MAX);
  const resources = prompt.resources
    .map((resource) => clean(resource, RESOURCE_MAX))
    .filter((resource) => resource !== "");
  const shown = resources.slice(0, RESOURCES_SHOWN);
  const more = resources.length - shown.length;
  const list = more > 0 ? [...shown, `and ${more} more`] : shown;
  const what = action === "" ? "an unnamed action" : action;
  return list.length === 0
    ? `a permission prompt: ${what}`
    : `a permission prompt: ${what} for ${list.join(", ")}`;
}

function clean(value: string, maxCodePoints: number): string {
  return sanitizeText(value, maxCodePoints).text;
}

function promptKey(
  sessionID: SessionID,
  kind: PromptKind,
  requestID: string,
): string {
  return `${sessionID}/${kind}/${requestID}`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
