import { EventEmitter } from "node:events";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
export const DISABLED_FEATURES = [
    "shell_tool",
    "unified_exec",
    "apps",
    "browser_use",
    "browser_use_external",
    "computer_use",
    "image_generation",
    "view_image",
    "plugins",
    "memories",
    "multi_agent",
    "goals",
    "skill_search",
];
export function codexArguments() {
    const args = ["app-server", "--stdio"];
    for (const feature of DISABLED_FEATURES)
        args.push("--disable", feature);
    args.push("-c", "mcp_servers={}", "-c", 'web_search="live"');
    return args;
}
export class JsonRpcProcess extends EventEmitter {
    child = null;
    nextId = 1;
    pending = new Map();
    stderr = "";
    async start() {
        if (this.child)
            return;
        const child = spawn("codex", codexArguments(), { stdio: "pipe" });
        this.child = child;
        child.stderr.on("data", (chunk) => {
            this.stderr = `${this.stderr}${chunk.toString("utf8")}`.slice(-4000);
        });
        child.once("error", (error) => this.failAll(error));
        child.once("exit", (code, signal) => {
            const detail = this.stderr.trim().split("\n").at(-1);
            this.failAll(new Error(detail || `Codex app-server exited (${signal || code || "unknown"}).`));
            this.emit("exit", code, signal);
            this.child = null;
        });
        const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
        lines.on("line", (line) => this.receiveLine(line));
        await this.request("initialize", {
            clientInfo: { name: "omachatgpt", title: "Quick Chat", version: "0.2.1" },
            capabilities: { experimentalApi: true },
        });
        this.notify("initialized", {});
    }
    request(method, params, timeoutMs = 30_000) {
        if (!this.child?.stdin.writable)
            return Promise.reject(new Error("Codex app-server is not running."));
        const id = this.nextId++;
        return new Promise((resolve, reject) => {
            const timeout = setTimeout(() => {
                this.pending.delete(id);
                reject(new Error(`${method} timed out.`));
            }, timeoutMs);
            this.pending.set(id, { resolve, reject, timeout });
            this.write({ id, method, params });
        });
    }
    notify(method, params) {
        this.write({ method, params });
    }
    stop() {
        this.child?.kill("SIGTERM");
        this.child = null;
    }
    write(message) {
        this.child?.stdin.write(`${JSON.stringify(message)}\n`);
    }
    receiveLine(line) {
        let message;
        try {
            message = JSON.parse(line);
        }
        catch {
            return;
        }
        if (typeof message.id === "number") {
            const pending = this.pending.get(message.id);
            if (!pending)
                return;
            clearTimeout(pending.timeout);
            this.pending.delete(message.id);
            if (message.error)
                pending.reject(new Error(`${message.error.message} (${message.error.code})`));
            else
                pending.resolve(message.result);
            return;
        }
        if (message.method)
            this.emit("notification", message.method, message.params || {});
    }
    failAll(error) {
        for (const pending of this.pending.values()) {
            clearTimeout(pending.timeout);
            pending.reject(error);
        }
        this.pending.clear();
    }
}
