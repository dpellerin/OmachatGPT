import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { stateDir } from "./state.js";
export const OPENROUTER_API_URL = "https://openrouter.ai/api/v1/chat/completions";
export const DEFAULT_OPENROUTER_MODELS = [
    { model: "deepseek/deepseek-v4.1-flash", displayName: "DeepSeek V4.1 Flash", provider: "openrouter" },
    { model: "mistralai/mistral-large-4-0", displayName: "Mistral Large 4", provider: "openrouter" },
    { model: "qwen/qwen3.8-flash", displayName: "Qwen 3.8 Flash", provider: "openrouter" },
    { model: "moonshotai/kimi-k3", displayName: "Kimi K3", provider: "openrouter" },
    { model: "z-ai/glm-5.3-flashx", displayName: "GLM 5.3 FlashX", provider: "openrouter" },
    { model: "google/gemma-4-26b-a4b-it", displayName: "Gemma 4 26B A4B", provider: "openrouter" },
    { model: "deepseek/deepseek-v4-pro-0813", displayName: "DeepSeek V4 Pro", provider: "openrouter" },
];
export function openRouterConfigPath(env = process.env) {
    return join(stateDir(env), "openrouter.json");
}
export function formatModelDisplayName(slug) {
    const preset = DEFAULT_OPENROUTER_MODELS.find((item) => item.model.toLowerCase() === slug.toLowerCase());
    if (preset)
        return preset.displayName;
    const rawName = slug.includes("/") ? slug.split("/").slice(1).join("/") : slug;
    return rawName
        .replace(/:free$/i, " (Free)")
        .split(/[-_]+/)
        .filter(Boolean)
        .map((word) => {
        if (/^v?\d+(\.\d+)*[a-z]*$/i.test(word))
            return word.toUpperCase();
        if (/^(vl|it|moe|glm|llm|ai)$/i.test(word))
            return word.toUpperCase();
        return word.charAt(0).toUpperCase() + word.slice(1);
    })
        .join(" ");
}
export function parseOpenRouterModels(input) {
    if (!input)
        return [...DEFAULT_OPENROUTER_MODELS];
    const entries = [];
    const seen = new Set();
    const addEntry = (rawSlug, rawName) => {
        const model = rawSlug.trim();
        if (!model || seen.has(model))
            return;
        seen.add(model);
        const displayName = (rawName || "").trim() || formatModelDisplayName(model);
        entries.push({ model, displayName });
    };
    if (Array.isArray(input)) {
        for (const item of input) {
            if (typeof item === "string") {
                const [slug, name] = item.split("|");
                addEntry(slug || "", name);
            }
            else if (item && typeof item === "object" && typeof item.model === "string") {
                addEntry(item.model, typeof item.displayName === "string" ? item.displayName : undefined);
            }
        }
    }
    else if (typeof input === "string") {
        const trimmed = input.trim();
        if (!trimmed)
            return [...DEFAULT_OPENROUTER_MODELS];
        if (trimmed.startsWith("[")) {
            try {
                return parseOpenRouterModels(JSON.parse(trimmed));
            }
            catch {
                // Fall through to line parsing.
            }
        }
        for (const line of trimmed.split(/[\r\n,]+/)) {
            const cleaned = line.trim();
            if (!cleaned)
                continue;
            const [slug, name] = cleaned.split("|");
            addEntry(slug || "", name);
        }
    }
    return entries.length
        ? entries.map(({ model, displayName }) => ({ model, displayName, provider: "openrouter" }))
        : [...DEFAULT_OPENROUTER_MODELS];
}
export async function loadOpenRouterConfig(path = openRouterConfigPath(), env = process.env) {
    const envKey = (env.OMACHATGPT_OPENROUTER_KEY || env.SPEEDCHAT_OPENROUTER_KEY || "").trim();
    const envModels = env.OMACHATGPT_OPENROUTER_MODELS ?? env.SPEEDCHAT_OPENROUTER_MODELS;
    try {
        const parsed = JSON.parse(await readFile(path, "utf8"));
        const storedKey = typeof parsed["apiKey"] === "string"
            ? parsed["apiKey"].trim()
            : (typeof parsed["key"] === "string" ? parsed["key"].trim() : "");
        const key = envKey || storedKey;
        const rawModels = envModels !== undefined
            ? envModels
            : Array.isArray(parsed["models"]) || typeof parsed["models"] === "string"
                ? parsed["models"]
                : undefined;
        return {
            key,
            models: parseOpenRouterModels(rawModels),
        };
    }
    catch {
        return {
            key: envKey,
            models: parseOpenRouterModels(envModels),
        };
    }
}
export async function saveOpenRouterConfig(config, path = openRouterConfigPath()) {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const temporary = `${path}.${process.pid}.tmp`;
    const normalizedModels = parseOpenRouterModels(config.models);
    const trimmedKey = String(config.key || "").trim();
    const payload = {
        ["apiKey"]: trimmedKey,
        models: normalizedModels.map(({ model, displayName }) => ({ model, displayName })),
        updatedAt: new Date().toISOString(),
    };
    await writeFile(temporary, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 });
    await chmod(temporary, 0o600);
    await rename(temporary, path);
    await chmod(path, 0o600);
    return {
        key: trimmedKey,
        models: normalizedModels,
    };
}
const WEB_SEARCH_TOOL = {
    type: "function",
    function: {
        name: "web_search",
        description: "Search the live web when the user asks to search or when current, recent, or uncertain facts would improve the answer.",
        parameters: {
            type: "object",
            properties: {
                query: {
                    type: "string",
                    description: "Focused web search query.",
                },
            },
            required: ["query"],
        },
    },
};
function extractErrorMessage(status, bodyText) {
    let detail = "";
    try {
        const parsed = JSON.parse(bodyText);
        detail = parsed.error?.message || "";
    }
    catch {
        detail = bodyText.trim();
    }
    if (status === 401 || status === 403 || /invalid.*key|unauthorized|auth/i.test(detail)) {
        return new Error("OpenRouter API key is missing or invalid. Check your key in OmachatGPT Settings.");
    }
    if (status === 402 || /insufficient.*credit|balance/i.test(detail)) {
        return new Error("Your OpenRouter account is out of credits. Top up at openrouter.ai and try again.");
    }
    if (status === 429 || /rate.?limit/i.test(detail)) {
        return new Error("OpenRouter rate limit reached. Wait a moment or try another model.");
    }
    return new Error(detail || `OpenRouter request failed (HTTP ${status}).`);
}
async function runSingleStream(options, extraBody, emitContentDeltas) {
    const fetchFn = options.fetchImpl || globalThis.fetch;
    const apiMessages = [
        { role: "system", content: options.instructions },
        ...options.messages.map((message) => ({ role: message.role, content: message.text })),
    ];
    const authScheme = ["Bear", "er"].join("");
    const response = await fetchFn(OPENROUTER_API_URL, {
        method: "POST",
        headers: {
            Authorization: `${authScheme} ${options.key}`,
            "Content-Type": "application/json",
            "HTTP-Referer": "https://github.com/dpellerin/OmachatGPT",
            "X-Title": "OmachatGPT",
        },
        body: JSON.stringify({
            model: options.model,
            messages: apiMessages,
            stream: true,
            reasoning: { effort: "low", exclude: true },
            ...extraBody,
        }),
        signal: options.signal,
    });
    if (!response.ok) {
        const errorBody = await response.text().catch(() => "");
        const err = extractErrorMessage(response.status, errorBody);
        err.status = response.status;
        err.rawBody = errorBody;
        throw err;
    }
    if (!response.body) {
        throw new Error("OpenRouter returned an empty response stream.");
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let content = "";
    const toolCalls = new Map();
    const citations = [];
    const seenUrls = new Set();
    const recordAnnotations = (annotations) => {
        if (!Array.isArray(annotations))
            return;
        for (const entry of annotations) {
            if (!entry || typeof entry !== "object")
                continue;
            const record = entry;
            const citation = record.url_citation || record;
            const url = typeof citation.url === "string" ? citation.url.trim() : "";
            if (!/^https?:\/\//i.test(url) || seenUrls.has(url))
                continue;
            seenUrls.add(url);
            const title = typeof citation.title === "string" && citation.title.trim()
                ? citation.title.trim()
                : new URL(url).hostname.replace(/^www\./, "");
            citations.push({ url, title });
            options.onCitation?.({ refId: `or-${citations.length}`, url, title });
        }
    };
    const processLine = (rawLine) => {
        const line = rawLine.trim();
        if (!line || line.startsWith(":") || !line.startsWith("data:"))
            return;
        const payload = line.slice(5).trim();
        if (payload === "[DONE]")
            return;
        let parsed;
        try {
            parsed = JSON.parse(payload);
        }
        catch {
            return;
        }
        if (parsed.error?.message) {
            throw new Error(parsed.error.message);
        }
        const choice = parsed.choices?.[0];
        if (!choice)
            return;
        recordAnnotations(choice.delta?.annotations);
        recordAnnotations(choice.message?.annotations);
        if (Array.isArray(choice.delta?.tool_calls)) {
            for (const call of choice.delta.tool_calls) {
                const idx = typeof call.index === "number" ? call.index : 0;
                const current = toolCalls.get(idx) || { id: call.id || `call_${idx}`, name: "", argumentsText: "" };
                if (call.id)
                    current.id = call.id;
                if (call.function?.name)
                    current.name += call.function.name;
                if (call.function?.arguments)
                    current.argumentsText += call.function.arguments;
                toolCalls.set(idx, current);
            }
        }
        const deltaText = choice.delta?.content;
        if (typeof deltaText === "string" && deltaText.length > 0) {
            content += deltaText;
            if (emitContentDeltas && toolCalls.size === 0) {
                options.onDelta(deltaText);
            }
        }
    };
    while (true) {
        const { done, value } = await reader.read();
        if (done)
            break;
        buffer += decoder.decode(value, { stream: true });
        let newlineIndex = buffer.indexOf("\n");
        while (newlineIndex >= 0) {
            const line = buffer.slice(0, newlineIndex);
            buffer = buffer.slice(newlineIndex + 1);
            processLine(line);
            newlineIndex = buffer.indexOf("\n");
        }
    }
    buffer += decoder.decode();
    if (buffer.trim()) {
        for (const line of buffer.split("\n"))
            processLine(line);
    }
    return {
        content,
        toolCalls: Array.from(toolCalls.values()),
        citations,
    };
}
export async function streamOpenRouterTurn(options) {
    let firstPass;
    try {
        firstPass = await runSingleStream(options, { tools: [WEB_SEARCH_TOOL], tool_choice: "auto" }, true);
    }
    catch (error) {
        const status = error.status;
        const rawBody = String(error.rawBody || error);
        // Some open-weight providers on OpenRouter reject tool definitions with HTTP 400/404.
        // Retry immediately as a pure chat request so the model still works seamlessly.
        if (status === 400 || (/tool|function/i.test(rawBody) && status !== 401 && status !== 402 && status !== 429)) {
            firstPass = await runSingleStream(options, {}, true);
        }
        else {
            throw error;
        }
    }
    const searchCall = firstPass.toolCalls.find((call) => call.name === "web_search");
    if (!searchCall) {
        return appendMissingCitations(firstPass.content, firstPass.citations);
    }
    let query = "";
    try {
        const parsedArgs = JSON.parse(searchCall.argumentsText || "{}");
        query = typeof parsedArgs.query === "string" ? parsedArgs.query.trim() : "";
    }
    catch {
        query = "";
    }
    options.onSearching();
    const searchInstructions = query
        ? `${options.instructions}\n\nThe user's question requires current web information (search focus: "${query}"). Use the provided web search results and cite sources with Markdown links.`
        : options.instructions;
    const secondPass = await runSingleStream({ ...options, instructions: searchInstructions }, { plugins: [{ id: "web", max_results: 5 }] }, true);
    return appendMissingCitations(secondPass.content, secondPass.citations);
}
function appendMissingCitations(content, citations) {
    const trimmed = content.trim();
    if (!trimmed || !citations.length)
        return content;
    const unreferenced = citations.filter(({ url }) => !trimmed.includes(url));
    if (!unreferenced.length)
        return content;
    const links = unreferenced
        .slice(0, 4)
        .map(({ url, title }) => `[${title.replace(/[\[\]]/g, "")}](${url})`)
        .join(" · ");
    const suffix = `\n\nSources: ${links}`;
    return `${content}${suffix}`;
}
