import {randomUUID} from "node:crypto";
import {rm} from "node:fs/promises";
import {createRuntimeDirectory} from "./runtime.js";
import {EventEmitter} from "node:events";
import {JsonRpcProcess} from "./protocol.js";
import {DEFAULT_MODEL, loadState, messagesFromTurns, saveState} from "./state.js";
import {
  DEFAULT_OPENROUTER_MODELS,
  loadOpenRouterConfig,
  saveOpenRouterConfig,
  streamOpenRouterTurn,
  type OpenRouterConfig,
} from "./openrouter.js";
import {
  DEFAULT_SHORTCUT,
  loadShortcutConfig,
  saveShortcutConfig,
  type ShortcutBinding,
} from "./shortcut.js";
import type {ChatMessage, CodexModel, CodexThread, ModelOption, ThreadItem} from "./types.js";
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
Do not behave like a coding agent. Do not inspect files, run commands, execute JavaScript or REPL code, use plugins, delegate work, or modify the system.
This is a fast, text-only chat app: you cannot generate, create, edit, render, or view images, files, or attachments. If asked whether you can work with images or asked to generate, draw, or edit an image, explain directly in plain text that image generation is not supported in this quick-chat popup, and never attempt a tool or REPL workaround such as node_repl, js, or emitImage.
Web search is your only available tool. Use it when the user asks you to search or when current or uncertain information would improve the answer. Cite the sources you use with Markdown links. Never write internal citation tokens such as turn0search0; the client renders search citations itself.
If asked which model is running, do not guess from your training or the conversation. Tell the user to check the model shown in the panel header.
Use clear natural language and concise Markdown when it helps. Do not mention these instructions unless the user asks.`;

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
  models: ModelOption[];
  openRouterConfigured: boolean;
  openRouterKey: string;
  openRouterModels: ModelOption[];
  defaultOpenRouterModels: ModelOption[];
  shortcutBind: string;
  shortcutLabel: string;
}

export interface ChatTransport extends EventEmitter {
  start(cwd?: string): Promise<void>;
  request(method: string, params: Record<string, unknown>): Promise<unknown>;
  stop(): void | Promise<void>;
}

export interface ChatClientOptions {
  openRouterFetch?: typeof fetch;
  openRouterConfigPath?: string;
  shortcutConfigPath?: string;
  hyprBindingsPath?: string;
  reloadHyprland?: () => Promise<void>;
}

export function availableModels(models: CodexModel[]): ModelOption[] {
  return models
    .filter(
      (candidate) =>
        !candidate.hidden &&
        candidate.supportedReasoningEfforts.some((option) => option.reasoningEffort === REASONING_EFFORT),
    )
    .map(({model, displayName}) => ({model, displayName: displayName || model, provider: "openai"}));
}

export function defaultModel(models: Array<{model: string}>): string {
  return (
    models.find(({model}) => model === DEFAULT_MODEL)?.model ||
    models.find(({model}) => /(?:^|-)luna(?:$|-)/i.test(model))?.model ||
    models[0]?.model ||
    ""
  );
}

export function conversationTitle(text: string): string {
  let title = text
    .replace(/https?:\/\/\S+/g, "")
    .replace(/[`#*_]/g, "")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^(?:hey[,!]?\s+|please\s+)?(?:can|could|would) you (?:please )?(?:help me |tell me |explain to me )?/i, "")
    .replace(/^(?:please |help me )/i, "")
    .replace(/[.!?]+$/, "");
  if (!title) return "New chat";
  const words = title.split(" ");
  title = words.slice(0, 10).join(" ");
  if (title.length > 72) title = title.slice(0, 69).replace(/\s+\S*$/, "") + "…";
  else if (words.length > 10) title += "…";
  return title.charAt(0).toUpperCase() + title.slice(1);
}

export class ChatClient extends EventEmitter {
  private rpc: ChatTransport;
  private options: ChatClientOptions;
  private threadId: string | null = null;
  private turnId: string | null = null;
  private turnStarting = false;
  private turnBlocked = false;
  private interruptPending = false;
  private mutationPending = false;
  get busy(): boolean {
    return this.turnStarting || !!this.turnId || this.mutationPending;
  }
  private citationSources = new Map<string, CitationSource>();
  private citationStream = new StreamingCitationResolver();
  private linkStream = new StreamingLinkResolver();
  private runtimeDir = "";
  private openAiModels: ModelOption[] = [];
  private openRouterConfig: OpenRouterConfig = {key: "", models: [...DEFAULT_OPENROUTER_MODELS]};
  private shortcutConfig: ShortcutBinding = {...DEFAULT_SHORTCUT};
  private codexAvailable = false;
  private models: ModelOption[] = [];
  private model = "";
  private messages: ChatMessage[] = [];
  private codexSyncedCount = 0;
  private openRouterAbort: AbortController | null = null;
  private titleNeeded = true;

