import assert from "node:assert/strict";
import { request } from "node:http";
import process from "node:process";
import WebSocket from "ws";

const PORT = Number(process.env.WS_SIM_PORT ?? 8792);
const WS_URL = process.env.WS_URL ?? `ws://127.0.0.1:${PORT}`;
const HTTP_BASE = process.env.WS_HEALTH_URL ?? `http://127.0.0.1:${PORT}`;
const START_LOCAL = !process.env.WS_URL;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getJson(path: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const req = request(`${HTTP_BASE}${path}`, { method: "GET" }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      res.on("end", () => {
        try {
          const body = Buffer.concat(chunks).toString("utf8");
          resolve(JSON.parse(body));
        } catch (err) {
          reject(err);
        }
      });
    });
    req.on("error", reject);
    req.end();
  });
}

type AnyMsg = Record<string, unknown>;

class SimClient {
  id: string;
  room: string;
  ws: WebSocket | null;
  messages: AnyMsg[];

  constructor(id: string, room: string) {
    this.id = id;
    this.room = room;
    this.ws = null;
    this.messages = [];
  }

  async connect(): Promise<AnyMsg> {
    this.ws = new WebSocket(WS_URL);
    this.ws.on("message", (raw) => {
      try {
        const msg = JSON.parse(raw.toString("utf8")) as AnyMsg;
        this.messages.push(msg);
      } catch {
        // Ignore malformed messages in test buffer.
      }
    });

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`connect timeout for ${this.id}`)), 5000);
      this.ws?.once("open", () => {
        clearTimeout(timer);
        resolve();
      });
      this.ws?.once("error", reject);
    });

    this.send({ t: "join", room: this.room, clientId: this.id });
    const snapshot = await this.waitFor((m) => m.t === "snapshot");
    return snapshot;
  }

  send(msg: AnyMsg): void {
    assert(this.ws, `${this.id} websocket not connected`);
    this.ws.send(JSON.stringify(msg));
  }

  async waitFor(predicate: (msg: AnyMsg) => boolean, timeoutMs = 5000): Promise<AnyMsg> {
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

  async expectNo(predicate: (msg: AnyMsg) => boolean, durationMs = 300): Promise<void> {
    const startLen = this.messages.length;
    await sleep(durationMs);
    for (let i = startLen; i < this.messages.length; i += 1) {
      if (predicate(this.messages[i])) {
        throw new Error(`unexpected message on ${this.id}: ${JSON.stringify(this.messages[i])}`);
      }
    }
  }

  async close(): Promise<void> {
    if (!this.ws || this.ws.readyState >= WebSocket.CLOSING) return;
    await new Promise<void>((resolve) => {
      this.ws?.once("close", () => resolve());
      this.ws?.close(1000, "sim shutdown");
    });
  }
}

async function spamCursor(client: SimClient, n: number): Promise<void> {
  for (let i = 0; i < n; i += 1) {
    client.send({ t: "cursor", p: { x: 50 + i, y: 10 + i } });
    await sleep(20);
  }
}

function getVersion(msg: AnyMsg): number {
  const v = msg.v;
  return typeof v === "number" ? v : -1;
}

