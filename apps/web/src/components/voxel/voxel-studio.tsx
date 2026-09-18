import { useEffect, useMemo, useRef, useState } from "react";
import {
  applyVoxelOperation,
  buildVoxelModel,
  importPixzelsModel,
  exportVoxelOBJ,
  exportVoxelTexturedOBJ,
  projectVoxelModel,
  inspectVoxelModel,
  renderVoxelDirections,
  renderVoxelModel,
  voxelModelSchema,
  voxelNormals,
  voxelSurface,
  voxelViews,
} from "@retrodex/contracts";
import type {
  VoxelModel,
  VoxelOperation,
  VoxelProjection,
  VoxelView,
  VoxelSettings,
} from "@retrodex/contracts";
import type { AnimationFrame, Size } from "../../editor/types";
import "./voxel-studio.css";
import {
  download,
  paintCanvas,
  readProjection,
  savePNG,
  saveGIF,
  composeSheet,
  splitOrtho,
  nativeProjectionCells,
  textureBundle,
} from "./voxel-files";

type State = {
  model: VoxelModel | null;
  revision: number;
  canUndo: boolean;
  canRedo?: boolean;
};
const apiBase =
  (import.meta as unknown as { env?: { VITE_API_URL?: string } }).env
    ?.VITE_API_URL ?? "http://127.0.0.1:5175";
