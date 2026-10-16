import assert from "node:assert/strict";
import test from "node:test";
import {ChatClient} from "../src/client.js";
import {EventEmitter} from "node:events";
import {mkdtemp} from "node:fs/promises";
import {join} from "node:path";
import {tmpdir} from "node:os";

class FakeRPC extends EventEmitter {
  calls: Array<{method: string; params: Record<string, unknown>}> = [];
  release: ((v: unknown) => void) | undefined;
  holdSettings = false;
  settingsRelease: ((v: unknown) => void) | undefined;
  async start() {}
  stop() {}
  async request(method: string, params: Record<string, unknown>) {
    this.calls.push({method, params});
    if (method === "thread/settings/update" && this.holdSettings) {
      return new Promise((resolve) => {
        this.settingsRelease = resolve;
      });
    }
    if (method === "model/list") {
      return {data: [{model: "gpt-6-luna", displayName: "Luna", supportedReasoningEfforts: [{reasoningEffort: "low"}]}]};
    }
    if (method === "thread/start") return {thread: {id: "dedicated"}, model: "gpt-6-luna"};
    if (method === "turn/start" && this.release) return {turn: {id: "unexpected"}};
    if (method === "turn/start") {
      return new Promise((resolve) => {
        this.release = resolve;
      });
    }
    return {};
  }
}

async function setup() {
  process.env.OMACHATGPT_STATE_DIR = await mkdtemp(join(tmpdir(), "omachatgpt-client-test-"));
  const rpc = new FakeRPC();
  const client = new ChatClient(rpc);
  client.on("error", () => {});
  await client.connect();
  return {rpc, client};
}

test("first message assigns a content-based title without extra model turns", async () => {
  const {rpc, client} = await setup();
  const sending = client.send("Can you help me plan a weekend trip to Yosemite?");
  rpc.release!({turn: {id: "t"}});
  await sending;
  assert.equal(rpc.calls.filter((c) => c.method === "thread/name/set").at(-1)?.params.name, "Plan a weekend trip to Yosemite");
  assert.equal(rpc.calls.filter((c) => c.method === "turn/start").length, 1);
  await client.close();
});

test("in-flight title naming for an earlier thread does not suppress naming after newChat", async () => {
  const {rpc, client} = await setup();
  let releaseName: ((v: unknown) => void) | undefined;
  let threadCount = 0;
  rpc.request = async (method: string, params: Record<string, unknown>) => {
    rpc.calls.push({method, params});
    if (method === "thread/start") return {thread: {id: `thread-${++threadCount}`}, model: "gpt-6-luna"};
    if (method === "turn/start") return {turn: {id: `turn-${threadCount}`}};
    if (method === "thread/name/set" && params.name !== "New chat" && !releaseName) {
      return new Promise((resolve) => {
        releaseName = resolve;
      });
    }
    return {};
  };
  const firstSend = client.send("First thread topic");
  await new Promise((resolve) => setImmediate(resolve));
  rpc.emit("notification", "turn/completed", {threadId: "dedicated", turnId: "turn-0", turn: {status: "completed"}});
  await client.newChat();
  releaseName!({});
  await firstSend;
  await client.send("Second thread topic");
  const renames = rpc.calls.filter((c) => c.method === "thread/name/set" && c.params.name !== "New chat");
  assert.deepEqual(
    renames.map((c) => ({threadId: c.params.threadId, name: c.params.name})),
    [
      {threadId: "dedicated", name: "First thread topic"},
      {threadId: "thread-1", name: "Second thread topic"},
    ],
  );
  await client.close();
});

test("send and new chat are gated while a turn is starting", async () => {
  const {rpc, client} = await setup();
  const first = client.send("one");
  await assert.rejects(client.send("two"), /current response/);
  await assert.rejects(client.newChat(), /current response/);
  rpc.release!({turn: {id: "t"}});
  await first;
  await client.close();
});

test("interrupt requested before turn acknowledgement is delivered once ID arrives", async () => {
  const {rpc, client} = await setup();
  const sending = client.send("one");
  await client.interrupt();
  rpc.release!({turn: {id: "late"}});
  await sending;
  assert.equal(rpc.calls.filter((c) => c.method === "turn/interrupt").length, 1);
  await client.close();
});

test("late and foreign events cannot update chat; reroutes show actual model", async () => {
  const {rpc, client} = await setup();
  const models: string[] = [];
  const deltas: string[] = [];
  client.on("model", (m) => models.push(m));
  client.on("delta", (d) => deltas.push(d));
  rpc.emit("notification", "item/agentMessage/delta", {threadId: "other", delta: "foreign"});
  rpc.emit("notification", "item/agentMessage/delta", {threadId: "dedicated", delta: "late"});
  assert.deepEqual(deltas, []);
  const sending = client.send("one");
  rpc.release!({turn: {id: "t"}});
  await sending;
  rpc.emit("notification", "model/rerouted", {threadId: "dedicated", toModel: "gpt-6-sol"});
  assert.equal(models.at(-1), "gpt-6-sol");
  rpc.emit("notification", "item/agentMessage/delta", {threadId: "dedicated", turnId: "old", delta: "old"});
  assert.deepEqual(deltas, []);
  await client.close();
});

test("unknown local actions are interrupted and reported", async () => {
  const {rpc, client} = await setup();
  const errors: string[] = [];
  const messages: string[] = [];
  client.on("error", (e) => errors.push(e.message));
  client.on("message", (_id, text) => messages.push(text));
  const sending = client.send("one");
  rpc.release!({turn: {id: "t"}});
  await sending;
  rpc.emit("notification", "item/started", {threadId: "dedicated", turnId: "t", item: {id: "bad", type: "browserControl"}});
  rpc.emit("notification", "item/completed", {threadId: "dedicated", turnId: "t", item: {id: "bad", type: "browserControl"}});
  assert.equal(errors.length, 1);
  assert.match(errors[0] || "", /Blocked/);
  assert.equal(rpc.calls.at(-1)?.method, "turn/interrupt");
  rpc.emit("notification", "turn/completed", {threadId: "dedicated", turnId: "t", turn: {status: "interrupted"}});
  rpc.release = undefined;
  const sendingImage = client.send("make an image");
  rpc.release!({turn: {id: "t2"}});
  await sendingImage;
  rpc.emit("notification", "item/started", {
    threadId: "dedicated",
    turnId: "t2",
    item: {id: "img", type: "mcpToolCall", arguments: {code: "nodeRepl.emitImage(buf)"}},
  });
  assert.equal(messages.length, 1);
  assert.match(messages[0] || "", /text-only|cannot generate|can’t generate/i);
  assert.equal(errors.length, 1);
  await client.close();
});

test("model update locks send and new-chat until acknowledgement", async () => {
  const {rpc, client} = await setup();
  rpc.holdSettings = true;
  rpc.release = () => {};
  const changing = client.selectModel("gpt-6-luna");
  await assert.rejects(client.send("race"), /current response|change/);
  await assert.rejects(client.newChat(), /current response|change/);
  rpc.settingsRelease!({});
  await changing;
  await client.close();
});

test("thread explicitly retains live search and read-only policy independent of global config", async () => {
  const {rpc, client} = await setup();
  const start = rpc.calls.find((c) => c.method === "thread/start")!;
  assert.equal((start.params.config as Record<string, unknown> | undefined)?.web_search, "live");
  assert.equal(start.params.sandbox, "read-only");
  assert.equal(start.params.approvalPolicy, "never");
  assert.deepEqual(start.params.dynamicTools, []);
  await client.close();
});
