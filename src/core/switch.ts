// Checks a change of a subagent's agent or model the way OpenCode's `subagent` tool checks one when
// it continues a child with a different agent or a `model`, against the catalog of this plugin
// instance's location, which `sendToSubagent` only uses for subagents in that location. One check
// goes further than OpenCode's: a new agent's configured model must be available too. OpenCode
// switches to it unchecked, and a subagent left with an unavailable model fails at its next step;
// refusing up front leaves it running as it was. Nothing here switches anything: `sendToSubagent`
// applies a plan only once every check has passed.

import { errorMessage } from "@/core/errors";
import type {
  CatalogAgent,
  CatalogModel,
  ModelRef,
  SessionInfo,
  SessionSwitcher,
} from "@/core/ports";

/** Ends the errors of a call that switched and sent nothing. */
export const NOTHING_SWITCHED = "Nothing was switched or sent.";

/** Model types other than chat that OpenCode lists, to tell a model of another type from a missing one. */
const NON_CHAT_TYPES = ["image", "video", "decision"];

/** A checked agent or model cannot be switched to. Nothing was switched or sent. */
export class SwitchError extends Error {
  override name = "SwitchError";
}

/** One value a call switches. `from` equals `to` when the value asked for is already in effect. */
export interface Change<T> {
  /** Absent when the session records none, so OpenCode falls back to its default. */
  readonly from?: T;
  readonly to: T;
}

export interface ModelChange extends Change<ModelRef> {
  /** `agent` when the model is the configured model of the agent the call switches to. */
  readonly source: "request" | "agent";
}

export interface SwitchPlan {
  /** Set when the call asked for an agent. */
  readonly agent?: Change<string>;
  /** Set when the call asked for a model, or switches to an agent that has a configured model. */
  readonly model?: ModelChange;
}

/** The values a plan changes, models written as `providerID/modelID#variant`. */
export interface SwitchedValues {
  readonly agent?: Change<string>;
  readonly model?: Change<string>;
}

/**
 * Parses `providerID/modelID` or `providerID/modelID#variant` the way OpenCode does: the provider
 * ends at the first slash, so a model ID can contain slashes, and the variant starts at the first
 * `#` after it. Surrounding whitespace is ignored. Throws `SwitchError` for any other shape.
 */
export function parseModelRef(input: string): ModelRef {
  const text = input.trim();
  const invalid = () =>
    new SwitchError(
      `Invalid model ${JSON.stringify(input)}. Use "providerID/modelID" or "providerID/modelID#variant". ${NOTHING_SWITCHED}`,
    );
  const providerEnd = text.indexOf("/");
  if (providerEnd <= 0) throw invalid();
  const providerID = text.slice(0, providerEnd);
  const variantStart = text.indexOf("#", providerEnd + 1);
  const id = text.slice(
    providerEnd + 1,
    variantStart === -1 ? undefined : variantStart,
  );
  const variant =
    variantStart === -1 ? undefined : text.slice(variantStart + 1);
  if (
    id === "" ||
    providerID.includes("#") ||
    (variant !== undefined && (variant === "" || variant.includes("#")))
  ) {
    throw invalid();
  }
  return { providerID, id, ...(variant === undefined ? {} : { variant }) };
}

/** `providerID/modelID#variant`, or without `#variant` when the ref names none. */
export function formatModelRef(ref: ModelRef): string {
  const base = `${ref.providerID}/${ref.id}`;
  return ref.variant === undefined ? base : `${base}#${ref.variant}`;
}

/** Whether `a` names model `b` at its variant. OpenCode treats no variant as `default`. */
export function sameModel(a: ModelRef | undefined, b: ModelRef): boolean {
  return (
    a !== undefined &&
    a.providerID === b.providerID &&
    a.id === b.id &&
    (a.variant ?? "default") === (b.variant ?? "default")
  );
}

/** The agent switch the plan makes, when the agent changes. */
export function agentChange(plan: SwitchPlan): Change<string> | undefined {
  return plan.agent !== undefined && plan.agent.from !== plan.agent.to
    ? plan.agent
    : undefined;
}

/** The model switch the plan makes, when the model changes. */
export function modelChange(plan: SwitchPlan): ModelChange | undefined {
  return plan.model !== undefined && !sameModel(plan.model.from, plan.model.to)
    ? plan.model
    : undefined;
}

/** What the plan changes; empty when everything it asked for is already in effect. */
export function switchedValues(plan: SwitchPlan): SwitchedValues {
  const agent = agentChange(plan);
  const model = modelChange(plan);
  return {
    ...(agent === undefined ? {} : { agent }),
    ...(model === undefined
      ? {}
      : {
          model: {
            ...(model.from === undefined
              ? {}
              : { from: formatModelRef(model.from) }),
            to: formatModelRef(model.to),
          },
        }),
  };
}

/**
 * `from agent general to explore and from model a/b to c/d#high`, for the values that change, with
 * `from its default model` when the session recorded none; undefined when nothing changes.
 */
export function describeChanges(values: SwitchedValues): string | undefined {
  const change = (kind: string, value: Change<string>) =>
    value.from === undefined
      ? `from its default ${kind} to ${value.to}`
      : `from ${kind} ${value.from} to ${value.to}`;
  const parts = [
    ...(values.agent === undefined ? [] : [change("agent", values.agent)]),
    ...(values.model === undefined ? [] : [change("model", values.model)]),
  ];
  return parts.length === 0 ? undefined : parts.join(" and ");
}

