import assert from "node:assert/strict";
import test from "node:test";
import {mkdtemp, stat} from "node:fs/promises";
import {join} from "node:path";
import {tmpdir} from "node:os";
import {EventEmitter} from "node:events";
import {
  DEFAULT_OPENROUTER_MODELS,
  loadOpenRouterConfig,
  parseOpenRouterModels,
  saveOpenRouterConfig,
} from "../src/openrouter.js";
import {ChatClient} from "../src/client.js";

function sseResponse(events: Array<Record<string, unknown>>): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const event of events) {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
      }
      controller.enqueue(encoder.encode("data: [DONE]\n\n"));
      controller.close();
    },
  });
  return new Response(stream, {status: 200, headers: {"Content-Type": "text/event-stream"}});
}

class FakeCodexRPC extends EventEmitter {
  calls: Array<{method: string; params: Record<string, unknown>}> = [];
  failStart = false;
  async start(): Promise<void> {
    if (this.failStart) throw new Error("unauthorized");
  }
  stop(): void {}
  async request(method: string, params: Record<string, unknown>): Promise<unknown> {
    this.calls.push({method, params});
    if (method === "model/list") {
      return {
        data: [
          {
            id: "gpt-6-luna",
            model: "gpt-6-luna",
            displayName: "GPT-6 Luna",
            hidden: false,
            supportedReasoningEfforts: [{reasoningEffort: "low"}],
          },
        ],
      };
    }
    if (method === "thread/start") return {thread: {id: "codex-thread-1"}, model: "gpt-6-luna"};
    if (method === "turn/start") return {turn: {id: "codex-turn-1"}};
    return {};
  }
}

test("default OpenRouter lineup contains the latest fast conversational open-weight models", () => {
  assert.deepEqual(
    DEFAULT_OPENROUTER_MODELS.map((m) => m.model),
    [
      "deepseek/deepseek-v4.1-flash",
      "mistralai/mistral-large-4-0",
      "qwen/qwen3.8-flash",
      "moonshotai/kimi-k3",
      "z-ai/glm-5.3-flashx",
      "google/gemma-4-26b-a4b-it",
      "deepseek/deepseek-v4-pro-0813",
    ],
  );
  assert.ok(DEFAULT_OPENROUTER_MODELS.every((m) => m.provider === "openrouter"));
});

test("parseOpenRouterModels supports custom slug | name lines and deduplicates", () => {
  const parsed = parseOpenRouterModels(
    "deepseek/deepseek-v4.1-flash | DeepSeek Flash\nqwen/qwen3.8-flash\ndeepseek/deepseek-v4.1-flash | Duplicate",
  );
  assert.deepEqual(parsed, [
    {model: "deepseek/deepseek-v4.1-flash", displayName: "DeepSeek Flash", provider: "openrouter"},
    {model: "qwen/qwen3.8-flash", displayName: "Qwen 3.8 Flash", provider: "openrouter"},
  ]);
});

test("openrouter config round-trips with 0600 file permissions", async () => {
  const root = await mkdtemp(join(tmpdir(), "omachatgpt-or-cfg-"));
  const cfgPath = join(root, "openrouter.json");
  await saveOpenRouterConfig(
    {
      key: "test-key-value",
      models: [{model: "moonshotai/kimi-k3", displayName: "Kimi K3"}],
    },
    cfgPath,
  );
  assert.equal((await stat(cfgPath)).mode & 0o777, 0o600);
  const loaded = await loadOpenRouterConfig(cfgPath, {});
  assert.equal(loaded.key, "test-key-value");
  assert.equal(loaded.models.length, 1);
  assert.equal(loaded.models[0]?.model, "moonshotai/kimi-k3");
});

