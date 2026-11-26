// Sends a message from a parent to one of its running subagents without stopping it, and can switch
// the subagent's agent or model. The message is steered into the subagent's inbox without a wake, so
// a running subagent reads it at its next step boundary and an idle one is never started: a run the
// plugin starts has no subagent job, so its result would never reach the parent. OpenCode reads a
// session's agent and model when each step and each retry starts, before it takes in steered
// messages. The switch is made before the message is posted, so the step that reads the message
// runs with what was switched, unless that step had already read the agent and model when the
// switch landed.

import { type ActivityTracker, idleSince } from "@/core/activity";
import { assertDescendant, type Descendant } from "@/core/ancestry";
import { errorMessage, overLimit } from "@/core/errors";
import type { Latch } from "@/core/latch";
import {
  type Clock,
  PLUGIN_ID,
  type RunState,
  type SessionID,
  type SessionInfo,
  type SessionMessenger,
  type SessionReader,
  type SessionSwitcher,
} from "@/core/ports";
import type { RunStateTracker } from "@/core/run-state";
import { sanitizeBlock, sanitizeText } from "@/core/sanitize";
import { CONTINUE_NESTED_NOTE, CONTINUE_OWN_NOTE } from "@/core/stop";
import { formatDuration } from "@/core/summarize";
import {
  agentChange,
  describeChanges,
  formatModelRef,
  modelChange,
  NOTHING_SWITCHED,
  parseModelRef,
  planSwitch,
  type SwitchPlan,
  switchedValues,
} from "@/core/switch";

export const MESSAGE_MAX_CODE_POINTS = 8000;
/** The element that wraps a parent message in the text the subagent reads. */
export const MESSAGE_WRAPPER = "parent-message";
/** Shown to people in OpenCode next to the message. */
export const MESSAGE_DESCRIPTION = "Message from parent";
/** `kind` in the metadata of a parent message. */
export const MESSAGE_KIND = "parent-message";
/** Cap on the caller's session ID inside the message markup. */
const CALLER_ID_MAX_CODE_POINTS = 100;
/** How often a switch is planned again because someone else switched the target meanwhile. */
const MAX_REPLANS = 2;

const CONTINUE_IDLE_NOTE =
  "To give it your message, continue it: call subagent with its sessionID and the message.";

/** Nothing was sent, or what the message says was switched. The message is written for the calling model. */
export class SendError extends Error {
  override name = "SendError";
}

export interface SendDeps {
  readonly reader: SessionReader;
  readonly messenger: SessionMessenger;
  readonly switcher: SessionSwitcher;
  readonly latch: Pick<Latch, "isActive">;
  readonly runState: Pick<RunStateTracker, "observe">;
  readonly clock: Pick<Clock, "now">;
  /** Live activity, for the target's last activity. Without it, none is known. */
  readonly activity?: Pick<ActivityTracker, "get">;
}

export interface SendCall {
  readonly callerID: SessionID;
  /** Aborted when the calling tool call is interrupted. */
  readonly signal: AbortSignal;
  /**
   * Checks that the caller may run `agent` as a subagent, before the target is switched to it. A
   * rejection propagates, and nothing is switched or sent.
   */
  readonly confirmAgent: (agent: string) => Promise<void>;
}

export interface SendRequest {
  readonly sessionID: SessionID;
  /** Model-written; sanitized before it is sent. Optional when `model` or `agent` is given. */
  readonly message?: string;
  /** Model-written `providerID/modelID[#variant]`. Blank counts as absent. */
  readonly model?: string;
  /** Model-written agent ID. Blank counts as absent. */
  readonly agent?: string;
}

export interface SendOptions {
  /** Whether stopped sessions are kept stopped. With it on, a stopped target is refused. Default true. */
  readonly latch?: boolean;
}

export interface PostedMessage {
  /**
   * The message's inbox item ID. Core keeps it as the message's ID once the message is delivered,
   * so finding it among the target's messages shows the target has read it.
   */
  readonly messageID: string;
  /** When the message was admitted, in epoch milliseconds. */
  readonly postedAt: number;
}

