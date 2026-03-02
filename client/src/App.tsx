import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import "./App.css";
import { debugLog, getWsUrl } from "./lib/ws";

type Brush = "pencil" | "marker" | "highlighter" | "airbrush";
type Tool = "pen" | "eraser" | "select" | "shape";

type Point = { x: number; y: number };

type StrokeStyle = {
  tool: "pen" | "eraser";
  brush: Brush;
  color: string;
  size: number; 
};

type ShapeType = "rect" | "ellipse" | "triangle" | "star" | "line" | "pentagon" | "tree" | "umbrella" | "heart";

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


type WSMsg =
  | { t: "join"; room: string; clientId: string }
  | { t: "ping"; ts: number }
  | { t: "pong"; ts: number }
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

function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

function isFiniteNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

function isFinitePoint(value: unknown): value is Point {
  return isRecord(value) && isFiniteNumber(value.x) && isFiniteNumber(value.y);
}

function isStrokeStyle(value: unknown): value is StrokeStyle {
  if (!isRecord(value)) return false;
  if (value.tool !== "pen" && value.tool !== "eraser") return false;
  if (value.brush !== "pencil" && value.brush !== "marker" && value.brush !== "highlighter" && value.brush !== "airbrush")
    return false;
  if (typeof value.color !== "string" || value.color.length === 0) return false;
  if (!isFiniteNumber(value.size) || value.size <= 0 || value.size > 512) return false;
  return true;
}

function parseElement(value: unknown): Element | null {
  if (!isRecord(value) || typeof value.kind !== "string" || typeof value.id !== "string") return null;
  if (value.kind === "stroke") {
    if (!Array.isArray(value.points) || !isStrokeStyle(value.style)) return null;
    const points: Point[] = [];
    for (const p of value.points) {
      if (!isFinitePoint(p)) return null;
      points.push({ x: p.x, y: p.y });
    }
    return {
      id: value.id,
      kind: "stroke",
      ownerId: typeof value.ownerId === "string" ? value.ownerId : undefined,
      points,
      style: value.style,
    };
  }
  if (value.kind === "shape") {
    if (
      (value.shape !== "rect" &&
        value.shape !== "ellipse" &&
        value.shape !== "triangle" &&
        value.shape !== "star" &&
        value.shape !== "line" &&
        value.shape !== "pentagon" &&
        value.shape !== "tree" &&
        value.shape !== "umbrella" &&
        value.shape !== "heart") ||
      !isFiniteNumber(value.x1) ||
      !isFiniteNumber(value.y1) ||
      !isFiniteNumber(value.x2) ||
      !isFiniteNumber(value.y2) ||
      typeof value.color !== "string" ||
      !isFiniteNumber(value.size)
    ) {
      return null;
    }
    return {
      id: value.id,
      kind: "shape",
      ownerId: typeof value.ownerId === "string" ? value.ownerId : undefined,
      shape: value.shape,
      x1: value.x1,
      y1: value.y1,
      x2: value.x2,
      y2: value.y2,
      color: value.color,
      size: value.size,
    };
  }
  return null;
}

function parseIncomingMessage(raw: unknown): WSMsg | null {
  if (typeof raw !== "string") return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isRecord(parsed) || typeof parsed.t !== "string") return null;

  switch (parsed.t) {
    case "ping":
    case "pong":
      return isFiniteNumber(parsed.ts) ? { t: parsed.t, ts: parsed.ts } : null;
    case "snapshot":
      if (!Array.isArray(parsed.elements)) return null;
      return {
        t: "snapshot",
        elements: parsed.elements.map(parseElement).filter((el): el is Element => !!el),
      };
    case "presence":
      return isFiniteNumber(parsed.count) ? { t: "presence", count: parsed.count } : null;
    case "cursor":
      return typeof parsed.clientId === "string" && isFinitePoint(parsed.p)
        ? { t: "cursor", clientId: parsed.clientId, p: parsed.p }
        : null;
    case "cursor:leave":
      return typeof parsed.clientId === "string" ? { t: "cursor:leave", clientId: parsed.clientId } : null;
    case "element:add":
    case "element:update": {
      const el = parseElement(parsed.el);
      return el ? { t: parsed.t, el } : null;
    }
    case "element:remove":
      return typeof parsed.id === "string" ? { t: "element:remove", id: parsed.id } : null;
    case "stroke:start":
      return typeof parsed.id === "string" && isFinitePoint(parsed.p) && isStrokeStyle(parsed.style)
        ? { t: "stroke:start", id: parsed.id, p: parsed.p, style: parsed.style }
        : null;
    case "stroke:point":
      return typeof parsed.id === "string" && isFinitePoint(parsed.p)
        ? { t: "stroke:point", id: parsed.id, p: parsed.p }
        : null;
    case "stroke:end":
      return typeof parsed.id === "string" ? { t: "stroke:end", id: parsed.id } : null;
    case "shape:start":
    case "shape:update": {
      const shape = parseElement(parsed.el);
      return shape && shape.kind === "shape" ? { t: parsed.t, el: shape } : null;
    }
    case "shape:end":
      return typeof parsed.id === "string" ? { t: "shape:end", id: parsed.id } : null;
    default:
      return null;
  }
}

function upsertElement(scene: Element[], el: Element): Element[] {
  const idx = scene.findIndex((e) => e.id === el.id);
  if (idx === -1) return [...scene, el];
  const next = scene.slice();
  next[idx] = el;
  return next;
}

function clamp(n: number, min: number, max: number) {
  return Math.max(min, Math.min(max, n));
}

function makeId() {
  return Math.random().toString(16).slice(2) + Date.now().toString(16);
}

function hashColor(input: string): string {
  
  let h = 0;
  for (let i = 0; i < input.length; i++) h = (h * 31 + input.charCodeAt(i)) >>> 0;
  const hue = h % 360;
  return `hsl(${hue} 80% 60%)`;
}



function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function getCanvasPoint(e: PointerEvent, canvas: HTMLCanvasElement): Point {
  const rect = canvas.getBoundingClientRect();
  return {
    x: e.clientX - rect.left,
    y: e.clientY - rect.top,
  };
}

function dist(a: Point, b: Point) {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return Math.sqrt(dx * dx + dy * dy);
}

function normalizeRect(x1: number, y1: number, x2: number, y2: number) {
  const left = Math.min(x1, x2);
  const top = Math.min(y1, y2);
  const right = Math.max(x1, x2);
  const bottom = Math.max(y1, y2);
  return { left, top, right, bottom, w: right - left, h: bottom - top };
}


function hitTestShape(shape: ShapeElement, p: Point): boolean {
  const pad = Math.max(6, shape.size);

  
  if (shape.shape === "line") {
    const x1 = shape.x1;
    const y1 = shape.y1;
    const x2 = shape.x2;
    const y2 = shape.y2;
    const px = p.x;
    const py = p.y;

    const dx = x2 - x1;
    const dy = y2 - y1;
    const len2 = dx * dx + dy * dy;

    
    if (len2 < 1e-6) {
      const ddx = px - x1;
      const ddy = py - y1;
      return ddx * ddx + ddy * ddy <= (pad + 2) * (pad + 2);
    }

    let t = ((px - x1) * dx + (py - y1) * dy) / len2;
    t = Math.max(0, Math.min(1, t));
    const cx = x1 + t * dx;
    const cy = y1 + t * dy;
    const ddx = px - cx;
    const ddy = py - cy;
    return ddx * ddx + ddy * ddy <= (pad + 2) * (pad + 2);
  }

  const r = normalizeRect(shape.x1, shape.y1, shape.x2, shape.y2);
  
  const x = p.x;
  const y = p.y;

  
  if (shape.shape !== "ellipse") {
    return x >= r.left - pad && x <= r.right + pad && y >= r.top - pad && y <= r.bottom + pad;
  }

  
  const cx = r.left + r.w / 2;
  const cy = r.top + r.h / 2;
  const rx = Math.max(1, r.w / 2) + pad;
  const ry = Math.max(1, r.h / 2) + pad;
  const nx = (x - cx) / rx;
  const ny = (y - cy) / ry;
  return nx * nx + ny * ny <= 1;
}


