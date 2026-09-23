import {mkdir} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {CHAT_INSTRUCTIONS, CHAT_PERSONALITY, availableModels, defaultModel} from "../dist/client.js";
import {JsonRpcProcess} from "../dist/protocol.js";

const rpc = new JsonRpcProcess();
const runtimeDir = join(tmpdir(), `omachatgpt-smoke-${process.pid}`);
await mkdir(runtimeDir, {recursive: true, mode: 0o700});

let output = "";
let webSearchSeen = false;
const webSearchItems = [];
let unexpectedToolEvent = null;
let finish;
const finished = new Promise((resolve, reject) => {
  const timeout = setTimeout(() => reject(new Error("Smoke response timed out.")), 60_000);
  finish = (error) => {
    clearTimeout(timeout);
    if (error) reject(error);
    else resolve();
  };
});

rpc.on("notification", (method, params) => {
  if (method === "item/agentMessage/delta") output += String(params.delta || "");
  if (method === "item/started") {
    const type = params.item?.type;
    if (type === "webSearch") webSearchSeen = true;
    else if (type && !["userMessage", "agentMessage", "reasoning"].includes(type)) unexpectedToolEvent = type;
  }
  if (method === "item/completed" && params.item?.type === "webSearch") {
    webSearchItems.push(params.item);
  }
  if (method === "turn/completed") {
    const error = params.turn?.error?.message;
    finish(error ? new Error(error) : null);
  }
  if (method === "error") finish(new Error(params.error?.message || "Codex error"));
});

try {
  await rpc.start();
  const models = await rpc.request("model/list", {limit: 100, includeHidden: false});
  const model = defaultModel(availableModels(models.data));
  if (!model) throw new Error("No available model supports low reasoning effort.");

  const started = await rpc.request("thread/start", {
    model,
    personality: CHAT_PERSONALITY,
    cwd: runtimeDir,
    approvalPolicy: "never",
    sandbox: "read-only",
    baseInstructions: CHAT_INSTRUCTIONS,
    developerInstructions: CHAT_INSTRUCTIONS,
    dynamicTools: [],
    environments: [],
    runtimeWorkspaceRoots: [],
    selectedCapabilityRoots: [],
    ephemeral: true,
    serviceTier: "default",
  });
  await rpc.request("turn/start", {
    threadId: started.thread.id,
    input: [{type: "text", text: "Search the web for the current OpenAI developer documentation homepage title, then reply with the title and a Markdown source link."}],
    model,
    personality: CHAT_PERSONALITY,
    effort: "low",
    serviceTierForTurn: "default",
    approvalPolicy: "never",
    cwd: runtimeDir,
    environments: [],
    runtimeWorkspaceRoots: [],
  });
  await finished;
  if (unexpectedToolEvent) throw new Error(`Unexpected tool event: ${unexpectedToolEvent}`);
  if (!webSearchSeen) throw new Error("The model did not use web search.");
  if (!/https?:\/\//i.test(output)) throw new Error(`Response did not include a source link: ${output}`);
  if (process.env.OMACHATGPT_DEBUG) {
    process.stdout.write(`Web search items: ${JSON.stringify(webSearchItems, null, 2)}\n`);
  }
  process.stdout.write(`Live response: ${output.trim()}\n`);
} finally {
  rpc.stop();
}
