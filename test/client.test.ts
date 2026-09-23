import assert from "node:assert/strict";
import test from "node:test";
import {availableModels, defaultModel} from "../src/client.js";
import type {CodexModel} from "../src/types.js";

function candidate(model: string, hidden = false, efforts = ["low"]): CodexModel {
  return {
    id: model, model, displayName: model, hidden,
    supportedReasoningEfforts: efforts.map((reasoningEffort) => ({reasoningEffort})),
  };
}

test("chooser includes only visible models supporting the actual effort", () => {
  assert.deepEqual(availableModels([
    candidate("gpt-6-luna"), candidate("hidden", true), candidate("medium-only", false, ["medium"]),
  ]).map(({model}) => model), ["gpt-6-luna"]);
});

test("new sessions prefer current Luna and fall back to an available model", () => {
  assert.equal(defaultModel(availableModels([candidate("gpt-6-sol"), candidate("gpt-6-luna")])), "gpt-6-luna");
  assert.equal(defaultModel(availableModels([candidate("gpt-5.6-luna"), candidate("gpt-6-sol")])), "gpt-5.6-luna");
  assert.equal(defaultModel(availableModels([candidate("gpt-6-sol")])), "gpt-6-sol");
});
