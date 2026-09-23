import {chmod, mkdir, readFile, rename, writeFile} from "node:fs/promises";
import {dirname, join} from "node:path";
import {homedir} from "node:os";
import type {ChatMessage, PersistedState, ThreadItem, ThreadTurn} from "./types.js";
import {citationSourcesFromResults, normalizeAssistantText, type CitationSource} from "./render.js";

export const DEFAULT_MODEL = "gpt-6-luna";
export const STATE_VERSION = 3;

export function statePath(env: NodeJS.ProcessEnv = process.env): string {
  const root = env.XDG_STATE_HOME || join(homedir(), ".local", "state");
  return join(root, "omachatgpt", "state.json");
}

export async function loadState(path = statePath()): Promise<PersistedState | null> {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as Partial<PersistedState>;
    if (parsed.version !== STATE_VERSION || typeof parsed.threadId !== "string" || !parsed.threadId) return null;
    if (typeof parsed.model !== "string" || !parsed.model || typeof parsed.updatedAt !== "string") return null;
    return parsed as PersistedState;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    return null;
  }
}

export async function saveState(threadId: string, model: string, path = statePath()): Promise<void> {
  await mkdir(dirname(path), {recursive: true, mode: 0o700});
  const temporary = `${path}.${process.pid}.tmp`;
  const data: PersistedState = {
    version: STATE_VERSION,
    threadId,
    model,
    updatedAt: new Date().toISOString(),
  };
  await writeFile(temporary, `${JSON.stringify(data, null, 2)}\n`, {mode: 0o600});
  await chmod(temporary, 0o600);
  await rename(temporary, path);
  await chmod(path, 0o600);
}

function itemToMessage(item: ThreadItem, sources: Iterable<CitationSource> = []): ChatMessage | null {
  if (item.type === "userMessage") {
    const text = (item.content || [])
      .filter((part) => part.type === "text" && typeof part.text === "string")
      .map((part) => part.text)
      .join("\n");
    return text ? {id: item.id, role: "user", text} : null;
  }
  if (item.type === "agentMessage" && item.phase !== "commentary" && item.text) {
    return {id: item.id, role: "assistant", text: normalizeAssistantText(item.text, sources)};
  }
  return null;
}

export function messagesFromTurns(turns: ThreadTurn[]): ChatMessage[] {
  return turns.flatMap((turn) => {
    const sources = turn.items.flatMap((item) => item.type === "webSearch" ? citationSourcesFromResults(item.results) : []);
    return turn.items.map((item) => itemToMessage(item, sources)).filter((item): item is ChatMessage => item !== null);
  });
}

export function friendlyError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (/unauthorized|not logged in|authentication/i.test(message)) {
    return "ChatGPT sign-in is required. Run `codex login` in a regular terminal, then reopen this popup.";
  }
  if (/usageLimitExceeded|rate.?limit|quota|usage limit/i.test(message)) {
    return "Your Codex usage limit has been reached. Try again after the allowance resets.";
  }
  if (/ENOENT.*codex|spawn codex ENOENT/i.test(message)) {
    return "Codex is not installed or is not on PATH. Update Omarchy, then reopen this popup.";
  }
  if (/model.*unavailable/i.test(message)) {
    return "That model is not available to this account. Choose another model or update Codex.";
  }
  return message.replace(/\s+/g, " ").trim() || "Something went wrong.";
}
