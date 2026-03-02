import { createServer } from "node:http";
import { pathToFileURL } from "node:url";
import { WebSocketServer, type RawData, type WebSocket } from "ws";

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

type CursorState = {
  p: Point;
  updatedAt: number;
};

type ClientMeta = {
  id: string;
  roomId: string;
};

type Client = WebSocket & {
  meta?: ClientMeta;
  isAlive: boolean;
};

type RoomState = {
  clients: Set<Client>;
  byClientId: Map<string, Client>;
  elementsById: Map<string, Element>;
  elementOrder: string[];
  cursors: Map<string, CursorState>;
  version: number;
  telemetry: {
    broadcastLatencyMs: number[];
    droppedEphemeralSoft: number;
    droppedHardDisconnects: number;
    totalBroadcasts: number;
    totalDelivered: number;
    totalSendFailures: number;
    lastActivityAt: number;
  };
};

type ErrorCode =
  | "bad_json"
  | "invalid_message"
  | "unsupported_type"
  | "not_joined"
  | "room_limit_reached"
  | "room_full"
  | "elements_limit_reached"
  | "forbidden"
  | "invalid_state";

type ServerMsg =
  | { t: "snapshot"; elements: Element[]; cursors: Array<{ clientId: string; p: Point }>; presence: number; v: number }
  | { t: "presence"; count: number }
  | { t: "cursor"; clientId: string; p: Point }
  | { t: "cursor:leave"; clientId: string }
  | { t: "element:add"; el: Element; v: number }
  | { t: "element:update"; el: Element; v: number }
  | { t: "element:remove"; id: string; v: number }
  | { t: "stroke:start"; id: string; p: Point; style: StrokeStyle }
  | { t: "stroke:point"; id: string; p: Point }
  | { t: "stroke:end"; id: string }
  | { t: "shape:start"; el: ShapeElement }
  | { t: "shape:update"; el: ShapeElement }
  | { t: "shape:end"; id: string }
  | { t: "pong"; ts: number }
  | { t: "error"; code: ErrorCode; message: string; details?: string };

type JoinMsg = { t: "join"; room: string; clientId: string };
type PingMsg = { t: "ping"; ts?: number };
type ElementAddMsg = { t: "element:add"; el: Element };
type ElementUpdateMsg = { t: "element:update"; el: Element };
type ElementRemoveMsg = { t: "element:remove"; id: string };
type CursorMsg = { t: "cursor"; p: Point };
type StrokeStartMsg = { t: "stroke:start"; id: string; p: Point; style: StrokeStyle };
type StrokePointMsg = { t: "stroke:point"; id: string; p: Point };
type StrokeEndMsg = { t: "stroke:end"; id: string };
type ShapeStartMsg = { t: "shape:start"; el: ShapeElement };
type ShapeUpdateMsg = { t: "shape:update"; el: ShapeElement };
type ShapeEndMsg = { t: "shape:end"; id: string };

const PORT = parseEnvInt(process.env.PORT ?? process.env.WS_PORT, 8787);
const HOST = "0.0.0.0";
const DEBUG = process.env.DEBUG === "1";
const NODE_ENV = process.env.NODE_ENV ?? "development";
const MAX_MSG_BYTES = parseEnvInt(process.env.MAX_MSG_BYTES, 64 * 1024);
const MAX_ROOMS = parseEnvInt(process.env.MAX_ROOMS, 200);
const MAX_CLIENTS_PER_ROOM = parseEnvInt(process.env.MAX_CLIENTS_PER_ROOM, 64);
const MAX_ELEMENTS_PER_ROOM = parseEnvInt(process.env.MAX_ELEMENTS_PER_ROOM, 5000);
const MAX_BUFFERED_SOFT_BYTES = parseEnvInt(process.env.MAX_BUFFERED_SOFT_BYTES, 256_000);
const MAX_BUFFERED_HARD_BYTES = parseEnvInt(process.env.MAX_BUFFERED_HARD_BYTES, 1_000_000);
const SERVER_PING_INTERVAL_MS = parseEnvInt(process.env.SERVER_PING_INTERVAL_MS, 30_000);
const CURSOR_STALE_MS = parseEnvInt(process.env.CURSOR_STALE_MS, 15_000);
const CURSOR_SWEEP_MS = parseEnvInt(process.env.CURSOR_SWEEP_MS, 5_000);
const LOG_RATE_LIMIT_MS = parseEnvInt(process.env.LOG_RATE_LIMIT_MS, 5_000);
const METRICS_WINDOW_SIZE = parseEnvInt(process.env.METRICS_WINDOW_SIZE, 256);

