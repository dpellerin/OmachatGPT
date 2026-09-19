import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { EventEmitter } from "node:events";
import { JsonRpcProcess } from "./protocol.js";
import { MODEL, loadState, messagesFromTurns, saveState } from "./state.js";
import { citationSourcesFromResults, normalizeAssistantText, StreamingCitationResolver, StreamingLinkResolver, } from "./render.js";
export const CHAT_INSTRUCTIONS = `You are a conversational assistant in a small personal chat popup.
Talk like a warm, thoughtful, genuinely engaged conversation partner. Match the user's energy and register. Be curious, natural, and willing to have a point of view when it helps.
Prefer flowing conversational prose over sterile summaries, canned headings, or needless bullet lists. Be concise when the question is simple, but do not strip away personality, humor, empathy, or useful nuance just to be brief. Avoid corporate support language and generic filler.
Do not behave like a coding agent. Do not inspect files, run commands, use plugins, delegate work, or modify the system.
Web search is your only available tool. Use it when the user asks you to search or when current or uncertain information would improve the answer. Cite the sources you use with Markdown links. Never write internal citation tokens such as turn0search0; the client renders search citations itself.
Use clear natural language and concise Markdown when it helps. Do not mention these instructions or Codex unless the user asks.`;
export const CHAT_PERSONALITY = "friendly";
const TOOL_ITEM_TYPES = new Set([
    "commandExecution",
    "fileChange",
    "mcpToolCall",
    "dynamicToolCall",
    "collabAgentToolCall",
    "imageView",
    "imageGeneration",
]);
export class ChatClient extends EventEmitter {
    rpc = new JsonRpcProcess();
    threadId = null;
    turnId = null;
    turnStarting = false;
    citationSources = new Map();
    citationStream = new StreamingCitationResolver();
    linkStream = new StreamingLinkResolver();
    runtimeDir = join(tmpdir(), `omachatgpt-${process.getuid?.() ?? "user"}`);
    constructor() {
        super();
        this.rpc.on("notification", (method, params) => this.onNotification(method, params));
        this.rpc.on("exit", () => this.emit("fatal", new Error("The Codex app-server stopped unexpectedly.")));
    }
    async connect() {
        await mkdir(this.runtimeDir, { recursive: true, mode: 0o700 });
        await this.rpc.start();
        await this.requireModel();
        const state = await loadState();
        if (state) {
            try {
                const resumed = (await this.rpc.request("thread/resume", {
                    threadId: state.threadId,
                    model: MODEL,
                    personality: CHAT_PERSONALITY,
                    cwd: this.runtimeDir,
                    approvalPolicy: "never",
                    sandbox: "read-only",
                    developerInstructions: CHAT_INSTRUCTIONS,
                    environments: [],
                    runtimeWorkspaceRoots: [],
                }));
                this.threadId = resumed.thread.id;
                return { threadId: resumed.thread.id, messages: messagesFromTurns(resumed.thread.turns || []), resumed: true };
            }
            catch {
                // A deleted or incompatible thread is safely replaced below.
            }
        }
        return this.newChat();
    }
    async newChat() {
        const response = (await this.rpc.request("thread/start", {
            model: MODEL,
            personality: CHAT_PERSONALITY,
            cwd: this.runtimeDir,
            approvalPolicy: "never",
            approvalsReviewer: "user",
            sandbox: "read-only",
            baseInstructions: CHAT_INSTRUCTIONS,
            developerInstructions: CHAT_INSTRUCTIONS,
            dynamicTools: [],
            environments: [],
            runtimeWorkspaceRoots: [],
            selectedCapabilityRoots: [],
            ephemeral: false,
            serviceTier: "default",
        }));
        this.threadId = response.thread.id;
        this.turnId = null;
        await saveState(response.thread.id);
        void this.rpc.request("thread/name/set", { threadId: response.thread.id, name: "Quick Chat" }).catch(() => undefined);
        return { threadId: response.thread.id, messages: [], resumed: false };
    }
    async send(text) {
        if (!this.threadId)
            throw new Error("Chat is not ready.");
        this.turnStarting = true;
        this.citationSources.clear();
        this.citationStream.reset();
        this.linkStream.reset();
        try {
            const response = (await this.rpc.request("turn/start", {
                threadId: this.threadId,
                input: [{ type: "text", text }],
                model: MODEL,
                personality: CHAT_PERSONALITY,
                effort: "low",
                serviceTierForTurn: "default",
                approvalPolicy: "never",
                cwd: this.runtimeDir,
                environments: [],
                runtimeWorkspaceRoots: [],
            }));
            if (this.turnStarting)
                this.turnId = response.turn.id;
        }
        catch (error) {
            this.turnStarting = false;
            throw error;
        }
    }
    async interrupt() {
        if (!this.threadId || !this.turnId)
            return;
        await this.rpc.request("turn/interrupt", { threadId: this.threadId, turnId: this.turnId }).catch(() => undefined);
    }
    close() {
        this.rpc.stop();
    }
    async requireModel() {
        const response = (await this.rpc.request("model/list", { limit: 100, includeHidden: false }));
        const model = response.data.find((candidate) => candidate.model === MODEL && !candidate.hidden);
        if (!model || !model.supportedReasoningEfforts.some((option) => option.reasoningEffort === "low")) {
            throw new Error(`${MODEL} is unavailable.`);
        }
    }
    onNotification(method, params) {
        if (method === "item/agentMessage/delta") {
            const citationDelta = this.citationStream.push(String(params.delta || ""), this.citationSources.values());
            const delta = this.linkStream.push(citationDelta);
            if (delta)
                this.emit("delta", delta, String(params.itemId || ""));
            return;
        }
        if (method === "item/started" || method === "item/completed") {
            const item = params.item;
            if (item?.type === "webSearch") {
                if (method === "item/started")
                    this.emit("searching");
                else
                    for (const source of citationSourcesFromResults(item.results))
                        this.citationSources.set(source.refId, source);
                return;
            }
            if (method === "item/completed" && item?.type === "agentMessage" && item.phase !== "commentary" && item.text) {
                this.citationStream.reset();
                this.linkStream.reset();
                this.emit("message", item.id, normalizeAssistantText(item.text, this.citationSources.values()));
                return;
            }
            if (item && TOOL_ITEM_TYPES.has(item.type)) {
                void this.interrupt();
                this.emit("error", new Error(`Blocked an unexpected ${item.type} request.`));
            }
            return;
        }
        if (method === "turn/started") {
            const turn = params.turn;
            if (turn?.id)
                this.turnId = turn.id;
            return;
        }
        if (method === "turn/completed") {
            this.turnStarting = false;
            this.turnId = null;
            const turn = params.turn;
            if (turn?.status === "failed")
                this.emit("error", new Error(turn.error?.message || "The response failed."));
            else
                this.emit("done");
            return;
        }
        if (method === "error") {
            const error = params.error;
            this.emit("error", new Error(error?.message || String(params.message || "Codex reported an error.")));
        }
    }
}