  private isOpenRouterModel(model: string): boolean {
    const found = this.models.find((item) => item.model === model);
    if (found?.provider) return found.provider === "openrouter";
    return this.openRouterConfig.models.some((item) => item.model === model) || model.includes("/");
  }

  private rebuildModelCatalog(): void {
    const openRouterModels = this.openRouterConfig.key
      ? this.openRouterConfig.models.map((m) => ({...m, provider: "openrouter" as const}))
      : [];
    this.models = [...this.openAiModels, ...openRouterModels];
  }

  private async nameFromContent(text: string): Promise<void> {
    const threadId = this.threadId;
    if (!threadId || !this.titleNeeded || !this.codexAvailable || threadId.startsWith("openrouter-")) return;
    try {
      await this.rpc.request("thread/name/set", {threadId, name: conversationTitle(text)});
      if (this.threadId === threadId) this.titleNeeded = false;
    } catch {
      /* Naming is optional; retry on the next message without failing chat. */
    }
  }

  constructor(rpc: ChatTransport = new JsonRpcProcess(), options: ChatClientOptions = {}) {
    super();
    this.rpc = rpc;
    this.options = options;
    this.rpc.on("notification", (method: string, params: Record<string, unknown>) =>
      this.onNotification(method, params),
    );
    this.rpc.on("exit", () => {
      if (this.openRouterConfig.key) {
        this.codexAvailable = false;
        this.openAiModels = [];
        this.rebuildModelCatalog();
        return;
      }
      this.emit("fatal", new Error("The Codex app-server stopped unexpectedly."));
    });
  }

  async connect(): Promise<ReadyState> {
    this.runtimeDir = await createRuntimeDirectory();
    this.openRouterConfig = await loadOpenRouterConfig(this.options.openRouterConfigPath);
    this.shortcutConfig = await loadShortcutConfig(this.options.shortcutConfigPath, this.options.hyprBindingsPath);

    let codexError: unknown = null;
    try {
      await this.rpc.start(this.runtimeDir);
      await this.loadModels();
      this.codexAvailable = true;
    } catch (error) {
      codexError = error;
      this.codexAvailable = false;
      this.openAiModels = [];
    }

    this.rebuildModelCatalog();
    if (!this.models.length) {
      if (codexError) throw codexError;
      throw new Error("No available models support low reasoning effort.");
    }

    const state = await loadState();
    this.model =
      state && this.models.some(({model}) => model === state.model) ? state.model : defaultModel(this.models);

    if (state) {
      if (this.codexAvailable && !state.threadId.startsWith("openrouter-")) {
        try {
          const initialCodexModel = this.isOpenRouterModel(this.model)
            ? defaultModel(this.openAiModels) || this.model
            : this.model;
          const resumed = (await this.rpc.request("thread/resume", {
            threadId: state.threadId,
            model: initialCodexModel,
            personality: CHAT_PERSONALITY,
            cwd: this.runtimeDir,
            approvalPolicy: "never",
            sandbox: "read-only",
            baseInstructions: CHAT_INSTRUCTIONS,
            developerInstructions: CHAT_INSTRUCTIONS,
            config: {web_search: "live"},
            environments: [],
            runtimeWorkspaceRoots: [],
          })) as ThreadResponse;
          this.threadId = resumed.thread.id;
          if (!this.isOpenRouterModel(this.model)) {
            this.model = resumed.model;
          }
          const codexMessages = messagesFromTurns(resumed.thread.turns || []);
          this.messages =
            state.messages && state.messages.length >= codexMessages.length ? state.messages : codexMessages;
          this.codexSyncedCount = state.codexSyncedCount ?? codexMessages.length;
          const existingName = (resumed.thread as CodexThread & {name?: string | null}).name;
          this.titleNeeded =
            !existingName ||
            existingName === "OmachatGPT" ||
            existingName === "SpeedChat" ||
            existingName === "New chat";
          const firstPrompt = this.messages.find((message) => message.role === "user")?.text;
          if (firstPrompt) await this.nameFromContent(firstPrompt);
          if (state.model !== this.model) {
            await saveState(this.threadId, this.model, undefined, this.messages, this.codexSyncedCount);
          }
          return this.readyState(true);
        } catch {
          // A deleted or incompatible thread is safely replaced below.
        }
      } else if (state.messages && state.messages.length > 0) {
        this.threadId = state.threadId;
        this.messages = state.messages;
        this.codexSyncedCount = state.codexSyncedCount ?? 0;
        this.titleNeeded = false;
        return this.readyState(true);
      }
    }
    return this.newChat();
  }

