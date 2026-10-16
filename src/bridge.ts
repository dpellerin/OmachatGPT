#!/usr/bin/env node
import {createInterface} from "node:readline";
import {performance} from "node:perf_hooks";
import {ChatClient} from "./client.js";
import {friendlyError} from "./state.js";

type BridgeCommand =
  | {type: "send"; text?: string}
  | {type: "newChat"}
  | {type: "selectModel"; model?: string}
  | {type: "reloadConfig"}
  | {type: "saveOpenRouterConfig"; key?: string; models?: Array<{model: string; displayName?: string}> | string}
  | {type: "saveShortcut"; shortcut?: string}
  | {type: "interrupt"}
  | {type: "close"};

function emit(event: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify(event)}\n`);
}

const client = new ChatClient();
let turnStartedAt = 0;
let firstTokenSeen = false;
let pendingDelta = "";
let pendingItemId = "";
let deltaTimer: NodeJS.Timeout | null = null;

function metric(name: string, startedAt: number): void {
  if (startedAt <= 0) return;
  emit({type: "metric", name, durationMs: Math.max(0, Math.round(performance.now() - startedAt))});
}

function flushDelta(): void {
  if (deltaTimer) clearTimeout(deltaTimer);
  deltaTimer = null;
  if (!pendingDelta) return;
  if (!firstTokenSeen) {
    firstTokenSeen = true;
    metric("first-token", turnStartedAt);
  }
  emit({type: "delta", delta: pendingDelta, itemId: pendingItemId});
  pendingDelta = "";
  pendingItemId = "";
}

client.on("delta", (delta: string, itemId: string) => {
  if (pendingItemId && pendingItemId !== itemId) flushDelta();
  pendingItemId = itemId;
  pendingDelta += delta;
  if (!deltaTimer) deltaTimer = setTimeout(flushDelta, 16);
});
client.on("message", (itemId: string, text: string) => {
  flushDelta();
  emit({type: "message", itemId, text});
});
client.on("done", () => {
  flushDelta();
  metric("response", turnStartedAt);
  emit({type: "done"});
});
client.on("searching", () => emit({type: "searching"}));
client.on("model", (model: string) => emit({type: "activeModel", model}));
client.on("error", (error: Error) => {
  flushDelta();
  emit({type: "error", message: friendlyError(error), busy: client.busy});
});
client.on("fatal", (error: Error) => {
  flushDelta();
  emit({type: "fatal", message: friendlyError(error)});
});

async function handle(command: BridgeCommand): Promise<void> {
  if (command.type === "send") {
    const text = String(command.text || "").trim();
    if (text) {
      turnStartedAt = performance.now();
      firstTokenSeen = false;
      await client.send(text);
    }
    return;
  }
  if (command.type === "newChat") {
    const ready = await client.newChat();
    emit({
      type: "ready",
      messages: ready.messages,
      notice: "New chat",
      model: ready.model,
      reasoningEffort: ready.reasoningEffort,
      models: ready.models,
      openRouterConfigured: ready.openRouterConfigured,
      openRouterKey: ready.openRouterKey,
      openRouterModels: ready.openRouterModels,
      defaultOpenRouterModels: ready.defaultOpenRouterModels,
      shortcutBind: ready.shortcutBind,
      shortcutLabel: ready.shortcutLabel,
    });
    return;
  }
  if (command.type === "selectModel") {
    const ready = await client.selectModel(String(command.model || ""));
    emit({type: "modelSelected", model: ready.model});
    return;
  }
  if (command.type === "reloadConfig") {
    const ready = await client.reloadOpenRouter();
    emit({
      type: "modelsUpdated",
      model: ready.model,
      models: ready.models,
      openRouterConfigured: ready.openRouterConfigured,
      openRouterKey: ready.openRouterKey,
      openRouterModels: ready.openRouterModels,
      defaultOpenRouterModels: ready.defaultOpenRouterModels,
      shortcutBind: ready.shortcutBind,
      shortcutLabel: ready.shortcutLabel,
    });
    return;
  }
  if (command.type === "saveOpenRouterConfig") {
    const ready = await client.saveOpenRouterSettings(String(command.key || ""), command.models);
    emit({
      type: "modelsUpdated",
      model: ready.model,
      models: ready.models,
      openRouterConfigured: ready.openRouterConfigured,
      openRouterKey: ready.openRouterKey,
      openRouterModels: ready.openRouterModels,
      defaultOpenRouterModels: ready.defaultOpenRouterModels,
      shortcutBind: ready.shortcutBind,
      shortcutLabel: ready.shortcutLabel,
    });
    return;
  }
  if (command.type === "saveShortcut") {
    const ready = await client.saveShortcut(String(command.shortcut || ""));
    emit({
      type: "shortcutUpdated",
      shortcutBind: ready.shortcutBind,
      shortcutLabel: ready.shortcutLabel,
    });
    return;
  }
  if (command.type === "interrupt") {
    await client.interrupt();
    return;
  }
  if (command.type === "close") await shutdown("command");
}

let closing = false;
async function shutdown(reason: string): Promise<void> {
  if (closing) return;
  closing = true;
  flushDelta();
  if (process.env.OMACHATGPT_DEBUG) process.stderr.write(`bridge shutdown: ${reason}\n`);
  await client.close();
  process.exit(0);
}

const input = createInterface({input: process.stdin, crlfDelay: Infinity});
input.on("close", () => void shutdown("stdin EOF"));
input.on("line", (line) => {
  let command: BridgeCommand;
  try {
    command = JSON.parse(line) as BridgeCommand;
  } catch {
    emit({type: "error", message: "The chat interface sent an invalid request."});
    return;
  }
  void handle(command).catch((error: unknown) => {
    emit({type: "error", message: friendlyError(error), busy: client.busy});
  });
});
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("uncaughtException", (error) => {
  emit({type: "fatal", message: friendlyError(error)});
  void shutdown("uncaughtException");
});
process.on("unhandledRejection", (error) => {
  emit({type: "fatal", message: friendlyError(error)});
  void shutdown("unhandledRejection");
});

try {
  const ready = await client.connect();
  emit({
    type: "ready",
    messages: ready.messages,
    notice: ready.resumed && ready.messages.length ? "Resumed previous chat" : "Ready",
    model: ready.model,
    reasoningEffort: ready.reasoningEffort,
    models: ready.models,
    openRouterConfigured: ready.openRouterConfigured,
    openRouterKey: ready.openRouterKey,
    openRouterModels: ready.openRouterModels,
    defaultOpenRouterModels: ready.defaultOpenRouterModels,
    shortcutBind: ready.shortcutBind,
    shortcutLabel: ready.shortcutLabel,
  });
} catch (error) {
  const settings = client.getOpenRouterSettings();
  emit({
    type: "fatal",
    message: friendlyError(error),
    openRouterConfigured: settings.openRouterConfigured,
    openRouterKey: settings.openRouterKey,
    openRouterModels: settings.openRouterModels,
    defaultOpenRouterModels: settings.defaultOpenRouterModels,
    shortcutBind: settings.shortcutBind,
    shortcutLabel: settings.shortcutLabel,
  });
}