const DEFAULT_ALLOWED_ORIGINS = new Set([
  "http://localhost:5173",
  "http://127.0.0.1:5173",
  "http://localhost:4173",
  "http://127.0.0.1:4173",
]);
const allowedOriginsFromEnv = (process.env.ALLOWED_ORIGINS ?? process.env.CORS_ORIGINS ?? process.env.CLIENT_ORIGIN ?? "")
  .split(",")
  .map((v) => v.trim())
  .filter(Boolean);
const BRUSH_TYPES: readonly Brush[] = ["pencil", "marker", "highlighter", "airbrush"];
const SHAPE_TYPES: readonly ShapeType[] = ["rect", "ellipse", "triangle", "star", "line", "pentagon", "tree", "umbrella", "heart"];
const SERVER_ONLY_TYPES = new Set(["snapshot", "presence", "cursor:leave", "error"]);
const rooms = new Map<string, RoomState>();
const logLastAt = new Map<string, number>();
let heartbeatTimer: NodeJS.Timeout | null = null;
let cursorSweepTimer: NodeJS.Timeout | null = null;
let listening = false;

function parseEnvInt(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
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

function isFiniteNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.trim().length > 0;
}

function normalizeId(input: string, fallback: string): string {
  const cleaned = input.trim();
  if (!cleaned) return fallback;
  return cleaned.slice(0, 128);
}

function isPoint(v: unknown): v is Point {
  return isRecord(v) && isFiniteNumber(v.x) && isFiniteNumber(v.y);
}

function isStrokeStyle(v: unknown): v is StrokeStyle {
  if (!isRecord(v)) return false;
  if (v.tool !== "pen" && v.tool !== "eraser") return false;
  if (typeof v.brush !== "string" || !BRUSH_TYPES.includes(v.brush as Brush)) return false;
  if (!isNonEmptyString(v.color)) return false;
  if (!isFiniteNumber(v.size) || v.size <= 0 || v.size > 512) return false;
  return true;
}

function parseStrokeElement(v: unknown): StrokeElement | null {
  if (!isRecord(v)) return null;
  if (v.kind !== "stroke" || !isNonEmptyString(v.id) || !isStrokeStyle(v.style)) return null;
  if (!Array.isArray(v.points) || v.points.length > 20_000) return null;
  const points: Point[] = [];
  for (const p of v.points) {
    if (!isPoint(p)) return null;
    points.push({ x: p.x, y: p.y });
  }
  const dots: StrokeElement["dots"] = [];
  if (v.dots !== undefined) {
    if (!Array.isArray(v.dots) || v.dots.length > 20_000) return null;
    for (const dot of v.dots) {
      if (!isRecord(dot)) return null;
      if (!isFiniteNumber(dot.x) || !isFiniteNumber(dot.y) || !isFiniteNumber(dot.r) || !isFiniteNumber(dot.a)) return null;
      dots.push({ x: dot.x, y: dot.y, r: dot.r, a: dot.a });
    }
  }
  return {
    id: normalizeId(v.id, "invalid"),
    kind: "stroke",
    ownerId: typeof v.ownerId === "string" ? normalizeId(v.ownerId, "") : undefined,
    points,
    style: v.style,
    dots: dots.length > 0 ? dots : undefined,
  };
}

function parseShapeElement(v: unknown): ShapeElement | null {
  if (!isRecord(v)) return null;
  if (v.kind !== "shape" || !isNonEmptyString(v.id)) return null;
  if (typeof v.shape !== "string" || !SHAPE_TYPES.includes(v.shape as ShapeType)) return null;
  if (!isFiniteNumber(v.x1) || !isFiniteNumber(v.y1) || !isFiniteNumber(v.x2) || !isFiniteNumber(v.y2)) return null;
  if (!isNonEmptyString(v.color)) return null;
  if (!isFiniteNumber(v.size) || v.size <= 0 || v.size > 512) return null;
  return {
    id: normalizeId(v.id, "invalid"),
    kind: "shape",
    ownerId: typeof v.ownerId === "string" ? normalizeId(v.ownerId, "") : undefined,
    shape: v.shape as ShapeType,
    x1: v.x1,
    y1: v.y1,
    x2: v.x2,
    y2: v.y2,
    color: v.color,
    size: v.size,
  };
}

function parseElement(v: unknown): Element | null {
  if (!isRecord(v) || typeof v.kind !== "string") return null;
  if (v.kind === "stroke") return parseStrokeElement(v);
  if (v.kind === "shape") return parseShapeElement(v);
  return null;
}

