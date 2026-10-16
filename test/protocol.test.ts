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

test("chat additionally blocks hooks, code mode, skill discovery and API authentication", () => {
  const args = codexArguments();
  for (const feature of [
    "hooks",
    "code_mode",
    "sleep_tool",
    "skill_mcp_dependency_install",
    "remote_plugin",
    "workspace_dependencies",
  ]) {
    assert.ok(args.some((v, i) => v === "--disable" && args[i + 1] === feature), feature);
  }
  assert.ok(args.includes('forced_login_method="chatgpt"'));
  assert.ok(args.includes("skip_host_skill_discovery"));
});

test("web search is explicitly exposed independently of disabled code mode", () => {
  const args = codexArguments();
  assert.ok(args.some((v, i) => v === "--enable" && args[i + 1] === "standalone_web_search"));
});

test("web routing host remains available while model code execution stays disabled", () => {
  const args = codexArguments();
  assert.ok(!args.some((v, i) => v === "--disable" && args[i + 1] === "code_mode_host"));
  assert.ok(args.some((v, i) => v === "--disable" && args[i + 1] === "code_mode"));
});
