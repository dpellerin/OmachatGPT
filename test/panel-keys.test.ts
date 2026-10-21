import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {runInNewContext} from "node:vm";
import test from "node:test";

const panel = readFileSync(new URL("../Panel.qml", import.meta.url), "utf8");
const composer = panel.slice(panel.indexOf("id: prompt"));
const handler = composer.match(/Keys\.priority: Keys\.BeforeItem\s+Keys\.onPressed: function\(event\) \{([\s\S]*?)\n            \}/)?.[1];
assert.ok(handler, "composer key handler exists");

const Qt = {
  Key_N: 78, Key_Escape: 27, Key_Comma: 44, Key_Return: 13,
  Key_Enter: 16777221, Key_PageUp: 16777238, Key_PageDown: 16777239,
  ControlModifier: 0x04000000, MetaModifier: 0x10000000,
  ShiftModifier: 0x02000000, AltModifier: 0x08000000,
};

for (const [label, modifiers, expected] of [
  ["Super+N", Qt.MetaModifier, true],
  ["Ctrl+N", Qt.ControlModifier, true],
  ["N", 0, false],
  ["Alt+N", Qt.AltModifier, false],
] as const) {
  test(`focused composer ${label} ${expected ? "starts" : "does not start"} a new chat`, () => {
    let calls = 0;
    const event = {key: Qt.Key_N, modifiers, accepted: false};
    runInNewContext(handler!, {Qt, event, root: {newChat() { calls++; }}});
    assert.equal(calls, expected ? 1 : 0);
    assert.equal(event.accepted, expected);
  });
}