function parseJoin(msg: Record<string, unknown>): JoinMsg | null {
  if (msg.t !== "join" || !isNonEmptyString(msg.room) || !isNonEmptyString(msg.clientId)) return null;
  return { t: "join", room: normalizeId(msg.room, "lobby"), clientId: normalizeId(msg.clientId, "anon") };
}

function parsePing(msg: Record<string, unknown>): PingMsg | null {
  if (msg.t !== "ping") return null;
  if (msg.ts === undefined) return { t: "ping" };
  if (!isFiniteNumber(msg.ts)) return null;
  return { t: "ping", ts: msg.ts };
}

function parseElementAdd(msg: Record<string, unknown>): ElementAddMsg | null {
  if (msg.t !== "element:add") return null;
  const el = parseElement(msg.el);
  if (!el) return null;
  return { t: "element:add", el };
}

function parseElementUpdate(msg: Record<string, unknown>): ElementUpdateMsg | null {
  if (msg.t !== "element:update") return null;
  const el = parseElement(msg.el);
  if (!el) return null;
  return { t: "element:update", el };
}

function parseElementRemove(msg: Record<string, unknown>): ElementRemoveMsg | null {
  if (msg.t !== "element:remove" || !isNonEmptyString(msg.id)) return null;
  return { t: "element:remove", id: normalizeId(msg.id, "") };
}

function parseCursor(msg: Record<string, unknown>): CursorMsg | null {
  if (msg.t !== "cursor" || !isPoint(msg.p)) return null;
  return { t: "cursor", p: { x: msg.p.x, y: msg.p.y } };
}

function parseStrokeStart(msg: Record<string, unknown>): StrokeStartMsg | null {
  if (msg.t !== "stroke:start" || !isNonEmptyString(msg.id) || !isPoint(msg.p) || !isStrokeStyle(msg.style)) return null;
  return { t: "stroke:start", id: normalizeId(msg.id, ""), p: msg.p, style: msg.style };
}

function parseStrokePoint(msg: Record<string, unknown>): StrokePointMsg | null {
  if (msg.t !== "stroke:point" || !isNonEmptyString(msg.id) || !isPoint(msg.p)) return null;
  return { t: "stroke:point", id: normalizeId(msg.id, ""), p: msg.p };
}

function parseStrokeEnd(msg: Record<string, unknown>): StrokeEndMsg | null {
  if (msg.t !== "stroke:end" || !isNonEmptyString(msg.id)) return null;
  return { t: "stroke:end", id: normalizeId(msg.id, "") };
}

function parseShapeStart(msg: Record<string, unknown>): ShapeStartMsg | null {
  if (msg.t !== "shape:start") return null;
  const el = parseShapeElement(msg.el);
  if (!el) return null;
  return { t: "shape:start", el };
}

function parseShapeUpdate(msg: Record<string, unknown>): ShapeUpdateMsg | null {
  if (msg.t !== "shape:update") return null;
  const el = parseShapeElement(msg.el);
  if (!el) return null;
  return { t: "shape:update", el };
}

function parseShapeEnd(msg: Record<string, unknown>): ShapeEndMsg | null {
  if (msg.t !== "shape:end" || !isNonEmptyString(msg.id)) return null;
  return { t: "shape:end", id: normalizeId(msg.id, "") };
}

function rawToString(raw: RawData): string | null {
  if (typeof raw === "string") return raw;
  if (raw instanceof Buffer) return raw.toString("utf8");
  if (Array.isArray(raw)) return Buffer.concat(raw).toString("utf8");
  if (raw instanceof ArrayBuffer) return Buffer.from(raw).toString("utf8");
  return null;
}

function logInfo(message: string) {
  if (DEBUG) console.log(message);
}

function logWarn(message: string, key?: string) {
  if (!key) {
    console.warn(message);
    return;
  }
  const now = Date.now();
  const last = logLastAt.get(key) ?? 0;
  if (now - last < LOG_RATE_LIMIT_MS) return;
  logLastAt.set(key, now);
  console.warn(message);
}

function isOriginAllowed(origin: string | undefined): boolean {
  if (!origin) return true;
  if (DEFAULT_ALLOWED_ORIGINS.has(origin)) return true;

  try {
    const parsed = new URL(origin);
    const host = parsed.hostname.toLowerCase();
    if (host === "localhost" || host === "127.0.0.1" || host === "::1") return true;
    if (host.endsWith(".vercel.app")) return true;
  } catch {
    return false;
  }

  for (const allowed of allowedOriginsFromEnv) {
    if (allowed === origin) return true;
    try {
      if (new URL(allowed).origin === origin) return true;
    } catch {
      if (allowed === origin) return true;
    }
  }
  return false;
}

