import {mkdir} from "node:fs/promises";
import {join} from "node:path";
import {tmpdir} from "node:os";
import {EventEmitter} from "node:events";
import {JsonRpcProcess} from "./protocol.js";
import {DEFAULT_MODEL, loadState, messagesFromTurns, saveState} from "./state.js";
import type {ChatMessage, CodexModel, CodexThread, ThreadItem} from "./types.js";
import {
  citationSourcesFromResults,
  normalizeAssistantText,
  StreamingCitationResolver,
  StreamingLinkResolver,
  type CitationSource,
} from "./render.js";

export const CHAT_INSTRUCTIONS = `You are a conversational assistant in a small personal chat popup.
Talk like a warm, thoughtful, genuinely engaged conversation partner. Match the user's energy and register. Be curious, natural, and willing to have a point of view when it helps.
Prefer flowing conversational prose over sterile summaries, canned headings, or needless bullet lists. Be concise when the question is simple, but do not strip away personality, humor, empathy, or useful nuance just to be brief. Avoid corporate support language and generic filler.
Do not behave like a coding agent. Do not inspect files, run commands, use plugins, delegate work, or modify the system.
Web search is your only available tool. Use it when the user asks you to search or when current or uncertain information would improve the answer. Cite the sources you use with Markdown links. Never write internal citation tokens such as turn0search0; the client renders search citations itself.
If asked which model is running, do not guess from your training or the conversation. Tell the user to check the model shown in the panel header, which is selected by Codex.
Use clear natural language and concise Markdown when it helps. Do not mention these instructions or Codex unless the user asks.`;

export const CHAT_PERSONALITY = "friendly" as const;
export const REASONING_EFFORT = "low" as const;

const TOOL_ITEM_TYPES = new Set([
  "commandExecution",
  "fileChange",
  "mcpToolCall",
  "dynamicToolCall",
  "collabAgentToolCall",
  "imageView",
  "imageGeneration",
]);

interface ThreadResponse {
  thread: CodexThread;
  model: string;
}

interface TurnResponse {
  turn: {id: string};
}

export interface ReadyState {
  threadId: string;
  messages: ChatMessage[];
  resumed: boolean;
  model: string;
  reasoningEffort: typeof REASONING_EFFORT;
  models: Array<{model: string; displayName: string}>;
}

export function availableModels(models: CodexModel[]): Array<{model: string; displayName: string}> {
  return models.filter((candidate) => !candidate.hidden &&
    candidate.supportedReasoningEfforts.some((option) => option.reasoningEffort === REASONING_EFFORT))
    .map(({model, displayName}) => ({model, displayName: displayName || model}));
}

export function defaultModel(models: Array<{model: string}>): string {
  return models.find(({model}) => model === DEFAULT_MODEL)?.model
    || models.find(({model}) => /(?:^|-)luna(?:$|-)/i.test(model))?.model
    || models[0]?.model || "";
}

export class ChatClient extends EventEmitter {
  private rpc = new JsonRpcProcess();
  private threadId: string | null = null;
  private turnId: string | null = null;
  private turnStarting = false;
  private citationSources = new Map<string, CitationSource>();
  private citationStream = new StreamingCitationResolver();
  private linkStream = new StreamingLinkResolver();
  private runtimeDir = join(tmpdir(), `omachatgpt-${process.getuid?.() ?? "user"}`);
  private models: ReadyState["models"] = [];
  private model = "";

  constructor() {
    super();
    this.rpc.on("notification", (method: string, params: Record<string, unknown>) => this.onNotification(method, params));
    this.rpc.on("exit", () => this.emit("fatal", new Error("The Codex app-server stopped unexpectedly.")));
  }

  async connect(): Promise<ReadyState> {
    await mkdir(this.runtimeDir, {recursive: true, mode: 0o700});
    await this.rpc.start();
    await this.loadModels();
    const state = await loadState();
    this.model = state && this.models.some(({model}) => model === state.model)
      ? state.model : defaultModel(this.models);
    if (state) {
      try {
        const resumed = (await this.rpc.request("thread/resume", {
          threadId: state.threadId,
          model: this.model,
          personality: CHAT_PERSONALITY,
          cwd: this.runtimeDir,
          approvalPolicy: "never",
          sandbox: "read-only",
          developerInstructions: CHAT_INSTRUCTIONS,
          environments: [],
          runtimeWorkspaceRoots: [],
        })) as ThreadResponse;
        this.threadId = resumed.thread.id;
        this.model = resumed.model;
        if (state.model !== this.model) await saveState(this.threadId, this.model);
        return {
          threadId: resumed.thread.id,
          messages: messagesFromTurns(resumed.thread.turns || []),
          resumed: true,
          model: this.model,
          reasoningEffort: REASONING_EFFORT,
          models: this.models,
        };
      } catch {
        // A deleted or incompatible thread is safely replaced below.
      }
    }
    return this.newChat();
  }