export interface SendResult {
  /** The target, with its record as last read: for a switch, right before it changed anything. */
  readonly target: Descendant;
  /** The message posted; absent when the call carried none. */
  readonly posted?: PostedMessage;
  /** What the call asked to switch, and what it switched; absent when it asked for neither. */
  readonly switch?: SwitchPlan;
  /** Run state observed before anything was switched or posted: running or unknown. */
  readonly before: RunState;
  /** Run state observed right after the message was admitted, or after the switch without one. */
  readonly after: RunState;
}

/**
 * Switches a running subagent of the caller to the agent or model asked for, then steers the
 * message into it. Throws `SendError`, `SwitchError` or an `AncestryError` before anything is
 * switched or sent: a stopped or idle target is refused, and so is one OpenCode reports idle
 * although its last run recorded no end, since nothing would read the message or use the switch
 * until it is continued. A switch is also refused for a target in another directory than the
 * switcher's. Checking the catalog and the permission can take long, so before a switch changes
 * anything, the target's record, stop and run state are read again. A switch that fails partway,
 * and a message that fails after the switch, throw a `SendError` that says what was switched.
 * Resolves `undefined` when `call.signal` aborts before anything is switched or posted.
 * Surrounding whitespace in the session ID is ignored.
 */
export async function sendToSubagent(
  deps: SendDeps,
  call: SendCall,
  request: SendRequest,
  options: SendOptions = {},
): Promise<SendResult | undefined> {
  const latching = options.latch ?? true;
  const agent = optionalInput(request.agent);
  const modelInput = optionalInput(request.model);
  const switching = agent !== undefined || modelInput !== undefined;
  const message =
    request.message === undefined
      ? undefined
      : sanitizeMessage(request.message, switching);
  const model = modelInput === undefined ? undefined : parseModelRef(modelInput);
  if (message === undefined && !switching) {
    throw new SendError(
      "Nothing was sent: give a message, a model or an agent.",
    );
  }
  const target = await assertDescendant(
    deps.reader,
    request.sessionID.trim(),
    call.callerID,
  );
  await refuseStopped(deps, target, switching, latching);
  let before = await observeRunning(deps, target, switching);
  let plan: SwitchPlan | undefined;
  // The target as last read; a switch reads it again before it changes anything.
  let current = target;
  if (switching) {
    const asked = {
      ...(agent === undefined ? {} : { agent }),
      ...(model === undefined ? {} : { model }),
    };
    refuseOtherDirectory(deps.switcher, target, target.info);
    plan = await planSwitch(deps.switcher, target.info, asked);
    const confirmed = agentChange(plan)?.to;
    if (confirmed !== undefined) await call.confirmAgent(confirmed);
    // Catalog reads, and a permission prompt waiting on a person, leave time for the subagent to be
    // moved, switched by someone else, stopped or finish its run. Its record is read again, and the
    // switch planned again while that record shows another agent or model. The stop and the run
    // state are checked last, so nothing else runs between them and the first change.
    for (let round = 1; ; round++) {
      const fresh = await deps.reader.get(target.id);
      if (fresh === undefined) {
        throw new SendError(
          `Subagent ${target.id} was deleted while this call was checked. ${NOTHING_SWITCHED}`,
        );
      }
      refuseOtherDirectory(deps.switcher, target, fresh);
      const replan = !sameSelection(fresh, current.info);
      current = { ...target, info: fresh };
      if (replan) {
        if (round > MAX_REPLANS) {
          throw new SendError(
            `Subagent ${target.id} kept being switched by someone else while this call was checked. ${NOTHING_SWITCHED}`,
          );
        }
        plan = await planSwitch(deps.switcher, fresh, asked);
        const newAgent = agentChange(plan);
        // Its agent changed away from the one asked for, which was neither checked nor confirmed.
        if (newAgent !== undefined && confirmed === undefined) {
          throw new SendError(
            `Subagent ${target.id} was switched to agent ${fresh.agent ?? "(its default)"} while this call was checked. ${NOTHING_SWITCHED} To switch it to ${newAgent.to}, call subagent_send again.`,
          );
        }
        continue;
      }
      await refuseStopped(deps, current, switching, latching);
      before = await observeRunning(deps, current, switching);
      break;
    }
  }
  if (call.signal.aborted) return undefined;

  if (plan !== undefined) await applySwitch(deps.switcher, current, plan);
  const switched =
    plan === undefined ? undefined : describeChanges(switchedValues(plan));
  let posted: PostedMessage | undefined;
  if (message !== undefined) {
    if (call.signal.aborted) {
      if (switched === undefined) return undefined;
      throw new SendError(
        `The call was cancelled after it switched ${target.id} ${switched}, so your message was not sent. The switch stays in effect from its next model request.`,
      );
    }
    try {
      const item = await deps.messenger.synthetic({
        sessionID: target.id,
        text: renderParentMessage(call.callerID, message),
        description: MESSAGE_DESCRIPTION,
        metadata: { plugin: PLUGIN_ID, kind: MESSAGE_KIND, from: call.callerID },
        delivery: "steer",
        resume: false,
      });
      posted = { messageID: item.id, postedAt: item.createdAt };
    } catch (error) {
      if (switched === undefined) throw error;
      throw new SendError(
        `Switched ${target.id} ${switched}, but your message could not be sent: ${errorMessage(error)}. The switch stays in effect from its next model request. To deliver the message, call subagent_send again without model or agent.`,
      );
    }
  }

  const after = await deps.runState.observe(current.id, current.info);
  return {
    target: current,
    ...(posted === undefined ? {} : { posted }),
    ...(plan === undefined ? {} : { switch: plan }),
    before,
    after: after.state,
  };
}

