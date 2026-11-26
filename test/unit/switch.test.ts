import { describe, expect, test } from "bun:test";
import type { ModelRef } from "@/core/ports";
import { parseModelRef, SwitchError } from "@/core/switch";

// The cases follow OpenCode's `Model.Ref.parse`: the provider ends at the first slash, the variant
// starts at the first `#` after it, and an empty provider, model or variant, or a second `#`, is
// invalid.
describe("parseModelRef", () => {
  test.each<[string, string, ModelRef]>([
    ["a model", "openai/gpt-5", { providerID: "openai", id: "gpt-5" }],
    [
      "a model with a variant",
      "openai/gpt-5#high",
      { providerID: "openai", id: "gpt-5", variant: "high" },
    ],
    [
      "a model ID that contains slashes",
      "openrouter/anthropic/claude-sonnet-4#thinking",
      {
        providerID: "openrouter",
        id: "anthropic/claude-sonnet-4",
        variant: "thinking",
      },
    ],
    [
      "a variant that contains a slash",
      "openai/gpt-5#effort/high",
      { providerID: "openai", id: "gpt-5", variant: "effort/high" },
    ],
    [
      "surrounding whitespace",
      "  openai/gpt-5#high \n",
      { providerID: "openai", id: "gpt-5", variant: "high" },
    ],
  ])("parses %s", (_, input, expected) => {
    expect(parseModelRef(input)).toStrictEqual(expected);
  });

  test.each([
    ["no provider", "gpt-5"],
    ["an empty provider", "/gpt-5"],
    ["an empty model", "openai/"],
    ["an empty model before a variant", "openai/#high"],
    ["an empty variant", "openai/gpt-5#"],
    ["a second variant marker", "openai/gpt-5#high#low"],
    ["a variant marker in the provider", "open#ai/gpt-5"],
  ])("refuses %s, with both accepted forms", (_, input) => {
    expect(() => parseModelRef(input)).toThrow(
      new SwitchError(
        `Invalid model "${input}". Use "providerID/modelID" or "providerID/modelID#variant". Nothing was switched or sent.`,
      ),
    );
  });
});