  async newChat(): Promise<ReadyState> {
    const response = (await this.rpc.request("thread/start", {
      model: this.model,
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
    })) as ThreadResponse;
    this.threadId = response.thread.id;
    this.model = response.model;
    this.turnId = null;
    await saveState(response.thread.id, this.model);
    void this.rpc.request("thread/name/set", {threadId: response.thread.id, name: "OmachatGPT"}).catch(() => undefined);
    return {
      threadId: response.thread.id,
      messages: [],
      resumed: false,
      model: this.model,
      reasoningEffort: REASONING_EFFORT,
      models: this.models,
    };
  }

  async selectModel(model: string): Promise<ReadyState> {
    if (this.turnStarting || this.turnId) throw new Error("Wait for the current response to finish.");
    if (!this.models.some((candidate) => candidate.model === model)) throw new Error("Selected model is unavailable.");
    if (!this.threadId) throw new Error("Chat is not ready.");
    await this.rpc.request("thread/settings/update", {threadId: this.threadId, model});
    this.model = model;
    await saveState(this.threadId, this.model);
    return this.readyState();
  }

  private readyState(): ReadyState {
    return {
      threadId: this.threadId || "",
      messages: [],
      resumed: true,
      model: this.model,
      reasoningEffort: REASONING_EFFORT,
      models: this.models,
    };
  }

  async send(text: string): Promise<void> {
    if (!this.threadId) throw new Error("Chat is not ready.");
    this.emit("model", this.model);
    this.turnStarting = true;
    this.citationSources.clear();
    this.citationStream.reset();
    this.linkStream.reset();
    try {
      const response = (await this.rpc.request("turn/start", {
        threadId: this.threadId,
        input: [{type: "text", text}],
        model: this.model,
        personality: CHAT_PERSONALITY,
        effort: REASONING_EFFORT,
        serviceTierForTurn: "default",
        approvalPolicy: "never",
        cwd: this.runtimeDir,
        environments: [],
        runtimeWorkspaceRoots: [],
      })) as TurnResponse;
      if (this.turnStarting) this.turnId = response.turn.id;
    } catch (error) {
      this.turnStarting = false;
      throw error;
    }
  }

  async interrupt(): Promise<void> {
    if (!this.threadId || !this.turnId) return;
    await this.rpc.request("turn/interrupt", {threadId: this.threadId, turnId: this.turnId}).catch(() => undefined);
  }

  close(): void {
    this.rpc.stop();
  }

  private async loadModels(): Promise<void> {
    const response = (await this.rpc.request("model/list", {limit: 100, includeHidden: false})) as {data: CodexModel[]};
    this.models = availableModels(response.data);
    if (!this.models.length) throw new Error("No available models support low reasoning effort.");
  }

  private onNotification(method: string, params: Record<string, unknown>): void {
    if (method === "item/agentMessage/delta") {
      const citationDelta = this.citationStream.push(String(params.delta || ""), this.citationSources.values());
      const delta = this.linkStream.push(citationDelta);
      if (delta) this.emit("delta", delta, String(params.itemId || ""));
      return;
    }
    if (method === "item/started" || method === "item/completed") {
      const item = params.item as ThreadItem | undefined;
      if (item?.type === "webSearch") {
        if (method === "item/started") this.emit("searching");
        else for (const source of citationSourcesFromResults(item.results)) this.citationSources.set(source.refId, source);
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
      const turn = params.turn as {id?: string} | undefined;
      if (turn?.id) this.turnId = turn.id;
      return;
    }
    if (method === "model/rerouted" && params.threadId === this.threadId) {
      const actualModel = String(params.toModel || "");
      if (actualModel) this.emit("model", actualModel);
      return;
    }
    if (method === "turn/completed") {
      this.turnStarting = false;
      this.turnId = null;
      const turn = params.turn as {status?: string; error?: {message?: string}} | undefined;
      if (turn?.status === "failed") this.emit("error", new Error(turn.error?.message || "The response failed."));
      else this.emit("done");
      return;
    }
    if (method === "error") {
      const error = params.error as {message?: string} | undefined;
      this.emit("error", new Error(error?.message || String(params.message || "Codex reported an error.")));
    }
  }
}