/** Throws `SendError` when stops are kept and the target is stopped. */
async function refuseStopped(
  deps: SendDeps,
  target: Descendant,
  switching: boolean,
  latching: boolean,
): Promise<void> {
  if (latching && (await deps.latch.isActive(target.id))) {
    throw new SendError(
      `Subagent ${target.id} is stopped, so ${switching ? "nothing was switched or sent" : "nothing was sent"}. ${continueNote(target, CONTINUE_OWN_NOTE)}`,
    );
  }
}

/**
 * Throws `SendError` when `info` puts the target in another directory than the switcher's. OpenCode
 * keeps a catalog per location and gives the plugin only its own location's, so a model or agent
 * elsewhere cannot be checked. A session records only the directory of its location, so the
 * directory is what is compared.
 */
function refuseOtherDirectory(
  switcher: Pick<SessionSwitcher, "directory">,
  target: Descendant,
  info: SessionInfo,
): void {
  if (info.location.directory === switcher.directory) return;
  throw new SendError(
    `Subagent ${target.id} runs in ${info.location.directory}, a different directory from this plugin instance's (${switcher.directory}), so its model and agent can't be checked from here: OpenCode gives the plugin only the agents and models of its own directory. ${NOTHING_SWITCHED} To switch it, call subagent_send from a session in that directory${target.depth === 1 ? ", or continue it with subagent, its sessionID, an agent and model" : ""}.`,
  );
}

/** Whether two reads of a session record the same agent and model. */
function sameSelection(a: SessionInfo, b: SessionInfo): boolean {
  return (
    a.agent === b.agent &&
    a.model?.providerID === b.model?.providerID &&
    a.model?.id === b.model?.id &&
    a.model?.variant === b.model?.variant
  );
}

/** The input trimmed; undefined when absent or blank, as models fill optional fields with "". */
function optionalInput(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed === "" ? undefined : trimmed;
}

/**
 * The target's run state, running or unknown. Throws `SendError` when it is idle, including idle
 * with no recorded end. `switching` names the switch in the error and adds how to continue a
 * direct child with a different model.
 */
async function observeRunning(
  deps: SendDeps,
  target: Descendant,
  switching: boolean,
): Promise<RunState> {
  const observed = await deps.runState.observe(target.id, target.info);
  if (observed.state !== "idle") return observed.state;
  // Read again: the session may have ended its run since the ancestry check read it.
  const info = (await deps.reader.get(target.id)) ?? target.info;
  const nothing = switching
    ? "nothing was switched or sent"
    : "nothing was sent";
  const unread = switching
    ? "neither a switch nor a message would take effect"
    : "the message would not be read";
  const how = continueNote(
    target,
    switching
      ? `To continue it with a different model or agent, call subagent with its sessionID, a prompt, model, and agent: ${info.agent === undefined ? "its current agent" : `its current agent, ${info.agent},`} to keep that agent, or another agent to switch to it.`
      : CONTINUE_IDLE_NOTE,
  );
  throw new SendError(
    observed.noRecordedEnd === true
      ? `Subagent ${target.id} is not running, so ${nothing}: OpenCode reports it idle, but its last run recorded no end, so ${unread} until it is continued with subagent. ${unendedAge(deps, target.id)} ${how}`
      : `Subagent ${target.id} is idle, so ${nothing}: ${switching ? "subagent_send only reaches a running subagent" : "a message only reaches a running subagent"}. ${idleAge(info, deps.clock.now())} ${how}`,
  );
}

