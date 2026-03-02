import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import process from "node:process";
import WebSocket from "ws";

const PORT = 8792;
const SERVER_ENTRY = "server/dist/index.js";
const WS_URL = `ws://127.0.0.1:${PORT}`;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

class SimClient {
  constructor(id, room) {
    this.id = id;
    this.room = room;
    this.ws = null;
    this.messages = [];
  }

  async connect() {
    this.ws = new WebSocket(WS_URL);
    this.ws.on("message", (raw) => {
      try {
        const msg = JSON.parse(raw.toString("utf8"));
        this.messages.push(msg);
      } catch {
      }
    });

    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`connect timeout for ${this.id}`)), 5000);
      this.ws.once("open", () => {
        clearTimeout(timer);
        resolve();
      });
      this.ws.once("error", reject);
    });

    this.send({ t: "join", room: this.room, clientId: this.id });
    const snapshot = await this.waitFor((m) => m.t === "snapshot");
    return snapshot;
  }

  send(msg) {
    assert(this.ws, `${this.id} websocket not connected`);
    this.ws.send(JSON.stringify(msg));
  }

  async waitFor(predicate, timeoutMs = 5000) {
    const deadline = Date.now() + timeoutMs;
    let idx = 0;
    while (Date.now() < deadline) {
      for (; idx < this.messages.length; idx += 1) {
        const msg = this.messages[idx];
        if (predicate(msg)) return msg;
      }
      await sleep(10);
    }
    throw new Error(`timeout waiting for message on ${this.id}`);
  }

  async expectNo(predicate, durationMs = 400) {
    const startLen = this.messages.length;
    await sleep(durationMs);
    for (let i = startLen; i < this.messages.length; i += 1) {
      if (predicate(this.messages[i])) {
        throw new Error(`unexpected message on ${this.id}: ${JSON.stringify(this.messages[i])}`);
      }
    }
  }

  async close() {
    if (!this.ws || this.ws.readyState >= WebSocket.CLOSING) return;
    await new Promise((resolve) => {
      this.ws.once("close", () => resolve());
      this.ws.close(1000, "test shutdown");
    });
  }
}

async function waitForServerStart(proc) {
  const deadline = Date.now() + 7000;
  let started = false;
  proc.stdout.on("data", (buf) => {
    const line = buf.toString("utf8");
    process.stdout.write(`[ws-server] ${line}`);
    if (line.includes("WS server listening")) started = true;
  });
  proc.stderr.on("data", (buf) => {
    process.stderr.write(`[ws-server:err] ${buf.toString("utf8")}`);
  });
  while (Date.now() < deadline) {
    if (started) return;
    await sleep(20);
  }
  throw new Error("server did not start in time");
}

async function run() {
  const serverProc = spawn("node", [SERVER_ENTRY], {
    env: { ...process.env, PORT: String(PORT) },
    stdio: ["ignore", "pipe", "pipe"],
  });

  try {
    await waitForServerStart(serverProc);

    const a = new SimClient("qa-a", "alpha");
    const b = new SimClient("qa-b", "alpha");
    const c = new SimClient("qa-c", "beta");
    const d = new SimClient("qa-d", "alpha");
    const e = new SimClient("qa-e", "alpha");

    const snapA = await a.connect();
    assert(Array.isArray(snapA.elements) && snapA.elements.length === 0, "room alpha should start empty");
    await a.waitFor((m) => m.t === "presence" && m.count === 1);

    await b.connect();
    await a.waitFor((m) => m.t === "presence" && m.count === 2);
    await b.waitFor((m) => m.t === "presence" && m.count === 2);

    await c.connect();
    await c.waitFor((m) => m.t === "presence" && m.count === 1);

    const el1 = {
      id: "el-alpha-1",
      kind: "shape",
      ownerId: "qa-a",
      shape: "rect",
      x1: 10,
      y1: 10,
      x2: 80,
      y2: 60,
      color: "#111111",
      size: 2,
    };
    a.send({ t: "element:add", el: el1 });
    await b.waitFor((m) => m.t === "element:add" && m.el?.id === el1.id);
    await c.expectNo((m) => m.t === "element:add" && m.el?.id === el1.id);

    const snapD = await d.connect();
    assert(snapD.elements.some((el) => el.id === el1.id), "late joiner snapshot missing committed element");

    b.send({ t: "element:remove", id: el1.id });
    await a.expectNo((m) => m.t === "element:remove" && m.id === el1.id);
    const snapE = await e.connect();
    assert(snapE.elements.some((el) => el.id === el1.id), "non-owner remove should not mutate server state");

    await a.waitFor((m) => m.t === "presence" && m.count === 4);
    await b.waitFor((m) => m.t === "presence" && m.count === 4);
    await d.waitFor((m) => m.t === "presence" && m.count === 4);
    await e.waitFor((m) => m.t === "presence" && m.count === 4);

    a.send({ t: "cursor", clientId: "spoofed", p: { x: 22, y: 40 } });
    const cursorB = await b.waitFor((m) => m.t === "cursor" && m.p?.x === 22 && m.p?.y === 40);
    assert.equal(cursorB.clientId, "qa-a", "server should normalize cursor sender id");
    await c.expectNo((m) => m.t === "cursor" && m.p?.x === 22 && m.p?.y === 40);

    await b.close();
    await a.waitFor((m) => m.t === "presence" && m.count === 3);

    const b2 = new SimClient("qa-b", "alpha");
    const snapB2 = await b2.connect();
    assert(snapB2.elements.some((el) => el.id === el1.id), "reconnected client snapshot mismatch");
    await a.waitFor((m) => m.t === "presence" && m.count === 4);

    const el2 = {
      id: "el-alpha-2",
      kind: "shape",
      ownerId: "qa-b",
      shape: "ellipse",
      x1: 100,
      y1: 100,
      x2: 130,
      y2: 140,
      color: "#333333",
      size: 3,
    };
    b2.send({ t: "element:add", el: el2 });
    await a.waitFor((m) => m.t === "element:add" && m.el?.id === el2.id);
    b2.send({ t: "element:remove", id: el2.id });
    await a.waitFor((m) => m.t === "element:remove" && m.id === el2.id);

    await d.close();
    await e.close();
    await b2.close();
    await a.close();

    const f = new SimClient("qa-f", "alpha");
    const snapF = await f.connect();
    assert.equal(snapF.elements.length, 0, "room state should be cleaned when last client leaves");
    await f.close();
    await c.close();

    console.log("WS simulation test passed.");
  } finally {
    serverProc.kill("SIGTERM");
  }
}

run().catch((err) => {
  console.error("WS simulation test failed:", err);
  process.exitCode = 1;
});

