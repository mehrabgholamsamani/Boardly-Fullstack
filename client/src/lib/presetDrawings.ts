type Point = { x: number; y: number };
type StrokeStyle = { tool: "pen" | "eraser"; brush: "pencil" | "marker" | "highlighter" | "airbrush"; color: string; size: number };
type StrokeElement = { id: string; kind: "stroke"; points: Point[]; style: StrokeStyle; dots?: any[] };

type RawStroke =
  | { type: "path"; d: string }
  | { type: "circle"; cx: number; cy: number; r: number }
  | { type: "ellipse"; cx: number; cy: number; rx: number; ry: number; rotateDeg?: number; rotateCx?: number; rotateCy?: number }
  | { type: "line"; x1: number; y1: number; x2: number; y2: number };

function samplePath(d: string): Point[] {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg") as SVGSVGElement;
  svg.style.cssText = "position:fixed;visibility:hidden;pointer-events:none;width:0;height:0";
  const pathEl = document.createElementNS("http://www.w3.org/2000/svg", "path") as SVGPathElement;
  pathEl.setAttribute("d", d);
  svg.appendChild(pathEl);
  document.body.appendChild(svg);
  const len = pathEl.getTotalLength();
  const pts: Point[] = [];
  const step = 3;
  for (let l = 0; l <= len; l += step) {
    const p = pathEl.getPointAtLength(l);
    pts.push({ x: p.x, y: p.y });
  }
  const end = pathEl.getPointAtLength(len);
  if (!pts.length || pts[pts.length - 1].x !== end.x) pts.push({ x: end.x, y: end.y });
  document.body.removeChild(svg);
  return pts;
}

function sampleCircle(cx: number, cy: number, r: number): Point[] {
  const circumference = 2 * Math.PI * r;
  const numSteps = Math.max(8, Math.ceil(circumference / 3));
  const pts: Point[] = [];
  for (let i = 0; i <= numSteps; i++) {
    const angle = (i / numSteps) * 2 * Math.PI;
    pts.push({ x: cx + r * Math.cos(angle), y: cy + r * Math.sin(angle) });
  }
  return pts;
}

function sampleEllipse(
  cx: number, cy: number, rx: number, ry: number,
  rotateDeg = 0, rotateCx = cx, rotateCy = cy
): Point[] {
  const perimeter = Math.PI * (3 * (rx + ry) - Math.sqrt((3 * rx + ry) * (rx + 3 * ry)));
  const numSteps = Math.max(8, Math.ceil(perimeter / 3));
  const rad = (rotateDeg * Math.PI) / 180;
  const cosR = Math.cos(rad);
  const sinR = Math.sin(rad);
  const pts: Point[] = [];
  for (let i = 0; i <= numSteps; i++) {
    const t = (i / numSteps) * 2 * Math.PI;
    const px = cx + rx * Math.cos(t);
    const py = cy + ry * Math.sin(t);
    // Rotate around (rotateCx, rotateCy)
    const dx = px - rotateCx;
    const dy = py - rotateCy;
    pts.push({
      x: rotateCx + dx * cosR - dy * sinR,
      y: rotateCy + dx * sinR + dy * cosR,
    });
  }
  return pts;
}

function sampleLine(x1: number, y1: number, x2: number, y2: number): Point[] {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const len = Math.sqrt(dx * dx + dy * dy);
  const numSteps = Math.max(2, Math.ceil(len / 3));
  const pts: Point[] = [];
  for (let i = 0; i <= numSteps; i++) {
    const t = i / numSteps;
    pts.push({ x: x1 + dx * t, y: y1 + dy * t });
  }
  return pts;
}

export const PRESET_NAMES = ["cat", "rocket", "flower", "mountain", "coffee"] as const;
export type PresetName = typeof PRESET_NAMES[number];

