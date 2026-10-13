// Narrow Node decoder for our generated, non-interlaced RGBA8/filter-0 PNG
// fixtures. Browser/worker production still uses its native image APIs.
import { inflateSync } from "node:zlib";
export function installFixtureImageDecoder() {
  globalThis.createImageBitmap = async (blob) => {
    const b = Buffer.from(await blob.arrayBuffer());
    if (b.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a")
      throw Error("fixture reference requires PNG");
    let width, height;
    const idat = [];
    for (let p = 8; p < b.length;) {
      const n = b.readUInt32BE(p),
        type = b.toString("ascii", p + 4, p + 8),
        data = b.subarray(p + 8, p + 8 + n);
      if (type === "IHDR") {
        width = data.readUInt32BE(0);
        height = data.readUInt32BE(4);
        if (data[8] !== 8 || data[9] !== 6 || data[12] !== 0)
          throw Error("fixture PNG must be non-interlaced RGBA8");
      }
      if (type === "IDAT") idat.push(data);
      p += n + 12;
    }
    const raw = inflateSync(Buffer.concat(idat)),
      data = new Uint8ClampedArray(width * height * 4);
    for (let y = 0; y < height; y++) {
      const offset = y * (1 + width * 4);
      if (raw[offset] !== 0)
        throw Error("generated fixture PNG filter must be zero");
      data.set(raw.subarray(offset + 1, offset + 1 + width * 4), y * width * 4);
    }
    return { width, height, data, close() {} };
  };
  globalThis.OffscreenCanvas = class {
    constructor(width, height) {
      this.width = width;
      this.height = height;
    }
    getContext() {
      return {
        drawImage: (image) => {
          this.image = image;
        },
        getImageData: () => ({ data: this.image.data }),
      };
    }
  };
}