function getOrCreateRoom(roomId: string): RoomState | null {
  const normalized = normalizeId(roomId, "lobby");
  const existing = rooms.get(normalized);
  if (existing) return existing;
  if (rooms.size >= MAX_ROOMS) return null;
  const next: RoomState = {
    clients: new Set<Client>(),
    byClientId: new Map<string, Client>(),
    elementsById: new Map<string, Element>(),
    elementOrder: [],
    cursors: new Map<string, CursorState>(),
    version: 0,
    telemetry: {
      broadcastLatencyMs: [],
      droppedEphemeralSoft: 0,
      droppedHardDisconnects: 0,
      totalBroadcasts: 0,
      totalDelivered: 0,
      totalSendFailures: 0,
      lastActivityAt: Date.now(),
    },
  };
  rooms.set(normalized, next);
  return next;
}

function pushMetric(sampleWindow: number[], value: number) {
  sampleWindow.push(value);
  if (sampleWindow.length > METRICS_WINDOW_SIZE) {
    sampleWindow.shift();
  }
}

function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = values.slice().sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.floor((p / 100) * sorted.length)));
  return sorted[idx];
}

function roomElements(room: RoomState): Element[] {
  const out: Element[] = [];
  for (const id of room.elementOrder) {
    const el = room.elementsById.get(id);
    if (el) out.push(el);
  }
  return out;
}

function roomCursorSnapshot(room: RoomState): Array<{ clientId: string; p: Point }> {
  const now = Date.now();
  const list: Array<{ clientId: string; p: Point }> = [];
  for (const [clientId, cursor] of room.cursors) {
    if (now - cursor.updatedAt > CURSOR_STALE_MS) continue;
    list.push({ clientId, p: cursor.p });
  }
  return list;
}

function send(ws: Client, msg: ServerMsg) {
  if (ws.readyState !== ws.OPEN) return;
  try {
    ws.send(JSON.stringify(msg));
  } catch (err) {
    logWarn(`[ws] send failed: ${(err as Error).message}`, "send_failed");
  }
}

function sendError(ws: Client, code: ErrorCode, message: string, details?: string) {
  send(ws, { t: "error", code, message, details });
  logWarn(`[ws] error code=${code} message=${message}${details ? ` details=${details}` : ""}`, `err_${code}`);
}

function isEphemeral(message: ServerMsg): boolean {
  return (
    message.t === "cursor" ||
    message.t === "cursor:leave" ||
    message.t === "stroke:start" ||
    message.t === "stroke:point" ||
    message.t === "stroke:end" ||
    message.t === "shape:start" ||
    message.t === "shape:update" ||
    message.t === "shape:end"
  );
}

function broadcast(room: RoomState, message: ServerMsg, options?: { except?: Client; includeSender?: boolean }) {
  const startMs = Date.now();
  const includeSender = options?.includeSender ?? false;
  const except = options?.except;
  const payload = JSON.stringify(message);
  let delivered = 0;
  room.telemetry.totalBroadcasts += 1;
  room.telemetry.lastActivityAt = startMs;
  for (const client of room.clients) {
    if (client.readyState !== client.OPEN) continue;
    if (!includeSender && except && client === except) continue;
    if (client.bufferedAmount > MAX_BUFFERED_HARD_BYTES) {
      logWarn(`[ws] slow client terminated buffered=${client.bufferedAmount}`, "slow_client_hard");
      room.telemetry.droppedHardDisconnects += 1;
      client.terminate();
      continue;
    }
    if (client.bufferedAmount > MAX_BUFFERED_SOFT_BYTES && isEphemeral(message)) {
      logWarn(`[ws] skipped ephemeral event for slow client buffered=${client.bufferedAmount}`, "slow_client_soft");
      room.telemetry.droppedEphemeralSoft += 1;
      continue;
    }
    try {
      client.send(payload);
      delivered += 1;
    } catch (err) {
      logWarn(`[ws] broadcast send failed: ${(err as Error).message}`, "broadcast_send_failed");
      room.telemetry.totalSendFailures += 1;
    }
  }
  room.telemetry.totalDelivered += delivered;
  pushMetric(room.telemetry.broadcastLatencyMs, Date.now() - startMs);
  logInfo(`[ws] broadcast type=${message.t} delivered=${delivered}`);
}

function broadcastPresence(room: RoomState) {
  broadcast(room, { t: "presence", count: room.clients.size }, { includeSender: true });
}

function insertElement(room: RoomState, element: Element): void {
  if (!room.elementsById.has(element.id)) {
    room.elementOrder.push(element.id);
  }
  room.elementsById.set(element.id, element);
}

