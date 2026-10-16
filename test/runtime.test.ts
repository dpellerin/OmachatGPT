import assert from "node:assert/strict";
import test from "node:test";
import {mkdtemp, mkdir, writeFile, chmod, stat, readdir} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {resolveExecutable, safeEnvironment, createRuntimeDirectory} from "../src/runtime.js";

test("dependency discovery uses paths with spaces and rejects invalid overrides", async () => {
  const root = await mkdtemp(join(tmpdir(), "omachatgpt-runtime-"));
  const bin = join(root, "tools with spaces");
  await mkdir(bin);
  const exe = join(bin, "codex");
  await writeFile(exe, "");
  await chmod(exe, 0o700);
  assert.equal(resolveExecutable("codex", {PATH: bin}, root), exe);
  assert.throws(() => resolveExecutable("codex", {PATH: bin, OMACHATGPT_CODEX: "/missing"}, root), /executable/);
});

test("chat environment never inherits keys or Node injection options", () => {
  const env = safeEnvironment({
    HOME: "/home",
    PATH: "/bin",
    OPENAI_API_KEY: "secret",
    ANTHROPIC_API_KEY: "secret",
    NODE_OPTIONS: "injection",
    OMACHATGPT_STATE_DIR: "/tmp/test",
  });
  assert.equal(env.OPENAI_API_KEY, undefined);
  assert.equal(env.ANTHROPIC_API_KEY, undefined);
  assert.equal(env.NODE_OPTIONS, undefined);
  assert.equal(env.OMACHATGPT_STATE_DIR, "/tmp/test");
  assert.match(env.PATH!, /\/usr\/local\/bin/);
});

test("each runtime cwd is private, empty, and unique", async () => {
  const a = await createRuntimeDirectory();
  const b = await createRuntimeDirectory();
  assert.notEqual(a, b);
  assert.deepEqual(await readdir(a), []);
  assert.equal((await stat(a)).mode & 0o777, 0o700);
});

test("executable overrides reject directories even when searchable", async () => {
  const root = await mkdtemp(join(tmpdir(), "omachatgpt-exe-dir-"));
  assert.throws(() => resolveExecutable("codex", {OMACHATGPT_CODEX: root}, root), /executable/);
});
