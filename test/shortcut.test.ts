import assert from "node:assert/strict";
import test from "node:test";
import {mkdtemp, readFile, stat, writeFile} from "node:fs/promises";
import {join} from "node:path";
import {tmpdir} from "node:os";
import {
  extractShortcutFromHyprBindings,
  loadShortcutConfig,
  parseShortcutSpec,
  saveShortcutConfig,
  updateHyprBindingsContent,
} from "../src/shortcut.js";

test("parseShortcutSpec normalizes Option/Alt/Super/Ctrl combinations and displays Option", () => {
  assert.deepEqual(parseShortcutSpec("ALT + SPACE"), {
    bind: "ALT + SPACE",
    label: "Option+Space",
  });
  assert.deepEqual(parseShortcutSpec("Option+Space"), {
    bind: "ALT + SPACE",
    label: "Option+Space",
  });
  assert.deepEqual(parseShortcutSpec("Super+Shift+A"), {
    bind: "SUPER + SHIFT + A",
    label: "Super+Shift+A",
  });
  assert.deepEqual(parseShortcutSpec("Ctrl+Option+comma"), {
    bind: "CTRL + ALT + comma",
    label: "Ctrl+Option+,",
  });
  assert.throws(() => parseShortcutSpec("Space"), /modifier/);
});

test("extractShortcutFromHyprBindings and updateHyprBindingsContent preserve surrounding lua config", () => {
  const initialLua = [
    "-- Personal bindings",
    'hl.unbind("SUPER + A")',
    'hl.unbind("ALT + SPACE")',
    'o.bind("ALT + SPACE", "Toggle ChatGPT popup", "omarchy-shell shell toggle dpellerin.omachatgpt \'{}\'")',
    'o.bind("CTRL + RIGHT", "Next workspace", "step +1")',
  ].join("\n");

  assert.deepEqual(extractShortcutFromHyprBindings(initialLua), {
    bind: "ALT + SPACE",
    label: "Option+Space",
  });

  const updatedLua = updateHyprBindingsContent(initialLua, "Super+Space");
  assert.match(updatedLua, /hl\.unbind\("SUPER \+ SPACE"\)/);
  assert.match(
    updatedLua,
    /o\.bind\("SUPER \+ SPACE", "Toggle ChatGPT popup", "omarchy-shell shell toggle dpellerin\.omachatgpt '\{\}'"\)/,
  );
  assert.match(updatedLua, /Next workspace/);
  assert.deepEqual(extractShortcutFromHyprBindings(updatedLua), {
    bind: "SUPER + SPACE",
    label: "Super+Space",
  });
});

test("saveShortcutConfig persists shortcut.json with 0600 permissions and updates bindings.lua", async () => {
  const root = await mkdtemp(join(tmpdir(), "omachatgpt-shortcut-"));
  const cfgPath = join(root, "shortcut.json");
  const bindingsPath = join(root, "bindings.lua");
  await writeFile(
    bindingsPath,
    'hl.unbind("ALT + SPACE")\no.bind("ALT + SPACE", "Toggle ChatGPT popup", "omarchy-shell shell toggle dpellerin.omachatgpt \'{}\'")\n',
  );

  let reloaded = 0;
  const saved = await saveShortcutConfig("Ctrl+Space", {
    configPath: cfgPath,
    bindingsPath,
    reloadHyprland: async () => {
      reloaded++;
    },
  });

  assert.deepEqual(saved, {bind: "CTRL + SPACE", label: "Ctrl+Space"});
  assert.equal(reloaded, 1);
  assert.equal((await stat(cfgPath)).mode & 0o777, 0o600);
  const luaAfter = await readFile(bindingsPath, "utf8");
  assert.match(luaAfter, /hl\.unbind\("CTRL \+ SPACE"\)/);
  assert.match(luaAfter, /o\.bind\("CTRL \+ SPACE"/);

  const loaded = await loadShortcutConfig(cfgPath, bindingsPath);
  assert.deepEqual(loaded, {bind: "CTRL + SPACE", label: "Ctrl+Space"});
});