test("unified model catalog merges OpenAI and OpenRouter models and streams OpenRouter turns with web search", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "omachatgpt-or-client-"));
  process.env.OMACHATGPT_STATE_DIR = stateDir;
  const cfgPath = join(stateDir, "openrouter.json");
  await saveOpenRouterConfig({key: "test-key-value"}, cfgPath);

  const fetchCalls: Array<Record<string, unknown>> = [];
  const fakeFetch: typeof fetch = async (_input, init) => {
    const body = JSON.parse(String(init?.body || "{}")) as Record<string, unknown>;
    fetchCalls.push(body);
    if (fetchCalls.length === 1) {
      return sseResponse([
        {
          choices: [
            {
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: "call_1",
                    function: {name: "web_search", arguments: '{"query":"Fresno weather"}'},
                  },
                ],
              },
            },
          ],
        },
      ]);
    }
    return sseResponse([
      {choices: [{delta: {content: "It is sunny in Fresno."}}]},
      {
        choices: [
          {
            delta: {
              annotations: [
                {
                  type: "url_citation",
                  url_citation: {url: "https://weather.example.com/fresno", title: "Fresno Forecast"},
                },
              ],
            },
          },
        ],
      },
    ]);
  };

  const rpc = new FakeCodexRPC();
  const client = new ChatClient(rpc, {openRouterConfigPath: cfgPath, openRouterFetch: fakeFetch});
  const ready = await client.connect();

  assert.ok(ready.models.some((m) => m.model === "gpt-6-luna" && m.provider === "openai"));
  assert.ok(ready.models.some((m) => m.model === "deepseek/deepseek-v4.1-flash" && m.provider === "openrouter"));

  await client.selectModel("deepseek/deepseek-v4.1-flash");

  let searched = false;
  const messages: string[] = [];
  const donePromise = new Promise<void>((resolve) => client.once("done", resolve));
  client.on("searching", () => {
    searched = true;
  });
  client.on("message", (_id, text) => {
    messages.push(text);
  });

  await client.send("What is the weather in Fresno?");
  await donePromise;

  assert.equal(searched, true);
  assert.equal(fetchCalls.length, 2);
  assert.deepEqual(fetchCalls[1]?.plugins, [{id: "web", max_results: 5}]);
  assert.match(messages.at(-1) || "", /It is sunny in Fresno/);
  assert.match(messages.at(-1) || "", /\[Fresno Forecast\]\(https:\/\/weather\.example\.com\/fresno\)/);

  // Switch back to OpenAI model mid-conversation and verify OpenRouter context is forwarded
  await client.selectModel("gpt-6-luna");
  await client.send("Summarize that forecast");
  const turnStart = rpc.calls.find((c) => c.method === "turn/start");
  const sentInput = ((turnStart?.params.input as Array<{text: string}> | undefined)?.[0]?.text) || "";
  assert.match(sentInput, /Earlier turns in this conversation/);
  assert.match(sentInput, /It is sunny in Fresno/);

  await client.close();
  delete process.env.OMACHATGPT_STATE_DIR;
});

test("OpenRouter works standalone when Codex is unavailable", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "omachatgpt-or-standalone-"));
  process.env.OMACHATGPT_STATE_DIR = stateDir;
  const cfgPath = join(stateDir, "openrouter.json");
  await saveOpenRouterConfig({key: "test-key-value"}, cfgPath);

  const rpc = new FakeCodexRPC();
  rpc.failStart = true;
  const fakeFetch: typeof fetch = async () => sseResponse([{choices: [{delta: {content: "Hello from Kimi!"}}]}]);

  const client = new ChatClient(rpc, {openRouterConfigPath: cfgPath, openRouterFetch: fakeFetch});
  const ready = await client.connect();
  assert.equal(ready.model, "deepseek/deepseek-v4.1-flash");
  assert.ok(ready.threadId.startsWith("openrouter-"));

  await client.close();
  delete process.env.OMACHATGPT_STATE_DIR;
});

test("saveOpenRouterSettings updates model catalog dynamically", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "omachatgpt-or-save-"));
  process.env.OMACHATGPT_STATE_DIR = stateDir;
  const cfgPath = join(stateDir, "openrouter.json");

  const rpc = new FakeCodexRPC();
  const client = new ChatClient(rpc, {openRouterConfigPath: cfgPath});
  const initial = await client.connect();
  assert.equal(initial.openRouterConfigured, false);
  assert.ok(initial.models.every((m) => m.provider === "openai"));

  const updated = await client.saveOpenRouterSettings("new-key-val", [
    {model: "moonshotai/kimi-k3", displayName: "Kimi K3"},
  ]);
  assert.equal(updated.openRouterConfigured, true);
  assert.equal(updated.openRouterKey, "new-key-val");
  assert.ok(updated.models.some((m) => m.model === "moonshotai/kimi-k3" && m.provider === "openrouter"));

  await client.close();
  delete process.env.OMACHATGPT_STATE_DIR;
});
