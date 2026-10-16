import { execFile } from "node:child_process";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { stateDir } from "./state.js";
const execFileAsync = promisify(execFile);
export const DEFAULT_SHORTCUT = {
    bind: "ALT + SPACE",
    label: "Option+Space",
};
const MODIFIER_ORDER = ["SUPER", "CTRL", "ALT", "SHIFT"];
const DISPLAY_MODIFIER_MAP = {
    SUPER: "Super",
    CTRL: "Ctrl",
    ALT: "Option",
    SHIFT: "Shift",
};
const DISPLAY_KEY_MAP = {
    SPACE: "Space",
    RETURN: "Return",
    TAB: "Tab",
    BACKSPACE: "Backspace",
    DELETE: "Delete",
    INSERT: "Insert",
    HOME: "Home",
    END: "End",
    PRIOR: "PageUp",
    NEXT: "PageDown",
    UP: "Up",
    DOWN: "Down",
    LEFT: "Left",
    RIGHT: "Right",
    comma: ",",
    period: ".",
    slash: "/",
    semicolon: ";",
    apostrophe: "'",
    bracketleft: "[",
    bracketright: "]",
    backslash: "\\",
    minus: "-",
    equal: "=",
    grave: "`",
};
const INPUT_KEY_NORMALIZATION = {
    SPACE: "SPACE",
    " ": "SPACE",
    ENTER: "RETURN",
    RETURN: "RETURN",
    TAB: "TAB",
    BACKSPACE: "BACKSPACE",
    DELETE: "DELETE",
    DEL: "DELETE",
    INSERT: "INSERT",
    INS: "INSERT",
    HOME: "HOME",
    END: "END",
    PAGEUP: "PRIOR",
    PGUP: "PRIOR",
    PRIOR: "PRIOR",
    PAGEDOWN: "NEXT",
    PGDN: "NEXT",
    NEXT: "NEXT",
    UP: "UP",
    DOWN: "DOWN",
    LEFT: "LEFT",
    RIGHT: "RIGHT",
    ",": "comma",
    COMMA: "comma",
    ".": "period",
    PERIOD: "period",
    "/": "slash",
    SLASH: "slash",
    ";": "semicolon",
    SEMICOLON: "semicolon",
    "'": "apostrophe",
    APOSTROPHE: "apostrophe",
    "[": "bracketleft",
    BRACKETLEFT: "bracketleft",
    "]": "bracketright",
    BRACKETRIGHT: "bracketright",
    "\\": "backslash",
    BACKSLASH: "backslash",
    "-": "minus",
    MINUS: "minus",
    "=": "equal",
    EQUAL: "equal",
    "`": "grave",
    GRAVE: "grave",
};
export function shortcutConfigPath(env = process.env) {
    return join(stateDir(env), "shortcut.json");
}
export function hyprBindingsPath(env = process.env) {
    const configHome = env.XDG_CONFIG_HOME || join(env.HOME || homedir(), ".config");
    return join(configHome, "hypr", "bindings.lua");
}
export function parseShortcutSpec(raw) {
    const cleaned = String(raw || "")
        .replace(/⌥/g, " Option ")
        .replace(/⌘/g, " Super ")
        .replace(/⌃/g, " Ctrl ")
        .replace(/⇧/g, " Shift ")
        .trim();
    if (!cleaned) {
        throw new Error("Shortcut cannot be empty.");
    }
    const tokens = cleaned
        .split(/[+\s]+/)
        .map((token) => token.trim())
        .filter(Boolean);
    const modifiers = new Set();
    let keyToken = "";
    for (const token of tokens) {
        const upper = token.toUpperCase();
        if (upper === "ALT" || upper === "OPTION" || upper === "OPT" || upper === "META") {
            modifiers.add("ALT");
        }
        else if (upper === "CTRL" || upper === "CONTROL") {
            modifiers.add("CTRL");
        }
        else if (upper === "SUPER" || upper === "CMD" || upper === "COMMAND" || upper === "WIN") {
            modifiers.add("SUPER");
        }
        else if (upper === "SHIFT") {
            modifiers.add("SHIFT");
        }
        else {
            if (keyToken) {
                throw new Error(`Shortcut can only include one non-modifier key (found "${keyToken}" and "${token}").`);
            }
            keyToken = token;
        }
    }
    if (modifiers.size === 0) {
        throw new Error("Include at least one modifier (Option, Ctrl, Super, or Shift).");
    }
    if (!keyToken) {
        throw new Error("Include a key with your modifier (for example Option+Space).");
    }
    const upperKey = keyToken.toUpperCase();
    let normalizedKey = INPUT_KEY_NORMALIZATION[keyToken] || INPUT_KEY_NORMALIZATION[upperKey] || "";
    if (!normalizedKey) {
        if (/^[A-Z0-9]$/.test(upperKey)) {
            normalizedKey = upperKey;
        }
        else if (/^F(?:[1-9]|1[0-2])$/.test(upperKey)) {
            normalizedKey = upperKey;
        }
        else {
            throw new Error(`Unsupported shortcut key "${keyToken}".`);
        }
    }
    const orderedModifiers = MODIFIER_ORDER.filter((mod) => modifiers.has(mod));
    const bind = [...orderedModifiers, normalizedKey].join(" + ");
    const displayParts = [
        ...orderedModifiers.map((mod) => DISPLAY_MODIFIER_MAP[mod] || mod),
        DISPLAY_KEY_MAP[normalizedKey] || normalizedKey,
    ];
    return {
        bind,
        label: displayParts.join("+"),
    };
}
export function extractShortcutFromHyprBindings(luaSource) {
    const lines = String(luaSource || "").split(/\r?\n/);
    for (let i = lines.length - 1; i >= 0; i--) {
        const line = lines[i]?.trim() || "";
        if (line.startsWith("--") || !line.includes("dpellerin.omachatgpt"))
            continue;
        const match = line.match(/^(?:o|hl)\.bind\(\s*"([^"]+)"/);
        if (match?.[1]) {
            try {
                return parseShortcutSpec(match[1]);
            }
            catch {
                // Ignore malformed custom lines.
            }
        }
    }
    return null;
}
export function updateHyprBindingsContent(luaSource, nextBind) {
    const normalized = parseShortcutSpec(nextBind);
    const lines = String(luaSource || "").replace(/\r\n/g, "\n").split("\n");
    const bindLineIndex = lines.findIndex((line) => {
        const trimmed = line.trim();
        return !trimmed.startsWith("--") && trimmed.includes("dpellerin.omachatgpt") && /^(?:o|hl)\.bind\(/.test(trimmed);
    });
    let previousBind = "";
    if (bindLineIndex >= 0) {
        const existingMatch = lines[bindLineIndex]?.match(/^(?:o|hl)\.bind\(\s*"([^"]+)"/);
        previousBind = existingMatch?.[1] ? parseShortcutSpec(existingMatch[1]).bind : "";
    }
    const newUnbindLine = `hl.unbind("${normalized.bind}")`;
    const newBindLine = `o.bind("${normalized.bind}", "Toggle ChatGPT popup", "omarchy-shell shell toggle dpellerin.omachatgpt '{}'")`;
    if (bindLineIndex >= 0) {
        lines[bindLineIndex] = newBindLine;
        // Update the preceding unbind if it matched the old binding, or insert one if not present
        let unbindUpdated = false;
        for (let i = bindLineIndex - 1; i >= Math.max(0, bindLineIndex - 5); i--) {
            const trimmed = lines[i]?.trim() || "";
            if (trimmed === newUnbindLine) {
                unbindUpdated = true;
                break;
            }
            if (previousBind && trimmed === `hl.unbind("${previousBind}")`) {
                lines[i] = newUnbindLine;
                unbindUpdated = true;
                break;
            }
        }
        if (!unbindUpdated) {
            lines.splice(bindLineIndex, 0, newUnbindLine);
        }
        return lines.join("\n");
    }
    const trimmedEnd = lines.join("\n").replace(/\s+$/, "");
    const block = [
        "",
        "-- Toggle the native OmachatGPT shell panel.",
        newUnbindLine,
        newBindLine,
        "",
    ].join("\n");
    return trimmedEnd ? `${trimmedEnd}\n${block}` : `${block.trimStart()}`;
}
export async function loadShortcutConfig(path = shortcutConfigPath(), bindingsPath = hyprBindingsPath()) {
    try {
        const luaText = await readFile(bindingsPath, "utf8");
        const fromLua = extractShortcutFromHyprBindings(luaText);
        if (fromLua)
            return fromLua;
    }
    catch {
        // Fall back to saved state file or default.
    }
    try {
        const raw = JSON.parse(await readFile(path, "utf8"));
        if (typeof raw.bind === "string") {
            return parseShortcutSpec(raw.bind);
        }
    }
    catch {
        // Fall back to default.
    }
    return { ...DEFAULT_SHORTCUT };
}
async function defaultReloadHyprland() {
    try {
        await execFileAsync("hyprctl", ["reload"], { timeout: 4000 });
    }
    catch {
        // Ignore when running outside an active Hyprland session (e.g. CI or unit tests).
    }
}
export async function saveShortcutConfig(rawShortcut, options = {}) {
    const normalized = parseShortcutSpec(rawShortcut);
    const cfgPath = options.configPath || shortcutConfigPath();
    const bindPath = options.bindingsPath || hyprBindingsPath();
    await mkdir(dirname(cfgPath), { recursive: true, mode: 0o700 });
    const tmpCfg = `${cfgPath}.${process.pid}.tmp`;
    await writeFile(tmpCfg, `${JSON.stringify({ bind: normalized.bind, label: normalized.label, updatedAt: new Date().toISOString() }, null, 2)}\n`, { mode: 0o600 });
    await chmod(tmpCfg, 0o600);
    await rename(tmpCfg, cfgPath);
    await chmod(cfgPath, 0o600);
    try {
        let existingLua = "";
        try {
            existingLua = await readFile(bindPath, "utf8");
        }
        catch {
            existingLua = "";
        }
        if (existingLua || options.bindingsPath) {
            await mkdir(dirname(bindPath), { recursive: true });
            const updatedLua = updateHyprBindingsContent(existingLua, normalized.bind);
            const tmpLua = `${bindPath}.${process.pid}.tmp`;
            await writeFile(tmpLua, updatedLua, "utf8");
            await rename(tmpLua, bindPath);
            const reloadFn = options.reloadHyprland || defaultReloadHyprland;
            await reloadFn();
        }
    }
    catch {
        // If ~/.config/hypr/bindings.lua is not writable, shortcut.json still persists the preference.
    }
    return normalized;
}