/**
 * Plans the switch from `target`, the session as last read, and checks the agent and model asked for
 * against the switcher's catalog. An agent other than the target's current one must exist and be
 * able to run as a subagent; without a model it brings its configured model, if it has one. Every
 * model the plan names must be an available chat model with the variant named, the agent's
 * configured one included. Throws `SwitchError` at the first failure.
 */
export async function planSwitch(
  switcher: Pick<SessionSwitcher, "agents" | "models">,
  target: SessionInfo,
  request: { readonly agent?: string; readonly model?: ModelRef },
): Promise<SwitchPlan> {
  const from = <T>(value: T | undefined) =>
    value === undefined ? {} : { from: value };
  let agent: Change<string> | undefined;
  let configured: ModelRef | undefined;
  if (request.agent !== undefined) {
    agent = { ...from(target.agent), to: request.agent };
    if (agent.from !== agent.to) {
      configured = (await findAgent(switcher, request.agent)).model;
    }
  }
  let model: ModelChange | undefined;
  if (request.model !== undefined) {
    await checkModel(switcher, request.model);
    model = { ...from(target.model), to: request.model, source: "request" };
  } else if (configured !== undefined && agent !== undefined) {
    await checkModel(switcher, configured, agent.to);
    model = { ...from(target.model), to: configured, source: "agent" };
  }
  return {
    ...(agent === undefined ? {} : { agent }),
    ...(model === undefined ? {} : { model }),
  };
}

async function findAgent(
  switcher: Pick<SessionSwitcher, "agents">,
  id: string,
): Promise<CatalogAgent> {
  const agents = await readCatalog("agents", () => switcher.agents());
  const agent = agents.find((candidate) => candidate.id === id);
  if (agent === undefined) {
    throw new SwitchError(
      `Unknown agent ${JSON.stringify(id)}. ${subagentList(agents)} ${NOTHING_SWITCHED}`,
    );
  }
  if (agent.mode === "primary") {
    throw new SwitchError(
      `Agent ${id} cannot run as a subagent. ${subagentList(agents)} ${NOTHING_SWITCHED}`,
    );
  }
  return agent;
}

/** The agents a parent can name, the way OpenCode lists them to it: no primary or hidden agents. */
function subagentList(agents: readonly CatalogAgent[]): string {
  const ids = agents
    .filter((agent) => agent.mode !== "primary" && !agent.hidden)
    .map((agent) => agent.id)
    .toSorted();
  return ids.length === 0
    ? "No agent can run as a subagent in this project."
    : `Agents that can run as subagents: ${ids.join(", ")}.`;
}

/**
 * Throws `SwitchError` unless `ref` names an available chat model with the variant named. With
 * `agent`, the error says the model is that agent's configured one.
 */
async function checkModel(
  switcher: Pick<SessionSwitcher, "models">,
  ref: ModelRef,
  agent?: string,
): Promise<void> {
  const name = JSON.stringify(`${ref.providerID}/${ref.id}`);
  const fail = (reason: string) =>
    new SwitchError(
      agent === undefined
        ? `${reason} ${NOTHING_SWITCHED}`
        : `${reason} It is the configured model of agent ${agent}; pass model to choose another. ${NOTHING_SWITCHED}`,
    );
  const models = await readCatalog("models", () => switcher.models());
  const model = models.find(
    (candidate) =>
      candidate.providerID === ref.providerID && candidate.id === ref.id,
  );
  if (model === undefined) {
    const other = await otherTypeModel(switcher, ref);
    throw fail(
      other === undefined
        ? `Model ${name} is not available. Use the models tool to see what is available.`
        : `Model ${name} is ${withArticle(other.type ?? "non-chat")} model; subagents need a chat model. Use the models tool to find one.`,
    );
  }
  if (
    ref.variant !== undefined &&
    !model.variants.some((variant) => variant.id === ref.variant)
  ) {
    throw fail(
      model.variants.length === 0
        ? `Model ${name} has no variants. Omit the variant.`
        : `Variant ${JSON.stringify(ref.variant)} is not available for ${name}. Available: ${model.variants.map((variant) => variant.id).join(", ")}.`,
    );
  }
}

/** The model of another type that `ref` names; undefined when there is none or the list fails. */
async function otherTypeModel(
  switcher: Pick<SessionSwitcher, "models">,
  ref: ModelRef,
): Promise<CatalogModel | undefined> {
  try {
    return (await switcher.models(NON_CHAT_TYPES)).find(
      (candidate) =>
        candidate.providerID === ref.providerID && candidate.id === ref.id,
    );
  } catch {
    return undefined;
  }
}

function withArticle(word: string): string {
  return `${/^[aeiou]/i.test(word) ? "an" : "a"} ${word}`;
}

async function readCatalog<T>(
  what: "agents" | "models",
  read: () => Promise<T>,
): Promise<T> {
  try {
    return await read();
  } catch (error) {
    throw new SwitchError(
      `The ${what} available to the subagent could not be read: ${errorMessage(error)}. ${NOTHING_SWITCHED}`,
    );
  }
}
