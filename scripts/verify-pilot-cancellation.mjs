import assert from "node:assert/strict";
import LumenSession from "../lumen/LumenSession.js";

// Surface builders can reject with an ordinary error after world destruction.
// Neither that rejection nor a late success may publish into a newer session.
for (const outcome of ["resolve", "reject"]) {
  let complete, fail;
  const pending = new Promise((resolve, reject) => {
    complete = resolve;
    fail = reject;
  });
  const session = Object.create(LumenSession.prototype);
  Object.assign(session, {
    generation: 1,
    disposed: false,
    cache: "new-cache",
    _cacheFailure: "new-state",
    world: { buildSurfaceRadiance: () => pending },
    budget: { reserve: () => ({ release() {} }) },
  });
  const controller = new AbortController();
  const operation = session._experimental(controller.signal);
  session.generation++;
  controller.abort();
  if (outcome === "resolve") complete({ revision: "old" });
  else fail(Error("Superseded surface source"));
  await assert.rejects(operation, { name: "AbortError" });
  assert.equal(session.cache, "new-cache");
  assert.equal(session._cacheFailure, "new-state");
}
console.log(
  "PASS late cache success and ordinary supersession rejection preserve newer session state",
);
