import { WebSocketServer, type WebSocket } from "ws";

// A tiny room-based WS server for collaborative drawing.
// - Room state keeps *committed* elements (strokes/shapes).
// - Live strokes/shapes are broadcast but not stored until committed.

type Brush = "pencil" | "marker" | "highlighter" | "airbrush";
type ShapeType =
  | "rect"
  | "ellipse"
  | "triangle"
  | "star"
  | "line"
  | "pentagon"
  | "tree"
  | "umbrella"
  | "heart";

type Point = { x: number; y: number };

type StrokeStyle = {
  tool: "pen" | "eraser";
  brush: Brush;
  color: string;
  size: number;
};

type StrokeElement = {
  id: string;
  kind: "stroke";
  ownerId?: string;
  points: Point[];
  style: StrokeStyle;
  dots?: { x: number; y: number; r: number; a: number }[];
};

type ShapeElement = {
  id: string;
  kind: "shape";
  ownerId?: string;
  shape: ShapeType;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  color: string;
  size: number;
};

type Element = StrokeElement | ShapeElement;

type ClientMeta = {
  id: string;
  room: string;
};

type Client = WebSocket & { meta?: ClientMeta };

type RoomState = {
  clients: Set<Client>;
  elements: Element[];
};

type Msg =
  | { t: "join"; room: string; clientId: string }
  | { t: "snapshot"; elements: Element[] }
  | { t: "presence"; count: number }
  | { t: "cursor"; clientId: string; p: Point }
  | { t: "cursor:leave"; clientId: string }
  | { t: "element:add"; el: Element }
  | { t: "element:update"; el: Element }
  | { t: "element:remove"; id: string }
  | { t: "stroke:start"; id: string; p: Point; style: StrokeStyle }
  | { t: "stroke:point"; id: string; p: Point }
  | { t: "stroke:end"; id: string }
  | { t: "shape:start"; el: ShapeElement }
  | { t: "shape:update"; el: ShapeElement }
  | { t: "shape:end"; id: string };

const PORT = Number(process.env.PORT ?? process.env.WS_PORT ?? 8787);
const MAX_MSG_BYTES = 256_000;

const rooms = new Map<string, RoomState>();

function getRoom(roomId: string): RoomState {
  const id = roomId.trim() || "lobby";
  let st = rooms.get(id);
  if (!st) {
    st = { clients: new Set(), elements: [] };
    rooms.set(id, st);
  }
  return st;
}

function safeJsonParse(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

function broadcastPresence(room: RoomState) {
  broadcast(room, { t: "presence", count: room.clients.size });
}

function broadcastCursorLeave(room: RoomState, clientId: string) {
  broadcast(room, { t: "cursor:leave", clientId });
}

function broadcast(room: RoomState, data: Msg, except?: Client) {
  const payload = JSON.stringify(data);
  for (const c of room.clients) {
    if (c.readyState !== c.OPEN) continue;
    if (except && c === except) continue;
    c.send(payload);
  }
}

function upsert(elements: Element[], el: Element): Element[] {
  const idx = elements.findIndex((e) => e.id === el.id);
  if (idx === -1) return [...elements, el];
  const next = elements.slice();
  next[idx] = el;
  return next;

function removeById(elements: Element[], id: string): Element[] {
  return elements.filter((e) => e.id !== id);
}

}

const wss = new WebSocketServer({ port: PORT });

wss.on("connection", (ws: Client) => {
  ws.on("message", (buf) => {
    if (!(buf instanceof Buffer)) return;
    if (buf.byteLength > MAX_MSG_BYTES) {
      ws.close(1009, "Message too large");
      return;
    }

    const raw = buf.toString("utf8");
    const msg = safeJsonParse(raw);
    if (!isRecord(msg) || typeof msg.t !== "string") return;

    // Must join first.
    if (!ws.meta && msg.t !== "join") return;

    if (msg.t === "join") {
      const room = typeof msg.room === "string" ? msg.room : "lobby";
      const clientId = typeof msg.clientId === "string" ? msg.clientId : "anon";
      ws.meta = { id: clientId, room: room.trim() || "lobby" };
      const st = getRoom(ws.meta.room);
      st.clients.add(ws);
      // Send snapshot only to joiner
      ws.send(JSON.stringify({ t: "snapshot", elements: st.elements } satisfies Msg));
      // Notify everyone in the room about presence.
      broadcastPresence(st);
      return;
    }

    const meta = ws.meta!;
    const room = getRoom(meta.room);

    // Relay + update state depending on message type.
    switch (msg.t) {
      case "element:add": {
        if (!isRecord(msg.el) || typeof msg.el.id !== "string" || typeof msg.el.kind !== "string") return;
        // Basic sanity: cap points length.
        const el = msg.el as Element;
        if (el.kind === "stroke" && Array.isArray((el as StrokeElement).points) && (el as StrokeElement).points.length > 20_000)
          return;
        room.elements = upsert(room.elements, el);
        broadcast(room, { t: "element:add", el }, ws);
        return;
      }
      case "element:update": {
        if (!isRecord(msg.el) || typeof msg.el.id !== "string" || typeof msg.el.kind !== "string") return;
        const el = msg.el as Element;
        room.elements = upsert(room.elements, el);
        broadcast(room, { t: "element:update", el }, ws);
        return;
      }
      case "element:remove": {
        const id = typeof msg.id === "string" ? msg.id : "";
        if (!id) return;
        room.elements = removeById(room.elements, id);
        broadcast(room, { t: "element:remove", id }, ws);
        return;
      }
      case "cursor": {
        const clientId = typeof msg.clientId === "string" ? msg.clientId : "";
        const p = isRecord(msg.p) ? (msg.p as any) : null;
        if (!clientId || !p || typeof p.x !== "number" || typeof p.y !== "number") return;
        broadcast(room, { t: "cursor", clientId, p: { x: p.x, y: p.y } }, ws);
        return;
      }
      case "stroke:start":
      case "stroke:point":
      case "stroke:end":
      case "shape:start":
      case "shape:update":
      case "shape:end": {
        // Live events: broadcast only (not stored).
        broadcast(room, msg as Msg, ws);
        return;
      }
      default:
        return;
    }
  });

  ws.on("close", () => {
    const meta = ws.meta;
    if (!meta) return;
    const room = rooms.get(meta.room);
    if (!room) return;

    room.clients.delete(ws);

    // Tell others this cursor is gone, and update presence.
    broadcastCursorLeave(room, meta.id);
    broadcastPresence(room);

    if (room.clients.size === 0) {
      // Keep memory tidy.
      rooms.delete(meta.room);
    }
  });});

// eslint-disable-next-line no-console
console.log(`\u2705 WS server listening on ws://localhost:${PORT}`);