function IconButton({
  active,
  disabled,
  title,
  onClick,
  children,
}: {
  active?: boolean;
  disabled?: boolean;
  title: string;
  onClick?: () => void;
  children: ReactNode;
}) {
  return (
    <button
      className={"iconBtn" + (active ? " active" : "")}
      onClick={onClick}
      disabled={disabled}
      title={title}
      type="button"
    >
      {children}
    </button>
  );
}

function Svg({ children }: { children: ReactNode }) {
  return (
    <svg
      width="28"
      height="28"
      viewBox="0 0 28 28"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
    >
      {children}
    </svg>
  );
}

function IcPointer() {
  return (
    <Svg>
      <path
        d="M8 4.5L18.5 15l-5.2.3 2.2 6-2.2.9-2.3-6-3.8 3.6V4.5Z"
        fill="rgba(255,255,255,.92)"
        stroke="rgba(255,255,255,.22)"
      />
    </Svg>
  );
}

function IcPencil() {
  return (
    <Svg>
      <path
        d="M6.5 20.8l.7-3.5L17.7 6.9c.7-.7 1.8-.7 2.5 0l.9.9c.7.7.7 1.8 0 2.5L10.7 20.7l-4.2.1Z"
        fill="rgba(255,255,255,.9)"
      />
      <path d="M6.7 20.8l3.6-.6" stroke="rgba(0,0,0,.35)" strokeWidth="2" strokeLinecap="round" />
    </Svg>
  );
}

function IcEraser() {
  return (
    <Svg>
      <path
        d="M6.8 17.6 15.9 8.5c.7-.7 1.8-.7 2.5 0l2.2 2.2c.7.7.7 1.8 0 2.5l-6.6 6.6H9.8l-3-2.2Z"
        fill="rgba(255,255,255,.88)"
      />
      <path d="M9.8 19.8h11" stroke="rgba(255,255,255,.35)" strokeWidth="2" strokeLinecap="round" />
    </Svg>
  );
}

function IcRect() {
  return (
    <Svg>
      <rect x="6" y="7" width="16" height="14" rx="3" stroke="rgba(255,255,255,.9)" strokeWidth="2" />
    </Svg>
  );
}

function IcEllipse() {
  return (
    <Svg>
      <ellipse cx="14" cy="14" rx="8" ry="6.5" stroke="rgba(255,255,255,.9)" strokeWidth="2" />
    </Svg>
  );
}

function IcTriangle() {
  return (
    <Svg>
      <path
        d="M14 6.5 22 21H6L14 6.5Z"
        stroke="rgba(255,255,255,.9)"
        strokeWidth="2"
        strokeLinejoin="round"
      />
    </Svg>
  );
}

function IcStar() {
  return (
    <Svg>
      <path
        d="M14 6.3l2.3 5.1 5.6.6-4.2 3.6 1.2 5.4-4.9-2.8-4.9 2.8 1.2-5.4-4.2-3.6 5.6-.6L14 6.3Z"
        stroke="rgba(255,255,255,.9)"
        strokeWidth="2"
        strokeLinejoin="round"
      />
    </Svg>
  );
}

function IcLine() {
  return (
    <Svg>
      <path d="M6 20L22 8" stroke="rgba(255,255,255,.9)" strokeWidth="2" strokeLinecap="round" />
      <circle cx="6" cy="20" r="1.5" fill="rgba(255,255,255,.9)" />
      <circle cx="22" cy="8" r="1.5" fill="rgba(255,255,255,.9)" />
    </Svg>
  );
}

function IcPentagon() {
  return (
    <Svg>
      <path
        d="M14 5.5l7 5.1-2.7 8.2H9.7L7 10.6l7-5.1Z"
        stroke="rgba(255,255,255,.9)"
        strokeWidth="2"
        strokeLinejoin="round"
      />
    </Svg>
  );
}

function IcTree() {
  return (
    <Svg>
      <path
        d="M14 5l7 10h-4l4 6H7l4-6H7l7-10Z"
        stroke="rgba(255,255,255,.9)"
        strokeWidth="2"
        strokeLinejoin="round"
      />
      <path d="M12.2 21h3.6" stroke="rgba(255,255,255,.9)" strokeWidth="2" strokeLinecap="round" />
    </Svg>
  );
}

function IcUmbrella() {
  return (
    <Svg>
      <path
        d="M6 13a8 8 0 0 1 16 0"
        stroke="rgba(255,255,255,.9)"
        strokeWidth="2"
        strokeLinecap="round"
      />
      <path d="M14 13v7" stroke="rgba(255,255,255,.9)" strokeWidth="2" strokeLinecap="round" />
      <path
        d="M14 20c0 1.8 2.5 1.8 2.5 0"
        stroke="rgba(255,255,255,.9)"
        strokeWidth="2"
        strokeLinecap="round"
      />
    </Svg>
  );
}

function IcHeart() {
  return (
    <Svg>
      <path
        d="M14 21s-7-4.6-7-9.4C7 8.7 9.1 7 11.2 7c1.4 0 2.4.7 2.8 1.3.4-.6 1.4-1.3 2.8-1.3C19 7 21 8.7 21 11.6 21 16.4 14 21 14 21Z"
        stroke="rgba(255,255,255,.9)"
        strokeWidth="2"
        strokeLinejoin="round"
      />
    </Svg>
  );
}


function IcUndo() {
  return (
    <Svg>
      <path
        d="M11 8.3 6.8 12.5 11 16.7"
        stroke="rgba(255,255,255,.92)"
        strokeWidth="2.2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M7 12.5h9.2c2.7 0 4.8 2 4.8 4.6 0 2.4-1.8 4.2-4.2 4.2"
        stroke="rgba(255,255,255,.6)"
        strokeWidth="2.2"
        strokeLinecap="round"
      />
    </Svg>
  );
}

function IcRedo() {
  return (
    <Svg>
      <path
        d="M17 8.3 21.2 12.5 17 16.7"
        stroke="rgba(255,255,255,.92)"
        strokeWidth="2.2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M21 12.5H11.8C9.1 12.5 7 14.5 7 17.1c0 2.4 1.8 4.2 4.2 4.2"
        stroke="rgba(255,255,255,.6)"
        strokeWidth="2.2"
        strokeLinecap="round"
      />
    </Svg>
  );
}

function IcTrash() {
  return (
    <Svg>
      <path
        d="M9.2 9.5h9.6l-.9 12.2c-.1 1-1 1.8-2 1.8h-3.8c-1 0-1.9-.8-2-1.8L9.2 9.5Z"
        fill="rgba(255,255,255,.85)"
      />
      <path d="M8 9.5h12" stroke="rgba(0,0,0,.25)" strokeWidth="2" strokeLinecap="round" />
      <path d="M11 8.2c.4-1 .9-1.7 2.1-1.7h1.8c1.2 0 1.7.7 2.1 1.7" stroke="rgba(255,255,255,.5)" strokeWidth="2" strokeLinecap="round" />
    </Svg>
  );
}

function IcClear() {
  return (
    <Svg>
      <path
        d="M6.5 19.5h15"
        stroke="rgba(255,255,255,.65)"
        strokeWidth="2.2"
        strokeLinecap="round"
      />
      <path
        d="M10.4 18.8 18.8 10.4c.7-.7.7-1.8 0-2.5l-.7-.7c-.7-.7-1.8-.7-2.5 0L7.2 15.6"
        stroke="rgba(255,255,255,.92)"
        strokeWidth="2.2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M19.4 13.2l1.2.3-.9 1 .2 1.2-1.1-.6-1.1.6.2-1.2-.9-1 1.2-.3.6-1.1.6 1.1Z"
        fill="rgba(255,255,255,.75)"
      />
    </Svg>
  );
}

function IcDownload() {
  return (
    <Svg>
      <path
        d="M14 5.8v10.4"
        stroke="rgba(255,255,255,.9)"
        strokeWidth="2.2"
        strokeLinecap="round"
      />
      <path
        d="M10.2 12.8 14 16.7l3.8-3.9"
        stroke="rgba(255,255,255,.9)"
        strokeWidth="2.2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path d="M7.8 20.8h12.4" stroke="rgba(255,255,255,.55)" strokeWidth="2.2" strokeLinecap="round" />
    </Svg>
  );
}

