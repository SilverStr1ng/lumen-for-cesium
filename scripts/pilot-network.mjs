// Deployment diagnostics only. Preserve CDP cancellation facts even when the
// current immutable dataset owns the full, independently rehashed content.
export function classifyDeploymentCancellation({
  request,
  response,
  failure,
  proof,
}) {
  const verified =
    request &&
    response &&
    failure &&
    proof &&
    request.requestId === response.requestId &&
    request.requestId === failure.requestId &&
    request.request.method === "GET" &&
    request.type === "Fetch" &&
    response.response.status === 200 &&
    response.response.url === request.request.url &&
    failure.errorText === "net::ERR_ABORTED" &&
    failure.canceled === true &&
    proof.uniqueRequest &&
    proof.uniqueCall &&
    proof.samePage &&
    proof.sameSession &&
    proof.sameScope &&
    proof.ready &&
    proof.generation === proof.committedGeneration &&
    proof.startedGeneration === proof.generation &&
    !proof.closed &&
    !proof.aborted &&
    proof.owned &&
    proof.url === request.request.url &&
    /^[0-9a-f]{64}$/.test(proof.expected ?? "") &&
    proof.bytes > 0 &&
    proof.bytes === proof.declaredBytes &&
    proof.actual === proof.expected;
  return verified ? "cancelled-with-verified-content" : "failed";
}

export async function observeDeploymentNetwork(page, dataset) {
  const session = await page.context().newCDPSession(page),
    requests = new Map(),
    responses = new Map(),
    failures = [];
  await session.send("Network.enable");
  session.on("Network.requestWillBeSent", (r) => requests.set(r.requestId, r));
  session.on("Network.responseReceived", (r) => responses.set(r.requestId, r));
  session.on("Network.loadingFailed", (r) => failures.push(r));
  await page.addInitScript(() => {
    const nativeFetch = window.fetch.bind(window);
    window.__deploymentNetwork = { page: {}, calls: [] };
    window.fetch = (...args) => {
      const state = window.__deploymentNetwork,
        s = window.pilotSession ?? window.embedded?.session;
      const call = {
        page: state.page,
        session: s,
        generation: s?.generation,
        scope:
          s?._pendingResources.get(s.generation)?.resources ?? s?._resources,
        signal: args[1]?.signal,
        url: new URL(String(args[0]), document.baseURI).href,
        started: performance.timeOrigin + performance.now(),
      };
      state.calls.push(call);
      return nativeFetch(...args).then((response) => {
        call.declaredBytes = Number(response.headers.get("content-length"));
        return response;
      });
    };
  });
  return async () => {
    const rows = [];
    for (const failure of failures) {
      const request = requests.get(failure.requestId),
        response = responses.get(failure.requestId),
        url = request?.request.url;
      const proof = url
        ? await page.evaluate(
            async ({ url, dataset }) => {
              const state = window.__deploymentNetwork,
                calls = state.calls.filter((c) => c.url === url),
                call = calls[0],
                s = window.pilotSession ?? window.embedded?.session,
                scope = s?._resources,
                entry = scope?.verified.get(url);
              const expected = Object.entries(
                s?.manifest?.resources ?? {},
              ).find(([uri]) => new URL(uri, dataset).href === url)?.[1];
              return {
                url,
                uniqueCall: calls.length === 1,
                samePage: !!call && call.page === state.page,
                sameSession: !!s && call?.session === s,
                sameScope: !!scope && call?.scope === scope,
                ready: !!s?.ready && s.phase === "available",
                phase: s?.phase,
                stage: s?.stage,
                generation: s?.generation,
                committedGeneration: s?._committedGeneration,
                startedGeneration: call?.generation,
                started: call?.started,
                closed: scope?.closed ?? true,
                aborted: !!(call?.signal?.aborted || scope?.signal?.aborted),
                owned: !!entry && scope.owned.has(entry),
                declaredBytes: call?.declaredBytes,
                bytes: entry?.bytes.byteLength ?? 0,
                expected,
                actual: entry
                  ? Array.from(
                      new Uint8Array(
                        await crypto.subtle.digest("SHA-256", entry.bytes),
                      ),
                      (b) => b.toString(16).padStart(2, "0"),
                    ).join("")
                  : undefined,
              };
            },
            { url, dataset },
          )
        : {};
      proof.uniqueRequest =
        !!request &&
        [...requests.values()].filter((r) => r.request.url === url).length ===
          1 &&
        Math.abs(request.wallTime * 1000 - proof.started) < 1000;
      const row = { request, response, failure, proof };
      rows.push({ ...row, outcome: classifyDeploymentCancellation(row) });
    }
    await session.detach();
    return rows;
  };
}