  async reloadOpenRouter(): Promise<ReadyState> {
    this.openRouterConfig = await loadOpenRouterConfig(this.options.openRouterConfigPath);
    this.shortcutConfig = await loadShortcutConfig(this.options.shortcutConfigPath, this.options.hyprBindingsPath);
    this.rebuildModelCatalog();
    if (!this.models.some((item) => item.model === this.model)) {
      this.model = defaultModel(this.models);
      if (this.threadId) {
        await saveState(this.threadId, this.model, undefined, this.messages, this.codexSyncedCount);
      }
    }
    if (!this.threadId && this.models.length > 0) {
      this.threadId = `openrouter-${randomUUID()}`;
      this.messages = [];
      this.codexSyncedCount = 0;
      await saveState(this.threadId, this.model, undefined, this.messages, 0);
    }
    return this.readyState();
  }

  async saveOpenRouterSettings(
    key: string,
    models?: Array<{model: string; displayName?: string}> | string,
  ): Promise<ReadyState> {
    this.openRouterConfig = await saveOpenRouterConfig(
      {key, models: models ?? this.openRouterConfig.models},
      this.options.openRouterConfigPath,
    );
    return this.reloadOpenRouter();
  }

  async saveShortcut(shortcut: string): Promise<ReadyState> {
    this.shortcutConfig = await saveShortcutConfig(shortcut, {
      configPath: this.options.shortcutConfigPath,
      bindingsPath: this.options.hyprBindingsPath,
      reloadHyprland: this.options.reloadHyprland,
    });
    return this.readyState();
  }

  getOpenRouterSettings(): {
    openRouterConfigured: boolean;
    openRouterKey: string;
    openRouterModels: ModelOption[];
    defaultOpenRouterModels: ModelOption[];
    shortcutBind: string;
    shortcutLabel: string;
  } {
    return {
      openRouterConfigured: Boolean(this.openRouterConfig.key),
      openRouterKey: this.openRouterConfig.key,
      openRouterModels: this.openRouterConfig.models,
      defaultOpenRouterModels: DEFAULT_OPENROUTER_MODELS,
      shortcutBind: this.shortcutConfig.bind,
      shortcutLabel: this.shortcutConfig.label,
    };
  }

