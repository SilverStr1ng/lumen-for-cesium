import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
const root = "reports/ballpool-curved-receivers-v8",
  suite = JSON.parse(
    await readFile(root + "/acceptance-20261014-final-safe/test-suite.json"),
  ),
  supplement = JSON.parse(
    await readFile(root + "/supplementary/owned-costs.json"),
  );
assert.equal(supplement.status, "passed");
assert.equal(supplement.version.head, suite.version.head);
assert.equal(supplement.version.compiledBundle, suite.version.compiledBundle);
for (const [file, sha] of Object.entries(suite.version.sources))
  if (supplement.version.sources[file])
    assert.equal(supplement.version.sources[file], sha);
const f = (x) => x.toFixed(2),
  rows = supplement.rows.map(
    (r) =>
      `| ${r.quality} | ${f(r.whole.gpuMilliseconds.p95)} | ${f(r.fullSceneRenderCpu.p95)} | ${r.coverage?.rayCounts.actualPrimaryRays.toLocaleString("en-US") ?? "0 · 预览"} | ${r.whole.actualFGFrames}/${r.whole.renderedFrames} |`,
  ),
  section = [
    "单窗补充测量（正式性能套件结束后，同一初始64球姿态）：",
    "",
    "| 模式 | GPU P95 ms | Scene.render调用CPU墙钟P95 ms | 实际primary/帧 | FG帧/绘制帧 |",
    "|---|---:|---:|---:|---|",
    ...rows,
    "",
    "CPU范围包含preUpdate、物理、节点同步和渲染提交，排除widget resize/RAF/输入回调。计数覆盖全部接收表面（含地板/容器），不是仅球面。单窗GPU值有时序/预热差异，不替代正式三轮门限；solar仍只报上界。原始数据见[补充测量](../../reports/ballpool-curved-receivers-v8/supplementary/owned-costs.json)。",
    "",
  ].join("\n"),
  version = `docs/progress/2026-10-14-${suite.version.head.slice(0, 7)}.md`,
  latest = await readFile("docs/progress/latest.md", "utf8"),
  immutable = await readFile(version, "utf8");
assert.equal(latest, immutable);
assert(
  !latest.includes("单窗补充测量"),
  "This unpublished report draft was already finalized",
);
const text = latest.replace("| 物理预览球数 |", section + "\n| 物理预览球数 |");
assert.notEqual(latest, text);
await writeFile("docs/progress/latest.md", text);
await writeFile(version, text);
console.log(
  "Supplementary scopes and ray counts added before report publication.",
);
