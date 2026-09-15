import { z } from "zod";

const point = z.object({ x: z.number().finite(), y: z.number().finite() });
export const drawingGuideSchema = z.object({
  reference: z.object({
    name: z.string().min(1).max(200),
    dataUrl: z.string().max(6_000_000).regex(/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/u),
    // Placement in canvas coordinates; the source image remains unmodified.
    x: z.number().finite(), y: z.number().finite(),
    width: z.number().positive().finite(), height: z.number().positive().finite(),
    opacity: z.number().min(0).max(1).default(0.45),
    overlay: z.boolean().default(false),
  }).nullable().default(null),
  landmarks: z.array(z.object({
    id: z.string().min(1).max(80), label: z.string().min(1).max(100),
    // Reference points use normalized source image coordinates, artwork points use canvas pixels.
    reference: z.object({ x: z.number().min(0).max(1), y: z.number().min(0).max(1) }).nullable(),
    artwork: point.nullable(),
  })).max(64).default([]),
  measurements: z.array(z.object({
    label: z.string().min(1).max(100), from: z.string(), to: z.string(),
    baselineFrom: z.string(), baselineTo: z.string(),
  })).max(64).default([]),
}).superRefine((guide, ctx) => {
  const ids = new Set(guide.landmarks.map((mark) => mark.id));
  if (ids.size !== guide.landmarks.length) ctx.addIssue({ code: "custom", message: "Landmark IDs must be unique" });
  for (const measurement of guide.measurements) {
    if ([measurement.from, measurement.to, measurement.baselineFrom, measurement.baselineTo].some((id) => !ids.has(id)))
      ctx.addIssue({ code: "custom", message: "Measurement references an unknown landmark" });
  }
});
export type DrawingGuide = z.infer<typeof drawingGuideSchema>;

export const createPortraitGuide = (): DrawingGuide => ({
  reference: null,
  landmarks: ([
    ["crown", "Top of hair"], ["hairline", "Hairline"], ["chin", "Chin"],
    ["leftEye", "Left eye"], ["rightEye", "Right eye"], ["nose", "Nose base"],
    ["leftShoulder", "Left shoulder"], ["rightShoulder", "Right shoulder"],
    ["leftTemple", "Left temple"], ["rightTemple", "Right temple"],
    ["leftHair", "Left hair edge"], ["rightHair", "Right hair edge"],
  ] as const).map(([id, label]) => ({ id, label, artwork: null, reference: null })),
  measurements: [
    { label: "Hair / face", from: "crown", to: "hairline" },
    { label: "Head width / face", from: "leftTemple", to: "rightTemple" },
    { label: "Hair width / face", from: "leftHair", to: "rightHair" },
    { label: "Eye spacing / face", from: "leftEye", to: "rightEye" },
    { label: "Shoulders / face", from: "leftShoulder", to: "rightShoulder" },
    { label: "Hairline–nose / face", from: "hairline", to: "nose" },
  ].map((item) => ({ ...item, baselineFrom: "hairline", baselineTo: "chin" })),
});

export function measureDrawingGuide(guide: DrawingGuide) {
  const position = (id: string, source: "reference" | "artwork") => {
    const p = guide.landmarks.find((mark) => mark.id === id)?.[source];
    if (!p || (source === "reference" && !guide.reference)) return null;
    return source === "reference" && guide.reference
      ? { x: p.x * guide.reference.width, y: p.y * guide.reference.height } : p;
  };
  const distance = (a: string, b: string, source: "reference" | "artwork") => {
    const p = position(a, source), q = position(b, source);
    return p && q ? Math.hypot(p.x - q.x, p.y - q.y) : null;
  };
  return guide.measurements.map((m) => {
    const ratio = (source: "reference" | "artwork") => {
      const length = distance(m.from, m.to, source);
      const baseline = distance(m.baselineFrom, m.baselineTo, source);
      return length !== null && baseline !== null && baseline > 0 ? length / baseline : null;
    };
    const reference = ratio("reference"), artwork = ratio("artwork");
    return { label: m.label, reference, artwork,
      deviationPercent: reference !== null && reference > 0 && artwork !== null ? (artwork / reference - 1) * 100 : null };
  });
}