async function request(
  runId: string,
  path: string,
  method = "GET",
  body?: unknown,
): Promise<State> {
  const response = await fetch(
    `${apiBase}/runs/${encodeURIComponent(runId)}/voxel${path}`,
    {
      method,
      headers: { "Content-Type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    },
  );
  const result = await response.json();
  if (!response.ok)
    throw new Error(result.error?.message ?? "3D request failed");
  return result;
}
function ProjectionPreview({ grid }: { grid?: VoxelProjection }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    if (ref.current && grid) paintCanvas(ref.current, grid);
  }, [grid]);
  return grid ? (
    <canvas ref={ref} aria-label="Projection preview" />
  ) : (
    <span className="voxel-projection-empty">No view</span>
  );
}
function demoProjections() {
  const n = 16;
  const front: VoxelProjection = {
    width: n,
    height: n,
    cells: Array(n * n).fill(null),
  };
  const side: VoxelProjection = {
    width: n,
    height: n,
    cells: Array(n * n).fill(null),
  };
  for (let y = 2; y < 15; y++)
    for (let x = 2; x < 14; x++) {
      if (
        (y < 7 && x >= 4 && x < 12) ||
        (y >= 7 && y < 12) ||
        (y >= 12 && ((x >= 4 && x < 7) || (x >= 9 && x < 12)))
      )
        front.cells[x + y * n] = y < 7 ? "#e3bb7b" : "#567b91";
      if (x >= 5 && x < 10)
        side.cells[x + y * n] = y < 7 ? "#b48855" : "#345269";
    }
  front.cells[6 + 4 * n] = "#26323d";
  front.cells[9 + 4 * n] = "#26323d";
  return { front, right: side };
}
export function VoxelStudio({
  active,
  runId,
  currentFrame,
  canvasSize,
  onClose,
  onImport,
}: {
  active: boolean;
  runId: string | null;
  currentFrame: () => AnimationFrame;
  canvasSize: Size;
  onClose: () => void;
  onImport: (frames: VoxelProjection[]) => void;
}) {
  const [state, setState] = useState<State>({
    model: null,
    revision: 0,
    canUndo: false,
  });
  const [history, setHistory] = useState<(VoxelModel | null)[]>([]);
  const [future, setFuture] = useState<(VoxelModel | null)[]>([]);
  const [brush, setBrush] = useState(1),
    [gridVisible, setGridVisible] = useState(true),
    [outline, setOutline] = useState(false),
    [edges, setEdges] = useState(false),
    [shading, setShading] = useState(false),
    [outlineColor, setOutlineColor] = useState("#15171c"),
    [background, setBackground] = useState("#20252c"),
    [lightYaw, setLightYaw] = useState(-45),
    [lightPitch, setLightPitch] = useState(45),
    [zoom, setZoom] = useState(1),
    [pan, setPan] = useState({ x: 0, y: 0 }),
    [pixelMode, setPixelMode] = useState(true),
    [viewLock, setViewLock] = useState(false),
    [lightTheme, setLightTheme] = useState(false),
    [outputSize, setOutputSize] = useState(64),
    [fps, setFps] = useState(8),
    [newSize, setNewSize] = useState(32);
  type Point = { x: number; y: number; z: number };
  type Bounds = { min: Point; max: Point };
  const [throughSelection, setThroughSelection] = useState(true);
  const [selectionRegions, setSelectionRegions] = useState<Bounds[]>([]);
  const [selection, setSelection] = useState<Bounds | null>(null),
    [offset, setOffset] = useState<Point>({ x: 0, y: 0, z: 0 }),
    [selectionSize, setSelectionSize] = useState<Point>({ x: 1, y: 1, z: 1 });
  useEffect(() => {
    if (!selection) setSelectionRegions([]);
  }, [selection]);
  const [selectionRect, setSelectionRect] = useState<{
    x: number;
    y: number;
    w: number;
    h: number;
  } | null>(null);
  const [gallery, setGallery] = useState<{ name: string; file: File }[]>([]);
  const space = useRef(false),
    lastPoint = useRef<{ voxel: Point; face: number } | null>(null);
  const stroke = useRef<{
    ops: VoxelOperation[];
    seen: Set<string>;
    last: { clientX: number; clientY: number };
    tool: string;
  } | null>(null);
  const selectDrag = useRef<{
    clientX: number;
    clientY: number;
    append: boolean;
    transform: boolean;
    copy: boolean;
    bounds: Bounds | null;
    hit: Point | null;
  } | null>(null);
  const cameraDrag = useRef<{
    x: number;
    y: number;
    pan: { x: number; y: number };
    zoom: number;
    mode: "pan" | "zoom";
  } | null>(null);
  const [sources, setSources] = useState<
    Partial<Record<VoxelView, VoxelProjection>>
  >({});
  const [depth, setDepth] = useState(1);
  const [yaw, setYaw] = useState(35),
    [pitch, setPitch] = useState(20),
    [tool, setTool] = useState("orbit"),
    [color, setColor] = useState("#dca970"),
    [distance, setDistance] = useState(1);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [status, setStatus] = useState(""),
    [ready, setReady] = useState(!runId);
  const [directions, setDirections] = useState<1 | 8 | 16>(8);
  const [hover, setHover] = useState("");
  const closeButton = useRef<HTMLButtonElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null),
    drag = useRef<{ x: number; y: number; yaw: number; pitch: number } | null>(
      null,
    ),
    gate = useRef(false);
  const model = state.model;
  const occupied = useMemo(
    () => new Set(model?.voxels.map((v) => `${v.x},${v.y},${v.z}`) ?? []),
    [model],
  );
  const surface = useMemo(() => (model ? voxelSurface(model) : []), [model]);
  const rendered = useMemo(
    () =>
      model
        ? renderVoxelModel(
            model,
            {
              width: pixelMode ? 192 : 384,
              height: pixelMode ? 192 : 384,
              yaw,
              pitch,
              zoom,
              panX: pan.x,
              panY: pan.y,
              outline,
              outlineColor,
              shading,
              edges,
              lightYaw,
              lightPitch,
            },
            surface,
          )
        : null,
    [
      model,
      surface,
      yaw,
      pitch,
      zoom,
      pan,
      outline,
      outlineColor,
      shading,
      edges,
      lightYaw,
      lightPitch,
      pixelMode,
    ],
  );
  const inspection = useMemo(
    () => (model ? inspectVoxelModel(model) : null),
    [model],
  );
  useEffect(() => {
    if (rendered && canvas.current) {
      const cells = selection
        ? rendered.cells.map((c, i) => {
            const id = rendered.hits[i]!,
              v = id < 0 ? null : model?.voxels[Math.floor(id / 6)];
            return v && insideSelection(v)
              ? "#" +
                  [1, 3, 5]
                    .map((j, k) =>
                      Math.round(
                        parseInt(c!.slice(j, j + 2), 16) * 0.65 +
                          [95, 190, 255][k]! * 0.35,
                      )
                        .toString(16)
                        .padStart(2, "0"),
                    )
                    .join("")
              : c;
          })
        : rendered.cells;
      paintCanvas(canvas.current, { ...rendered, cells });
    }
  }, [rendered, active, selection, selectionRegions, model]);
  useEffect(() => {
    let alive = true;
    if (!runId) {
      setReady(true);
      return;
    }
    setReady(false);
    request(runId, "")
      .then((s) => {
        if (alive) {
          setState(s);
          restoreSettings(s.model?.settings);
          setSources(s.model?.projections ?? {});
          setReady(true);
        }
      })
      .catch((e) => {
        if (alive) setError(e.message);
      });
    return () => {
      alive = false;
    };
  }, [runId]);
  useEffect(() => {
    if (active) closeButton.current?.focus();
  }, [active]);
  async function work(fn: () => Promise<void>) {
    if (gate.current) return;
    gate.current = true;
    setBusy(true);
    setError("");
    try {
      await fn();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      gate.current = false;
      setBusy(false);
    }
  }
  async function commit(
    next: VoxelModel,
    path = "",
    body: Record<string, unknown> = { model: next },
    method = "PUT",
  ) {
    if (!ready) throw new Error("Reload the saved 3D model before editing.");
    if (runId)
      setState(
        await request(runId, path, method, {
          ...body,
          expectedRevision: state.revision,
        }),
      );
    else {
      setHistory((h) => [...h, model].slice(-12));
      setFuture([]);
      setState({
        model: next,
        revision: state.revision + 1,
        canUndo: true,
        canRedo: false,
      });
    }
    setStatus(
      runId
        ? "Saved to run"
        : "Local session · download JSON to keep this model",
    );
  }
  const settings: VoxelSettings = {
    yaw,
    pitch,
    zoom,
    panX: pan.x,
    panY: pan.y,
    pixelMode,
    grid: gridVisible,
    outline,
    edges,
    shading,
    outlineColor,
    background,
    lightYaw,
    lightPitch,
    outputSize,
    fps,
    viewLock,
  };
  function restoreSettings(s?: VoxelSettings) {
    if (!s) return;
    setYaw(s.yaw);
    setPitch(s.pitch);
    setZoom(s.zoom);
    setPan({ x: s.panX, y: s.panY });
    setPixelMode(s.pixelMode);
    setGridVisible(s.grid);
    setOutline(s.outline);
    setEdges(s.edges);
    setShading(s.shading);
    setOutlineColor(s.outlineColor);
    setBackground(s.background);
    setLightYaw(s.lightYaw);
    setLightPitch(s.lightPitch);
    setOutputSize(s.outputSize);
    setFps(s.fps);
    setViewLock(s.viewLock);
  }
  function build() {
    void work(async () => {
      const size = Object.values(sources)[0]?.width ?? 16;
      const body = { size, projections: sources, singleViewDepth: depth };
      await commit(buildVoxelModel(body), "/build", body, "POST");
    });
  }
  function operate(op: VoxelOperation) {
    void work(async () => {
      if (!model) return;
      const next = applyVoxelOperation(model, op);
      await commit(next, "/operations", { operations: [op] }, "PATCH");
      if (["interpolate", "resize", "clear"].includes(op.type)) {
        setSources(next.projections);
        setSelection(null);
      }
      if (op.type === "delete") setSelection(null);
      if (op.type === "transform") {
        setSelectionRegions([]);
        const min = {
          x: op.min.x + op.offset.x,
          y: op.min.y + op.offset.y,
          z: op.min.z + op.offset.z,
        };
        const size = op.scale ?? {
          x: op.max.x - op.min.x + 1,
          y: op.max.y - op.min.y + 1,
          z: op.max.z - op.min.z + 1,
        };
        setSelection({
          min,
          max: {
            x: min.x + size.x - 1,
            y: min.y + size.y - 1,
            z: min.z + size.z - 1,
          },
        });
        setOffset({ x: 0, y: 0, z: 0 });
        setSelectionSize(size);
      }
    });
  }
  function pick(event: { clientX: number; clientY: number }) {
    if (!canvas.current || !rendered || !model) return null;
    const rect = canvas.current.getBoundingClientRect();
    const x = Math.floor(
        ((event.clientX - rect.left) / rect.width) * rendered.width,
      ),
      y = Math.floor(
        ((event.clientY - rect.top) / rect.height) * rendered.height,
      );
    if (x < 0 || y < 0 || x >= rendered.width || y >= rendered.height)
      return null;
    const id = rendered.hits[x + y * rendered.width] ?? -1;
    return id < 0
      ? null
      : { voxel: model.voxels[Math.floor(id / 6)]!, face: id % 6 };
  }
  function insideSelection(p: Point) {
    return (
      !selection ||
      (selectionRegions.length ? selectionRegions : [selection]).some(
        (b) =>
          p.x >= b.min.x &&
          p.x <= b.max.x &&
          p.y >= b.min.y &&
          p.y <= b.max.y &&
          p.z >= b.min.z &&
          p.z <= b.max.z,
      )
    );
  }
  function planePoint(
    event: { clientX: number; clientY: number },
    provided?: Point,
  ) {
    if (!model || !rendered || !canvas.current) return null;
    const r = canvas.current.getBoundingClientRect(),
      a = (yaw * Math.PI) / 180,
      b = (pitch * Math.PI) / 180;
    const right = [Math.cos(a), 0, -Math.sin(a)],
      up = [
        -Math.sin(a) * Math.sin(b),
        Math.cos(b),
        -Math.cos(a) * Math.sin(b),
      ],
      eye = [Math.sin(a) * Math.cos(b), Math.sin(b), Math.cos(a) * Math.cos(b)];
    const axis = eye.reduce(
        (best, v, i) => (Math.abs(v) > Math.abs(eye[best]!) ? i : best),
        0,
      ),
      face =
        axis === 0
          ? eye[0]! > 0
            ? 3
            : 2
          : axis === 1
            ? eye[1]! > 0
              ? 4
              : 5
            : eye[2]! > 0
              ? 0
              : 1;
    const scale =
      ((Math.min(rendered.width, rendered.height) - 2) * zoom) /
      (model.size * Math.sqrt(3));
    const dx =
        (((event.clientX - r.left) * rendered.width) / r.width -
          rendered.width / 2 -
          pan.x) /
        scale,
      dy =
        -(
          ((event.clientY - r.top) * rendered.height) / r.height -
          rendered.height / 2 -
          pan.y
        ) / scale;
    const base = right.map((v, i) => v * dx + up[i]! * dy),
      anchor = provided ?? lastPoint.current?.voxel;
    const center = anchor
      ? [anchor.x, anchor.y, anchor.z][axis]! + 0.5 - model.size / 2
      : 0.5;
    const d = (center - base[axis]!) / eye[axis]!;
    const p = base.map((v, i) => Math.floor(v + eye[i]! * d + model.size / 2)),
      point = { x: p[0]!, y: p[1]!, z: p[2]! };
    return Math.min(...p) >= 0 &&
      Math.max(...p) < model.size &&
      insideSelection(point)
      ? { point, face }
      : null;
  }
  function collect(
    event: { clientX: number; clientY: number },
    selectedTool: string,
  ) {
    const hit = pick(event);
    if (!model) return;
    if (!hit) {
      const plane = planePoint(event);
      if (!plane) return;
      if (selectedTool === "fill") {
        operate({
          type: "fill-plane",
          ...plane,
          face: voxelViews[plane.face]!,
          color,
          enclosed: !selection,
          selection: selection ?? undefined,
          regions: selectionRegions.length ? selectionRegions : undefined,
        });
        return;
      }
      const pending = stroke.current;
      if (pending && (selectedTool === "add" || selectedTool === "paint")) {
        const k = `${plane.point.x},${plane.point.y},${plane.point.z}/empty`;
        if (!pending.seen.has(k)) {
          pending.seen.add(k);
          pending.ops.push({ type: "set", points: [plane.point], color });
          setStatus(`${pending.seen.size} cells · release to apply stroke`);
        }
      }
      return;
    }
    if (!insideSelection(hit.voxel)) return;
    if (selectedTool === "pick") {
      setColor(model.palette[hit.voxel.colors[hit.face]!]!);
      return;
    }
    if (selectedTool === "fill") {
      operate({
        type: "fill",
        point: hit.voxel,
        face: voxelViews[hit.face]!,
        color,
        contiguous: true,
        selection: selection ?? undefined,
        regions: selectionRegions.length ? selectionRegions : undefined,
      });
      return;
    }
    const pending = stroke.current;
    if (!pending) return;
    const n = voxelNormals[hit.face]!,
      axes = (["x", "y", "z"] as const).filter((_, i) => n[i] === 0);
    const low = -Math.floor((brush - 1) / 2),
      points: Point[] = [];
    for (let b = low; b < low + brush; b++)
      for (let a = low; a < low + brush; a++) {
        const q = { x: hit.voxel.x, y: hit.voxel.y, z: hit.voxel.z };
        q[axes[0]!] += a;
        q[axes[1]!] += b;
        if (
          Math.min(q.x, q.y, q.z) < 0 ||
          Math.max(q.x, q.y, q.z) >= model.size
        )
          continue;
        const k = `${q.x},${q.y},${q.z}/${hit.face}`;
        if (pending.seen.has(k)) continue;
        const exists = occupied.has(`${q.x},${q.y},${q.z}`);
        if (!exists || !insideSelection(q)) continue;
        pending.seen.add(k);
        points.push(q);
      }
    if (!points.length) return;
    if (selectedTool === "paint")
      pending.ops.push({
        type: "paint",
        points,
        face: voxelViews[hit.face]!,
        color,
      });
    if (selectedTool === "erase")
      pending.ops.push({ type: "set", points, color: null });
    if (selectedTool === "extrude")
      pending.ops.push({
        type: "extrude",
        points,
        face: voxelViews[hit.face]!,
        distance,
      });
    if (selectedTool === "add")
      pending.ops.push({
        type: "set",
        points: points.map((q) => ({
          x: q.x + n[0],
          y: q.y + n[1],
          z: q.z + n[2],
        })),
        color,
      });
    if (canvas.current && rendered) {
      const pointKeys = new Set(points.map((p) => `${p.x},${p.y},${p.z}`)),
        ctx = canvas.current.getContext("2d")!;
      ctx.fillStyle = selectedTool === "paint" ? color : "#81c7ff";
      for (let i = 0; i < rendered.hits.length; i++) {
        const id = rendered.hits[i]!;
        if (id < 0 || id % 6 !== hit.face) continue;
        const v = model.voxels[Math.floor(id / 6)]!;
        if (pointKeys.has(`${v.x},${v.y},${v.z}`))
          ctx.fillRect(
            i % rendered.width,
            Math.floor(i / rendered.width),
            1,
            1,
          );
      }
    }
    lastPoint.current = { voxel: hit.voxel, face: hit.face };
    setStatus(`${pending.seen.size} faces · release to apply stroke`);
  }
  async function finishStroke() {
    const pending = stroke.current;
    stroke.current = null;
    if (!pending?.ops.length || !model) return;
    // Collapse each tool/face into one operation, so a stroke has one undo entry.
    const groups = new Map<string, VoxelOperation>();
    for (const op of pending.ops) {
      const k = op.type + ("face" in op ? op.face : "");
      const old = groups.get(k);
      if (old && "points" in old && "points" in op)
        old.points.push(...op.points);
      else groups.set(k, op);
    }
    const ops = [...groups.values()];
    await work(async () => {
      try {
        const next = ops.reduce(applyVoxelOperation, model);
        await commit(next, "/operations", { operations: ops }, "PATCH");
      } catch (e) {
        if (canvas.current && rendered) paintCanvas(canvas.current, rendered);
        throw e;
      }
    });
  }
  function finishSelection(event: { clientX: number; clientY: number }) {
    const d = selectDrag.current;
    selectDrag.current = null;
    setSelectionRect(null);
    if (!d || !rendered || !canvas.current || !model) return;
    if (d.transform && d.bounds && d.hit) {
      const endPoint = planePoint(event, d.hit);
      const end = endPoint ? { voxel: endPoint.point } : null;
      if (end)
        operate({
          type: "transform",
          ...d.bounds,
          regions: selectionRegions.length ? selectionRegions : undefined,
          offset: {
            x: end.voxel.x - d.hit.x,
            y: end.voxel.y - d.hit.y,
            z: end.voxel.z - d.hit.z,
          },
          copy: d.copy,
        });
      return;
    }
    const rect = canvas.current.getBoundingClientRect(),
      points: Point[] = [];
    const x0 = Math.max(
        0,
        Math.floor(
          ((Math.min(d.clientX, event.clientX) - rect.left) * rendered.width) /
            rect.width,
        ),
      ),
      x1 = Math.min(
        rendered.width - 1,
        Math.floor(
          ((Math.max(d.clientX, event.clientX) - rect.left) * rendered.width) /
            rect.width,
        ),
      );
    const y0 = Math.max(
        0,
        Math.floor(
          ((Math.min(d.clientY, event.clientY) - rect.top) * rendered.height) /
            rect.height,
        ),
      ),
      y1 = Math.min(
        rendered.height - 1,
        Math.floor(
          ((Math.max(d.clientY, event.clientY) - rect.top) * rendered.height) /
            rect.height,
        ),
      );
    for (let y = y0; y <= y1; y++)
      for (let x = x0; x <= x1; x++) {
        const id = rendered.hits[x + y * rendered.width]!;
        if (id >= 0) points.push(model.voxels[Math.floor(id / 6)]!);
      }

    if (!points.length) {
      setSelection(null);
      return;
    }
    const bounds = {
      min: { x: 127, y: 127, z: 127 },
      max: { x: 0, y: 0, z: 0 },
    };
    for (const v of points)
      for (const a of ["x", "y", "z"] as const) {
        bounds.min[a] = Math.min(bounds.min[a], v[a]);
        bounds.max[a] = Math.max(bounds.max[a], v[a]);
      }
    if (throughSelection) {
      const a = (yaw * Math.PI) / 180,
        b = (pitch * Math.PI) / 180,
        eye = [
          Math.sin(a) * Math.cos(b),
          Math.sin(b),
          Math.cos(a) * Math.cos(b),
        ],
        axis = (["x", "y", "z"] as const)[
          eye.reduce(
            (best, v, i) => (Math.abs(v) > Math.abs(eye[best]!) ? i : best),
            0,
          )
        ]!;
      const others = (["x", "y", "z"] as const).filter((a) => a !== axis),
        depths = model.voxels
          .filter((v) =>
            others.every((a) => v[a] >= bounds.min[a] && v[a] <= bounds.max[a]),
          )
          .map((v) => v[axis]);
      if (depths.length) {
        bounds.min[axis] = depths.reduce((a, b) => Math.min(a, b), 127);
        bounds.max[axis] = depths.reduce((a, b) => Math.max(a, b), 0);
      }
    }
    const boxes =
      d.append && selection
        ? [
            ...(selectionRegions.length ? selectionRegions : [selection]),
            structuredClone(bounds),
          ]
        : [structuredClone(bounds)];
    setSelectionRegions(boxes.slice(-64));
    for (const box of boxes)
      for (const a of ["x", "y", "z"] as const) {
        bounds.min[a] = Math.min(bounds.min[a], box.min[a]);
        bounds.max[a] = Math.max(bounds.max[a], box.max[a]);
      }
    setSelection(bounds);
    setSelectionSize({
      x: bounds.max.x - bounds.min.x + 1,
      y: bounds.max.y - bounds.min.y + 1,
      z: bounds.max.z - bounds.min.z + 1,
    });
    setOffset({ x: 0, y: 0, z: 0 });
  }
  function addSource(view: VoxelView, grid: VoxelProjection) {
    if (grid.width !== grid.height || grid.width > 128)
      throw new Error(
        "Projection must be a square native grid up to 128 × 128.",
      );
    setSources((s) => ({ ...s, [view]: grid }));
    setStatus("Views changed · Build volume to apply");
  }
  async function undo() {
    if (runId) {
      const s = await request(runId, "/undo", "POST", {
        expectedRevision: state.revision,
      });
      setState(s);
      setSources(s.model?.projections ?? {});
    } else {
      setFuture((h) => [...h, model].slice(-12));
      const previous = history[history.length - 1] ?? null;
      setState({
        model: previous,
        revision: state.revision + 1,
        canUndo: history.length > 1,
        canRedo: true,
      });
      setSources(previous?.projections ?? {});
      setHistory((h) => h.slice(0, -1));
    }
  }
  async function redo() {
    if (runId) {
      const s = await request(runId, "/redo", "POST", {
        expectedRevision: state.revision,
      });
      setState(s);
      setSources(s.model?.projections ?? {});
    } else {
      const next = future[future.length - 1] ?? null;
      setHistory((h) => [...h, model].slice(-12));
      setFuture((h) => h.slice(0, -1));
      setState({
        model: next,
        revision: state.revision + 1,
        canUndo: true,
        canRedo: future.length > 1,
      });
      setSources(next?.projections ?? {});
    }
  }
  async function importModel(f: File) {
    if (f.size > 160_000_000) throw new Error("Model file is too large.");
    const raw = JSON.parse(await f.text());
    const next = Array.isArray(raw.voxelOverrides)
      ? await importPixzelsModel(raw, async (data) => {
          const bytes = Uint8Array.from(
            atob(data.slice(data.indexOf(",") + 1)),
            (c) => c.charCodeAt(0),
          );
          return readProjection(
            new Blob([bytes], { type: "image/png" }),
            false,
          );
        })
      : voxelModelSchema.parse(raw);
    await commit(next);
    setSources(next.projections);
    restoreSettings(next.settings);
    setSelection(null);
  }
  useEffect(() => {
    if (!active) return;
    const key = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement)?.closest("input,textarea,select")) return;
      if (e.code === "Space") {
        space.current = true;
        e.preventDefault();
      }
      if (e.key === "Escape") {
        setSelection(null);
        return;
      }
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "z") {
        e.preventDefault();
        if (e.shiftKey ? state.canRedo : state.canUndo)
          void work(e.shiftKey ? redo : undo);
        return;
      }
      if (e.key === "Backspace" || e.key === "Delete") {
        if (selection) {
          e.preventDefault();
          operate({ type: "delete", ...selection });
        }
        return;
      }
      const shortcuts: Record<string, string> = {
        p: "paint",
        b: "fill",
        e: "erase",
        m: "select",
        i: "pick",
        v: "add",
        x: "extrude",
        o: "orbit",
      };
      if (shortcuts[e.key.toLowerCase()])
        setTool(shortcuts[e.key.toLowerCase()]!);
      if (e.key === "[") setBrush((b) => Math.max(1, b - 1));
      if (e.key === "]") setBrush((b) => Math.min(16, b + 1));
      if (e.key.startsWith("Arrow")) {
        e.preventDefault();
        {
          if (e.key === "ArrowLeft") setYaw((y) => y - 45);
          if (e.key === "ArrowRight") setYaw((y) => y + 45);
          if (e.key === "ArrowUp") setPitch((p) => Math.min(90, p + 15));
          if (e.key === "ArrowDown") setPitch((p) => Math.max(-90, p - 15));
        }
      }
    };
    const up = (e: KeyboardEvent) => {
      if (e.code === "Space") space.current = false;
    };
    const blur = () => {
      space.current = false;
      stroke.current = null;
      drag.current = null;
      cameraDrag.current = null;
      selectDrag.current = null;
      setSelectionRect(null);
    };
    window.addEventListener("keydown", key);
    window.addEventListener("keyup", up);
    window.addEventListener("blur", blur);
    return () => {
      window.removeEventListener("keydown", key);
      window.removeEventListener("keyup", up);
      window.removeEventListener("blur", blur);
    };
  });
  const outputOptions = {
    width: outputSize,
    height: outputSize,
    yaw: 0,
    pitch,
    directions,
    shading,
    outline,
    outlineColor,
    edges,
    lightYaw,
    lightPitch,
  };
  return (
    <section
      className={`voxel-studio ${lightTheme ? "voxel-light" : ""}`}
      hidden={!active}
      aria-label="3D studio"
    >
      <header className="voxel-header">
        <div>
          <strong>
            Retrodex <span>3D</span>
          </strong>
          <small>Pixel views → voxel model → sprites</small>
        </div>
        <div className="voxel-actions">
          <span>{runId ? `r${state.revision}` : "Local session"}</span>
          <button
            onClick={() =>
              void work(async () => {
                if (runId) {
                  const s = await request(runId, "");
                  setState(s);
                  setSources(s.model?.projections ?? {});
                  setReady(true);
                  setStatus("Loaded latest revision");
                }
              })
            }
            disabled={!runId || busy}
          >
            Reload
          </button>
          <button onClick={() => setLightTheme((v) => !v)}>
            {lightTheme ? "Dark" : "Light"}
          </button>
          <button
            onClick={() =>
              void work(async () => {
                if (document.fullscreenElement) await document.exitFullscreen();
                else await document.documentElement.requestFullscreen();
              })
            }
          >
            Fullscreen
          </button>
          <button ref={closeButton} onClick={onClose}>
            Back to 2D
          </button>
        </div>
      </header>
      <div className="voxel-layout">
        <aside className="voxel-inputs">
          <h2>Workspace</h2>
          <label>
            Grid size{" "}
            <select
              aria-label="New grid size"
              value={newSize}
              onChange={(e) => setNewSize(Number(e.target.value))}
            >
              {[16, 32, 64, 128].map((n) => (
                <option key={n} value={n}>
                  {n}³
                </option>
              ))}
            </select>
          </label>
          <div className="voxel-row">
            <button
              disabled={busy}
              onClick={() =>
                void work(async () => {
                  await commit({
                    version: 1,
                    size: newSize,
                    palette: [color],
                    voxels: [],
                    projections: {},
                    recipe: {
                      algorithm: "silhouette-intersection-v1",
                      singleViewDepth: 1,
                    },
                  });
                  setSources({});
                  setSelection(null);
                })
              }
            >
              New blank
            </button>
            <button
              disabled={!model || busy}
              onClick={() =>
                operate({ type: "resize", size: newSize, anchor: "center" })
              }
            >
              Resize grid
            </button>
          </div>
          <h2>Source views</h2>
          <p>
            Same native size and aligned silhouette. Transparent pixels carve
            the volume.
          </p>
          <div className="voxel-projections">
            {voxelViews.map((view) => (
              <div className="voxel-projection" key={view}>
                <strong>{view}</strong>
                <ProjectionPreview grid={sources[view]} />
                <small>
                  {sources[view]
                    ? `${sources[view]!.width} × ${sources[view]!.height}`
                    : "PNG · native pixels"}
                </small>
                <div>
                  <label className="voxel-file">
                    Upload
                    <input
                      aria-label={`Upload ${view} projection`}
                      type="file"
                      accept="image/png"
                      disabled={busy}
                      onChange={(e) => {
                        const file = e.target.files?.[0];
                        e.target.value = "";
                        if (file)
                          void work(async () =>
                            addSource(view, await readProjection(file)),
                          );
                      }}
                    />
                  </label>
                  <button
                    title={`Use current frame as ${view}`}
                    disabled={busy}
                    onClick={() =>
                      void work(async () => {
                        const f = currentFrame();
                        addSource(view, {
                          width: f.size.width,
                          height: f.size.height,
                          cells: nativeProjectionCells(f.grid),
                        });
                      })
                    }
                  >
                    Frame
                  </button>
                  {sources[view] && (
                    <button
                      aria-label={`Remove ${view} projection`}
                      disabled={busy}
                      onClick={() =>
                        setSources((s) => {
                          const n = { ...s };
                          delete n[view];
                          return n;
                        })
                      }
                    >
                      ×
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>
          <label>
            Single-view depth{" "}
            <input
              aria-label="Single-view depth"
              type="number"
              min={1}
              max={128}
              value={depth}
              onChange={(e) => setDepth(Number(e.target.value))}
            />
          </label>
          <button
            className="voxel-primary"
            disabled={busy || !ready || !Object.keys(sources).length}
            onClick={build}
          >
            {busy ? "Working…" : "Build volume"}
          </button>
          <button
            disabled={busy || !ready}
            onClick={() =>
              void work(async () => {
                const projections = demoProjections();
                await commit(
                  buildVoxelModel({ size: 16, projections }),
                  "/build",
                  { size: 16, projections },
                  "POST",
                );
                setSources(projections);
              })
            }
          >
            Load demo robot
          </button>
          <label className="voxel-file">
            Import ORTHO · 6 views
            <input
              aria-label="Import ORTHO"
              type="file"
              accept="image/png"
              disabled={busy}
              onChange={(e) => {
                const f = e.target.files?.[0];
                e.target.value = "";
                if (f)
                  void work(async () => {
                    const views = splitOrtho(
                      await readProjection(f, true, true),
                    );
                    const next = buildVoxelModel({
                      size: views.front!.width,
                      projections: views,
                    });
                    await commit(next);
                    setSources(views);
                  });
              }}
            />
          </label>
          <h2>Reconstruct from model</h2>
          <button
            disabled={!model || busy}
            onClick={() =>
              operate({ type: "interpolate", views: "front-side" })
            }
          >
            Interpolate · front + side
          </button>
          <button
            disabled={!model || busy}
            onClick={() =>
              operate({ type: "interpolate", views: "front-side-top" })
            }
          >
            Interpolate · front + side + top
          </button>
          <h2>Example library</h2>
          <label className="voxel-file">
            Add Pixzels / Retrodex examples
            <input
              aria-label="Add example models"
              type="file"
              accept=".json"
              multiple
              onChange={(e) => {
                setGallery((g) => [
                  ...g,
                  ...Array.from(e.target.files ?? []).map((file) => ({
                    name: file.name.replace(/\.json$/, ""),
                    file,
                  })),
                ]);
                e.target.value = "";
              }}
            />
          </label>
          {gallery.map((item, i) => (
            <button
              key={i}
              disabled={busy}
              onClick={() => void work(() => importModel(item.file))}
            >
              {item.name}
            </button>
          ))}
          <p>Rebuilding replaces edits. Undo restores the previous model.</p>
        </aside>
        <main className="voxel-main">
          <div className="voxel-tools" aria-label="Voxel tools">
            {[
              "orbit",
              "paint",
              "add",
              "erase",
              "extrude",
              "pick",
              "fill",
              "select",
            ].map((t) => (
              <button
                key={t}
                aria-pressed={tool === t}
                onClick={() => setTool(t)}
              >
                {t}
              </button>
            ))}
            <button
              disabled={!state.canUndo || busy || !ready}
              onClick={() => void work(undo)}
            >
              Undo
            </button>
            <button
              disabled={!state.canRedo || busy || !ready}
              onClick={() => void work(redo)}
            >
              Redo
            </button>
            <label>
              Brush{" "}
              <input
                aria-label="Brush size"
                type="number"
                min={1}
                max={16}
                value={brush}
                onChange={(e) =>
                  setBrush(
                    Math.max(1, Math.min(16, Number(e.target.value) || 1)),
                  )
                }
              />
            </label>
            <input
              type="color"
              aria-label="Voxel color"
              value={color}
              onChange={(e) => setColor(e.target.value)}
            />
            {tool === "extrude" && (
              <label>
                Depth{" "}
                <input
                  aria-label="Extrusion distance"
                  type="number"
                  min={1}
                  max={128}
                  value={distance}
                  onChange={(e) => setDistance(Number(e.target.value))}
                />
              </label>
            )}
          </div>
          <div
            className={`voxel-viewport ${gridVisible ? "voxel-grid" : ""}`}
            style={{ backgroundColor: background }}
            onContextMenu={(e) => e.preventDefault()}
          >
            {model ? (
              <canvas
                ref={canvas}
                aria-label="Voxel model viewport"
                style={{ imageRendering: pixelMode ? "pixelated" : "auto" }}
                onWheel={(e) => {
                  e.preventDefault();
                  setZoom((z) =>
                    Math.max(0.1, Math.min(8, z * Math.exp(-e.deltaY * 0.002))),
                  );
                }}
                onPointerDown={(e) => {
                  if (busy) return;
                  e.preventDefault();
                  e.currentTarget.setPointerCapture(e.pointerId);
                  if (e.button === 1 || space.current) {
                    cameraDrag.current = {
                      x: e.clientX,
                      y: e.clientY,
                      pan,
                      zoom,
                      mode: e.metaKey ? "zoom" : "pan",
                    };
                    return;
                  }
                  if (tool === "orbit" || e.button === 2) {
                    drag.current = { x: e.clientX, y: e.clientY, yaw, pitch };
                    return;
                  }
                  if (e.button !== 0) return;
                  if (tool === "select") {
                    selectDrag.current = {
                      clientX: e.clientX,
                      clientY: e.clientY,
                      append: e.altKey,
                      transform: e.shiftKey || e.ctrlKey || e.metaKey,
                      copy: e.ctrlKey || e.metaKey,
                      bounds: selection,
                      hit: pick(e)?.voxel ?? null,
                    };
                    return;
                  }
                  const chosen = e.altKey
                    ? "pick"
                    : e.metaKey
                      ? "erase"
                      : e.ctrlKey
                        ? "extrude"
                        : tool;
                  if (chosen === "pick" || chosen === "fill") {
                    collect(e, chosen);
                    return;
                  }
                  stroke.current = {
                    ops: [],
                    seen: new Set(),
                    last: { clientX: e.clientX, clientY: e.clientY },
                    tool: chosen,
                  };
                  if (e.shiftKey && lastPoint.current && rendered) {
                    const previous = lastPoint.current.voxel,
                      r = e.currentTarget.getBoundingClientRect();
                    let index = rendered.hits.findIndex(
                      (id) =>
                        id >= 0 &&
                        model.voxels[Math.floor(id / 6)]?.x === previous.x &&
                        model.voxels[Math.floor(id / 6)]?.y === previous.y &&
                        model.voxels[Math.floor(id / 6)]?.z === previous.z,
                    );
                    if (index >= 0) {
                      const x =
                          r.left +
                          (((index % rendered.width) + 0.5) * r.width) /
                            rendered.width,
                        y =
                          r.top +
                          ((Math.floor(index / rendered.width) + 0.5) *
                            r.height) /
                            rendered.height,
                        steps = Math.ceil(
                          Math.hypot(e.clientX - x, e.clientY - y),
                        );
                      for (let i = 0; i <= steps; i++)
                        collect(
                          {
                            clientX:
                              x + ((e.clientX - x) * i) / Math.max(1, steps),
                            clientY:
                              y + ((e.clientY - y) * i) / Math.max(1, steps),
                          },
                          chosen,
                        );
                    }
                  } else collect(e, chosen);
                }}
                onPointerMove={(e) => {
                  if (cameraDrag.current) {
                    const d = cameraDrag.current,
                      r = e.currentTarget.getBoundingClientRect();
                    if (d.mode === "zoom")
                      setZoom(
                        Math.max(
                          0.1,
                          Math.min(
                            8,
                            d.zoom * Math.exp((e.clientY - d.y) * 0.01),
                          ),
                        ),
                      );
                    else
                      setPan({
                        x: Math.max(
                          -512,
                          Math.min(
                            512,
                            d.pan.x +
                              ((e.clientX - d.x) * (rendered?.width ?? 192)) /
                                r.width,
                          ),
                        ),
                        y: Math.max(
                          -512,
                          Math.min(
                            512,
                            d.pan.y +
                              ((e.clientY - d.y) * (rendered?.height ?? 192)) /
                                r.height,
                          ),
                        ),
                      });
                  } else if (drag.current) {
                    setYaw(
                      drag.current.yaw + (e.clientX - drag.current.x) * 0.5,
                    );
                    setPitch(
                      Math.max(
                        -90,
                        Math.min(
                          90,
                          drag.current.pitch +
                            (e.clientY - drag.current.y) * 0.4,
                        ),
                      ),
                    );
                  } else if (selectDrag.current) {
                    const r =
                        e.currentTarget.parentElement!.getBoundingClientRect(),
                      d = selectDrag.current;
                    setSelectionRect({
                      x: Math.min(d.clientX, e.clientX) - r.left,
                      y: Math.min(d.clientY, e.clientY) - r.top,
                      w: Math.abs(d.clientX - e.clientX),
                      h: Math.abs(d.clientY - e.clientY),
                    });
                  } else if (stroke.current) {
                    const d = stroke.current,
                      steps = Math.ceil(
                        Math.hypot(
                          e.clientX - d.last.clientX,
                          e.clientY - d.last.clientY,
                        ),
                      );
                    for (let i = 1; i <= steps; i++)
                      collect(
                        {
                          clientX:
                            d.last.clientX +
                            ((e.clientX - d.last.clientX) * i) / steps,
                          clientY:
                            d.last.clientY +
                            ((e.clientY - d.last.clientY) * i) / steps,
                        },
                        d.tool,
                      );
                    d.last = { clientX: e.clientX, clientY: e.clientY };
                  } else {
                    const h = pick(e);
                    setHover(
                      h
                        ? `${h.voxel.x}, ${h.voxel.y}, ${h.voxel.z} · ${voxelViews[h.face]}`
                        : "",
                    );
                  }
                }}
                onPointerUp={(e) => {
                  if (drag.current && viewLock) {
                    setYaw((y) => Math.round(y / 45) * 45);
                    setPitch((p) => Math.round(p / 45) * 45);
                  }
                  drag.current = null;
                  cameraDrag.current = null;
                  if (selectDrag.current) finishSelection(e);
                  void finishStroke();
                }}
                onPointerCancel={() => {
                  drag.current = null;
                  cameraDrag.current = null;
                  stroke.current = null;
                  selectDrag.current = null;
                  setSelectionRect(null);
                }}
              />
            ) : (
              <div className="voxel-empty">
                <strong>Give your pixels depth.</strong>
                <p>
                  Upload matching views, use a frame,
                  <br />
                  or load the demo to explore the tools.
                </p>
              </div>
            )}
            {selectionRect && (
              <div
                className="voxel-selection-rect"
                style={{
                  left: selectionRect.x,
                  top: selectionRect.y,
                  width: selectionRect.w,
                  height: selectionRect.h,
                }}
              />
            )}
            <span className="voxel-hover">
              {hover ||
                "Right-drag orbit · Space-drag pan · scroll zoom · Shift line · Alt pick"}
            </span>
          </div>
          <div className="voxel-camera">
            <label>
              Turn{" "}
              <input
                aria-label="Camera yaw"
                type="range"
                min={-180}
                max={180}
                value={((((yaw + 180) % 360) + 360) % 360) - 180}
                onChange={(e) => setYaw(Number(e.target.value))}
              />
            </label>
            <label>
              Tilt{" "}
              <input
                aria-label="Camera pitch"
                type="range"
                min={-89}
                max={89}
                value={pitch}
                onChange={(e) => setPitch(Number(e.target.value))}
              />
            </label>
            {[0, 90, 180, 270].map((a, i) => (
              <button
                key={a}
                onClick={() => {
                  setYaw(a);
                  setPitch(0);
                }}
              >
                {["Front", "Right", "Back", "Left"][i]}
              </button>
            ))}
            <button
              onClick={() => {
                setYaw(0);
                setPitch(90);
              }}
            >
              Top
            </button>
            <button
              onClick={() => {
                setYaw(0);
                setPitch(-90);
              }}
            >
              Bottom
            </button>
            {[45, 135, 225, 315].map((a) => (
              <button
                key={a}
                onClick={() => {
                  setYaw(a);
                  setPitch(20);
                }}
              >
                {a}°
              </button>
            ))}
          </div>
          <div className="voxel-display">
            <button
              aria-pressed={pixelMode}
              onClick={() => setPixelMode((v) => !v)}
            >
              Pixel art
            </button>
            <button
              aria-pressed={viewLock}
              onClick={() => setViewLock((v) => !v)}
            >
              Snap view
            </button>
            <button
              aria-pressed={gridVisible}
              onClick={() => setGridVisible((v) => !v)}
            >
              Grid
            </button>
            <button aria-pressed={edges} onClick={() => setEdges((v) => !v)}>
              Voxel edges
            </button>
            <button
              aria-pressed={outline}
              onClick={() => setOutline((v) => !v)}
            >
              Outline
            </button>
            <input
              aria-label="Outline color"
              type="color"
              value={outlineColor}
              onChange={(e) => setOutlineColor(e.target.value)}
            />
            <button
              aria-pressed={shading}
              onClick={() => setShading((v) => !v)}
            >
              Shading
            </button>
            <label>
              Background{" "}
              <input
                aria-label="Background color"
                type="color"
                value={background}
                onChange={(e) => setBackground(e.target.value)}
              />
            </label>
            <label>
              Zoom{" "}
              <input
                aria-label="Viewport zoom"
                type="range"
                min={0.1}
                max={8}
                step={0.1}
                value={zoom}
                onChange={(e) => setZoom(Number(e.target.value))}
              />
            </label>
            <button
              onClick={() => {
                setPan({ x: 0, y: 0 });
                setZoom(1);
              }}
            >
              Fit
            </button>
            {shading && (
              <>
                <label>
                  Light turn{" "}
                  <input
                    aria-label="Light yaw"
                    type="range"
                    min={-180}
                    max={180}
                    value={lightYaw}
                    onChange={(e) => setLightYaw(Number(e.target.value))}
                  />
                </label>
                <label>
                  Light tilt{" "}
                  <input
                    aria-label="Light pitch"
                    type="range"
                    min={-90}
                    max={90}
                    value={lightPitch}
                    onChange={(e) => setLightPitch(Number(e.target.value))}
                  />
                </label>
              </>
            )}
          </div>
          <div className="voxel-feedback" aria-live="polite">
            {error ? (
              <p role="alert" className="voxel-error">
                {error}
              </p>
            ) : (
              <p>
                {status || "3D edits and 2D frames have separate histories."}
              </p>
            )}
          </div>
        </main>
        <aside className="voxel-output">
          <h2>Model</h2>
          <dl>
            <dt>Grid</dt>
            <dd>{model ? `${model.size}³` : "—"}</dd>
            <dt>Voxels</dt>
            <dd>{inspection?.voxelCount.toLocaleString() ?? "—"}</dd>
            <dt>Surface faces</dt>
            <dd>{inspection?.surfaceFaces.toLocaleString() ?? "—"}</dd>
            <dt>Colors</dt>
            <dd>{inspection?.paletteColors ?? "—"}</dd>
          </dl>
          {inspection && (
            <div className="voxel-qc">
              <h3>Silhouette check</h3>
              {Object.entries(inspection.projections).map(([view, q]) => (
                <p key={view}>
                  {view}:{" "}
                  {q.missing || q.extra
                    ? `${q.missing} missing · ${q.extra} extra`
                    : "matches"}
                </p>
              ))}
            </div>
          )}
          <h2>Palette</h2>
          <div className="voxel-palette">
            {model?.palette.map((c) => (
              <button
                key={c}
                aria-label={`Choose ${c}`}
                title={c}
                style={{ background: c }}
                onClick={() => setColor(c)}
              />
            ))}
          </div>
          <input
            aria-label="Hex paint color"
            key={color}
            defaultValue={color}
            pattern="#[0-9a-fA-F]{6}"
            onKeyDown={(e) => {
              if (e.key === "Enter") e.currentTarget.blur();
            }}
            onBlur={(e) => {
              if (/^#[0-9a-fA-F]{6}$/.test(e.target.value))
                setColor(e.target.value);
            }}
          />
          <h2>Selection</h2>
          <label>
            <input
              type="checkbox"
              checked={throughSelection}
              onChange={(e) => setThroughSelection(e.target.checked)}
            />{" "}
            Through volume
          </label>
          <p>
            Drag a box. Alt adds a region; Shift drags voxels; Ctrl/Cmd drags a
            copy.
          </p>
          <button
            disabled={!model}
            onClick={() => {
              if (model) {
                const max = model.size - 1;
                setSelection({
                  min: { x: 0, y: 0, z: 0 },
                  max: { x: max, y: max, z: max },
                });
                setSelectionSize({
                  x: model.size,
                  y: model.size,
                  z: model.size,
                });
                setTool("select");
              }
            }}
          >
            Select all
          </button>
          {selection && (
            <div className="voxel-selection-controls">
              {(["x", "y", "z"] as const).map((a) => (
                <div key={a}>
                  <strong>{a.toUpperCase()}</strong>
                  <label>
                    Min
                    <input
                      aria-label={`Selection ${a} min`}
                      type="number"
                      min={0}
                      max={(model?.size ?? 128) - 1}
                      value={selection.min[a]}
                      onChange={(e) =>
                        setSelection((s) =>
                          s
                            ? {
                                ...s,
                                min: { ...s.min, [a]: Number(e.target.value) },
                              }
                            : s,
                        )
                      }
                    />
                  </label>
                  <label>
                    Max
                    <input
                      aria-label={`Selection ${a} max`}
                      type="number"
                      min={0}
                      max={(model?.size ?? 128) - 1}
                      value={selection.max[a]}
                      onChange={(e) =>
                        setSelection((s) =>
                          s
                            ? {
                                ...s,
                                max: { ...s.max, [a]: Number(e.target.value) },
                              }
                            : s,
                        )
                      }
                    />
                  </label>
                  <label>
                    Move
                    <input
                      aria-label={`Move selection ${a}`}
                      type="number"
                      value={offset[a]}
                      onChange={(e) =>
                        setOffset((v) => ({
                          ...v,
                          [a]: Number(e.target.value),
                        }))
                      }
                    />
                  </label>
                  <label>
                    Size
                    <input
                      aria-label={`Selection size ${a}`}
                      type="number"
                      min={1}
                      max={128}
                      value={selectionSize[a]}
                      onChange={(e) =>
                        setSelectionSize((v) => ({
                          ...v,
                          [a]: Number(e.target.value),
                        }))
                      }
                    />
                  </label>
                </div>
              ))}
              <div className="voxel-row">
                <button
                  disabled={busy}
                  onClick={() =>
                    operate({
                      type: "transform",
                      ...selection,
                      regions: selectionRegions.length
                        ? selectionRegions
                        : undefined,
                      offset,
                      copy: false,
                    })
                  }
                >
                  Move
                </button>
                <button
                  disabled={busy}
                  onClick={() =>
                    operate({
                      type: "transform",
                      ...selection,
                      regions: selectionRegions.length
                        ? selectionRegions
                        : undefined,
                      offset,
                      copy: true,
                    })
                  }
                >
                  Copy
                </button>
                <button
                  disabled={busy}
                  onClick={() =>
                    operate({
                      type: "transform",
                      ...selection,
                      regions: selectionRegions.length
                        ? selectionRegions
                        : undefined,
                      offset,
                      copy: false,
                      scale: selectionSize,
                    })
                  }
                >
                  Scale
                </button>
                <button
                  disabled={busy}
                  onClick={() => operate({ type: "delete", ...selection })}
                >
                  Delete
                </button>
                <button onClick={() => setSelection(null)}>Deselect</button>
              </div>
            </div>
          )}
          <h2>Symmetry</h2>
          <button
            disabled={!model || busy}
            onClick={() =>
              model &&
              operate({
                type: "mirror",
                axis: "x",
                min: { x: 0, y: 0, z: 0 },
                max: {
                  x: Math.floor((model.size - 1) / 2),
                  y: model.size - 1,
                  z: model.size - 1,
                },
              })
            }
          >
            Copy left half → right
          </button>
          <button
            disabled={!model || busy}
            onClick={() => operate({ type: "clear" })}
          >
            Clear model
          </button>
          <h2>Sprite output</h2>
          <label>
            Frame size{" "}
            <select
              aria-label="Export frame size"
              value={outputSize}
              onChange={(e) => setOutputSize(Number(e.target.value))}
            >
              {[16, 32, 48, 64, 128, 256, 512].map((n) => (
                <option key={n} value={n}>
                  {n} × {n}
                </option>
              ))}
            </select>
          </label>
          <label>
            GIF FPS{" "}
            <input
              aria-label="GIF frame rate"
              type="number"
              min={1}
              max={60}
              value={fps}
              onChange={(e) =>
                setFps(Math.max(1, Math.min(60, Number(e.target.value) || 8)))
              }
            />
          </label>
          <label>
            Directions{" "}
            <select
              aria-label="Render directions"
              value={directions}
              onChange={(e) =>
                setDirections(Number(e.target.value) as 1 | 8 | 16)
              }
            >
              <option value={1}>1</option>
              <option value={8}>8</option>
              <option value={16}>16</option>
            </select>
          </label>
          <p>
            {outputSize} × {outputSize} per frame · {Math.round(pitch)}° tilt
          </p>
          <button
            className="voxel-primary"
            disabled={!model || busy}
            onClick={() =>
              void work(async () => {
                if (model) {
                  onImport(
                    renderVoxelDirections(model, {
                      ...outputOptions,
                      width: canvasSize.width,
                      height: canvasSize.height,
                    }),
                  );
                }
              })
            }
          >
            Add views to 2D timeline · {canvasSize.width} × {canvasSize.height}
          </button>
          <button
            disabled={!model || busy}
            onClick={() =>
              void work(async () => {
                if (!model) return;
                const frames = renderVoxelDirections(model, outputOptions);
                const strip = document.createElement("canvas");
                strip.width = outputSize * frames.length;
                strip.height = outputSize;
                const ctx = strip.getContext("2d")!;
                frames.forEach((f, i) => {
                  const c = document.createElement("canvas");
                  paintCanvas(c, f);
                  ctx.drawImage(c, i * outputSize, 0);
                });
                const blob = await new Promise<Blob | null>((resolve) =>
                  strip.toBlob(resolve),
                );
                if (blob) download("voxel-directions.png", blob);
              })
            }
          >
            Download sprite sheet
          </button>
          <button
            disabled={!model || busy}
            onClick={() =>
              void work(async () => {
                if (model)
                  await savePNG(
                    "retrodex-snapshot.png",
                    renderVoxelModel(model, { ...outputOptions, yaw, pitch }),
                  );
              })
            }
          >
            Snapshot PNG
          </button>
          <button
            disabled={!model || busy}
            onClick={() =>
              void work(async () => {
                if (model)
                  saveGIF(
                    renderVoxelDirections(model, {
                      ...outputOptions,
                      directions: 16,
                    }),
                    fps,
                  );
              })
            }
          >
            Rotation GIF · 16 views
          </button>
          <button
            disabled={!model || busy}
            onClick={() =>
              void work(async () => {
                if (model) {
                  const size = Math.max(48, outputSize);
                  await savePNG(
                    "!Retrodex_RPGMaker.png",
                    composeSheet(
                      renderVoxelDirections(model, {
                        ...outputOptions,
                        width: size,
                        height: size,
                        directions: 16,
                      }),
                      true,
                    ),
                  );
                }
              })
            }
          >
            RPG Maker sheet
          </button>
          <button
            disabled={!model || busy}
            onClick={() =>
              void work(async () => {
                if (model) {
                  const p = projectVoxelModel(model);
                  await savePNG(
                    "retrodex-ortho.png",
                    composeSheet([
                      p.front,
                      p.right,
                      p.back,
                      p.left,
                      p.top,
                      p.bottom,
                    ]),
                  );
                }
              })
            }
          >
            ORTHO · 6 native views
          </button>
          <h2>Files</h2>
          <button
            disabled={!model || busy}
            onClick={() =>
              void work(async () => {
                if (model) await commit({ ...model, settings });
              })
            }
          >
            Save view settings
          </button>
          <button
            disabled={!model || busy}
            onClick={() =>
              model &&
              download(
                "retrodex-model.json",
                JSON.stringify({ ...model, settings }),
              )
            }
          >
            Save model JSON
          </button>
          <label className="voxel-file">
            Load JSON · Retrodex / Pixzels
            <input
              aria-label="Load model JSON"
              type="file"
              accept=".json"
              disabled={busy || !ready}
              onChange={(e) => {
                const f = e.target.files?.[0];
                e.target.value = "";
                if (f)
                  void work(async () => {
                    await importModel(f);
                  });
              }}
            />
          </label>
          <button
            disabled={!model || busy}
            onClick={() =>
              model &&
              download("model.obj", exportVoxelOBJ(model).obj, "text/plain")
            }
          >
            Download OBJ
          </button>
          <button
            disabled={!model || busy}
            onClick={() =>
              model &&
              download("model.mtl", exportVoxelOBJ(model).mtl, "text/plain")
            }
          >
            Download materials
          </button>
          <button
            disabled={!model || busy}
            onClick={() =>
              void work(async () => {
                if (model) {
                  const e = exportVoxelTexturedOBJ(model);
                  await textureBundle(e);
                }
              })
            }
          >
            Textured OBJ bundle · ZIP
          </button>
          <p>
            Keep model.obj and model.mtl together. Colors are stored per face.
          </p>
        </aside>
      </div>
    </section>
  );
}
