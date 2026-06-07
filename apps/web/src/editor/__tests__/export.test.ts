import { gunzipSync } from "node:zlib";

import { describe, expect, it } from "vitest";

import {
  buildTgsLottieDocument,
  computeJsonExportScale,
  computeLottieFrameHold,
  createLottieExport,
  createReactExport,
  createSavedAnimationJson,
  createSvgExport,
  createTgsExportBlob,
  frameToSvgPaths,
  getExportDialogFrames,
  getExportFramesForScope,
  JSON_EXPORT_MAX_SIZE,
  LOTTIE_EXPORT_FPS,
  TGS_EXPORT_MAX_BYTES,
  TGS_LOTTIE_VERSION,
} from "../export/serializers";
import { createFrame } from "../grid";

describe("export serializers", () => {
  const frame = createFrame(
    { height: 2, width: 2 },
    ["#111111", null, "#ffffff", null],
    "frame-a"
  );
  const frameB = createFrame(
    { height: 2, width: 2 },
    [null, "#222222", null, null],
    "frame-b"
  );

  it("serializes SVG path runs and animation groups", () => {
    expect(frameToSvgPaths(frame, 2)).toContain(
      '<path fill="#111111" d="M0 0h2v2h-2z" />'
    );
    expect(
      frameToSvgPaths(
        createFrame({ height: 1, width: 1 }, ["rgba(0, 0, 0, 0.4)"], "alpha"),
        2
      )
    ).toContain('fill="#000000" fill-opacity="0.4"');
    expect(createSvgExport([frame, frameB], 2)).toContain(
      'shape-rendering="crispEdges"'
    );
  });

  it("serializes saved animation, lottie and react exports", () => {
    const saved = JSON.parse(
      createSavedAnimationJson([frame], 3, "json", "frame")
    );
    const jsonScale = computeJsonExportScale(frame.size);
    expect(saved.canvas).toEqual({
      height: frame.size.height * jsonScale,
      width: frame.size.width * jsonScale,
    });
    expect(saved.scale).toBe(jsonScale);
    expect(saved.targetMaxSize).toBe(JSON_EXPORT_MAX_SIZE);
    expect(saved.frames[0].grid).toHaveLength(frame.grid.length * jsonScale * jsonScale);

    const spriteFrame = createFrame(
      { height: 32, width: 32 },
      Array.from({ length: 32 * 32 }, () => "#111111"),
      "sprite"
    );
    const spriteExport = JSON.parse(
      createSavedAnimationJson([spriteFrame], 1, "json", "animation")
    );
    expect(spriteExport.canvas).toEqual({ height: 512, width: 512 });
    expect(spriteExport.scale).toBe(16);
    const lottieScale = computeJsonExportScale(frame.size);
    const lottie = JSON.parse(createLottieExport([frame], 2, 20));
    expect(lottie.w).toBe(frame.size.width * lottieScale);
    expect(lottie.h).toBe(frame.size.height * lottieScale);
    expect(lottie.layers.length).toBe(1);
    expect(lottie.fr).toBe(LOTTIE_EXPORT_FPS);
    expect(lottie.op).toBe(computeLottieFrameHold(20));
    expect(lottie.layers[0].ip).toBe(0);
    expect(lottie.layers[0].op).toBe(computeLottieFrameHold(20));
    expect(lottie.markers[0].cm).toContain("retrodex sourceFps=20");
    expect(lottie.markers[0].cm).toContain("exportFps=60");
    expect(lottie.markers[0].cm).toContain(`pixelScale=${lottieScale}`);
    expect(lottie.layers[0].ddd).toBe(0);
    expect(lottie.layers[0].ks.a).toEqual({ a: 0, k: [0, 0] });
    expect(lottie.layers[0].shapes[0].it[0].d).toBe(1);
    expect(lottie.layers[0].shapes[0].it[0].p).toEqual({
      a: 0,
      k: [lottieScale / 2, lottieScale / 2],
    });

    const spriteLottie = JSON.parse(createLottieExport([spriteFrame], 1, 20));
    expect(spriteLottie.w).toBe(512);
    expect(spriteLottie.h).toBe(512);
    expect(lottie.layers[0].shapes[0].it.at(-1).ty).toBe("tr");
    const lottieRaw = createLottieExport([frame], 2, 20);
    expect(lottieRaw).not.toContain("\n");

    const animation = JSON.parse(createLottieExport([frame, frameB], 2, 20));
    expect(animation.op).toBe(2 * computeLottieFrameHold(20));
    expect(animation.layers[1].ip).toBe(computeLottieFrameHold(20));
    expect(createReactExport([frame], 2)).toContain(
      "export function PixelAnimation"
    );
  });

  it("serializes Telegram TGS exports", async () => {
    const transparentFrame = createFrame(
      { height: 2, width: 2 },
      ["rgba(0, 0, 0, 0.4)", null, "#111111", null],
      "frame-alpha"
    );
    const tgs = buildTgsLottieDocument([transparentFrame], 20);
    expect(tgs.tgs).toBe(1);
    expect(tgs.ddd).toBe(0);
    expect(tgs.v).toBe(TGS_LOTTIE_VERSION);
    expect(tgs.w).toBe(512);
    expect(tgs.h).toBe(512);
    expect("markers" in tgs).toBe(false);
    expect(tgs.layers[0]?.ks).toEqual({});
    expect(tgs.layers[0]?.ao).toBe(0);
    expect(tgs.layers[0]?.bm).toBe(0);
    expect("np" in (tgs.layers[0]?.shapes[0] ?? {})).toBe(false);

    const alphaFill = tgs.layers[0]?.shapes[0]?.it.find(
      (item) => item.ty === "fl"
    ) as { c: { k: number[] }; o: { k: number } } | undefined;
    expect(alphaFill?.c.k).toEqual([0, 0, 0, 1]);
    expect(alphaFill?.o.k).toBe(0.4);

    const byteAlphaFrame = createFrame(
      { height: 1, width: 1 },
      ["rgba(0, 0, 0, 102)"],
      "frame-byte-alpha"
    );
    const byteAlphaTgs = buildTgsLottieDocument([byteAlphaFrame], 20);
    const byteAlphaFill = byteAlphaTgs.layers[0]?.shapes[0]?.it.find(
      (item) => item.ty === "fl"
    ) as { o: { k: number } } | undefined;
    expect(byteAlphaFill?.o.k).toBe(0.4);
    expect(JSON.stringify(buildTgsLottieDocument([transparentFrame], 20)).startsWith(
      '{"tgs":1'
    ));

    const blob = await createTgsExportBlob([frame], 1, 20);
    const bytes = new Uint8Array(await blob.arrayBuffer());
    expect(bytes.length).toBeLessThan(TGS_EXPORT_MAX_BYTES);
    const decoded = JSON.parse(gunzipSync(bytes).toString("utf8")) as {
      tgs: number;
      layers: Array<{
        shapes: Array<{ it: Array<{ ty: string; sk?: { a: number; k: number } }> }>;
      }>;
    };
    expect(decoded.tgs).toBe(1);
    expect(Object.keys(decoded)[0]).toBe("tgs");
    expect(decoded.layers[0]?.shapes[0]?.it.at(-1)?.sk).toEqual({ a: 0, k: 0 });
  });

  it("selects export frames and preview frame fallbacks", () => {
    expect(
      getExportFramesForScope([frame, frameB], "frame-b", "frame")
    ).toEqual([frameB]);
    expect(
      getExportFramesForScope([frame, frameB], "missing", "frame")
    ).toEqual([]);
    expect(getExportDialogFrames([], [frame])).toEqual([frame]);
    expect(getExportDialogFrames([frameB], [frame])).toEqual([frameB]);
  });
});
