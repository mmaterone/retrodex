import { extractPalette } from "../../editor/reference-palette";
import { rgbToHex } from "../../editor/color";
import { useEffect, useRef, useState } from "react";
import { measureDrawingGuide } from "@retrodex/contracts";
import type { DrawingGuide } from "@retrodex/contracts";
import type { Bounds, Size } from "../../editor/types";
import "../../styles/drawing-guide.css";

type Mark = DrawingGuide["landmarks"][number];
export function GuideMarks({ guide, source, size }: { guide: DrawingGuide; source: "reference" | "artwork"; size: Size }) {
  return <>{guide.landmarks.map((mark, index) => {
    const point = mark[source];
    if (!point) return null;
    const x = source === "reference" && guide.reference ? guide.reference.x + point.x * guide.reference.width : point.x;
    const y = source === "reference" && guide.reference ? guide.reference.y + point.y * guide.reference.height : point.y;
    const radius = Math.max(size.width, size.height) / 90;
    return <g key={mark.id}><circle cx={x} cy={y} r={radius} fill="#e7b75c" stroke="#17181c" strokeWidth={radius / 3} /><text x={x + radius * 1.5} y={y} fontSize={radius * 3} fill="#fff" stroke="#17181c" strokeWidth={radius / 5} paintOrder="stroke">{index + 1}</text></g>;
  })}</>;
}
export function DrawingGuideOverlay({ guide, size }: { guide: DrawingGuide; size: Size }) {
  const ref = guide.reference;
  if (!ref?.overlay) return null;
  return <svg className="drawing-guide-overlay" viewBox={`0 0 ${size.width} ${size.height}`} aria-hidden="true">
    <image href={ref.dataUrl} x={ref.x} y={ref.y} width={ref.width} height={ref.height} preserveAspectRatio="none" opacity={ref.opacity} />
    <GuideMarks guide={guide} source="reference" size={size} />
    <GuideMarks guide={guide} source="artwork" size={size} />
  </svg>;
}

