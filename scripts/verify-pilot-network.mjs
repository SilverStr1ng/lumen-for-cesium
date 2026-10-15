import assert from "node:assert/strict";
import { classifyDeploymentCancellation as classify } from "./pilot-network.mjs";
const digest = "a".repeat(64),
  url = "http://local.invalid/a.glb";
const good = {
  request: { requestId: "1", type: "Fetch", request: { method: "GET", url } },
  response: { requestId: "1", response: { status: 200, url } },
  failure: { requestId: "1", canceled: true, errorText: "net::ERR_ABORTED" },
  proof: {
    uniqueRequest: true,
    uniqueCall: true,
    samePage: true,
    sameSession: true,
    sameScope: true,
    ready: true,
    worldReady: true,
    worldRound: 3,
    worldRevision: 1,
    worldPublishedRevision: 1,
    generation: 1,
    committedGeneration: 1,
    startedGeneration: 1,
    closed: false,
    aborted: false,
    owned: true,
    url,
    expected: digest,
    actual: digest,
    bytes: 4,
    declaredBytes: 4,
  },
};
assert.equal(classify(good), "cancelled-with-verified-content");
let rejected = 0;
function reject(change) {
  const candidate = structuredClone(good);
  change(candidate);
  assert.equal(classify(candidate), "failed");
  rejected++;
}
for (const field of [
  "uniqueRequest",
  "uniqueCall",
  "samePage",
  "sameSession",
  "sameScope",
  "ready",
  "owned",
  "worldReady",
])
  reject((r) => (r.proof[field] = false));
for (const field of ["closed", "aborted"])
  reject((r) => (r.proof[field] = true));
for (const field of ["generation", "startedGeneration", "committedGeneration"])
  reject((r) => (r.proof[field] = 2));
reject((r) => (r.proof.actual = "b".repeat(64)));
reject((r) => delete r.proof.expected);
reject((r) => (r.proof.bytes = 0));
reject((r) => (r.proof.declaredBytes = 8));
reject((r) => (r.proof.url += "x"));
reject((r) => (r.proof.worldRound = 2));
reject((r) => (r.proof.worldPublishedRevision = 2));
reject((r) => (r.proof.worldError = "Worker failed"));
for (const field of [
  "generation",
  "committedGeneration",
  "startedGeneration",
  "worldRevision",
  "worldPublishedRevision",
]) {
  reject((r) => delete r.proof[field]);
  reject((r) => (r.proof[field] = 0));
  reject((r) => (r.proof[field] = 0.5));
}
reject((r) => {
  delete r.proof.generation;
  delete r.proof.committedGeneration;
  delete r.proof.startedGeneration;
});
reject((r) => {
  delete r.proof.worldRevision;
  delete r.proof.worldPublishedRevision;
});
reject((r) => delete r.proof.closed);
reject((r) => delete r.proof.aborted);
reject((r) => (r.proof.bytes = r.proof.declaredBytes = Infinity));
reject((r) => (r.proof.bytes = r.proof.declaredBytes = "4"));
reject((r) => (r.response.requestId = "different"));
reject((r) => (r.failure.requestId = "different"));
reject((r) => (r.response.response.url += "x"));
reject((r) => (r.response.response.status = 404));
reject((r) => (r.failure.canceled = false));
reject((r) => (r.failure.errorText = "net::ERR_FAILED"));
reject((r) => (r.request.request.method = "POST"));
for (const type of ["Script", "Document", "Other", "Worker"])
  reject((r) => (r.request.type = type));
assert.equal(good.failure.errorText, "net::ERR_ABORTED");
console.log(
  JSON.stringify({
    status: "passed",
    positives: 1,
    rejected,
    scope:
      "content availability classification; raw cancellation remains a failure event",
  }),
);
