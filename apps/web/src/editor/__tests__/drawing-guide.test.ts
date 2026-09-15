import { describe, expect, it } from "vitest";
import { createPortraitGuide, drawingGuideSchema, measureDrawingGuide } from "@retrodex/contracts";

describe("proportion comparison", () => {
  it("normalizes different image scales and detects oversized hair", () => {
    const guide = createPortraitGuide();
    guide.reference = { name: "ref", dataUrl: "data:image/png;base64,YQ==", x: 70, y: -10, width: 200, height: 400, opacity: 0.5, overlay: true };
    for (const m of guide.landmarks) {
      if (m.id === "crown") { m.reference = { x: 0.5, y: 0 }; m.artwork = { x: 40, y: 0 }; }
      if (m.id === "hairline") { m.reference = { x: 0.5, y: 0.25 }; m.artwork = { x: 40, y: 50 }; }
      if (m.id === "chin") { m.reference = { x: 0.5, y: 0.75 }; m.artwork = { x: 40, y: 100 }; }
    }
    expect(measureDrawingGuide(guide)[0]).toMatchObject({ reference: 0.5, artwork: 1, deviationPercent: 100 });
    guide.reference.width *= 2; guide.reference.height *= 2;
    expect(measureDrawingGuide(guide)[0].deviationPercent).toBe(100);
    expect(measureDrawingGuide(guide)[1].deviationPercent).toBeNull();
    guide.landmarks.find((m) => m.id === "chin")!.artwork = { x: 40, y: 50 };
    expect(measureDrawingGuide(guide)[0].artwork).toBeNull();
  });
  it("rejects invalid sources, duplicate IDs and dangling measurements", () => {
    const guide = createPortraitGuide();
    expect(drawingGuideSchema.safeParse(guide).success).toBe(true);
    expect(drawingGuideSchema.safeParse({ ...guide, landmarks: [guide.landmarks[0], guide.landmarks[0]] }).success).toBe(false);
    expect(drawingGuideSchema.safeParse({ ...guide, landmarks: [] }).success).toBe(false);
    expect(drawingGuideSchema.safeParse({ ...guide, reference: { name: "bad", dataUrl: "javascript:alert(1)", x: 0, y: 0, width: 10, height: 10 } }).success).toBe(false);
  });
});