/**
 * Switches the agent, then the model. Throws `SendError`: when the agent fails nothing was switched,
 * and when the model fails after the agent, the error says the agent was switched.
 */
async function applySwitch(
  switcher: SessionSwitcher,
  target: Descendant,
  plan: SwitchPlan,
): Promise<void> {
  const agent = agentChange(plan);
  const model = modelChange(plan);
  if (agent !== undefined) {
    try {
      await switcher.switchAgent(target.id, agent.to);
    } catch (error) {
      throw new SendError(
        `Could not switch ${target.id} to agent ${agent.to}: ${errorMessage(error)}. ${NOTHING_SWITCHED}`,
      );
    }
  }
  if (model !== undefined) {
    try {
      await switcher.switchModel(target.id, model.to);
    } catch (error) {
      const to = formatModelRef(model.to);
      throw new SendError(
        agent === undefined
          ? `Could not switch ${target.id} to model ${to}: ${errorMessage(error)}. ${NOTHING_SWITCHED}`
          : `Switched ${target.id} ${describeChanges({ agent })}, but could not switch its model to ${to}: ${errorMessage(error)}. Nothing was sent. It runs agent ${agent.to} with ${model.from === undefined ? "its previous model" : `model ${formatModelRef(model.from)}`} from its next model request.`,
      );
    }
  }
}

/**
 * The text the subagent reads: the message from `sanitizeBlock`, on lines of its own between the
 * tags that mark it as coming from the caller.
 */
export function renderParentMessage(
  callerID: SessionID,
  message: string,
): string {
  const from = sanitizeText(
    callerID,
    CALLER_ID_MAX_CODE_POINTS,
    "attribute",
  ).text;
  return `<${MESSAGE_WRAPPER} from="${from}">\n${message}\n</${MESSAGE_WRAPPER}>`;
}

/**
 * `own` for a direct child of the caller. Only a session's own parent can continue it, so for a
 * deeper target the note names that parent instead.
 */
export function continueNote(target: Descendant, own: string): string {
  return target.depth === 1
    ? own
    : `${CONTINUE_NESTED_NOTE} This one was launched by ${target.parentID}.`;
}

/**
 * The message from `sanitizeBlock`. One with no visible text is refused, or counts as absent when
 * the call switches something.
 */
function sanitizeMessage(raw: string, switching: boolean): string | undefined {
  const text = sanitizeBlock(raw, MESSAGE_WRAPPER);
  if (text === "") {
    if (switching) return undefined;
    throw new SendError("message must contain visible text; nothing was sent.");
  }
  const length = [...text].length;
  if (length > MESSAGE_MAX_CODE_POINTS) {
    throw new SendError(
      `message is ${overLimit(length, MESSAGE_MAX_CODE_POINTS)}. ${switching ? NOTHING_SWITCHED : "Nothing was sent."}`,
    );
  }
  return text;
}

/** How long ago an idle session went idle, as a sentence. */
function idleAge(info: SessionInfo, now: number): string {
  const idle = idleSince(info, false);
  return idle === undefined
    ? "When it went idle was not recorded."
    : `It went idle ${formatDuration(Math.max(0, now - idle))} ago.`;
}

/** For a session whose last run recorded no end, its idle time is unknown; its last activity may not be. */
function unendedAge(deps: SendDeps, sessionID: SessionID): string {
  const last = deps.activity?.get(sessionID)?.lastProgressAt;
  return last === undefined
    ? "When it stopped running is unknown."
    : `When it stopped running is unknown; its last activity was ${formatDuration(Math.max(0, deps.clock.now() - last))} ago.`;
}
