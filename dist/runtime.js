import { accessSync, constants, readdirSync, statSync } from "node:fs";
import { chmod, mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { homedir, tmpdir } from "node:os";
export function safeEnvironment(env = process.env) {
    const result = {};
    for (const key of [
        "HOME",
        "USER",
        "LOGNAME",
        "TMPDIR",
        "LANG",
        "LC_ALL",
        "XDG_STATE_HOME",
        "XDG_CONFIG_HOME",
        "XDG_DATA_HOME",
        "XDG_RUNTIME_DIR",
        "CODEX_HOME",
        "OMACHATGPT_STATE_DIR",
        "OMACHATGPT_CODEX",
        "SPEEDCHAT_STATE_DIR",
        "SPEEDCHAT_CODEX",
    ]) {
        if (env[key])
            result[key] = env[key];
    }
    const home = env.HOME || homedir();
    result.PATH = [
        env.PATH,
        "/usr/local/bin",
        join(home, ".local/bin"),
        join(home, ".volta/bin"),
        join(home, ".asdf/shims"),
        join(home, ".local/share/mise/shims"),
        join(home, ".fnm/current/bin"),
        join(home, ".local/share/pnpm"),
        "/usr/bin",
        "/bin",
    ]
        .filter(Boolean)
        .join(":");
    return result;
}
export function resolveExecutable(name, env = process.env, home = homedir()) {
    const override = env[`OMACHATGPT_${name.toUpperCase()}`] || env[`SPEEDCHAT_${name.toUpperCase()}`];
    const candidates = override
        ? [override]
        : (safeEnvironment(env).PATH || "")
            .split(":")
            .filter(Boolean)
            .map((path) => join(path, name));
    if (!override && name === "node") {
        const root = join(home, ".hermes", "tools");
        try {
            for (const entry of readdirSync(root)
                .filter((e) => /^node-.*-(linux|darwin)-(arm64|x64)$/.test(e))
                .sort()
                .reverse()) {
                candidates.push(join(root, entry, "bin/node"));
            }
        }
        catch {
            // Optional fallback path.
        }
    }
    for (const candidate of candidates) {
        try {
            accessSync(candidate, constants.X_OK);
            if (statSync(candidate).isFile())
                return candidate;
        }
        catch {
            // Continue scanning PATH candidates.
        }
    }
    throw new Error(`${name} executable was not found. Make sure Node.js 20+ and the Codex CLI are installed.`);
}
export async function createRuntimeDirectory() {
    const path = await mkdtemp(join(tmpdir(), "omachatgpt-"));
    await chmod(path, 0o700);
    return path;
}