function removeElement(room: RoomState, id: string): boolean {
  const deleted = room.elementsById.delete(id);
  if (!deleted) return false;
  room.elementOrder = room.elementOrder.filter((elId) => elId !== id);
  return true;
}

function clearCursor(room: RoomState, clientId: string, opts?: { broadcastLeave?: boolean }) {
  if (!room.cursors.delete(clientId)) return;
  if (opts?.broadcastLeave) {
    broadcast(room, { t: "cursor:leave", clientId }, { includeSender: true });
  }
}

function tryCleanupRoom(roomId: string) {
  const room = rooms.get(roomId);
  if (!room) return;
  if (room.clients.size > 0) return;
  rooms.delete(roomId);
  logInfo(`[ws] room cleaned room=${roomId}`);
}

function leaveCurrentRoom(ws: Client, reason: string) {
  const meta = ws.meta;
  if (!meta) return;
  const room = rooms.get(meta.roomId);
  ws.meta = undefined;
  if (!room) return;

  room.clients.delete(ws);
  if (room.byClientId.get(meta.id) === ws) {
    room.byClientId.delete(meta.id);
  }
  clearCursor(room, meta.id, { broadcastLeave: true });
  broadcastPresence(room);
  tryCleanupRoom(meta.roomId);
  logInfo(`[ws] leave room=${meta.roomId} client=${meta.id} reason=${reason}`);
}

function sendSnapshot(ws: Client, room: RoomState) {
  const elements = roomElements(room);
  const cursors = roomCursorSnapshot(room);
  room.telemetry.lastActivityAt = Date.now();
  send(ws, { t: "snapshot", elements, cursors, presence: room.clients.size, v: room.version });
  logInfo(`[ws] snapshot room=${ws.meta?.roomId ?? "unknown"} elements=${elements.length} cursors=${cursors.length} v=${room.version}`);
}

const httpServer = createServer((req, res) => {
  const url = req.url ?? "/";
  if (req.method === "GET" && url.startsWith("/health")) {
    const totalClients = Array.from(rooms.values()).reduce((acc, room) => acc + room.clients.size, 0);
    const totalElements = Array.from(rooms.values()).reduce((acc, room) => acc + room.elementsById.size, 0);
    const roomTelemetry = Array.from(rooms.entries()).map(([roomId, room]) => ({
      roomId,
      clients: room.clients.size,
      elements: room.elementsById.size,
      version: room.version,
      p50BroadcastMs: percentile(room.telemetry.broadcastLatencyMs, 50),
      p95BroadcastMs: percentile(room.telemetry.broadcastLatencyMs, 95),
      droppedEphemeralSoft: room.telemetry.droppedEphemeralSoft,
      droppedHardDisconnects: room.telemetry.droppedHardDisconnects,
      totalBroadcasts: room.telemetry.totalBroadcasts,
      totalDelivered: room.telemetry.totalDelivered,
      totalSendFailures: room.telemetry.totalSendFailures,
      lastActivityAt: room.telemetry.lastActivityAt,
    }));
    const allBroadcastSamples = roomTelemetry.flatMap((room) => {
      const st = rooms.get(room.roomId);
      return st ? st.telemetry.broadcastLatencyMs : [];
    });
    const aggregateDropsSoft = roomTelemetry.reduce((acc, room) => acc + room.droppedEphemeralSoft, 0);
    const aggregateDropsHard = roomTelemetry.reduce((acc, room) => acc + room.droppedHardDisconnects, 0);
    const aggregateFailures = roomTelemetry.reduce((acc, room) => acc + room.totalSendFailures, 0);
    const body = JSON.stringify({
      status: "ok",
      env: NODE_ENV,
      uptimeSec: Math.round(process.uptime()),
      roomCount: rooms.size,
      totalClients,
      totalElements,
      limits: {
        maxMessageBytes: MAX_MSG_BYTES,
        maxRooms: MAX_ROOMS,
        maxClientsPerRoom: MAX_CLIENTS_PER_ROOM,
        maxElementsPerRoom: MAX_ELEMENTS_PER_ROOM,
        maxBufferedSoftBytes: MAX_BUFFERED_SOFT_BYTES,
        maxBufferedHardBytes: MAX_BUFFERED_HARD_BYTES,
      },
      telemetry: {
        aggregate: {
          p50BroadcastMs: percentile(allBroadcastSamples, 50),
          p95BroadcastMs: percentile(allBroadcastSamples, 95),
          droppedEphemeralSoft: aggregateDropsSoft,
          droppedHardDisconnects: aggregateDropsHard,
          totalSendFailures: aggregateFailures,
        },
        rooms: roomTelemetry,
      },
    });
    res.statusCode = 200;
    res.setHeader("content-type", "application/json; charset=utf-8");
    res.end(body);
    return;
  }
  res.statusCode = 200;
  res.setHeader("content-type", "text/plain; charset=utf-8");
  res.end("boardly websocket server");
});

