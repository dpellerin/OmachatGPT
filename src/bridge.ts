#!/usr/bin/env node
import {createInterface} from "node:readline";
import {performance} from "node:perf_hooks";
import {ChatClient} from "./client.js";
import {friendlyError} from "./state.js";

type BridgeCommand =
  | {type: "send"; text?: string}
  | {type: "newChat"}
  | {type: "selectModel"; model?: string}
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
  emit({type: "error", message: friendlyError(error)});
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
    });
    return;
  }
  if (command.type === "selectModel") {
    const ready = await client.selectModel(String(command.model || ""));
    emit({type: "modelSelected", model: ready.model});
    return;
  }
  if (command.type === "interrupt") {
    await client.interrupt();
    return;
  }
  if (command.type === "close") shutdown("command");
}

function shutdown(reason: string): void {
  flushDelta();
  if (process.env.OMACHATGPT_DEBUG) process.stderr.write(`bridge shutdown: ${reason}\n`);
  client.close();
  process.exit(0);
}

const input = createInterface({input: process.stdin, crlfDelay: Infinity});
input.on("line", (line) => {
  let command: BridgeCommand;
  try {
    command = JSON.parse(line) as BridgeCommand;
  } catch {
    emit({type: "error", message: "The chat interface sent an invalid request."});
    return;
  }
  void handle(command).catch((error: unknown) => {
    emit({type: "error", message: friendlyError(error)});
  });
});
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("uncaughtException", (error) => {
  emit({type: "fatal", message: friendlyError(error)});
  shutdown("uncaughtException");
});
process.on("unhandledRejection", (error) => {
  emit({type: "fatal", message: friendlyError(error)});
  shutdown("unhandledRejection");
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
  });
} catch (error) {
  emit({type: "fatal", message: friendlyError(error)});
}
