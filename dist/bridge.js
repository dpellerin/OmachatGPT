#!/usr/bin/env node
import { createInterface } from "node:readline";
import { performance } from "node:perf_hooks";
import { ChatClient } from "./client.js";
import { friendlyError } from "./state.js";
function emit(event) {
    process.stdout.write(`${JSON.stringify(event)}\n`);
}
const client = new ChatClient();
let turnStartedAt = 0;
let firstTokenSeen = false;
let pendingDelta = "";
let pendingItemId = "";
let deltaTimer = null;
function metric(name, startedAt) {
    if (startedAt <= 0)
        return;
    emit({ type: "metric", name, durationMs: Math.max(0, Math.round(performance.now() - startedAt)) });
}
function flushDelta() {
    if (deltaTimer)
        clearTimeout(deltaTimer);
    deltaTimer = null;
    if (!pendingDelta)
        return;
    if (!firstTokenSeen) {
        firstTokenSeen = true;
        metric("first-token", turnStartedAt);
    }
    emit({ type: "delta", delta: pendingDelta, itemId: pendingItemId });
    pendingDelta = "";
    pendingItemId = "";
}
client.on("delta", (delta, itemId) => {
    if (pendingItemId && pendingItemId !== itemId)
        flushDelta();
    pendingItemId = itemId;
    pendingDelta += delta;
    if (!deltaTimer)
        deltaTimer = setTimeout(flushDelta, 16);
});
client.on("message", (itemId, text) => {
    flushDelta();
    emit({ type: "message", itemId, text });
});
client.on("done", () => {
    flushDelta();
    metric("response", turnStartedAt);
    emit({ type: "done" });
});
client.on("searching", () => emit({ type: "searching" }));
client.on("error", (error) => {
    flushDelta();
    emit({ type: "error", message: friendlyError(error) });
});
client.on("fatal", (error) => {
    flushDelta();
    emit({ type: "fatal", message: friendlyError(error) });
});
async function handle(command) {
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
        emit({ type: "ready", messages: ready.messages, notice: "New chat" });
        return;
    }
    if (command.type === "interrupt") {
        await client.interrupt();
        return;
    }
    if (command.type === "close")
        shutdown("command");
}
function shutdown(reason) {
    flushDelta();
    if (process.env.OMACHATGPT_DEBUG)
        process.stderr.write(`bridge shutdown: ${reason}\n`);
    client.close();
    process.exit(0);
}
const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
input.on("line", (line) => {
    let command;
    try {
        command = JSON.parse(line);
    }
    catch {
        emit({ type: "error", message: "The chat interface sent an invalid request." });
        return;
    }
    void handle(command).catch((error) => {
        emit({ type: "error", message: friendlyError(error) });
    });
});
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("uncaughtException", (error) => {
    emit({ type: "fatal", message: friendlyError(error) });
    shutdown("uncaughtException");
});
process.on("unhandledRejection", (error) => {
    emit({ type: "fatal", message: friendlyError(error) });
    shutdown("unhandledRejection");
});
try {
    const ready = await client.connect();
    emit({
        type: "ready",
        messages: ready.messages,
        notice: ready.resumed && ready.messages.length ? "Resumed previous chat" : "Ready",
    });
}
catch (error) {
    emit({ type: "fatal", message: friendlyError(error) });
}