const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_MSG_BYTES });

httpServer.on("upgrade", (req, socket, head) => {
  const origin = req.headers.origin;
  if (!isOriginAllowed(origin)) {
    socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
    socket.destroy();
    logWarn(`[ws] blocked upgrade origin=${origin ?? "(none)"}`, "blocked_origin");
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => {
    wss.emit("connection", ws, req);
  });
});

function requireJoined(ws: Client): RoomState | null {
  if (!ws.meta) {
    sendError(ws, "not_joined", "join is required before this message");
    return null;
  }
  const room = rooms.get(ws.meta.roomId);
  if (!room) {
    sendError(ws, "invalid_state", "room state not found");
    return null;
  }
  return room;
}

function handleJoin(ws: Client, rawMsg: Record<string, unknown>) {
  const msg = parseJoin(rawMsg);
  if (!msg) {
    sendError(ws, "invalid_message", "invalid join payload");
    return;
  }

  const room = getOrCreateRoom(msg.room);
  if (!room) {
    sendError(ws, "room_limit_reached", "max room capacity reached");
    return;
  }

  if (room.clients.size >= MAX_CLIENTS_PER_ROOM && room.byClientId.get(msg.clientId) !== ws) {
    sendError(ws, "room_full", "room is full");
    return;
  }

  if (ws.meta && (ws.meta.roomId !== msg.room || ws.meta.id !== msg.clientId)) {
    leaveCurrentRoom(ws, "join_switch");
  }

  const existing = room.byClientId.get(msg.clientId);
  if (existing && existing !== ws) {
    sendError(existing, "invalid_state", "duplicate clientId replaced by newer connection");
    existing.close(4002, "duplicate clientId");
    leaveCurrentRoom(existing, "duplicate_replaced");
  }

  ws.meta = { id: msg.clientId, roomId: msg.room };
  room.clients.add(ws);
  room.byClientId.set(msg.clientId, ws);
  sendSnapshot(ws, room);
  broadcastPresence(room);
  logInfo(`[ws] join room=${msg.room} client=${msg.clientId} clients=${room.clients.size}`);
}

function handleElementAdd(ws: Client, room: RoomState, rawMsg: Record<string, unknown>) {
  const msg = parseElementAdd(rawMsg);
  if (!msg) {
    sendError(ws, "invalid_message", "invalid element:add payload");
    return;
  }
  const existing = room.elementsById.get(msg.el.id);
  if (!existing && room.elementsById.size >= MAX_ELEMENTS_PER_ROOM) {
    sendError(ws, "elements_limit_reached", "room element limit reached");
    return;
  }
  if (existing?.ownerId && existing.ownerId !== ws.meta?.id) {
    sendError(ws, "forbidden", "cannot overwrite element owned by another client");
    return;
  }
  const ownerBound: Element = { ...msg.el, ownerId: existing?.ownerId ?? ws.meta?.id };
  insertElement(room, ownerBound);
  room.version += 1;
  broadcast(room, { t: "element:add", el: ownerBound, v: room.version }, { except: ws });
}

function handleElementUpdate(ws: Client, room: RoomState, rawMsg: Record<string, unknown>) {
  const msg = parseElementUpdate(rawMsg);
  if (!msg) {
    sendError(ws, "invalid_message", "invalid element:update payload");
    return;
  }
  const existing = room.elementsById.get(msg.el.id);
  if (existing?.ownerId && existing.ownerId !== ws.meta?.id) {
    sendError(ws, "forbidden", "cannot update element owned by another client");
    return;
  }
  if (!existing && room.elementsById.size >= MAX_ELEMENTS_PER_ROOM) {
    sendError(ws, "elements_limit_reached", "room element limit reached");
    return;
  }
  const ownerBound: Element = { ...msg.el, ownerId: existing?.ownerId ?? ws.meta?.id };
  insertElement(room, ownerBound);
  room.version += 1;
  broadcast(room, { t: "element:update", el: ownerBound, v: room.version }, { except: ws });
}