export function DrawingGuidePanel({ guide, size, artwork, onChange, onClose, status, onSave, onPickColor, isMinimized, onMinimize }: {
  guide: DrawingGuide; size: Size; artwork: string; onChange: (guide: DrawingGuide) => void; onClose: () => void; status: string; onSave: () => void; onPickColor: (color: string) => void; isMinimized: boolean; onMinimize: () => void;
}) {
  const [selected, setSelected] = useState(guide.landmarks[0]?.id ?? "");
  const [zoom, setZoom] = useState(1);
  const [error, setError] = useState("");
  const [pickColor, setPickColor] = useState(false);
  const [palette, setPalette] = useState<ReturnType<typeof extractPalette>>([]);
  const sourceImageRef = useRef<HTMLImageElement | null>(null);
  const panelRef = useRef<HTMLElement | null>(null);
  const dragRef = useRef<{ x: number; y: number } | null>(null);
  const [position, setPosition] = useState<{ x: number; y: number } | null>(null);
  useEffect(() => {
    let cancelled = false;
    sourceImageRef.current = null;
    setPalette([]);
    if (!guide.reference) return;
    const image = new Image();
    image.onload = () => { if (!cancelled) { sourceImageRef.current = image; setPalette(extractPalette(image)); } };
    image.src = guide.reference.dataUrl;
    return () => { cancelled = true; };
  }, [guide.reference?.dataUrl]);
  const fileRef = useRef<HTMLInputElement>(null);
  const reference = guide.reference;
  const updateReference = (patch: Partial<NonNullable<DrawingGuide["reference"]>>) => {
    if (reference) onChange({ ...guide, reference: { ...reference, ...patch } });
  };
  const updateMark = (source: "reference" | "artwork", point: Mark["artwork"]) => onChange({
    ...guide, landmarks: guide.landmarks.map((m) => m.id === selected ? { ...m, [source]: point } : m),
  });
  const load = async (file: File) => {
    setError("");
    if (!["image/png", "image/jpeg", "image/webp"].includes(file.type) || file.size > 4_000_000) {
      setError("Choose a PNG, JPEG or WebP smaller than 4 MB."); return;
    }
    try {
      const dataUrl = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader(); reader.onload = () => resolve(String(reader.result)); reader.onerror = reject; reader.readAsDataURL(file);
      });
      const image = new Image(); image.src = dataUrl; await image.decode();
      const fit = Math.min(size.width / image.width, size.height / image.height);
      onChange({ ...guide, landmarks: guide.landmarks.map((m) => ({ ...m, reference: null })), reference: {
        name: file.name, dataUrl, x: (size.width - image.width * fit) / 2, y: (size.height - image.height * fit) / 2,
        width: image.width * fit, height: image.height * fit, opacity: 0.45, overlay: true,
      } });
    } catch { setError("Could not open this image."); }
  };
  const mark = guide.landmarks.find((m) => m.id === selected);
  return <section ref={panelRef} className={`drawing-guide-panel${isMinimized ? " minimized" : ""}`} aria-label="Reference and proportions" style={position ? { left: position.x, top: position.y, right: "auto" } : undefined}>
    <header onPointerDown={(e) => {
      if ((e.target as Element).closest("button")) return;
      const rect = panelRef.current!.getBoundingClientRect();
      dragRef.current = { x: e.clientX - rect.left, y: e.clientY - rect.top };
      e.currentTarget.setPointerCapture(e.pointerId);
    }} onPointerMove={(e) => {
      if (!dragRef.current || !panelRef.current) return;
      setPosition({ x: Math.max(0, Math.min(window.innerWidth - panelRef.current.offsetWidth, e.clientX - dragRef.current.x)), y: Math.max(0, Math.min(window.innerHeight - 45, e.clientY - dragRef.current.y)) });
    }} onPointerUp={() => { dragRef.current = null; }} onPointerCancel={() => { dragRef.current = null; }}>
      <strong>Reference & proportions</strong><div className="guide-actions"><button type="button" onClick={onMinimize} aria-label={isMinimized ? "Expand reference" : "Minimize reference"}>{isMinimized ? "+" : "−"}</button><button type="button" onClick={onClose} aria-label="Close proportions">×</button></div>
    </header>
    {!isMinimized && <div className="drawing-guide-body">
      <div className="guide-actions"><button type="button" onClick={() => fileRef.current?.click()}>Open reference</button><span title={reference?.name}>{reference?.name ?? "No image"}</span></div>
      <input ref={fileRef} type="file" hidden accept="image/png,image/jpeg,image/webp" aria-label="Proportion reference file" onChange={(e) => { const file = e.target.files?.[0]; if (file) void load(file); e.target.value = ""; }} />
      {error && <p role="alert">{error}</p>}
      <div className="guide-actions"><button type="button" aria-pressed={pickColor} onClick={() => setPickColor(!pickColor)}>{pickColor ? "Pick color: on" : "Pick color"}</button><span>{pickColor ? "Click a reference pixel" : "Click to place landmarks"}</span></div>
      {palette.length > 0 && <div className="guide-palette" aria-label="Reference palette">{palette.map(({ color }) => <button key={color} type="button" title={color} aria-label={`Pick ${color}`} style={{ background: color }} onClick={() => onPickColor(color)} />)}</div>}
      <label className="guide-range">Compare zoom <input aria-label="Compare zoom" type="range" min="1" max="4" step="0.25" value={zoom} onChange={(e) => setZoom(Number(e.target.value))} /></label>
      <div className="guide-comparison-scroll"><div className="guide-comparison" style={{ width: `${zoom * 100}%` }}>
        {(["reference", "artwork"] as const).map((source) => <div key={source}><span>{source === "reference" ? "Reference" : "Drawing"}</span>
          <svg aria-label={`${source} landmarks`} role="img" viewBox={`0 0 ${size.width} ${size.height}`} onPointerDown={(e) => {
            if (!selected || (source === "reference" && !reference)) return;
            const rect = e.currentTarget.getBoundingClientRect();
            let x = (e.clientX - rect.left) / rect.width * size.width, y = (e.clientY - rect.top) / rect.height * size.height;
            if (source === "reference" && reference) { x = (x - reference.x) / reference.width; y = (y - reference.y) / reference.height; if (x < 0 || x > 1 || y < 0 || y > 1) return; }
            else { x = Math.round(x); y = Math.round(y); }
            if (pickColor) {
              if (source !== "reference" || !sourceImageRef.current) return;
              const image = sourceImageRef.current;
              const canvas = document.createElement("canvas"); canvas.width = 1; canvas.height = 1;
              const ctx = canvas.getContext("2d");
              if (!ctx) return;
              ctx.drawImage(image, Math.min(image.width - 1, Math.floor(x * image.width)), Math.min(image.height - 1, Math.floor(y * image.height)), 1, 1, 0, 0, 1, 1);
              const [r, g, b, a] = ctx.getImageData(0, 0, 1, 1).data;
              if (a) onPickColor(rgbToHex(r, g, b));
              return;
            }
            updateMark(source, { x, y });
          }}>
            {source === "reference" && reference && <image href={reference.dataUrl} x={reference.x} y={reference.y} width={reference.width} height={reference.height} preserveAspectRatio="none" />}
            {source === "artwork" && artwork && <image href={artwork} width={size.width} height={size.height} />}
            <GuideMarks guide={guide} source={source} size={size} />
          </svg>
        </div>)}
      </div></div>
      {reference && <fieldset><legend>Reference placement</legend>
        <div className="guide-fields">{(["x", "y", "width"] as const).map((key) => <label key={key}>{key === "width" ? "Width (px)" : key.toUpperCase()}<input aria-label={`Reference ${key}`} type="number" step="1" min={key === "width" ? 1 : undefined} value={Number(reference[key].toFixed(2))} onChange={(e) => {
          const value = e.target.valueAsNumber; if (!Number.isFinite(value) || (key === "width" && value <= 0)) return;
          updateReference(key === "width" ? { width: value, height: reference.height * value / reference.width } : { [key]: value });
        }} /></label>)}</div>
        <label><input type="checkbox" checked={reference.overlay} onChange={(e) => updateReference({ overlay: e.target.checked })} /> Overlay on canvas</label>
        <label className="guide-range">Opacity <input aria-label="Reference opacity" type="range" min="0" max="1" step="0.05" value={reference.opacity} onChange={(e) => updateReference({ opacity: Number(e.target.value) })} /></label>
      </fieldset>}
      <label>Landmark<select aria-label="Landmark" value={selected} onChange={(e) => setSelected(e.target.value)}>{guide.landmarks.map((m, i) => <option key={m.id} value={m.id}>{i + 1}. {m.label}</option>)}</select></label>
      <p>Choose a landmark, then click its position in each image. Face length is measured from hairline to chin. Recheck artwork points after editing anatomy.</p>
      {mark && <div className="guide-mark-fields">{(["reference", "artwork"] as const).map((source) => <fieldset key={source}><legend>{source === "reference" ? "Reference (0–1)" : "Drawing (px)"}</legend><div className="guide-fields">{(["x", "y"] as const).map((axis) => <label key={axis}>{axis.toUpperCase()}<input aria-label={`${source} landmark ${axis}`} type="number" step={source === "reference" ? 0.001 : 1} min={source === "reference" ? 0 : undefined} max={source === "reference" ? 1 : undefined} value={mark[source] ? Number(mark[source]![axis].toFixed(4)) : ""} onChange={(e) => {
        const value = e.target.valueAsNumber; if (!Number.isFinite(value) || (source === "reference" && (value < 0 || value > 1))) return;
        updateMark(source, { ...(mark[source] ?? { x: 0, y: 0 }), [axis]: value });
      }} /></label>)}</div><button type="button" onClick={() => updateMark(source, null)}>Clear point</button></fieldset>)}</div>}
      <table><caption>Proportions relative to face length</caption><thead><tr><th>Measure</th><th>Ref.</th><th>Drawing</th><th>Difference</th></tr></thead><tbody>{measureDrawingGuide(guide).map((m) => <tr key={m.label}><th>{m.label}</th><td>{m.reference?.toFixed(2) ?? "—"}</td><td>{m.artwork?.toFixed(2) ?? "—"}</td><td>{m.deviationPercent === null ? "—" : `${m.deviationPercent > 0 ? "+" : ""}${m.deviationPercent.toFixed(0)}%`}</td></tr>)}</tbody></table>
      <div className="guide-actions"><button type="button" onClick={onSave}>Save guide</button><p role="status">{status}</p></div>
    </div>}
  </section>;
}

