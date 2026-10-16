import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { citationSourcesFromResults, normalizeAssistantText } from "./render.js";
export const DEFAULT_MODEL = "gpt-6-luna";
export const STATE_VERSION = 3;
export function stateDir(env = process.env) {
    if (env.OMACHATGPT_STATE_DIR)
        return env.OMACHATGPT_STATE_DIR;
    if (env.SPEEDCHAT_STATE_DIR)
        return env.SPEEDCHAT_STATE_DIR;
    const root = env.XDG_STATE_HOME || join(homedir(), ".local", "state");
    return join(root, "omachatgpt");
}
export function statePath(env = process.env) {
    return join(stateDir(env), "state.json");
}
export async function loadState(path = statePath()) {
    try {
        const parsed = JSON.parse(await readFile(path, "utf8"));
        if (parsed.version !== STATE_VERSION || typeof parsed.threadId !== "string" || !parsed.threadId)
            return null;
        if (typeof parsed.model !== "string" || !parsed.model || typeof parsed.updatedAt !== "string")
            return null;
        const messages = Array.isArray(parsed.messages)
            ? parsed.messages.filter((m) => Boolean(m &&
                typeof m === "object" &&
                typeof m.id === "string" &&
                (m.role === "user" || m.role === "assistant") &&
                typeof m.text === "string"))
            : undefined;
        const codexSyncedCount = typeof parsed.codexSyncedCount === "number" ? parsed.codexSyncedCount : undefined;
        return {
            version: STATE_VERSION,
            threadId: parsed.threadId,
            model: parsed.model,
            updatedAt: parsed.updatedAt,
            ...(messages ? { messages } : {}),
            ...(codexSyncedCount !== undefined ? { codexSyncedCount } : {}),
        };
    }
    catch (error) {
        if (error.code === "ENOENT")
            return null;
        return null;
    }
}
export async function saveState(threadId, model, path = statePath(), messages, codexSyncedCount) {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const temporary = `${path}.${process.pid}.tmp`;
    const data = {
        version: STATE_VERSION,
        threadId,
        model,
        updatedAt: new Date().toISOString(),
        ...(messages ? { messages } : {}),
        ...(codexSyncedCount !== undefined ? { codexSyncedCount } : {}),
    };
    await writeFile(temporary, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
    await chmod(temporary, 0o600);
    await rename(temporary, path);
    await chmod(path, 0o600);
}
function itemToMessage(item, sources = []) {
    if (item.type === "userMessage") {
        const text = (item.content || [])
            .filter((part) => part.type === "text" && typeof part.text === "string")
            .map((part) => part.text)
            .join("\n");
        return text ? { id: item.id, role: "user", text } : null;
    }
    if (item.type === "agentMessage" && item.phase !== "commentary" && item.text) {
        return { id: item.id, role: "assistant", text: normalizeAssistantText(item.text, sources) };
    }
    return null;
}
export function messagesFromTurns(turns) {
    return turns.flatMap((turn) => {
        const sources = turn.items.flatMap((item) => (item.type === "webSearch" ? citationSourcesFromResults(item.results) : []));
        return turn.items.map((item) => itemToMessage(item, sources)).filter((item) => item !== null);
    });
}
export function friendlyError(error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/unauthorized|not logged in|authentication/i.test(message)) {
        return "ChatGPT sign-in is required. Run `codex login` in a regular terminal, or configure OpenRouter in Settings.";
    }
    if (/usageLimitExceeded|rate.?limit|quota|usage limit/i.test(message)) {
        return "Your Codex usage limit has been reached. Try again after the allowance resets.";
    }
    if (/ENOENT.*codex|spawn codex ENOENT|codex executable was not found/i.test(message)) {
        return "Codex is not installed or is not on PATH. Update Omarchy or configure OpenRouter in Settings.";
    }
    if (/model.*unavailable/i.test(message)) {
        return "That model is not available to this account. Choose another model or update Codex.";
    }
    return message.replace(/\s+/g, " ").trim() || "Something went wrong.";
}