export default function App() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const sizeRef = useRef({ w: 1, h: 1, dpr: 1 });

  const [tool, setTool] = useState<Tool>("pen");
  const [shapeType, setShapeType] = useState<ShapeType>("rect");
  const [shapeMenuOpen, setShapeMenuOpen] = useState(false);
  const [mobileNavHidden, setMobileNavHidden] = useState<boolean>(false);
  const [isCompactUI, setIsCompactUI] = useState<boolean>(() =>
    typeof window !== "undefined" ? window.matchMedia("(max-width: 920px)").matches : false,
  );
  const shapeLongPressTimerRef = useRef<number | null>(null);
  const shapeLongPressTriggeredRef = useRef<boolean>(false);
  const shapeTypeRef = useRef<ShapeType>("rect");
  useEffect(() => {
    shapeTypeRef.current = shapeType;
  }, [shapeType]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const media = window.matchMedia("(max-width: 920px)");
    const onChange = (e: MediaQueryListEvent) => setIsCompactUI(e.matches);
    setIsCompactUI(media.matches);
    media.addEventListener("change", onChange);
    return () => media.removeEventListener("change", onChange);
  }, []);

  useEffect(() => {
    function onDocDown(e: PointerEvent) {
      if (!shapeMenuOpen) return;
      const t = e.target as HTMLElement | null;
      if (!t) return;
      if (t.closest?.('[data-shape-menu]') || t.closest?.('[data-shape-button]')) return;
      setShapeMenuOpen(false);
    }
    document.addEventListener("pointerdown", onDocDown);
    return () => document.removeEventListener("pointerdown", onDocDown);
  }, [shapeMenuOpen]);

  useEffect(() => {
    if (tool !== "shape") setShapeMenuOpen(false);
  }, [tool]);

  useEffect(() => {
    if (mobileNavHidden) setShapeMenuOpen(false);
  }, [mobileNavHidden]);

  useEffect(() => {
    return () => {
      if (shapeLongPressTimerRef.current !== null) {
        window.clearTimeout(shapeLongPressTimerRef.current);
        shapeLongPressTimerRef.current = null;
      }
    };
  }, []);

  function selectShapeType(type: ShapeType) {
    shapeTypeRef.current = type;
    setShapeType(type);
    setShapeMenuOpen(false);
  }

  function clearShapeLongPressTimer() {
    if (shapeLongPressTimerRef.current !== null) {
      window.clearTimeout(shapeLongPressTimerRef.current);
      shapeLongPressTimerRef.current = null;
    }
  }

  function handleShapeButtonPointerDown() {
    if (!isCompactUI) return;
    clearShapeLongPressTimer();
    shapeLongPressTriggeredRef.current = false;
    shapeLongPressTimerRef.current = window.setTimeout(() => {
      shapeLongPressTriggeredRef.current = true;
      setTool("shape");
      setShapeMenuOpen(true);
    }, 280);
  }

  function handleShapeButtonPointerEnd() {
    if (!isCompactUI) return;
    clearShapeLongPressTimer();
  }

  function handleShapeButtonClick() {
    if (isCompactUI) {
      if (shapeLongPressTriggeredRef.current) {
        shapeLongPressTriggeredRef.current = false;
        return;
      }
      setTool("shape");
      setShapeMenuOpen((o) => !o);
      return;
    }
    setTool("shape");
    setShapeMenuOpen((o) => !o);
  }


  const [brush, setBrush] = useState<Brush>("pencil");
  const [color, setColor] = useState<string>("#111111");
  const [size, setSize] = useState<number>(6);
  
  const strokeStyle: StrokeStyle = useMemo(
    () => ({ tool: tool === "eraser" ? "eraser" : "pen", brush, color, size }),
    [tool, brush, color, size]
  );

  const [elements, setElements] = useState<Element[]>([]);
  const elementsRef = useRef<Element[]>([]);
  const [redoStack, setRedoStack] = useState<Element[]>([]);
  const [history, setHistory] = useState<Element[][]>([]);
  const [historyIndex, setHistoryIndex] = useState<number>(-1);

  const [selectedId, setSelectedId] = useState<string | null>(null);

  
  const [leftPinned, setLeftPinned] = useState<boolean>(true);
  const [leftPeek, setLeftPeek] = useState<boolean>(false);
  const [leftInteracting, setLeftInteracting] = useState<boolean>(false);

  const activeStrokeRef = useRef<StrokeElement | null>(null);
  const activeShapeRef = useRef<ShapeElement | null>(null);

  
  const [roomId, setRoomId] = useState<string>(() => {
    try {
      const qs = new URLSearchParams(window.location.search);
      return (qs.get("room") || "lobby").trim() || "lobby";
    } catch {
      return "lobby";
    }
  });
  const [wsStatus, setWsStatus] = useState<"disconnected" | "connecting" | "connected">("disconnected");
  const [presenceCount, setPresenceCount] = useState<number>(1);
  const wsRef = useRef<WebSocket | null>(null);
  const clientIdRef = useRef<string>(
    typeof globalThis.crypto?.randomUUID === "function" ? globalThis.crypto.randomUUID() : makeId()
  );
  const remoteLiveStrokesRef = useRef<Record<string, StrokeElement>>({});
  const remoteLiveShapesRef = useRef<Record<string, ShapeElement>>({});
  const remoteCursorsRef = useRef<Record<string, { p: Point; last: number }>>({});
  const cursorSendThrottleRef = useRef<number>(0);
  const reconnectAttemptRef = useRef(0);
  const reconnectTimerRef = useRef<number | null>(null);
  const heartbeatTimerRef = useRef<number | null>(null);
  const heartbeatTimeoutRef = useRef<number | null>(null);

  const localLiveStrokeRef = useRef<{ id: string; live: boolean } | null>(null);
  const localLiveShapeRef = useRef<string | null>(null);

  useEffect(() => {
    elementsRef.current = elements;
  }, [elements]);

  function wsSend(msg: WSMsg) {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      debugLog("drop outbound message while socket is not open", msg.t);
      return;
    }
    ws.send(JSON.stringify(msg));
  }

  
  useEffect(() => {
    try {
      const url = new URL(window.location.href);
      url.searchParams.set("room", roomId);
      window.history.replaceState({}, "", url);
    } catch {
      
    }
  }, [roomId]);

  
  useEffect(() => {
    remoteLiveStrokesRef.current = {};
    remoteLiveShapesRef.current = {};
    remoteCursorsRef.current = {};
    setPresenceCount(1);
    setRedoStack([]);

    let wsUrl = "";
    try {
      wsUrl = getWsUrl();
    } catch (err) {
      setWsStatus("disconnected");
      debugLog("unable to resolve websocket url", err);
      return;
    }
    const minBackoffMs = 600;
    const maxBackoffMs = 10_000;
    const heartbeatMs = 20_000;
    const pongTimeoutMs = 12_000;
    let stopped = false;

    function clearTimer(ref: { current: number | null }) {
      if (ref.current !== null) {
        window.clearTimeout(ref.current);
        ref.current = null;
      }
    }

    function clearHeartbeat() {
      if (heartbeatTimerRef.current !== null) {
        window.clearInterval(heartbeatTimerRef.current);
        heartbeatTimerRef.current = null;
      }
      clearTimer(heartbeatTimeoutRef);
    }

    function redrawCurrentScene() {
      requestRedraw(elementsRef.current, activeStrokeRef.current, activeShapeRef.current);
    }

    function startHeartbeat() {
      clearHeartbeat();
      heartbeatTimerRef.current = window.setInterval(() => {
        const ws = wsRef.current;
        if (!ws || ws.readyState !== WebSocket.OPEN) return;
        wsSend({ t: "ping", ts: Date.now() });
        clearTimer(heartbeatTimeoutRef);
        heartbeatTimeoutRef.current = window.setTimeout(() => {
          debugLog("heartbeat timed out, closing socket");
          try {
            ws.close(4000, "pong timeout");
          } catch {
            
          }
        }, pongTimeoutMs);
      }, heartbeatMs);
    }

    function scheduleReconnect() {
      if (stopped || reconnectTimerRef.current !== null) return;
      reconnectAttemptRef.current += 1;
      const exp = Math.min(maxBackoffMs, minBackoffMs * 2 ** (reconnectAttemptRef.current - 1));
      const jitter = Math.floor(Math.random() * 300);
      const delay = exp + jitter;
      debugLog("reconnect scheduled", { attempt: reconnectAttemptRef.current, delayMs: delay });
      reconnectTimerRef.current = window.setTimeout(() => {
        reconnectTimerRef.current = null;
        connect();
      }, delay);
    }

    function connect() {
      if (stopped) return;
      clearTimer(reconnectTimerRef);
      clearHeartbeat();

      setWsStatus("connecting");
      debugLog("connecting", { url: wsUrl, roomId });
      const ws = new WebSocket(wsUrl);
      wsRef.current = ws;

      ws.onopen = () => {
        if (stopped || wsRef.current !== ws) return;
        reconnectAttemptRef.current = 0;
        setWsStatus("connected");
        debugLog("open", { url: wsUrl, roomId });
        wsSend({ t: "join", room: roomId, clientId: clientIdRef.current });
        startHeartbeat();
      };

      ws.onmessage = (ev) => {
        if (stopped || wsRef.current !== ws) return;
        const data = parseIncomingMessage(ev.data);
        if (!data) {
          debugLog("ignored invalid inbound message");
          return;
        }

        switch (data.t) {
          case "ping":
            wsSend({ t: "pong", ts: data.ts });
            return;
          case "pong":
            clearTimer(heartbeatTimeoutRef);
            return;
          case "snapshot":
            if (!Array.isArray(data.elements)) return;
            setSelectedId(null);
            setElements(data.elements);
            setRedoStack([]);
            remoteCursorsRef.current = {};
            requestRedraw(data.elements, activeStrokeRef.current, activeShapeRef.current);
            return;
          case "presence":
            if (typeof data.count === "number" && Number.isFinite(data.count)) {
              setPresenceCount(Math.max(1, Math.floor(data.count)));
            }
            return;
          case "cursor":
            if (data.clientId === clientIdRef.current || !isFinitePoint(data.p)) return;
            remoteCursorsRef.current[data.clientId] = { p: data.p, last: Date.now() };
            redrawCurrentScene();
            return;
          case "cursor:leave":
            delete remoteCursorsRef.current[data.clientId];
            redrawCurrentScene();
            return;
          case "element:remove": {
            const id = data.id;
            if (!id) return;
            delete remoteLiveStrokesRef.current[id];
            delete remoteLiveShapesRef.current[id];
            setElements((prev) => {
              const next = prev.filter((e) => e.id !== id);
              requestRedraw(next, activeStrokeRef.current, activeShapeRef.current);
              return next;
            });
            setRedoStack((prev) => prev.filter((e) => e.id !== id));
            return;
          }
          case "element:add":
          case "element:update": {
            const el = data.el;
            if (!el || typeof el.id !== "string") return;
            delete remoteLiveStrokesRef.current[el.id];
            delete remoteLiveShapesRef.current[el.id];
            setElements((prev) => {
              const next = upsertElement(prev, el);
              requestRedraw(next, activeStrokeRef.current, activeShapeRef.current);
              return next;
            });
            return;
          }
          case "stroke:start":
            if (!data.id || !isFinitePoint(data.p)) return;
            remoteLiveStrokesRef.current[data.id] = {
              id: data.id,
              kind: "stroke",
              points: [data.p],
              style: data.style,
            };
            redrawCurrentScene();
            return;
          case "stroke:point": {
            if (!data.id || !isFinitePoint(data.p)) return;
            const st = remoteLiveStrokesRef.current[data.id];
            if (!st) return;
            st.points.push(data.p);
            redrawCurrentScene();
            return;
          }
          case "stroke:end":
            delete remoteLiveStrokesRef.current[data.id];
            redrawCurrentScene();
            return;
          case "shape:start":
          case "shape:update":
            if (!data.el?.id) return;
            remoteLiveShapesRef.current[data.el.id] = data.el;
            redrawCurrentScene();
            return;
          case "shape:end":
            delete remoteLiveShapesRef.current[data.id];
            redrawCurrentScene();
            return;
          default:
            return;
        }
      };

      ws.onerror = (ev) => {
        if (stopped || wsRef.current !== ws) return;
        debugLog("error", ev);
      };

      ws.onclose = (ev) => {
        if (wsRef.current === ws) wsRef.current = null;
        clearHeartbeat();
        setWsStatus("disconnected");
        debugLog("close", { code: ev.code, reason: ev.reason });
        if (!stopped) scheduleReconnect();
      };
    }

    connect();

    return () => {
      stopped = true;
      clearTimer(reconnectTimerRef);
      clearHeartbeat();
      reconnectAttemptRef.current = 0;
      setWsStatus("disconnected");
      try {
        wsRef.current?.close(1000, "room changed");
      } catch {
        
      }
      wsRef.current = null;
    };
  }, [roomId]);
  const dragRef = useRef<{
    mode: "none" | "move";
    id: string;
    start: Point;
    orig: { x1: number; y1: number; x2: number; y2: number };
  }>({ mode: "none", id: "", start: { x: 0, y: 0 }, orig: { x1: 0, y1: 0, x2: 0, y2: 0 } });

  const rafRef = useRef<number | null>(null);

  
  const STORAGE_KEY = "whiteboard:vector:v1";