function handleElementRemove(ws: Client, room: RoomState, rawMsg: Record<string, unknown>) {
  const msg = parseElementRemove(rawMsg);
  if (!msg) {
    sendError(ws, "invalid_message", "invalid element:remove payload");
    return;
  }
  const existing = room.elementsById.get(msg.id);
  if (!existing) return;
  if (existing.ownerId && existing.ownerId !== ws.meta?.id) {
    sendError(ws, "forbidden", "cannot remove element owned by another client");
    return;
  }
  removeElement(room, msg.id);
  room.version += 1;
  broadcast(room, { t: "element:remove", id: msg.id, v: room.version }, { except: ws });
}

function handleCursor(ws: Client, room: RoomState, rawMsg: Record<string, unknown>) {
  const msg = parseCursor(rawMsg);
  if (!msg) {
    sendError(ws, "invalid_message", "invalid cursor payload");
    return;
  }
  const clientId = ws.meta?.id;
  if (!clientId) return;
  room.cursors.set(clientId, { p: msg.p, updatedAt: Date.now() });
  broadcast(room, { t: "cursor", clientId, p: msg.p }, { except: ws });
}

function handleStrokeStart(ws: Client, room: RoomState, rawMsg: Record<string, unknown>) {
  const msg = parseStrokeStart(rawMsg);
  if (!msg) {
    sendError(ws, "invalid_message", "invalid stroke:start payload");
    return;
  }
  broadcast(room, { t: "stroke:start", id: msg.id, p: msg.p, style: msg.style }, { except: ws });
}

function handleStrokePoint(ws: Client, room: RoomState, rawMsg: Record<string, unknown>) {
  const msg = parseStrokePoint(rawMsg);
  if (!msg) {
    sendError(ws, "invalid_message", "invalid stroke:point payload");
    return;
  }
  broadcast(room, { t: "stroke:point", id: msg.id, p: msg.p }, { except: ws });
}

function handleStrokeEnd(ws: Client, room: RoomState, rawMsg: Record<string, unknown>) {
  const msg = parseStrokeEnd(rawMsg);
  if (!msg) {
    sendError(ws, "invalid_message", "invalid stroke:end payload");
    return;
  }
  broadcast(room, { t: "stroke:end", id: msg.id }, { except: ws });
}

function handleShapeStart(ws: Client, room: RoomState, rawMsg: Record<string, unknown>) {
  const msg = parseShapeStart(rawMsg);
  if (!msg) {
    sendError(ws, "invalid_message", "invalid shape:start payload");
    return;
  }
  broadcast(room, { t: "shape:start", el: { ...msg.el, ownerId: ws.meta?.id } }, { except: ws });
}

function handleShapeUpdate(ws: Client, room: RoomState, rawMsg: Record<string, unknown>) {
  const msg = parseShapeUpdate(rawMsg);
  if (!msg) {
    sendError(ws, "invalid_message", "invalid shape:update payload");
    return;
  }
  broadcast(room, { t: "shape:update", el: { ...msg.el, ownerId: ws.meta?.id } }, { except: ws });
}

function handleShapeEnd(ws: Client, room: RoomState, rawMsg: Record<string, unknown>) {
  const msg = parseShapeEnd(rawMsg);
  if (!msg) {
    sendError(ws, "invalid_message", "invalid shape:end payload");
    return;
  }
  broadcast(room, { t: "shape:end", id: msg.id }, { except: ws });
}

function cleanupStaleCursors() {
  const now = Date.now();
  for (const [roomId, room] of rooms) {
    let removed = 0;
    for (const [clientId, cursor] of room.cursors) {
      if (now - cursor.updatedAt <= CURSOR_STALE_MS) continue;
      room.cursors.delete(clientId);
      removed += 1;
      broadcast(room, { t: "cursor:leave", clientId }, { includeSender: true });
    }
    if (removed > 0) {
      logInfo(`[ws] stale cursors cleaned room=${roomId} removed=${removed}`);
    }
  }
}

