import assert from "node:assert/strict";
import test from "node:test";
import {codexArguments, DISABLED_FEATURES} from "../src/protocol.js";

test("Codex starts with live web search and all other tools disabled", () => {
  const args = codexArguments();
  assert.deepEqual(args.slice(0, 2), ["app-server", "--stdio"]);
  for (const feature of DISABLED_FEATURES) {
    const index = args.findIndex((value, position) => value === "--disable" && args[position + 1] === feature);
    assert.notEqual(index, -1, `${feature} should be disabled`);
  }
  assert.deepEqual(args.slice(-4), ["-c", "mcp_servers={}", "-c", 'web_search="live"']);
});
