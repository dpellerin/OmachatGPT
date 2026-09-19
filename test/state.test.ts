import assert from "node:assert/strict";
import test from "node:test";
import {mkdtemp, readFile, stat, writeFile} from "node:fs/promises";
import {join} from "node:path";
import {tmpdir} from "node:os";
import {friendlyError, loadState, messagesFromTurns, saveState, STATE_VERSION} from "../src/state.js";

test("state round trips with private permissions", async () => {
  const root = await mkdtemp(join(tmpdir(), "omachatgpt-test-"));
  const path = join(root, "nested", "state.json");
  await saveState("thread-123", path);
  assert.equal((await loadState(path))?.threadId, "thread-123");
  assert.equal((await loadState(path))?.version, STATE_VERSION);
  assert.equal((await stat(path)).mode & 0o777, 0o600);
  assert.match(await readFile(path, "utf8"), /gpt-5\.6-luna/);
});

test("invalid state is ignored", async () => {
  const root = await mkdtemp(join(tmpdir(), "omachatgpt-test-"));
  assert.equal(await loadState(join(root, "missing.json")), null);
});

test("older chat policy state is not resumed", async () => {
  const root = await mkdtemp(join(tmpdir(), "omachatgpt-test-"));
  const path = join(root, "state.json");
  await writeFile(path, JSON.stringify({
    version: 1,
    threadId: "old-thread",
    model: "gpt-5.6-luna",
    updatedAt: new Date().toISOString(),
  }));
  assert.equal(await loadState(path), null);
});

test("turn history keeps only user and final assistant messages", () => {
  const messages = messagesFromTurns([{id: "turn", status: "completed", items: [
    {id: "u", type: "userMessage", content: [{type: "text", text: "Hello"}]},
    {id: "c", type: "agentMessage", phase: "commentary", text: "Working"},
    {id: "a", type: "agentMessage", phase: "final_answer", text: "Hi!"},
    {id: "tool", type: "commandExecution"},
  ]}]);
  assert.deepEqual(messages.map(({role, text}) => ({role, text})), [
    {role: "user", text: "Hello"},
    {role: "assistant", text: "Hi!"},
  ]);
});

test("resumed history resolves citations from its web search items", () => {
  const messages = messagesFromTurns([{id: "turn", status: "completed", items: [
    {id: "search", type: "webSearch", results: [{ref_id: "turn0search0", title: "Example", url: "https://example.com"}]},
    {id: "a", type: "agentMessage", phase: "final_answer", text: "Fact. \uE200cite\uE202turn0search0\uE201"},
  ]}]);
  assert.equal(messages[0]?.text, "Fact. [Example](https://example.com)");
});

test("errors are translated into recovery actions", () => {
  assert.match(friendlyError(new Error("unauthorized")), /codex login/);
  assert.match(friendlyError(new Error("usageLimitExceeded")), /usage limit/);
});