  async newChat(): Promise<ReadyState> {
    if (this.busy) throw new Error("Wait for the current response or change to finish.");
    this.mutationPending = true;
    try {
      if (this.codexAvailable) {
        const codexModel = this.isOpenRouterModel(this.model)
          ? defaultModel(this.openAiModels) || this.model
          : this.model;
        const response = (await this.rpc.request("thread/start", {
          model: codexModel,
          personality: CHAT_PERSONALITY,
          cwd: this.runtimeDir,
          approvalPolicy: "never",
          approvalsReviewer: "user",
          sandbox: "read-only",
          config: {web_search: "live"},
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
        if (!this.isOpenRouterModel(this.model)) {
          this.model = response.model;
        }
        this.turnId = null;
        this.messages = [];
        this.codexSyncedCount = 0;
        await saveState(response.thread.id, this.model, undefined, this.messages, 0);
        this.titleNeeded = true;
        await this.rpc.request("thread/name/set", {threadId: response.thread.id, name: "New chat"}).catch(() => undefined);
      } else {
        this.threadId = `openrouter-${randomUUID()}`;
        this.turnId = null;
        this.messages = [];
        this.codexSyncedCount = 0;
        this.titleNeeded = false;
        await saveState(this.threadId, this.model, undefined, this.messages, 0);
      }
      return this.readyState(false);
    } finally {
      this.mutationPending = false;
    }
  }

  async selectModel(model: string): Promise<ReadyState> {
    if (this.busy) throw new Error("Wait for the current response or change to finish.");
    if (!this.models.some((candidate) => candidate.model === model)) throw new Error("Selected model is unavailable.");
    if (!this.threadId) throw new Error("Chat is not ready.");
    this.mutationPending = true;
    try {
      if (!this.isOpenRouterModel(model) && this.codexAvailable && !this.threadId.startsWith("openrouter-")) {
        await this.rpc.request("thread/settings/update", {threadId: this.threadId, model});
      }
      this.model = model;
      await saveState(this.threadId, this.model, undefined, this.messages, this.codexSyncedCount);
      return this.readyState();
    } finally {
      this.mutationPending = false;
    }
  }

  private readyState(resumed = true): ReadyState {
    return {
      threadId: this.threadId || "",
      messages: this.messages,
      resumed,
      model: this.model,
      reasoningEffort: REASONING_EFFORT,
      models: this.models,
      openRouterConfigured: Boolean(this.openRouterConfig.key),
      openRouterKey: this.openRouterConfig.key,
      openRouterModels: this.openRouterConfig.models,
      defaultOpenRouterModels: DEFAULT_OPENROUTER_MODELS,
      shortcutBind: this.shortcutConfig.bind,
      shortcutLabel: this.shortcutConfig.label,
    };
  }

  async send(text: string): Promise<void> {
    if (this.busy) throw new Error("Wait for the current response or change to finish.");
    if (!this.threadId) throw new Error("Chat is not ready.");
    this.emit("model", this.model);
    this.turnStarting = true;
    this.turnBlocked = false;
    this.interruptPending = false;
    this.citationSources.clear();
    this.citationStream.reset();
    this.linkStream.reset();

    if (this.isOpenRouterModel(this.model)) {
      if (!this.openRouterConfig.key) {
        this.turnStarting = false;
        throw new Error("OpenRouter API key is required. Add your key in OmachatGPT Settings.");
      }
      const userMessage: ChatMessage = {id: randomUUID(), role: "user", text};
      this.messages.push(userMessage);
      const turnId = `or-turn-${randomUUID()}`;
      const itemId = `or-msg-${randomUUID()}`;
      const controller = new AbortController();
      this.openRouterAbort = controller;
      this.turnId = turnId;
      this.turnStarting = false;
      if (this.interruptPending) {
        await this.interrupt();
        return;
      }
      void this.runOpenRouterTurn(itemId, controller);
      await this.nameFromContent(text);
      return;
    }

    try {
      const unsentMessages = this.messages.slice(this.codexSyncedCount);
      const inputText =
        unsentMessages.length > 0
          ? `[Earlier turns in this conversation from another model:\n${unsentMessages.map((m) => `${m.role === "user" ? "User" : "Assistant"}: ${m.text}`).join("\n\n")}]\n\n${text}`
          : text;
      const userMessage: ChatMessage = {id: randomUUID(), role: "user", text};
      this.messages.push(userMessage);

      const response = (await this.rpc.request("turn/start", {
        threadId: this.threadId,
        input: [{type: "text", text: inputText}],
        model: this.model,
        personality: CHAT_PERSONALITY,
        effort: REASONING_EFFORT,
        serviceTierForTurn: "default",
        approvalPolicy: "never",
        cwd: this.runtimeDir,
        environments: [],
        runtimeWorkspaceRoots: [],
      })) as TurnResponse;
      if (this.turnStarting) {
        this.turnId = response.turn.id;
        if (this.interruptPending) await this.interrupt();
      }
      await this.nameFromContent(text);
    } catch (error) {
      this.turnStarting = false;
      this.messages.pop();
      throw error;
    }
  }

  private async runOpenRouterTurn(itemId: string, controller: AbortController): Promise<void> {
    let streamedText = "";
    try {
      const fullText = await streamOpenRouterTurn({
        key: this.openRouterConfig.key,
        model: this.model,
        instructions: CHAT_INSTRUCTIONS,
        messages: [...this.messages],
        signal: controller.signal,
        fetchImpl: this.options.openRouterFetch,
        onSearching: () => {
          if (this.openRouterAbort === controller) this.emit("searching");
        },
        onCitation: (source) => {
          this.citationSources.set(source.refId, source);
        },
        onDelta: (rawDelta) => {
          if (this.openRouterAbort !== controller) return;
          streamedText += rawDelta;
          const citationDelta = this.citationStream.push(rawDelta, this.citationSources.values());
          const delta = this.linkStream.push(citationDelta);
          if (delta) this.emit("delta", delta, itemId);
        },
      });
      if (this.openRouterAbort !== controller) return;
      this.citationStream.reset();
      this.linkStream.reset();
      const normalized = normalizeAssistantText(fullText || streamedText, this.citationSources.values());
      if (normalized) {
        this.messages.push({id: itemId, role: "assistant", text: normalized});
        if (this.threadId) {
          await saveState(this.threadId, this.model, undefined, this.messages, this.codexSyncedCount);
        }
        this.emit("message", itemId, normalized);
      }
      this.openRouterAbort = null;
      this.turnId = null;
      this.turnStarting = false;
      this.emit("done");
    } catch (error) {
      if (controller.signal.aborted || (error instanceof Error && error.name === "AbortError")) {
        if (streamedText.trim()) {
          const normalized = normalizeAssistantText(streamedText, this.citationSources.values());
          this.messages.push({id: itemId, role: "assistant", text: normalized});
          if (this.threadId) {
            await saveState(this.threadId, this.model, undefined, this.messages, this.codexSyncedCount);
          }
        }
        if (this.openRouterAbort === controller) {
          this.openRouterAbort = null;
          this.turnId = null;
          this.turnStarting = false;
          this.emit("done");
        }
        return;
      }
      if (this.openRouterAbort === controller) {
        this.openRouterAbort = null;
        this.turnId = null;
        this.turnStarting = false;
        this.emit("error", error instanceof Error ? error : new Error(String(error)));
      }
    }
  }

  async interrupt(): Promise<void> {
    if (this.openRouterAbort) {
      const controller = this.openRouterAbort;
      this.interruptPending = false;
      controller.abort();
      return;
    }
    if (this.turnStarting && !this.turnId) {
      this.interruptPending = true;
      return;
    }
    if (!this.threadId || !this.turnId) return;
    this.interruptPending = false;
    await this.rpc.request("turn/interrupt", {threadId: this.threadId, turnId: this.turnId}).catch(() => undefined);
  }

  async close(): Promise<void> {
    if (this.openRouterAbort) {
      this.openRouterAbort.abort();
      this.openRouterAbort = null;
    }
    await this.rpc.stop();
    if (this.runtimeDir) await rm(this.runtimeDir, {recursive: true, force: true});
  }

  private async loadModels(): Promise<void> {
    const response = (await this.rpc.request("model/list", {limit: 100, includeHidden: false})) as {data: CodexModel[]};
    this.openAiModels = availableModels(response.data);
    if (!this.openAiModels.length && !this.openRouterConfig.key) {
      throw new Error("No available models support low reasoning effort.");
    }
  }

  private onNotification(method: string, params: Record<string, unknown>): void {
    if (method === "omachatgpt/blockedRequest" || method === "speedchat/blockedRequest") {
      void this.interrupt();
      this.emit("error", new Error("Blocked an unexpected client tool or local action request."));
      return;
    }
    if (params.threadId && params.threadId !== this.threadId) return;
    if (params.turnId && this.turnId && params.turnId !== this.turnId) return;
    if ((method.startsWith("item/") || method.startsWith("turn/")) && !this.turnStarting && !this.turnId) return;
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
        const normalized = normalizeAssistantText(item.text, this.citationSources.values());
        this.messages.push({id: item.id, role: "assistant", text: normalized});
        this.codexSyncedCount = this.messages.length;
        if (this.threadId) {
          void saveState(this.threadId, this.model, undefined, this.messages, this.codexSyncedCount);
        }
        this.emit("message", item.id, normalized);
        return;
      }
      if (
        item &&
        (TOOL_ITEM_TYPES.has(item.type) ||
          !["userMessage", "agentMessage", "reasoning", "contextCompaction"].includes(item.type))
      ) {
        if (!this.turnBlocked) {
          this.turnBlocked = true;
          void this.interrupt();
          const isImageAttempt =
            item.type === "imageGeneration" || item.type === "imageView" || /emitImage|image/i.test(JSON.stringify(item));
          if (isImageAttempt) {
            const explanation =
              "I can’t generate or display images here—this quick-chat panel is text-only for fast conversation.";
            this.messages.push({id: item.id, role: "assistant", text: explanation});
            this.codexSyncedCount = this.messages.length;
            this.emit("message", item.id, explanation);
          } else {
            this.emit("error", new Error(`Blocked an unexpected ${item.type} request.`));
          }
        }
      }
      return;
    }
    if (method === "turn/started") {
      const turn = params.turn as {id?: string} | undefined;
      if (turn?.id) this.turnId = turn.id;
      if (this.interruptPending) void this.interrupt();
      return;
    }
    if (method === "model/rerouted" && params.threadId === this.threadId) {
      const actualModel = String(params.toModel || "");
      if (actualModel) this.emit("model", actualModel);
      return;
    }
    if (method === "turn/completed") {
      this.turnStarting = false;
      this.turnBlocked = false;
      this.turnId = null;
      this.codexSyncedCount = this.messages.length;
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