const PRESETS: Record<PresetName, RawStroke[]> = {
  cat: [
    { type: "circle", cx: 50, cy: 57, r: 33 },
    { type: "path", d: "M19,40 L24,8 L40,30" },
    { type: "path", d: "M60,30 L76,8 L81,40" },
    { type: "path", d: "M30,51 Q37,43 44,51 Q37,57 30,51 Z" },
    { type: "circle", cx: 37, cy: 51, r: 3 },
    { type: "path", d: "M56,51 Q63,43 70,51 Q63,57 56,51 Z" },
    { type: "circle", cx: 63, cy: 51, r: 3 },
    { type: "path", d: "M47,62 L50,58 L53,62 Q50,65 47,62 Z" },
    { type: "path", d: "M47,64 Q43,69 39,67" },
    { type: "path", d: "M53,64 Q57,69 61,67" },
    { type: "line", x1: 6, y1: 58, x2: 37, y2: 60 },
    { type: "line", x1: 6, y1: 65, x2: 37, y2: 65 },
    { type: "line", x1: 6, y1: 72, x2: 37, y2: 70 },
    { type: "line", x1: 94, y1: 58, x2: 63, y2: 60 },
    { type: "line", x1: 94, y1: 65, x2: 63, y2: 65 },
    { type: "line", x1: 94, y1: 72, x2: 63, y2: 70 },
  ],
  rocket: [
    { type: "path", d: "M36,34 C40,8 60,8 64,34 L64,72 L36,72 Z" },
    { type: "path", d: "M36,56 L18,76 L36,76" },
    { type: "path", d: "M64,56 L82,76 L64,76" },
    { type: "circle", cx: 50, cy: 47, r: 9 },
    { type: "path", d: "M38,72 L38,78 L62,78 L62,72" },
    { type: "path", d: "M38,78 Q44,92 50,88 Q56,92 62,78" },
  ],
  flower: [
    ...([0, 45, 90, 135, 180, 225, 270, 315].map((deg) => ({
      type: "ellipse" as const,
      cx: 50,
      cy: 34,
      rx: 5,
      ry: 14,
      rotateDeg: deg,
      rotateCx: 50,
      rotateCy: 50,
    }))),
    { type: "circle", cx: 50, cy: 50, r: 9 },
    { type: "line", x1: 50, y1: 59, x2: 50, y2: 91 },
    { type: "path", d: "M50,74 Q38,68 36,76 Q40,84 50,80" },
    { type: "path", d: "M50,74 Q62,68 64,76 Q60,84 50,80" },
  ],
  mountain: [
    { type: "circle", cx: 82, cy: 20, r: 9 },
    { type: "path", d: "M4,80 L30,38 L56,80" },
    { type: "path", d: "M20,80 L58,10 L96,80" },
    { type: "path", d: "M46,32 Q58,10 70,32 Q58,38 46,32 Z" },
    { type: "line", x1: 2, y1: 80, x2: 98, y2: 80 },
  ],
  coffee: [
    { type: "path", d: "M26,38 L74,38 L68,70 L32,70 Z" },
    { type: "path", d: "M74,48 C92,48 92,64 74,64" },
    { type: "ellipse", cx: 50, cy: 73, rx: 30, ry: 5 },
    { type: "path", d: "M38,38 C34,30 42,24 38,16" },
    { type: "path", d: "M50,38 C46,30 54,24 50,16" },
    { type: "path", d: "M62,38 C58,30 66,24 62,16" },
  ],
};

let _idCounter = 0;
function makeId(): string {
  return `preset-${Date.now()}-${_idCounter++}`;
}

export type ExistingBounds = { minX: number; minY: number; maxX: number; maxY: number };

export function buildPresetStrokes(
  name: PresetName,
  canvasW: number,
  canvasH: number,
  existingBounds?: ExistingBounds | null,
): StrokeElement[] {
  const scale = (Math.min(canvasW, canvasH) * 0.65) / 100;
  const drawingSize = 100 * scale;
  const margin = Math.min(canvasW, canvasH) * 0.05;
  const maxOX = Math.max(0, canvasW - drawingSize - 2 * margin);
  const maxOY = Math.max(0, canvasH - drawingSize - 2 * margin);

  let offsetX = margin + Math.random() * maxOX;
  let offsetY = margin + Math.random() * maxOY;

  if (existingBounds) {
    const gap = margin;
    const eL = existingBounds.minX - gap;
    const eR = existingBounds.maxX + gap;
    const eT = existingBounds.minY - gap;
    const eB = existingBounds.maxY + gap;

    for (let attempt = 0; attempt < 20; attempt++) {
      const ox = margin + Math.random() * maxOX;
      const oy = margin + Math.random() * maxOY;
      // Always store the last attempt as fallback
      offsetX = ox;
      offsetY = oy;
      // AABB non-overlap check
      const nR = ox + drawingSize, nB = oy + drawingSize;
      if (nR < eL || ox > eR || nB < eT || oy > eB) break;
    }
  }

  const style: StrokeStyle = { tool: "pen", brush: "marker", color: "#111111", size: 3 };

  const rawStrokes = PRESETS[name];
  const result: StrokeElement[] = [];

  for (const raw of rawStrokes) {
    let pts: Point[];
    if (raw.type === "path") {
      pts = samplePath(raw.d);
    } else if (raw.type === "circle") {
      pts = sampleCircle(raw.cx, raw.cy, raw.r);
    } else if (raw.type === "ellipse") {
      pts = sampleEllipse(raw.cx, raw.cy, raw.rx, raw.ry, raw.rotateDeg, raw.rotateCx, raw.rotateCy);
    } else {
      pts = sampleLine(raw.x1, raw.y1, raw.x2, raw.y2);
    }

    // Transform to canvas coords
    const transformed = pts.map((p) => ({
      x: p.x * scale + offsetX,
      y: p.y * scale + offsetY,
    }));

    if (transformed.length >= 2) {
      result.push({ id: makeId(), kind: "stroke", points: transformed, style });
    }
  }

  return result;
}
