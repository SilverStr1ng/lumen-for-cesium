import http from "node:http";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
const root = fileURLToPath(new URL("../", import.meta.url));
const port = Number(process.env.LUMEN_PORT ?? 8090);
const base = (process.env.LUMEN_BASE_PATH ?? "").replace(/\/+$/, "");
if (base && (!base.startsWith("/") || base.includes(".."))) {
  throw new Error("LUMEN_BASE_PATH must be an absolute URL prefix");
}
const mime = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".mjs": "text/javascript",
  ".json": "application/json",
  ".gltf": "model/gltf+json",
  ".glb": "model/gltf-binary",
  ".bin": "application/octet-stream",
  ".css": "text/css",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".wasm": "application/wasm",
};
http
  .createServer(async (req, res) => {
    try {
      let name = decodeURIComponent(
        new URL(req.url, "http://localhost").pathname,
      );
      if (base) {
        if (name !== base && !name.startsWith(base + "/")) {
          res.writeHead(404);
          res.end("Outside deployment prefix");
          return;
        }
        name = name.slice(base.length) || "/";
      }
      if (name === "/") {
        res.writeHead(302, {
          Location: `${base}/demo/index.html${new URL(req.url, "http://localhost").search}`,
        });
        res.end();
        return;
      }
      const file = path.resolve(root, `.${name}`);
      const relative = path.relative(root, file);
      if (
        relative.startsWith("..") ||
        path.isAbsolute(relative) ||
        relative.split(path.sep).some((p) => p.startsWith("."))
      ) {
        res.writeHead(403);
        res.end();
        return;
      }
      const info = await stat(file);
      if (!info.isFile()) throw new Error("Not a file");
      res.writeHead(200, {
        "Content-Type": mime[path.extname(file)] ?? "application/octet-stream",
        "Content-Length": info.size,
        "Cache-Control": "no-store",
      });
      if (req.method === "HEAD") res.end();
      else createReadStream(file).pipe(res);
    } catch {
      res.writeHead(404);
      res.end("Not found");
    }
  })
  .listen(port, "127.0.0.1", () =>
    console.log(`Lumen for Cesium: http://localhost:${port}`),
  );
