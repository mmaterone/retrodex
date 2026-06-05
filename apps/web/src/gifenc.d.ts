declare module "gifenc" {
  export interface GifEncoder {
    bytes: () => Uint8Array;
    finish: () => void;
    writeFrame: (
      indexedPixels: Uint8Array,
      width: number,
      height: number,
      options: {
        delay?: number;
        palette: number[][];
      }
    ) => void;
  }

  export function GIFEncoder(): GifEncoder;
  export function applyPalette(
    pixels: Uint8Array | Uint8ClampedArray,
    palette: number[][]
  ): Uint8Array;
  export function quantize(
    pixels: Uint8Array | Uint8ClampedArray,
    maxColors: number
  ): number[][];

  const gifenc: {
    GIFEncoder: typeof GIFEncoder;
    applyPalette: typeof applyPalette;
    quantize: typeof quantize;
  };

  export default gifenc;
}
