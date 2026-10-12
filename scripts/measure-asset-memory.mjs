import { mkdir, writeFile } from "node:fs/promises";
import { launchBrowser, sourceVersion } from "./browser-tools.mjs";

const report = { startedAt: new Date().toISOString(), version: sourceVersion(["lumen/bvh.js"]), scope: "Diagnostic reconstruction of retained typed arrays and decoded CPU RGBA images; excludes JS object/allocator overhead, browser caches and driver allocations", assets: [], status: "failed" };
const browser = await launchBrowser();
try {
  const page = await browser.newPage();
  report.browserDiagnostics = [];
  page.on("console", message => { if (message.type() === "error") report.browserDiagnostics.push(message.text()); });
  page.on("requestfailed", request => report.browserDiagnostics.push({ url: request.url(), error: request.failure()?.errorText }));
  // A real local response gives Chromium the correct loopback address space.
  // A synthetic fulfilled document incorrectly denied cross-port local fetches.
  await mkdir("artifacts", { recursive: true });
  await writeFile("artifacts/memory-diagnostic.html", '<!doctype html><title>Memory diagnostic</title><script src="/cesium-1.146/Build/CesiumUnminified/Cesium.js"></script>');
  await page.goto("http://localhost:8090/artifacts/memory-diagnostic.html");
  for (const asset of ["http://localhost:8090/fixtures/earth-pavilion.gltf", "http://localhost:8008/gltf/2.0/Sponza/glTF/Sponza.gltf"]) {
    report.assets.push(await page.evaluate(async asset => {
      const { loadGeometry } = await import("/lumen/gltf.js");
      const { BVH } = await import("/lumen/bvh.js");
      // Match the two entry pages: pavilion Z-up/X-forward; Sponza Y-up/X-forward.
      const axisMatrix = Cesium.Matrix4.toArray(asset.includes("Sponza") ? Cesium.Axis.Y_UP_TO_Z_UP : Cesium.Matrix4.IDENTITY);
      const geometry = await loadGeometry(asset, axisMatrix);
      const geometryArrays = Object.fromEntries(["positions", "uvs", "normals", "materialIds"].map(key => [key, geometry[key].byteLength]));
      const images = geometry.images.map(image => ({ width: image.width, height: image.height, bytes: image.data.byteLength }));
      const strategies = {};
      for (const strategy of ["median", "sah"]) {
        const bvh = new BVH(geometry, { strategy, bins: 12 });
        strategies[strategy] = {
          nodes: bvh.stats.nodes,
          arrays: Object.fromEntries(["bounds", "children", "order", "stack"].map(key => [key, bvh[key].byteLength])),
          persistentBytes: ["bounds", "children", "order", "stack"].reduce((sum,key)=>sum+bvh[key].byteLength,0),
        };
      }
      return { asset, axisMatrix, triangles: geometry.positions.length/9, geometryArrays, geometryBytes: Object.values(geometryArrays).reduce((a,b)=>a+b,0), images, decodedCpuTextureBytes: images.reduce((sum,image)=>sum+image.bytes,0), strategies };
    }, asset));
  }
  report.status = "passed";
} catch (error) { report.error = String(error); process.exitCode = 1; }
finally {
  await mkdir("reports/globe-visibility-v3", { recursive: true });
  await writeFile(`reports/globe-visibility-v3/asset-memory-${report.startedAt.replaceAll(/[:.]/g, "-")}.json`, JSON.stringify(report,null,2));
  await writeFile("reports/globe-visibility-v3/asset-memory.json", JSON.stringify(report,null,2));
  await browser.close();
}
console.log(report.status);