wss.on("connection", (ws: Client) => {
  ws.isAlive = true;
  ws.on("pong", () => {
    ws.isAlive = true;
  });

  ws.on("message", (raw: RawData) => {
    const payload = rawToString(raw);
    if (!payload) {
      sendError(ws, "invalid_message", "unsupported raw payload");
      return;
    }
    if (Buffer.byteLength(payload, "utf8") > MAX_MSG_BYTES) {
      ws.close(1009, "message too large");
      return;
    }
    const parsed = safeJsonParse(payload);
    if (!isRecord(parsed) || typeof parsed.t !== "string") {
      sendError(ws, "bad_json", "invalid JSON payload");
      return;
    }

    if (SERVER_ONLY_TYPES.has(parsed.t)) {
      sendError(ws, "unsupported_type", `message type ${parsed.t} is server-only`);
      return;
    }

    if (parsed.t === "pong") {
      ws.isAlive = true;
      return;
    }
    if (parsed.t === "ping") {
      const msg = parsePing(parsed);
      if (!msg) {
        sendError(ws, "invalid_message", "invalid ping payload");
        return;
      }
      send(ws, { t: "pong", ts: msg.ts ?? Date.now() });
      return;
    }
    if (parsed.t === "join") {
      handleJoin(ws, parsed);
      return;
    }

    const room = requireJoined(ws);
    if (!room) return;

    switch (parsed.t) {
      case "element:add":
        handleElementAdd(ws, room, parsed);
        return;
      case "element:update":
        handleElementUpdate(ws, room, parsed);
        return;
      case "element:remove":
        handleElementRemove(ws, room, parsed);
        return;
      case "cursor":
        handleCursor(ws, room, parsed);
        return;
      case "stroke:start":
        handleStrokeStart(ws, room, parsed);
        return;
      case "stroke:point":
        handleStrokePoint(ws, room, parsed);
        return;
      case "stroke:end":
        handleStrokeEnd(ws, room, parsed);
        return;
      case "shape:start":
        handleShapeStart(ws, room, parsed);
        return;
      case "shape:update":
        handleShapeUpdate(ws, room, parsed);
        return;
      case "shape:end":
        handleShapeEnd(ws, room, parsed);
        return;
      default:
        sendError(ws, "unsupported_type", `unsupported message type: ${parsed.t}`);
        return;
    }
  });

  ws.on("close", () => {
    leaveCurrentRoom(ws, "socket_close");
  });

  ws.on("error", (err) => {
    logWarn(`[ws] socket error: ${(err as Error).message}`, "socket_error");
  });
});

function startTimers() {
  if (!heartbeatTimer) {
    heartbeatTimer = setInterval(() => {
      for (const wsClient of wss.clients) {
        const client = wsClient as Client;
        if (!client.isAlive) {
          logInfo("[ws] terminating stale connection");
          client.terminate();
          continue;
        }
        client.isAlive = false;
        try {
          client.ping();
        } catch (err) {
          logWarn(`[ws] ping failed: ${(err as Error).message}`, "ping_failed");
        }
      }
    }, SERVER_PING_INTERVAL_MS);
  }
  if (!cursorSweepTimer) {
    cursorSweepTimer = setInterval(cleanupStaleCursors, CURSOR_SWEEP_MS);
  }
}

function stopTimers() {
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
  if (cursorSweepTimer) {
    clearInterval(cursorSweepTimer);
    cursorSweepTimer = null;
  }
}

wss.on("close", () => {
  stopTimers();
});

export async function startServer(port = PORT, host = HOST): Promise<number> {
  if (listening) {
    const addr = httpServer.address();
    return typeof addr === "object" && addr ? addr.port : port;
  }
  startTimers();
  await new Promise<void>((resolve, reject) => {
    httpServer.once("error", reject);
    httpServer.listen(port, host, () => {
      httpServer.off("error", reject);
      resolve();
    });
  });
  listening = true;
  const addr = httpServer.address();
  const activePort = typeof addr === "object" && addr ? addr.port : port;
  logInfo(
    `[ws] config env=${NODE_ENV} debug=${DEBUG ? "1" : "0"} maxMsg=${MAX_MSG_BYTES} maxRooms=${MAX_ROOMS} maxPerRoom=${MAX_CLIENTS_PER_ROOM} maxElements=${MAX_ELEMENTS_PER_ROOM} bufferedSoft=${MAX_BUFFERED_SOFT_BYTES} bufferedHard=${MAX_BUFFERED_HARD_BYTES} metricsWindow=${METRICS_WINDOW_SIZE}`,
  );
  console.log(`[ws] listening host=${host} port=${activePort} env=${NODE_ENV}`);
  console.log("[ws] expected public URL: wss://<render-service>.onrender.com");
  return activePort;
}

export async function stopServer(): Promise<void> {
  if (!listening) {
    stopTimers();
    return;
  }
  await new Promise<void>((resolve) => {
    wss.close(() => resolve());
  });
  await new Promise<void>((resolve) => {
    httpServer.close(() => resolve());
  });
  listening = false;
  stopTimers();
  rooms.clear();
}

const isMain = process.argv[1] ? import.meta.url === pathToFileURL(process.argv[1]).href : false;
if (isMain) {
  startServer().catch((err) => {
    console.error(`[ws] failed to start: ${(err as Error).message}`);
    process.exitCode = 1;
  });
}
