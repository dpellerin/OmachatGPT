import assert from "node:assert/strict";
import test from "node:test";
import {mkdtemp, writeFile, chmod} from "node:fs/promises";
import {join} from "node:path";
import {tmpdir} from "node:os";
import {JsonRpcProcess} from "../src/protocol.js";

test("stop rejects pending requests promptly and waits for child exit", async () => {
  const root = await mkdtemp(join(tmpdir(), "omachatgpt-rpc-"));
  const exe = join(root, "fake-codex");
  await writeFile(
    exe,
    `#!/usr/bin/env node\nprocess.stdin.on('data',d=>{for(const l of d.toString().trim().split('\\n')) {const m=JSON.parse(l);if(m.method==='initialize')process.stdout.write(JSON.stringify({id:m.id,result:{}})+'\\n');}});`,
  );
  await chmod(exe, 0o700);
  const previous = process.env.OMACHATGPT_CODEX;
  process.env.OMACHATGPT_CODEX = exe;
  const rpc = new JsonRpcProcess();
  await rpc.start();
  const pending = rpc.request("never", {}, 150);
  const checked = assert.rejects(pending, /stopped/);
  await rpc.stop();
  await checked;
  if (previous) process.env.OMACHATGPT_CODEX = previous;
  else delete process.env.OMACHATGPT_CODEX;
});

test("server-initiated tool requests are refused without resolving client RPCs", async () => {
  const root = await mkdtemp(join(tmpdir(), "omachatgpt-rpc-"));
  const exe = join(root, "fake-codex");
  await writeFile(
    exe,
    `#!/usr/bin/env node\nlet buffer='';process.stdin.on('data',d=>{buffer+=d;while(buffer.includes('\\n')) {const i=buffer.indexOf('\\n'),m=JSON.parse(buffer.slice(0,i));buffer=buffer.slice(i+1);if(m.method==='initialize') {process.stdout.write(JSON.stringify({id:m.id,result:{}})+'\\n');process.stdout.write(JSON.stringify({id:'blocked',method:'item/tool/call',params:{tool:'shell'}})+'\\n');} if(m.id==='blocked' && m.error)process.stdout.write(JSON.stringify({method:'refused',params:{code:m.error.code}})+'\\n');}});`,
  );
  await chmod(exe, 0o700);
  const previous = process.env.OMACHATGPT_CODEX;
  process.env.OMACHATGPT_CODEX = exe;
  const rpc = new JsonRpcProcess();
  const refused = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("tool request was not refused")), 250);
    rpc.on("notification", (method, params) => {
      if (method === "refused") {
        clearTimeout(timer);
        assert.equal(params.code, -32601);
        resolve();
      }
    });
  });
  await rpc.start();
  try {
    await refused;
  } finally {
    await rpc.stop();
    if (previous) process.env.OMACHATGPT_CODEX = previous;
    else delete process.env.OMACHATGPT_CODEX;
  }
});
