// Compute thresholds from measured numbers; never trust candidate statuses.
import { readFile, writeFile } from "node:fs/promises";
const out = "reports/fg-reconstruction-showcase-v6",
  injected = process.argv.includes("--inject-error");
const report = { checks: [], status: "not-run", injected };
const add = (name, actual, threshold, scope) =>
  report.checks.push({
    name,
    actual,
    threshold,
    scope,
    status:
      Number.isFinite(actual) && actual <= threshold ? "passed" : "failed",
  });
try {
  const c = JSON.parse(await readFile(out + "/canonical.json", "utf8")),
    s = JSON.parse(await readFile(out + "/screen/data.json", "utf8")),
    baseline = JSON.parse(
      await readFile(
        "reports/ddgi-visual-quality-v4/independent-reference.json",
        "utf8",
      ),
    );
  if (c.status !== "executed" || s.status !== "executed")
    throw Error("required acquisition did not complete");
  add(
    "all canonical configurations",
    c.cases.length === 12 ? 0 : 1,
    0,
    "16/32r; original/held-out; seeds 0/5/19",
  );
  const rmse = (diff) =>
    Math.sqrt(diff.reduce((a, b) => a + b * b, 0) / diff.length);
  report.lines = [];
  for (const item of c.cases)
    for (const [name, line] of Object.entries(item.lines)) {
      const final = line.frames.at(-1),
        indices = line.scoredIndices;
      const tag =
        (item.heldOut ? "held-out" : "original") +
        " " +
        item.samples +
        "r s" +
        item.seed +
        " " +
        name;
      add(
        tag + " all49",
        final.composite.length === 49 &&
          line.high
            .flat()
            .every(
              (x) =>
                x.valid &&
                !x.unknown &&
                x.revision === final.revision &&
                x.round === 3,
            ) &&
          line.frames.map((x) => x.frame).join(",") === "1,4,8,16,32"
          ? 0
          : 1,
        0,
        "all points and matching revision/round",
      );
      let error = rmse(
        indices.flatMap((i) =>
          final.composite[i].Eused.map(
            (v, k) => v - line.reference[i].D.irradiance[k],
          ),
        ),
      );
      if (injected && name === "pillarFoot") error = 10;
      const A = rmse(
        indices.flatMap((i) =>
          final.composite[i].A.irradiance.map(
            (v, k) => v - line.reference[i].D.irradiance[k],
          ),
        ),
      );
      const se = rmse(
          indices.flatMap((i) => line.reference[i].D.standardError),
        ),
        threshold = A + 3 * se;
      report.lines.push({
        heldOut: item.heldOut,
        samples: item.samples,
        seed: item.seed,
        name,
        rmse: error,
        A,
        se,
        coverage: final.composite.filter((x) => x.weight > 0.99).length / 49,
        all49rmse: rmse(
          final.composite.flatMap((x, i) =>
            x.Eused.map((v, k) => v - line.reference[i].D.irradiance[k]),
          ),
        ),
      });
      if (!item.heldOut) {
        add(
          tag + " absolute",
          error,
          baseline.composedError.before[name].rmse,
          "unchanged exact original absolute RMSE",
        );
        if (["pillarFoot", "boxFloor"].includes(name))
          add(
            tag + " relative",
            error,
            0.7 * baseline.composedError.after[name].rmse,
            "unchanged 30% improvement threshold",
          );
      }
      add(
        tag + " no regression",
        error,
        threshold,
        "current A + 3 RMS independent D SE; candidate variance never widens gate",
      );
      add(
        tag + " actual coverage",
        1 - final.composite.filter((x) => x.weight > 0.99).length / 49,
        0.05,
        "physical visible surface composite; not all DDGI",
      );
    }
  add(
    "57 required screen configurations",
    s.cases.length === 57 ? 0 : 1,
    0,
    "original/held-out 16/32r; Gallery; slanted thin wall; full ROI and quarter resolution",
  );
  report.roi = [];
  for (const item of s.cases) {
    const first = item.frameStats[0],
      last = item.frameStats.at(-1);
    add(
      item.name + " frames",
      item.frameStats.map((x) => x.frame).join(",") === "1,4,8,16,32" ? 0 : 1,
      0,
      "actual sampling epochs",
    );
    add(
      item.name + " nonempty ROI",
      last.roiPoints >= 2000 ? 0 : 1,
      0,
      "contiguous 64x48; no failed points deleted",
    );
    add(
      item.name + " convergence",
      last.filteredRmseC,
      0.5 * first.rawRmseC,
      "at least 50% reduction against same-round high FG at identical receiver positions",
    );
    if (item.quality !== "roi")
      add(
        item.name + " coverage",
        1 - last.coverage.meanWeight,
        0.05,
        "actual main Scene weight over supported full-resolution receiver pixels",
      );
    if (
      item.quality === "high" &&
      ["original", "held-out"].includes(item.scenario)
    )
      add(
        item.name + " total E no regression",
        last.EusedRmseD,
        last.DdgirmseD,
        "actual Scene E_used vs fresh 4096-path D",
      );
    if (item.scenario === "slanted-thin" && item.view === "right")
      add(
        item.name + " dark-side error",
        last.EusedRmseD,
        0.005,
        "independent closed-room D retained",
      );
    report.roi.push({
      name: item.name,
      raw: first.rawRmseC,
      filtered: last.filteredRmseC,
      reduction: 1 - last.filteredRmseC / first.rawRmseC,
      total: last.EusedRmseD,
      A: last.DdgirmseD,
      coverage: last.coverage.meanWeight,
    });
  }
  report.status = report.checks.every((x) => x.status === "passed")
    ? "passed"
    : "failed";
} catch (e) {
  report.status = "failed";
  report.error = e.stack;
}
await writeFile(
  out + "/quality" + (injected ? "-injected" : "") + ".json",
  JSON.stringify(report, null, 2),
);
console.log(
  JSON.stringify({
    status: report.status,
    checks: report.checks.length,
    failed: report.checks.filter((x) => x.status !== "passed"),
    error: report.error,
  }),
);
if (report.status !== "passed") process.exitCode = 1;