async function run(): Promise<void> {
  let stopLocalServer: (() => Promise<void>) | null = null;
  if (START_LOCAL) {
    process.env.PORT = String(PORT);
    process.env.DEBUG = process.env.DEBUG ?? "1";
    const mod = await import("../index.js");
    await mod.startServer(PORT, "127.0.0.1");
    stopLocalServer = () => mod.stopServer();
  }

  try {
    const a = new SimClient("qa-a", "alpha");
    const b = new SimClient("qa-b", "alpha");
    const c = new SimClient("qa-c", "beta");
    const d = new SimClient("qa-d", "alpha");
    const e = new SimClient("qa-e", "alpha");

    const snapA = await a.connect();
    assert.equal(Array.isArray(snapA.elements), true, "snapshot must include elements array");
    assert.equal((snapA.elements as unknown[]).length, 0, "alpha must start empty");
    assert.equal(typeof snapA.v, "number", "snapshot must include room version");

    await b.connect();
    await c.connect();
    await d.connect();
    await e.connect();

    await a.waitFor((m) => m.t === "presence" && m.count === 4);
    await b.waitFor((m) => m.t === "presence" && m.count === 4);
    await d.waitFor((m) => m.t === "presence" && m.count === 4);
    await e.waitFor((m) => m.t === "presence" && m.count === 4);
    await c.waitFor((m) => m.t === "presence" && m.count === 1);

    const el1 = {
      id: "el-alpha-1",
      kind: "shape",
      ownerId: "spoof-owner",
      shape: "rect",
      x1: 10,
      y1: 20,
      x2: 80,
      y2: 60,
      color: "#111111",
      size: 2,
    };

    a.send({ t: "element:add", el: el1 });
    const addB = await b.waitFor((m) => m.t === "element:add" && (m.el as AnyMsg)?.id === el1.id);
    assert.equal((addB.el as AnyMsg)?.ownerId, "qa-a", "server must owner-bind on add");
    await c.expectNo((m) => m.t === "element:add" && (m.el as AnyMsg)?.id === el1.id);

    await Promise.all([spamCursor(a, 20), spamCursor(b, 20)]);
    await d.waitFor((m) => m.t === "cursor" && m.clientId === "qa-a");
    await c.expectNo((m) => m.t === "cursor" && (m.clientId === "qa-a" || m.clientId === "qa-b"));

    b.send({ t: "element:remove", id: el1.id });
    const unauthorized = await b.waitFor((m) => m.t === "error" && m.code === "forbidden");
    assert.equal(unauthorized.t, "error", "unauthorized remove must return error");

    a.send({ t: "element:remove", id: el1.id });
    const removeB = await b.waitFor((m) => m.t === "element:remove" && m.id === el1.id);
    await d.waitFor((m) => m.t === "element:remove" && m.id === el1.id);
    let lastVersion = getVersion(removeB);
    assert(lastVersion > 0, "durable remove must carry positive version");

    // Two-device durability smoothness: repeated commits must arrive with monotonic version growth.
    for (let i = 0; i < 25; i += 1) {
      const id = `round2-el-${i}`;
      a.send({
        t: "element:add",
        el: {
          id,
          kind: "shape",
          shape: "ellipse",
          x1: i,
          y1: i,
          x2: i + 10,
          y2: i + 12,
          color: "#00aa00",
          size: 2,
        },
      });
      const add = await b.waitFor((m) => m.t === "element:add" && (m.el as AnyMsg)?.id === id);
      const addV = getVersion(add);
      assert(addV > lastVersion, "element:add version must increase");
      lastVersion = addV;

      a.send({ t: "element:remove", id });
      const rem = await b.waitFor((m) => m.t === "element:remove" && m.id === id);
      const remV = getVersion(rem);
      assert(remV > lastVersion, "element:remove version must increase");
      lastVersion = remV;
    }

    const late = new SimClient("qa-late", "alpha");
    const lateSnap = await late.connect();
    const lateElements = lateSnap.elements as AnyMsg[];
    assert.equal(lateElements.some((el) => el.id === el1.id), false, "removed element must not appear in late snapshot");
    assert.equal(typeof lateSnap.v, "number", "late snapshot must include room version");
    assert((lateSnap.v as number) >= lastVersion, "late snapshot version must be current");

    await b.close();
    await a.waitFor((m) => m.t === "presence" && m.count === 4);

    const b2 = new SimClient("qa-b", "alpha");
    const b2Snap = await b2.connect();
    assert.equal(typeof b2Snap.v, "number", "reconnect snapshot must include room version");
    assert((b2Snap.v as number) >= lastVersion, "reconnect snapshot version must not regress");
    await a.waitFor((m) => m.t === "presence" && m.count === 5);

    b2.send({ t: "element:remove", id: 12345 });
    await b2.waitFor((m) => m.t === "error" && m.code === "invalid_message");

    await late.close();
    await b2.close();
    await a.close();
    await d.close();
    await e.close();
    await c.close();

    await sleep(350);
    const health = (await getJson("/health")) as AnyMsg;
    assert.equal(health.status, "ok", "health endpoint must report ok");
    assert.equal(health.roomCount, 0, "room count should return to 0 after all clients leave");
    const telemetry = health.telemetry as AnyMsg;
    assert.equal(typeof telemetry, "object", "health must include telemetry");
    const aggregate = telemetry.aggregate as AnyMsg;
    assert.equal(typeof aggregate.p50BroadcastMs, "number", "aggregate p50 must be numeric");
    assert.equal(typeof aggregate.p95BroadcastMs, "number", "aggregate p95 must be numeric");
    assert.equal(typeof aggregate.droppedEphemeralSoft, "number", "aggregate droppedEphemeralSoft must be numeric");
    assert.equal(typeof aggregate.droppedHardDisconnects, "number", "aggregate droppedHardDisconnects must be numeric");

    console.log("WS simulation test passed.");
  } finally {
    if (stopLocalServer) {
      await stopLocalServer();
    }
  }
}

run().catch((err) => {
  console.error("WS simulation test failed:", err);
  process.exitCode = 1;
});
