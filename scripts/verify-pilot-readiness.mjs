import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
const original = await readFile("docs/progress/readiness/baseline-v1.json");
const reviewed = await readFile("docs/progress/readiness/v10-review.json");
assert.equal(
  createHash("sha256").update(original).digest("hex"),
  "e4d27c5ab63f4e65ce76f728875f46c78af3c2bd3a15231abd1536f3d9f0d674",
);
assert.equal(
  createHash("sha256").update(reviewed).digest("hex"),
  "0f1561ea81d9b473dd0257010d48fe974c559954f98b69d15ba5a68273d2df3d",
);
const baseline = JSON.parse(original),
  review = JSON.parse(reviewed);
assert.deepEqual(review.anchors, baseline.anchors);
for (const [scope, expected, allowed] of [
  ["primary", 48.75, { assets: 50, tiles: 25 }],
  ["limitedPilot", 63.75, { assets: 50 }],
]) {
  const previous = baseline[scope].rows,
    rows = review[scope].rows;
  assert.equal(
    rows.reduce((sum, r) => sum + r.weight, 0),
    100,
  );
  assert.equal(rows.length, previous.length);
  for (const row of rows) {
    const old = previous.find((r) => r.id === row.id);
    assert.equal(row.weight, old.weight);
    assert.equal(row.maturity, allowed[row.id] ?? old.maturity);
    assert.equal(row.creditedPoints, (row.weight * row.maturity) / 100);
  }
  assert.equal(
    rows.reduce((sum, r) => sum + r.creditedPoints, 0),
    expected,
  );
  assert.equal(review[scope].scorePercent, expected);
}
assert.equal(review.releaseReady, false);
assert.equal(review.pilotReleaseReady, false);
console.log(
  "PASS immutable baseline-v1 weights/anchors; only reviewed asset/Tiles credits, 48.75/63.75; blockers remain binding",
);