function persistScene(scene: Element[]) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ scene }));
  } catch {
    
  }
}


  function deepCloneScene(scene: Element[]): Element[] {
    
    const sc = (globalThis as { structuredClone?: <T>(value: T) => T }).structuredClone;
    if (typeof sc === "function") return sc(scene);
    return JSON.parse(JSON.stringify(scene)) as Element[];
  }

  function pushHistory(nextScene: Element[]) {
    const snapshot = deepCloneScene(nextScene);
    setHistory((prev) => {
      const base = historyIndex >= 0 ? prev.slice(0, historyIndex + 1) : [];
      base.push(snapshot);
      return base;
    });
    setHistoryIndex(() => {
      const baseLen = historyIndex >= 0 ? history.slice(0, historyIndex + 1).length : 0;
      return baseLen; 
    });
    
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ scene: snapshot, historyIndex: (historyIndex >= 0 ? historyIndex + 1 : 0) }));
    } catch {
      
    }
  }

  useEffect(() => {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return;
    try {
      const parsed = JSON.parse(raw) as { scene?: Element[]; historyIndex?: number };
      if (Array.isArray(parsed.scene)) {
        setElements(parsed.scene);
        
        setHistory([deepCloneScene(parsed.scene)]);
        setHistoryIndex(0);
        setSelectedId(null);
        requestRedraw(parsed.scene, null, null);
      }
    } catch {
      
    }
    
  }, []);

  
  useEffect(() => {
    const canvas = canvasRef.current;
    const container = containerRef.current;
    if (!canvas || !container) return;

    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const resize = () => {
      const dpr = window.devicePixelRatio || 1;
      const { width, height } = container.getBoundingClientRect();
      const w = Math.max(1, Math.floor(width));
      const h = Math.max(1, Math.floor(height));

      canvas.style.width = `${w}px`;
      canvas.style.height = `${h}px`;
      canvas.width = Math.max(1, Math.floor(w * dpr));
      canvas.height = Math.max(1, Math.floor(h * dpr));

      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.scale(dpr, dpr);
      sizeRef.current = { w, h, dpr };
      requestRedraw(elements, activeStrokeRef.current, activeShapeRef.current);
    };

    const ro = new ResizeObserver(() => resize());
    ro.observe(container);
    resize();
    return () => ro.disconnect();
    
  }, [elements]);

  function getCtx(): CanvasRenderingContext2D | null {
    const canvas = canvasRef.current;
    return canvas ? canvas.getContext("2d") : null;
  }

  
  function applyStrokeStyle(ctx: CanvasRenderingContext2D, s: StrokeStyle) {
    ctx.lineJoin = "round";
    ctx.lineCap = "round";
    ctx.globalAlpha = 1;

    if (s.tool === "eraser") {
      ctx.globalCompositeOperation = "destination-out";
      ctx.strokeStyle = "rgba(0,0,0,1)";
      ctx.lineWidth = s.size * 1.25;
      return;
    }

    ctx.strokeStyle = s.color;
    switch (s.brush) {
      case "pencil":
        ctx.globalCompositeOperation = "source-over";
        ctx.globalAlpha = 1;
        ctx.lineWidth = s.size;
        break;
      case "marker":
        ctx.globalCompositeOperation = "source-over";
        ctx.globalAlpha = 0.75;
        ctx.lineWidth = s.size * 1.35;
        break;
      case "highlighter":
        ctx.globalCompositeOperation = "multiply";
        ctx.globalAlpha = 0.28;
        ctx.lineWidth = s.size * 2.2;
        break;
      case "airbrush":
        ctx.globalCompositeOperation = "source-over";
        ctx.globalAlpha = 0.35;
        ctx.lineWidth = s.size;
        break;
    }
  }

  function drawStroke(ctx: CanvasRenderingContext2D, el: StrokeElement) {
    const pts = el.points;
    if (pts.length === 0) return;

    if (el.style.tool === "pen" && el.style.brush === "airbrush") {
      
      const dots = el.dots ?? [];
      ctx.save();
      ctx.globalCompositeOperation = "source-over";
      ctx.fillStyle = el.style.color;
      for (const d of dots) {
        ctx.globalAlpha = d.a;
        ctx.beginPath();
        ctx.arc(d.x, d.y, d.r, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.restore();
      return;
    }

    ctx.save();
    applyStrokeStyle(ctx, el.style);
    ctx.beginPath();
    ctx.moveTo(pts[0].x, pts[0].y);
    for (let i = 1; i < pts.length; i++) {
      ctx.lineTo(pts[i].x, pts[i].y);
    }
    ctx.stroke();
    ctx.restore();
  }

  function drawShape(ctx: CanvasRenderingContext2D, el: ShapeElement) {
    const r = normalizeRect(el.x1, el.y1, el.x2, el.y2);
    ctx.save();
    ctx.globalCompositeOperation = "source-over";
    ctx.strokeStyle = el.color;
    ctx.lineWidth = Math.max(1, el.size);
    ctx.lineJoin = "round";
    ctx.lineCap = "round";

    const cx = r.left + r.w / 2;
    const cy = r.top + r.h / 2;

    if (el.shape === "line") {
      ctx.beginPath();
      ctx.moveTo(el.x1, el.y1);
      ctx.lineTo(el.x2, el.y2);
      ctx.stroke();
      ctx.restore();
      return;
    }

    if (el.shape === "rect") {
      ctx.strokeRect(r.left, r.top, r.w, r.h);
      ctx.restore();
      return;
    }

    if (el.shape === "ellipse") {
      ctx.beginPath();
      ctx.ellipse(cx, cy, Math.max(1, r.w / 2), Math.max(1, r.h / 2), 0, 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();
      return;
    }

    if (el.shape === "triangle") {
      const x1 = r.left + r.w / 2;
      const y1 = r.top;
      const x2 = r.left;
      const y2 = r.bottom;
      const x3 = r.right;
      const y3 = r.bottom;
      ctx.beginPath();
      ctx.moveTo(x1, y1);
      ctx.lineTo(x2, y2);
      ctx.lineTo(x3, y3);
      ctx.closePath();
      ctx.stroke();
      ctx.restore();
      return;
    }

    if (el.shape === "pentagon") {
      const rad = Math.max(6, Math.min(r.w, r.h) / 2);
      ctx.beginPath();
      for (let i = 0; i < 5; i++) {
        const ang = -Math.PI / 2 + (i * 2 * Math.PI) / 5;
        const x = cx + Math.cos(ang) * rad;
        const y = cy + Math.sin(ang) * rad;
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.closePath();
      ctx.stroke();
      ctx.restore();
      return;
    }

    if (el.shape === "star") {
      
      const outer = Math.max(6, Math.min(r.w, r.h) / 2);
      const inner = outer * 0.5;
      ctx.beginPath();
      for (let i = 0; i < 10; i++) {
        const ang = -Math.PI / 2 + (i * Math.PI) / 5;
        const rad = i % 2 === 0 ? outer : inner;
        const x = cx + Math.cos(ang) * rad;
        const y = cy + Math.sin(ang) * rad;
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.closePath();
      ctx.stroke();
      ctx.restore();
      return;
    }

    if (el.shape === "tree") {
      
      const trunkH = Math.max(6, r.h * 0.18);
      const trunkW = Math.max(6, r.w * 0.18);
      const topY = r.top;
      const baseY = r.bottom - trunkH;
      ctx.beginPath();
      ctx.moveTo(cx, topY);
      ctx.lineTo(r.left, baseY);
      ctx.lineTo(r.right, baseY);
      ctx.closePath();
      ctx.stroke();

      const tx = cx - trunkW / 2;
      const ty = baseY;
      ctx.strokeRect(tx, ty, trunkW, trunkH);
      ctx.restore();
      return;
    }

    
if (el.shape === "umbrella") {
  
  const x = r.left;
  const y = r.top;
  const w = Math.max(12, r.w);
  const h = Math.max(12, r.h);

  const left = x + w * 0.12;
  const right = x + w * 0.88;
  const top = y + h * 0.10;
  const canopyBottom = y + h * 0.55;
  const scallopDepth = Math.min(h * 0.09, (right - left) * 0.07);

  
  ctx.beginPath();
  ctx.moveTo(left, canopyBottom);
  ctx.quadraticCurveTo(cx, top, right, canopyBottom);

  
  const scallops = 4;
  const seg = (right - left) / scallops;
  for (let i = 0; i < scallops; i++) {
    const x0 = left + i * seg;
    const x1 = x0 + seg;
    const xm = (x0 + x1) / 2;
    ctx.quadraticCurveTo(xm, canopyBottom + scallopDepth, x1, canopyBottom);
  }
  ctx.stroke();

  
  ctx.beginPath();
  ctx.moveTo(cx, top + h * 0.06);
  ctx.lineTo(cx, canopyBottom);
  ctx.stroke();

  
  const stemTop = canopyBottom;
  const stemBottom = y + h * 0.86;
  ctx.beginPath();
  ctx.moveTo(cx, stemTop);
  ctx.lineTo(cx, stemBottom);
  ctx.stroke();

  
  const hookR = Math.min(w, h) * 0.12;
  const hookCx = cx + hookR;
  const hookCy = Math.min(y + h * 0.94, stemBottom + hookR);
  ctx.beginPath();
  ctx.arc(hookCx, hookCy, hookR, Math.PI, Math.PI * 1.55, false);
  ctx.stroke();

  ctx.restore();
  return;
}

    
if (el.shape === "heart") {
  
  const x = r.left;
  const y = r.top;
  const w = Math.max(12, r.w);
  const h = Math.max(12, r.h);

  const cx2 = x + w / 2;
  const bottomY = y + h;
  const topY = y + h * 0.30;
  const dipY = y + h * 0.22;

  ctx.beginPath();
  
  ctx.moveTo(cx2, bottomY);

  
  ctx.bezierCurveTo(
    x + w * 0.05,
    y + h * 0.75,
    x,
    y + h * 0.50,
    x + w * 0.25,
    topY
  );

  
  ctx.bezierCurveTo(
    x + w * 0.20,
    y + h * 0.06,
    cx2 - w * 0.18,
    y + h * 0.06,
    cx2,
    dipY
  );

  
  ctx.bezierCurveTo(
    cx2 + w * 0.18,
    y + h * 0.06,
    x + w * 0.80,
    y + h * 0.06,
    x + w * 0.75,
    topY
  );

  
  ctx.bezierCurveTo(
    x + w,
    y + h * 0.50,
    x + w * 0.95,
    y + h * 0.75,
    cx2,
    bottomY
  );

  ctx.closePath();
  ctx.stroke();
  ctx.restore();
  return;
}

    ctx.restore();
  }

  function drawSelection(ctx: CanvasRenderingContext2D, el: ShapeElement) {
    const r = normalizeRect(el.x1, el.y1, el.x2, el.y2);
    ctx.save();
    ctx.globalCompositeOperation = "source-over";
    ctx.setLineDash([6, 6]);
    ctx.lineWidth = 1;
    ctx.strokeStyle = "rgba(0,0,0,0.55)";
    ctx.strokeRect(r.left - 3, r.top - 3, r.w + 6, r.h + 6);
    ctx.setLineDash([]);
    
    const s = 6;
    const handles: Point[] = [
      { x: r.left, y: r.top },
      { x: r.right, y: r.top },
      { x: r.right, y: r.bottom },
      { x: r.left, y: r.bottom },
    ];
    ctx.fillStyle = "#ffffff";
    ctx.strokeStyle = "rgba(0,0,0,0.65)";
    for (const h of handles) {
      ctx.beginPath();
      ctx.rect(h.x - s / 2, h.y - s / 2, s, s);
      ctx.fill();
      ctx.stroke();
    }
    ctx.restore();
  }

  function redraw(scene: Element[], activeStroke: StrokeElement | null, activeShape: ShapeElement | null) {
    const ctx = getCtx();
    if (!ctx) return;
    const { w, h } = sizeRef.current;

    
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, w * sizeRef.current.dpr, h * sizeRef.current.dpr);
    ctx.restore();

    
    for (const el of scene) {
      if (el.kind === "stroke") drawStroke(ctx, el);
      else drawShape(ctx, el);
    }

    
    for (const st of Object.values(remoteLiveStrokesRef.current)) drawStroke(ctx, st);
    for (const sh of Object.values(remoteLiveShapesRef.current)) drawShape(ctx, sh);

    
    if (activeStroke) drawStroke(ctx, activeStroke);
    if (activeShape) drawShape(ctx, activeShape);

        
    const now = Date.now();
    for (const [cid, cur] of Object.entries(remoteCursorsRef.current)) {
      
      if (now - cur.last > 10_000) {
        delete remoteCursorsRef.current[cid];
        continue;
      }
      const col = hashColor(cid);
      ctx.save();
      ctx.globalAlpha = 0.9;
      ctx.lineWidth = 2;
      ctx.strokeStyle = col;
      ctx.beginPath();
      ctx.arc(cur.p.x, cur.p.y, 6, 0, Math.PI * 2);
      ctx.stroke();

      
      const tag = cid.slice(-4);
      ctx.font = "12px ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Arial";
      ctx.fillStyle = "rgba(0,0,0,0.65)";
      const pad = 3;
      const tw = ctx.measureText(tag).width;
      ctx.fillRect(cur.p.x + 10, cur.p.y - 16, tw + pad * 2, 16);
      ctx.fillStyle = "white";
      ctx.fillText(tag, cur.p.x + 10 + pad, cur.p.y - 4);
      ctx.restore();
    }


    if (selectedId) {
      const found = scene.find((e) => e.kind === "shape" && e.id === selectedId) as ShapeElement | undefined;
      if (found) drawSelection(ctx, found);
    }
  }

  function requestRedraw(scene: Element[], activeStroke: StrokeElement | null, activeShape: ShapeElement | null) {
    if (rafRef.current) cancelAnimationFrame(rafRef.current);
    rafRef.current = requestAnimationFrame(() => {
      redraw(scene, activeStroke, activeShape);
      rafRef.current = null;
    });
  }

  
  function addAirbrushDots(stroke: StrokeElement, from: Point, to: Point) {
    const d = dist(from, to);
    const steps = Math.max(1, Math.floor(d / 2));
    const radius = Math.max(2, stroke.style.size);
    const dots = stroke.dots ?? (stroke.dots = []);

    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      const x = from.x + (to.x - from.x) * t;
      const y = from.y + (to.y - from.y) * t;
      const count = Math.floor(radius * 1.6);
      for (let j = 0; j < count; j++) {
        const ang = Math.random() * Math.PI * 2;
        const r = Math.random() * radius;
        const dx = Math.cos(ang) * r;
        const dy = Math.sin(ang) * r;
        const dotSize = Math.max(1, Math.random() * (radius / 3));
        dots.push({ x: x + dx, y: y + dy, r: dotSize, a: 0.20 });
      }
    }
  }

  
  function onPointerDown(e: PointerEvent) {
    const canvas = canvasRef.current;
    if (!canvas) return;
    canvas.setPointerCapture(e.pointerId);
    const p = getCanvasPoint(e, canvas);

    if (tool === "select") {
      
      const shapes = elements.filter((el) => el.kind === "shape") as ShapeElement[];
      const hit = [...shapes].reverse().find((s) => hitTestShape(s, p));
      if (hit) {
        setSelectedId(hit.id);
        dragRef.current = {
          mode: "move",
          id: hit.id,
          start: p,
          orig: { x1: hit.x1, y1: hit.y1, x2: hit.x2, y2: hit.y2 },
        };
      } else {
        setSelectedId(null);
        dragRef.current.mode = "none";
      }
      requestRedraw(elements, activeStrokeRef.current, activeShapeRef.current);
      return;
    }

    if (tool === "shape") {
      setSelectedId(null);
      const sh: ShapeElement = {
        id: makeId(),
        kind: "shape",
        ownerId: clientIdRef.current,
        shape: shapeTypeRef.current,
        x1: p.x,
        y1: p.y,
        x2: p.x,
        y2: p.y,
        color,
        size,
      };
      activeShapeRef.current = sh;
      localLiveShapeRef.current = sh.id;
      wsSend({ t: "shape:start", el: sh });
      requestRedraw(elements, null, sh);
      return;
    }

    
    const st: StrokeElement = {
      id: makeId(),
      kind: "stroke",
      ownerId: clientIdRef.current,
      points: [p],
      style: {
        tool: tool === "eraser" ? "eraser" : "pen",
        brush,
        color,
        size,
      },
      dots: tool === "eraser" || brush !== "airbrush" ? undefined : [],
    };
    activeStrokeRef.current = st;

    
    const canLive = brush !== "airbrush";
    localLiveStrokeRef.current = { id: st.id, live: canLive };
    if (canLive) {
      wsSend({ t: "stroke:start", id: st.id, p, style: st.style });
    }

    if (st.style.tool === "pen" && st.style.brush === "airbrush") {
      addAirbrushDots(st, p, p);
    }
    requestRedraw(elements, st, null);
  }

  function onPointerMove(e: PointerEvent) {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const p = getCanvasPoint(e, canvas);

const now = performance.now();
if (wsStatus === "connected" && now - cursorSendThrottleRef.current > 33) {
  cursorSendThrottleRef.current = now;
  wsSend({ t: "cursor", clientId: clientIdRef.current, p });
}


    
    if (tool === "select" && dragRef.current.mode === "move") {
      const dx = p.x - dragRef.current.start.x;
      const dy = p.y - dragRef.current.start.y;
      const id = dragRef.current.id;
      const next = elements.map((el) => {
        if (el.kind !== "shape" || el.id !== id) return el;
        return {
          ...el,
          x1: dragRef.current.orig.x1 + dx,
          y1: dragRef.current.orig.y1 + dy,
          x2: dragRef.current.orig.x2 + dx,
          y2: dragRef.current.orig.y2 + dy,
        };
      });
      requestRedraw(next, null, null);
      return;
    }

    
    if (tool === "shape" && activeShapeRef.current) {
      activeShapeRef.current = { ...activeShapeRef.current, x2: p.x, y2: p.y };
      if (localLiveShapeRef.current === activeShapeRef.current.id) {
        wsSend({ t: "shape:update", el: activeShapeRef.current });
      }
      requestRedraw(elements, null, activeShapeRef.current);
      return;
    }

    
    if ((tool === "pen" || tool === "eraser") && activeStrokeRef.current) {
      const st = activeStrokeRef.current;
      const last = st.points[st.points.length - 1];
      st.points.push(p);
      if (st.style.tool === "pen" && st.style.brush === "airbrush") {
        addAirbrushDots(st, last, p);
      }

      
      if (localLiveStrokeRef.current?.id === st.id && localLiveStrokeRef.current.live) {
        wsSend({ t: "stroke:point", id: st.id, p });
      }

      requestRedraw(elements, st, null);
    }
  }

  function onPointerUp(e: PointerEvent) {
    const canvas = canvasRef.current;
    if (canvas) {
      try {
        canvas.releasePointerCapture(e.pointerId);
      } catch {
        
      }
    }

    
    if (tool === "select" && dragRef.current.mode === "move") {
      dragRef.current.mode = "none";
      
      const id = selectedId;
      if (id) {
        const committed = elements.map((el) => {
          if (el.kind !== "shape" || el.id !== id) return el;
          
          
          
          return el;
        });
        
        if (!canvas) return;
        const p = getCanvasPoint(e, canvas);
        const dx = p.x - dragRef.current.start.x;
        const dy = p.y - dragRef.current.start.y;
        const next = committed.map((el) => {
          if (el.kind !== "shape" || el.id !== id) return el;
          return {
            ...el,
            x1: dragRef.current.orig.x1 + dx,
            y1: dragRef.current.orig.y1 + dy,
            x2: dragRef.current.orig.x2 + dx,
            y2: dragRef.current.orig.y2 + dy,
          };
        });
        setElements(next);
        pushHistory(next);
        requestRedraw(next, null, null);
        const updated = next.find((el) => el.kind === "shape" && el.id === id) as ShapeElement | undefined;
        if (updated) wsSend({ t: "element:update", el: updated });
      }
      return;
    }

    
    if (tool === "shape" && activeShapeRef.current) {
      const sh = activeShapeRef.current;
      activeShapeRef.current = null;
      localLiveShapeRef.current = null;
      const next = [...elements, sh];
      setElements(next);
      setRedoStack([]);
      pushHistory(next);
      wsSend({ t: "shape:end", id: sh.id });
      wsSend({ t: "element:add", el: sh });
      requestRedraw(next, null, null);
      return;
    }

    
    if ((tool === "pen" || tool === "eraser") && activeStrokeRef.current) {
      const st = activeStrokeRef.current;
      activeStrokeRef.current = null;
      const liveMeta = localLiveStrokeRef.current;
      localLiveStrokeRef.current = null;
      const next = [...elements, st];
      setElements(next);
      setRedoStack([]);
      pushHistory(next);

      if (liveMeta?.id === st.id && liveMeta.live) {
        wsSend({ t: "stroke:end", id: st.id });
      }
      wsSend({ t: "element:add", el: st });

      requestRedraw(next, null, null);
    }
  }

  function bindPointerEvents() {
    const canvas = canvasRef.current;
    if (!canvas) return () => {};
    const down = (e: PointerEvent) => onPointerDown(e);
    const move = (e: PointerEvent) => onPointerMove(e);
    const up = (e: PointerEvent) => onPointerUp(e);
    const cancel = (e: PointerEvent) => onPointerUp(e);

    canvas.addEventListener("pointerdown", down);
    canvas.addEventListener("pointermove", move);
    canvas.addEventListener("pointerup", up);
    canvas.addEventListener("pointercancel", cancel);
    return () => {
      canvas.removeEventListener("pointerdown", down);
      canvas.removeEventListener("pointermove", move);
      canvas.removeEventListener("pointerup", up);
      canvas.removeEventListener("pointercancel", cancel);
    };
  }

  useEffect(() => {
    return bindPointerEvents();
    
  }, [tool, brush, color, size, elements, selectedId]);

  
  const myId = clientIdRef.current;
  const canUndo = elements.some((e) => e.ownerId === myId);
  const canRedo = redoStack.length > 0;

  function undo() {
  if (!canUndo) return;
  const myId = clientIdRef.current;
  for (let i = elements.length - 1; i >= 0; i--) {
    const el = elements[i] as Element;
    if (el.ownerId !== myId) continue;

    const next = elements.filter((e) => e.id !== el.id);
    setElements(next);
    setRedoStack((prev) => [el, ...prev]);
    if (selectedId === el.id) setSelectedId(null);
    wsSend({ t: "element:remove", id: el.id });
    requestRedraw(next, null, null);
    persistScene(next);
    return;
  }
}

function redo() {
  if (!canRedo) return;
  const el = redoStack[0];
  if (!el) return;
  const rest = redoStack.slice(1);
  const next = [...elements, el];
  setRedoStack(rest);
  setElements(next);
  setSelectedId(null);
  wsSend({ t: "element:add", el });
  requestRedraw(next, null, null);
  persistScene(next);
}


  function clearBoard() {
    const idsToRemove = elementsRef.current.map((el) => el.id);
    setSelectedId(null);
    setElements([]);
    setRedoStack([]);
    setHistory([[]]);
    setHistoryIndex(0);
    for (const id of idsToRemove) wsSend({ t: "element:remove", id });
    requestRedraw([], null, null);
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ scene: [] }));
    } catch {
      
    }
  }

  function deleteSelected() {
    if (!selectedId) return;
    const id = selectedId;
    const next = elements.filter((el) => el.id !== id);
    setSelectedId(null);
    setElements(next);
    setRedoStack((prev) => prev.filter((e) => e.id !== id));
    pushHistory(next);
    wsSend({ t: "element:remove", id });
    requestRedraw(next, null, null);
    persistScene(next);
  }


  async function exportPNG() {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const blob: Blob | null = await new Promise((resolve) =>
      canvas.toBlob((b) => resolve(b), "image/png")
    );
    if (!blob) return;
    
    const ts = new Date().toISOString().slice(0, 19).split(":").join("-");
    downloadBlob(blob, `whiteboard-${ts}.png`);
  }

  
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const isMod = e.ctrlKey || e.metaKey;

      if (e.key === "Escape") {
        setSelectedId(null);
        return;
      }

      if (e.key === "Delete" || e.key === "Backspace") {
        if (selectedId) {
          e.preventDefault();
          deleteSelected();
        }
        return;
      }

      if (!isMod) return;
      if (e.key.toLowerCase() === "z" && !e.shiftKey) {
        e.preventDefault();
        undo();
      } else if ((e.key.toLowerCase() === "z" && e.shiftKey) || e.key.toLowerCase() === "y") {
        e.preventDefault();
        redo();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    
  }, [historyIndex, history, selectedId, elements]);

  
  useEffect(() => {
    if (historyIndex === -1 && history.length === 0) {
      setHistory([[]]);
      setHistoryIndex(0);
      requestRedraw([], null, null);
    }
    
  }, []);

  const statusToolLabel = useMemo(() => {
    if (tool === "eraser") return "eraser";
    if (tool === "pen") return brush;
    if (tool === "shape") return shapeType;
    return tool;
  }, [tool, brush, shapeType]);

  const leftOpen = leftPinned || leftPeek;

  return (
    <div className={"app" + (mobileNavHidden ? " mobileNavHidden" : "")}>
      <div className="stage" ref={containerRef}>
        <div className="paper" aria-hidden="true" />
        <canvas ref={canvasRef} className="canvas" />
        {!leftPinned && !leftOpen && (
          <div
            className="edgeHotspot left"
            onMouseEnter={() => setLeftPeek(true)}
            aria-hidden="true"
          />
        )}
        <nav
          className={"dock dockLeft " + (leftOpen ? "open" : "closed")}
          aria-label="Tools"
          onMouseEnter={() => {
            setLeftInteracting(true);
            if (!leftPinned) setLeftPeek(true);
          }}
          onMouseLeave={() => {
            setLeftInteracting(false);
            if (!leftPinned) setLeftPeek(false);
          }}
        >
          <button
            className="dockHandle"
            type="button"
            title={leftPinned ? "Unpin dock" : "Pin dock"}
            onClick={() => {
              setLeftPinned((p) => !p);
              setLeftPeek(false);
            }}
          >
            <span className={"chev " + (leftOpen ? "open" : "")}>▸</span>
          </button>

          <div className="dockGroup">
            <IconButton title="Select / Move" active={tool === "select"} onClick={() => { setTool("select"); setShapeMenuOpen(false); }}
              ><IcPointer /></IconButton>
            <IconButton title="Pen" active={tool === "pen"} onClick={() => { setTool("pen"); setShapeMenuOpen(false); }}
              ><IcPencil /></IconButton>
            <IconButton title="Eraser" active={tool === "eraser"} onClick={() => { setTool("eraser"); setShapeMenuOpen(false); }}
              ><IcEraser /></IconButton>
            <div className="shapeToolWrap">
              <button
                className={"iconBtn" + (tool === "shape" ? " active" : "")}
                title="Shapes"
                type="button"
                data-shape-button
                onPointerDown={handleShapeButtonPointerDown}
                onPointerUp={handleShapeButtonPointerEnd}
                onPointerCancel={handleShapeButtonPointerEnd}
                onPointerLeave={handleShapeButtonPointerEnd}
                onClick={handleShapeButtonClick}
              >
                {shapeType === "rect" ? (
                  <IcRect />
                ) : shapeType === "ellipse" ? (
                  <IcEllipse />
                ) : shapeType === "triangle" ? (
                  <IcTriangle />
                ) : (
                  <IcStar />
                )}
              </button>

              {shapeMenuOpen && tool === "shape" && (
                <div className="shapeMenuPop" data-shape-menu>
                  <button
                    type="button"
                    className={"shapeBtnPop" + (shapeType === "rect" ? " active" : "")}
                    title="Rectangle"
                    onPointerDown={(e) => {
                      e.preventDefault();
                      selectShapeType("rect");
                    }}
                  >
                    <IcRect />
                  </button>
                  <button
                    type="button"
                    className={"shapeBtnPop" + (shapeType === "ellipse" ? " active" : "")}
                    title="Circle"
                    onPointerDown={(e) => {
                      e.preventDefault();
                      selectShapeType("ellipse");
                    }}
                  >
                    <IcEllipse />
                  </button>
                  <button
                    type="button"
                    className={"shapeBtnPop" + (shapeType === "line" ? " active" : "")}
                    title="Line"
                    onPointerDown={(e) => {
                      e.preventDefault();
                      selectShapeType("line");
                    }}
                  >
                    <IcLine />
                  </button>
                  <button
                    type="button"
                    className={"shapeBtnPop" + (shapeType === "triangle" ? " active" : "")}
                    title="Triangle"
                    onPointerDown={(e) => {
                      e.preventDefault();
                      selectShapeType("triangle");
                    }}
                  >
                    <IcTriangle />
                  </button>
                  <button
                    type="button"
                    className={"shapeBtnPop" + (shapeType === "star" ? " active" : "")}
                    title="Star"
                    onPointerDown={(e) => {
                      e.preventDefault();
                      selectShapeType("star");
                    }}
                  >
                    <IcStar />
                  </button>
                  <button
                    type="button"
                    className={"shapeBtnPop" + (shapeType === "pentagon" ? " active" : "")}
                    title="Pentagon"
                    onPointerDown={(e) => {
                      e.preventDefault();
                      selectShapeType("pentagon");
                    }}
                  >
                    <IcPentagon />
                  </button>
                  <button
                    type="button"
                    className={"shapeBtnPop" + (shapeType === "heart" ? " active" : "")}
                    title="Heart"
                    onPointerDown={(e) => {
                      e.preventDefault();
                      selectShapeType("heart");
                    }}
                  >
                    <IcHeart />
                  </button>
                  <button
                    type="button"
                    className={"shapeBtnPop" + (shapeType === "umbrella" ? " active" : "")}
                    title="Umbrella"
                    onPointerDown={(e) => {
                      e.preventDefault();
                      selectShapeType("umbrella");
                    }}
                  >
                    <IcUmbrella />
                  </button>
                  <button
                    type="button"
                    className={"shapeBtnPop" + (shapeType === "tree" ? " active" : "")}
                    title="Christmas tree"
                    onPointerDown={(e) => {
                      e.preventDefault();
                      selectShapeType("tree");
                    }}
                  >
                    <IcTree />
                  </button>
                </div>
              )}
            </div>
          </div>

          {leftOpen && (
            <div className="dockPanel" aria-label="Tool settings">
              {tool === "pen" && (
                <>
                  <div className="miniLabel">
                    <div className="miniTitle">Brush</div>
                    <select className="miniSelect" value={brush} onChange={(e) => setBrush(e.target.value as Brush)}>
                      <option value="pencil">Pencil</option>
                      <option value="marker">Marker</option>
                      <option value="highlighter">Highlighter</option>
                      <option value="airbrush">Airbrush</option>
                    </select>
                  </div>

                  <div className="miniLabel">
                    <div className="miniTitle">Color</div>
                    <input className="colorWell" type="color" value={color} onChange={(e) => setColor(e.target.value)} />
                  </div>

                  <div className="miniLabel">
                    <div className="miniTitle">Size</div>
                    <input
                      className="sizeSlider"
                      type="range"
                      min={2}
                      max={72}
                      step={1}
                      value={size}
                      onChange={(e) => setSize(Number(e.target.value))}
                    />
                    <div className="miniValue">{size}px</div>
                  </div>
                </>
              )}

              {tool === "eraser" && (
                <>
                  <div className="miniLabel">
                    <div className="miniTitle">Eraser</div>
                    <input
                      className="sizeSlider"
                      type="range"
                      min={4}
                      max={96}
                      step={1}
                      value={size}
                      onChange={(e) => setSize(Number(e.target.value))}
                    />
                    <div className="miniValue">{size}px</div>
                  </div>
                </>
              )}

              {tool === "shape" && (
                <>
                  <div className="miniLabel">
                    <div className="miniTitle">Stroke</div>
                    <input className="colorWell" type="color" value={color} onChange={(e) => setColor(e.target.value)} />
                  </div>

                  <div className="miniLabel">
                    <div className="miniTitle">Width</div>
                    <input
                      className="sizeSlider"
                      type="range"
                      min={1}
                      max={48}
                      step={1}
                      value={size}
                      onChange={(e) => setSize(Number(e.target.value))}
                    />
                    <div className="miniValue">{size}px</div>
                  </div>
                </>
              )}

              {tool === "select" && (
                <>
                  <div className="miniLabel">
                    <div className="miniTitle">Selection</div>
                    <IconButton title="Delete selected (Del)" disabled={!selectedId} onClick={deleteSelected}>
                      <IcTrash />
                    </IconButton>
                    <div className="miniValue">{selectedId ? "1 selected" : "None"}</div>
                  </div>
                </>
              )}
            </div>
          )}


          {!leftOpen && (
            <div className="dockTab" aria-hidden="true">
              <div className="dockTabDot" />
            </div>
          )}
        </nav>
        <div className="roomHud" aria-label="Collaboration status">
          <div className="roomBox" title="Share the URL (room=...) to collaborate">
            <div className={"statusDot " + wsStatus} aria-hidden="true" />
            <div className="roomLabel">Room</div>
            <div className="roomPresence">{presenceCount}</div>
            <input
              className="roomInput"
              value={roomId}
              onChange={(e) => setRoomId(e.target.value)}
              spellCheck={false}
              aria-label="Room id"
            />
          </div>
        </div>
        <div className="actions" aria-label="Actions">
          <IconButton title="Undo (Ctrl/Cmd+Z)" disabled={!canUndo} onClick={undo}><IcUndo /></IconButton>
          <IconButton title="Redo (Ctrl/Cmd+Y)" disabled={!canRedo} onClick={redo}><IcRedo /></IconButton>
          <IconButton title="Clear board" onClick={clearBoard}><IcClear /></IconButton>
          <IconButton title="Export PNG" onClick={exportPNG}><IcDownload /></IconButton>
        </div>

        <button
          type="button"
          className={"mobileNavToggle" + (mobileNavHidden ? " shown" : "")}
          onClick={() => setMobileNavHidden((v) => !v)}
          aria-label={mobileNavHidden ? "Show toolbar" : "Hide toolbar"}
          title={mobileNavHidden ? "Show toolbar" : "Hide toolbar"}
        >
          {mobileNavHidden ? "Show UI" : "Hide UI"}
        </button>
      </div>
    </div>
  );
}

