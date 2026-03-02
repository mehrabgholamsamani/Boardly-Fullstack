import { spawn } from "node:child_process";
import process from "node:process";
import WebSocket from "ws";

const PORT = 8791;
const ROOM = `smoke-${Date.now()}`;
const SERVER_PATH = "server/dist/index.js";

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function waitForMessage(ws, predicate, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("Timed out waiting for websocket message"));
    }, timeoutMs);

    const onMessage = (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw.toString("utf8"));
      } catch {
        return;
      }
      if (!predicate(msg)) return;
      cleanup();
      resolve(msg);
    };

    const cleanup = () => {
      clearTimeout(timer);
      ws.off("message", onMessage);
    };

    ws.on("message", onMessage);
  });
}

function connectClient(clientId) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}`);
    const timer = setTimeout(() => reject(new Error(`Timed out connecting ${clientId}`)), 5000);

    ws.once("open", async () => {
      clearTimeout(timer);
      ws.send(JSON.stringify({ t: "join", room: ROOM, clientId }));
      const snapshot = await waitForMessage(ws, (m) => m?.t === "snapshot");
      resolve({ ws, snapshot });
    });

    ws.once("error", reject);
  });
}

async function run() {
  const server = spawn("node", [SERVER_PATH], {
    env: { ...process.env, PORT: String(PORT) },
    stdio: ["ignore", "pipe", "pipe"],
  });

  let started = false;
  server.stdout.on("data", (buf) => {
    const text = buf.toString("utf8");
    process.stdout.write(`[server] ${text}`);
    if (text.includes("WS server listening")) started = true;
  });
  server.stderr.on("data", (buf) => {
    process.stderr.write(`[server:err] ${buf.toString("utf8")}`);
  });

  for (let i = 0; i < 50 && !started; i += 1) {
    await wait(100);
  }
  if (!started) throw new Error("Server did not start");

  const c1Conn = await connectClient("smoke-c1");
  const c1 = c1Conn.ws;
  const element = {
    id: "el-1",
    kind: "shape",
    ownerId: "smoke-c1",
    shape: "rect",
    x1: 10,
    y1: 10,
    x2: 100,
    y2: 80,
    color: "#111111",
    size: 2,
  };

  c1.send(JSON.stringify({ t: "element:add", el: element }));
  await wait(100);
  const c2Conn = await connectClient("smoke-c2");
  const c2 = c2Conn.ws;
  if (!c2Conn.snapshot.elements.some((el) => el.id === element.id)) {
    throw new Error("Late joiner snapshot missing committed element");
  }

  c1.send(JSON.stringify({ t: "cursor", clientId: "smoke-c1", p: { x: 20, y: 25 } }));
  await waitForMessage(c2, (m) => m?.t === "cursor" && m?.clientId === "smoke-c1");

  c1.send(JSON.stringify({ t: "element:remove", id: element.id }));
  await waitForMessage(c2, (m) => m?.t === "element:remove" && m?.id === element.id);

  const pingTs = Date.now();
  c1.send(JSON.stringify({ t: "ping", ts: pingTs }));
  await waitForMessage(c1, (m) => m?.t === "pong" && m?.ts === pingTs);

  c1.close();
  c2.close();
  server.kill("SIGTERM");
  console.log("Manual WS smoke test passed.");
}

run().catch((err) => {
  // eslint-disable-next-line no-console
  console.error("Manual WS smoke test failed:", err);
  process.exitCode = 1;
});
