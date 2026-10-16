import { EventEmitter } from "node:events";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { resolveExecutable, safeEnvironment } from "./runtime.js";
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
    "hooks",
    "code_mode",
    "sleep_tool",
    "skill_mcp_dependency_install",
    "remote_plugin",
    "workspace_dependencies",
    "in_app_local_automation",
    "realtime_conversation",
    "multi_agent_v2",
    "browser_annotation_api",
    "in_app_browser",
    "tool_suggest",
    "auth_elicitation",
];
export function codexArguments() {
    const args = ["app-server", "--stdio"];
    for (const feature of DISABLED_FEATURES)
        args.push("--disable", feature);
    args.push("--enable", "skip_host_skill_discovery", "-c", 'forced_login_method="chatgpt"', "-c", 'model_provider="openai"', "-c", "analytics.enabled=false");
    args.push("--enable", "standalone_web_search");
    args.push("-c", "mcp_servers={}", "-c", 'web_search="live"');
    return args;
}
export class JsonRpcProcess extends EventEmitter {
    child = null;
    nextId = 1;
    pending = new Map();
    stderr = "";
    async start(cwd) {
        if (this.child)
            return;
        const child = spawn(resolveExecutable("codex"), codexArguments(), {
            stdio: "pipe",
            cwd,
            env: safeEnvironment(),
        });
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
            clientInfo: { name: "omachatgpt", title: "OmachatGPT", version: "0.3.0" },
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
    async stop() {
        const child = this.child;
        this.child = null;
        this.failAll(new Error("Codex app-server stopped."));
        if (!child || !child.pid || child.exitCode !== null)
            return;
        await new Promise((resolve) => {
            const timer = setTimeout(() => child.kill("SIGKILL"), 1500);
            child.once("exit", () => {
                clearTimeout(timer);
                resolve();
            });
            child.kill("SIGTERM");
        });
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
        if (message.method && message.id !== undefined) {
            this.write({
                id: message.id,
                error: { code: -32601, message: "OmachatGPT does not permit client tools or local actions." },
            });
            this.emit("notification", "omachatgpt/blockedRequest", { method: message.method });
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