export function SelectionProportions({ bounds, onApply }: { bounds: Bounds; onApply: (value: { width: number; height: number; x: number; y: number; rotation: number }) => void }) {
  const [value, setValue] = useState({ width: bounds.width, height: bounds.height, x: 0, y: 0, rotation: 0 });
  useEffect(() => setValue({ width: bounds.width, height: bounds.height, x: 0, y: 0, rotation: 0 }), [bounds.width, bounds.height, bounds.x, bounds.y]);
  return <form className="selection-proportions" aria-label="Selection proportions" onSubmit={(e) => { e.preventDefault(); onApply(value); }}>
    <strong>Selection proportions</strong><div className="guide-fields">{(["width", "height", "x", "y", "rotation"] as const).map((key) => <label key={key}>{({ width: "Width", height: "Height", x: "Move X", y: "Move Y", rotation: "Angle °" })[key]}<input required aria-label={`Selection ${key}`} type="number" min={key === "width" || key === "height" ? 1 : undefined} max={key === "width" || key === "height" ? 4096 : undefined} value={value[key]} onChange={(e) => setValue({ ...value, [key]: e.target.valueAsNumber })} /></label>)}</div>
    <button type="submit">Apply proportions</button><small>Centered · nearest pixel · Undo available</small>
  </form>;
}
