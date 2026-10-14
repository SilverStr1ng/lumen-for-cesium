await (async function generateUserReport() {
  const fs = await import("node:fs/promises");
  const root = "reports/ballpool-curved-receivers-v8";
  const run = root + "/acceptance-20261014-final-safe";
  const read = async (name) =>
    JSON.parse(await fs.readFile(run + "/" + name, "utf8"));
  const suite = await read("test-suite.json");
  const life = await read("ballpool.json");
  const desktop = await read("desktop.json");
  const curves = await read("curved.json");
  const temporal = await read("curved-temporal.json");
  const preview = await read("preview-performance.json");
  const files = (await fs.readdir(run)).filter(
    (x) => x.startsWith("performance-") && x.endsWith(".json"),
  );
  const mean = (a) => a.reduce((s, x) => s + x, 0) / a.length;
  const f = (x, n = 2) => (Number.isFinite(x) ? x.toFixed(n) : "not-run");
  const costs = [];
  for (const file of files) {
    const r = await read(file);
    const modes = {};
    for (const mode of [
      "ddgi",
      "fixed-raw",
      "decorrelated-raw",
      "reconstructed",
    ]) {
      const rows = r.rounds.filter((x) => x.mode === mode);
      const keys = [
        ...new Set(rows.flatMap((x) => Object.keys(x.components.means))),
      ];
      modes[mode] = {
        gpuP95Mean: mean(rows.map((x) => x.whole.gpuMilliseconds.p95)),
        cpuP95Mean: mean(rows.map((x) => x.whole.cpuMilliseconds.p95)),
        receiver: rows[0]?.metrics.receiverResolution,
        samples: rows[0]?.metrics.samples,
        fgFrames: rows.map((x) => [
          x.whole.actualFGFrames,
          x.whole.renderedFrames,
        ]),
        cachedFrames: rows.map((x) => x.cachedFrames),
        fallbackFrames: rows.map((x) => x.fallbackFrames),
        components: Object.fromEntries(
          keys.map((k) => [
            k,
            mean(rows.map((x) => x.components.means[k] ?? 0)),
          ]),
        ),
      };
    }
    costs.push({
      configuration: r.configuration,
      status: r.status,
      checks: r.checks,
      targets: r.targets,
      modes,
      file,
    });
  }
  const summary = {
    version: suite.version.head,
    states: suite.states,
    recommended: suite.recommended,
    costs,
    frozen: {
      coverage: life.frozen.coverage.meanWeight,
      independentNRMSE: life.frozen.independentNRMSE,
      rays: life.frozen.coverage.rayCounts,
      resources: life.frozen.state.resources,
      latency: life.frozen.state.latencies.at(-1),
    },
    desktop: desktop.rows.map((x) => ({
      count: x.count,
      buffer: x.actualBuffer,
      receiver: x.state.fg.receiverResolution,
      coverage: x.coverage.meanWeight,
      peakBytes: x.state.resources.peakAdditionalBytes,
      quality: x.qualityStatus,
      planningReason: x.state.fg.plan.reason,
      rejections: x.state.fg.plan.rejections,
    })),
    curved: {
      cases: curves.rows.length,
      failed: curves.failures.length,
      normalErrorDegrees: Math.max(
        ...curves.rows.map((x) => x.maxHistoryNormalDegrees),
      ),
    },
    preview: preview.rows.map((x) => ({
      count: x.count,
      gpuP95: x.whole.gpuMilliseconds.p95,
      cpuSubmissionP95: x.whole.cpuMilliseconds.p95,
      ticks: x.ticks,
    })),
    cpuScope:
      "preRender→postRender submission; physics/update excluded and reported separately",
  };
  await fs.writeFile(root + "/summary.json", JSON.stringify(summary, null, 2), {
    flag: "wx",
  });
  const label = {
    regression: "既有局部GI/R8回归",
    "fixed-quality-regression": "既有固定质量",
    "Auto-quality-regression": "既有桌面Auto质量",
    "temporal-regression": "既有时间质量",
    "curved-quality": "曲面静态及区域独立误差",
    "curved-temporal": "曲面时间质量",
    "ballpool-frozen-GI": "Ball Pool冻结GI",
    "physics-interaction": "物理交互",
    "snapshot-consistency": "快照一致性",
    resource: "资源预算",
    "fixed32-performance": "固定32r持续性能",
    "interactive-performance": "新16r档持续性能",
    "ballpool-static-performance": "球池静态持续性能",
    "physics-preview-performance": "物理预览性能",
    "snapshot-update-latency": "定格更新延迟记录",
    showcase: "Gallery与球池展示",
  };
  const phase = life.frozen.state.latencies.at(-1);
  const find = (scene, q, activity = "static") =>
    costs.find(
      (x) =>
        x.configuration.sceneName === scene &&
        x.configuration.quality === q &&
        x.configuration.activity === activity,
    );
  const pairRows = ["original", "gallery", "ballpool"].map((scene) => {
    const a = find(scene, scene === "ballpool" ? "auto" : "high"),
      b = find(scene, "interactive16");
    const d = a.modes.reconstructed,
      e = b.modes.reconstructed;
    return `| ${scene} | ${d.receiver.join("×")} / ${d.samples}r | ${f(d.gpuP95Mean)} | ${e.receiver.join("×")} / ${e.samples}r | ${f(e.gpuP95Mean)} | ${f(d.cpuP95Mean)} / ${f(e.cpuP95Mean)} |`;
  });
  const ball = find("ballpool", "auto");
  const ball16 = find("ballpool", "interactive16");
  const c = ball.modes.reconstructed.components;
  const contact = curves.rows.find(
    (x) =>
      x.count === 1 &&
      x.view === "contact" &&
      x.scenario === "day" &&
      x.seed === 0,
  );
  const contour = curves.rows.find(
    (x) =>
      x.count === 1 &&
      x.view === "close" &&
      x.scenario === "day" &&
      x.seed === 0,
  );
  const late16 = temporal.rows.filter(
    (x) => x.quality === "interactive16" && x.frame === 64,
  );
  const late32 = temporal.rows.filter(
    (x) => x.quality === "auto" && x.frame === 32,
  );
  const body = [
    "# R9 实现进度 · 2026-10-14",
    "",
    "Ball Pool 已能播放、暂停、投球并定格重算 GI；受控曲面接收已接通，近接触画质仍不达标。固定 32r 和新档性能按原门限分别记录，整体 `recommended=false`。",
    "",
    `分支：\`feat/ballpool-curved-receivers-v8\`。最终测试源码：\`${suite.version.head}\`。`,
    "审查基线 `818ef240debddf322dd4be7ec504e5709b2a8b8e` 保留；已完成八个阶段代码/测试提交。此文的报告提交可在本文件 Git 历史查询。",
    "",
    "## 现在可以打开",
    "",
    "`npm run setup` → `npm run build` → `npm start`。",
    "[Ball Pool](http://localhost:8090/demo/ballpool.html) 默认64球；[Gallery](http://localhost:8090/demo/gallery.html) 有入口。[证据展示页](http://localhost:8090/reports/ballpool-curved-receivers-v8/index.html) 可比较成本、桌面配置与三阶段截图。",
    "",
    "点击“播放物理”或“投球”开始运动；“暂停”只停止物理；点击“定格并更新 GI”后等待“静态 GI 就绪”。运动和重建期间显示预览，旧球位置的局部 GI 与历史已失效。太阳/天空可以调整；同机位可比较 DDGI、重建 FG、仅移除局部间接光。曝光固定1。",
    "",
    "## 能力边界",
    "",
    "| 能力 | 状态 | 当前验证范围 |",
    "|---|---|---|",
    "| 静态局部DDGI + FG | 已实现 | 原展馆、held-out、Gallery、受控球池 |",
    "| 改灯重算 | 已实现 | 太阳/天空；重建采用最新输入，revision/round快照对应 |",
    "| 光滑曲面接收 | 部分 | 不透明基础PBR球，半径0.34m；Ng/Ns与球体身份分开，近接触独立误差失败；命中侧仍为三角形Ng Lambert |",
    "| 时空重建 | 已实现 | 线性E、二维采样、原平面/薄墙几何保护；同球曲面邻域受限 |",
    "| 桌面资源规划 | 已实现 | Auto32 / Interactive16；64MiB附加预算含曲面指南、快照、已知场景CPU/GPU及WASM资源 |",
    "| 物理播放/暂停/投球/重置 | 已实现 | 本地Rapier 0.18.0确定性构建、固定步长；运动为基础照明预览 |",
    "| 运动中连续完整GI | 未实现 | 定格重建静态世界；无通用动态BVH |",
    "| 地形/Tiles GI | 未实现 | Globe提供背景，未参加局部GI |",
    "| 局部追踪镜面反射 | 未实现 | 高光来自Cesium环境IBL |",
    "",
    "## 分项验收",
    "",
    "| 关卡 | 最终状态 |",
    "|---|---|",
    ...Object.entries(suite.states).map(
      ([k, v]) => `| ${label[k] ?? k} | ${v} |`,
    ),
    "",
    "完整命令与 cached 都返回1；失败未隐藏。原R8历史持续性能14/18失败与 `recommended=false` 保留。球池单项通过不表示R8全系统性能通过。完整Cesium测试总集不在本轮这组局部GI回归范围内。",
    "",
    "## 实际质量与一致性",
    "",
    `64球运动后定格：球面FG平均权重 **${f(life.frozen.coverage.meanWeight * 100)}%**，独立8192路径参考E NRMSE **${f(life.frozen.independentNRMSE * 100)}%**。屏外彩球移除颜色后，同一冻结接收点E差模长 ${f(life.offscreen.magnitude, 5)}，证明屏外因果贡献。`,
    `生命周期${life.checks.length}项通过：冷启动销毁/重置、16→64→128→16、20次重算、快速请求、改灯竞态、失败重试和完整自有GL资源释放；生产同步读回为0。显示、物理、GI来自同一描述。`,
    ``,
    `曲面矩阵全部${curves.rows.length}案例已运行，${curves.failures.length}失败。单球day/close/seed0轮廓E NRMSE ${f(contour.regionErrors.foregroundContour.linearNRMSE * 100)}%；day/contact/seed0球地区域 ${f(contact.regionErrors.ballFloorContact.linearNRMSE * 100)}%，绝对RMSE ${f(contact.regionErrors.ballFloorContact.absoluteRMSE, 5)}线性E。该案例区域FG权重仅轮廓${f(contact.regions.foregroundContour.meanWeight * 100)}%、球地${f(contact.regions.ballFloorContact.meanWeight * 100)}%，不能用整体99%替代边缘结论。`,
    `同点1024r query的球地NRMSE ${f(contact.regionErrors.ballFloorContact.queryNRMSE * 100)}%，与重建偏差接近。由此推断现有稀疏DDGI命中侧输入是主要限制；这不是新输入算法已验证。原close机位、低位contact机位、失败边缘和测点都保留，区域门限仍20%。`,
    `Ng/Ns压缩历史指南最大角误差 ${f(summary.curved.normalErrorDegrees, 3)}°，受0.25°门限验证；局部位置保留FLOAT32。32r×32有效帧误差 ${f(Math.min(...late32.map((x) => x.error)) * 100)}–${f(Math.max(...late32.map((x) => x.error)) * 100)}%；16r×64有效帧 ${f(Math.min(...late16.map((x) => x.error)) * 100)}–${f(Math.max(...late16.map((x) => x.error)) * 100)}%。另有24个冷启动100/250/500/1000ms窗口；这个受控16球时间质量通过不能覆盖接触区静态失败。`,
    ``,
    "## 成本与资源",
    "",
    "实际设备：AMD Ryzen 7 9800X3D（8核/16线程）/ RTX 5080 / Chrome155 / ANGLE Direct3D11 / WebGL2。使用本地资产、无token、headless浏览器可见页面；这是实验窗口，未宣称独占GPU或手工前台帧率。",
    "",
    "1280×800、曝光1、2048阴影、2m DDGI网格/128探针射线/3反弹不变。表中P95是三轮P95的算术平均；每轮100个持续绘制帧，前20帧预热排除，GPU统计80帧；分组件60帧另外计时。16r属于不同质量/收敛取舍。",
    "",
    "| 静态场景 | 32r接收纹理 | GPU P95 ms | 16r接收纹理 | GPU P95 ms | CPU提交P95 32r/16r ms |",
    "|---|---|---:|---|---:|---:|",
    ...pairRows,
    "",
    "球池同构建A/B/C/D：",
    "",
    "| 档位 | DDGI A | fixed raw B | 去相关raw C | reconstructed D | D−B | D−A |",
    "|---|---:|---:|---:|---:|---:|---:|",
    ...[ball, ball16].map(
      (x) =>
        `| ${x.configuration.quality} | ${f(x.modes.ddgi.gpuP95Mean)} | ${f(x.modes["fixed-raw"].gpuP95Mean)} | ${f(x.modes["decorrelated-raw"].gpuP95Mean)} | ${f(x.modes.reconstructed.gpuP95Mean)} | ${f(x.targets.additionalReconstructionP95.value)} | ${f(x.targets.completeFGP95.value)} |`,
    ),
    "",
    `旧门限仍为D−B≤1ms、D−A≤3ms；Auto32球池结果 ${ball.status}，Interactive16球池结果 ${ball16.status}。持续窗口启用continuousSampling；实际FG帧、epoch和回退逐窗口保存，未以停止采样或全部DDGI回退计作收益。原展馆/Gallery的moving与relight完整矩阵见证据页。`,
    `球池32r组件均值：primary trace ${f(c.trace)}ms、secondary shade ${f(c.shade)}ms、forward ${f(c.forward)}ms；重建temporal+filter1+filter2合计 ${f((c.temporal ?? 0) + (c.filter1 ?? 0) + (c.filter2 ?? 0))}ms。它们是另一计时窗口，不能直接相加冒充整帧P95。`,
    ``,
    `同序列匹配失败的配置：${
      costs
        .filter((x) => x.checks?.sameSequence === false)
        .map(
          (x) =>
            `${x.configuration.sceneName}/${x.configuration.quality}/${x.configuration.activity}`,
        )
        .join("、") || "无"
    }。这些改灯窗口也作为失败保留，不能用其中C↔D时间差声明同样本收益。`,
    ``,
    `运动后定格64球的重建至照明CPU提交 ${f(phase.modelAndWorldMilliseconds)}ms，至目标32个有效FG帧 ${f(phase.convergedMilliseconds)}ms；墙钟及CPU发布记录，不代表GPU fence确认。该姿态实际primary ${life.frozen.coverage.rayCounts.actualPrimaryRays.toLocaleString("en-US")}、Ng背面已知零 ${life.frozen.coverage.rayCounts.knownZeroDirections.toLocaleString("en-US")}；solar记录为上界。诊断scratch ${life.frozen.coverage.rayCounts.scratchBytes}B。`,
    `已知拥有附加资源峰值 ${f(life.frozen.state.resources.peakAdditionalBytes / 1048576)}MiB：FG ${f(life.frozen.state.resources.fgBytes / 1048576)}、快照 ${f(life.frozen.state.resources.snapshots / 1048576)}、球池场景 ${f(life.frozen.state.resources.sceneBytes / 1048576)}MiB；场景包括GPU几何/环境、CPU Blob/BVH/顺序及物理WASM保留量。不是整个Cesium、JavaScript堆或驱动显存。`,
    "| 拥有资源分类（冻结64球） | MiB |",
    "|---|---:|",
    `| FG附件/历史（GPU） | ${f(life.frozen.state.resources.fgBytes / 1048576)} |`,
    `| round/material快照（GPU） | ${f(life.frozen.state.resources.snapshots / 1048576)} |`,
    `| 新增球池模型/环境/world几何（GPU） | ${f((life.frozen.state.resources.modelGpuBytes + life.frozen.state.resources.environmentGpuBytes + life.frozen.state.resources.worldGeometryBytes) / 1048576)} |`,
    `| Blob/Worker几何/BVH/主线程顺序（CPU） | ${f((life.frozen.state.resources.assetCpuBytes + life.frozen.state.resources.workerCpuBytes + life.frozen.state.resources.mainWorldCpuBytes) / 1048576)} |`,
    `| 物理WASM保留线性内存（CPU） | ${f(life.frozen.state.resources.physicsWasmReservedBytes / 1048576)} |`,
    "",
    `完整局部world的GPU资源另记录 ${f(life.frozen.state.resources.worldGpuBytes / 1048576)}MiB，含上表已经计入的几何；不能重复相加。既有DDGI探针资源不冒充新增FG预算。`,
    "",
    "CPU表值为preRender→postRender提交，物理步进单列，未包含更早的所有更新与节点同步开销。",
    "",
    "| 物理预览球数 | GPU P95 ms | CPU提交P95 ms | 实际物理步数 |",
    "|---|---:|---:|---:|",
    ...preview.rows.map(
      (x) =>
        `| ${x.count} | ${f(x.whole.gpuMilliseconds.p95)} | ${f(x.whole.cpuMilliseconds.p95)} | ${x.ticks} |`,
    ),
    "",
    "预览窗口至少1秒、120绘制帧；局部GI为预览0r，这些值不属于FG加速成果。不同球数独立窗口有调度/预热差异，不以其中高球数更低的数值推断性能趋势。",
    "",
    "| 球数 | 实际drawing buffer | Auto receiver/32r | 球面FG权重 | 附加峰值MiB | 压力质量 |",
    "|---|---|---|---:|---:|---|",
    ...summary.desktop.map(
      (x) =>
        `| ${x.count} | ${x.buffer.join("×")} | ${x.receiver.join("×")} / 32r | ${f(x.coverage * 100)}% | ${f(x.peakBytes / 1048576)} | ${x.quality} |`,
    ),
    "",
    "128球的640×360候选需要68,404,276B，超64MiB而被拒；更大候选还超primary+几何查询预算。Auto只调整FG接收纹理，主画面、阴影、DDGI网格及反弹保持公开值。资源通过不表示128球画质通过。",
    "",
    "## 当前建议与下一里程碑",
    "",
    "默认Auto适合查看受控静态演示；Interactive16用于比较较低每帧样本与更长收敛。两者都保留实验标记；128球为显式压力档。当前不推荐为全系统性能已达标的配置。",
    "",
    "1. 先解决近接触命中侧输入偏差，以同点query≤12%、重建区域≤20%验证，不修改原测点/门限。",
    "2. 降低固定32r的primary trace与secondary shade成本，继续使用原≤1ms/≤3ms门限和持续采样窗口。",
    "3. 提升128球压力档覆盖，维持64MiB与跨球/薄墙保护；推广曲面半径或拓扑前扩展独立几何参考。",
    "",
    "完整运动GI另需独立的运动查询、缓存失效、历史和异步生命周期设计，本轮未实现。",
    "",
    `来源：[最终严格总表](../../${run}/test-suite.json)、[交互与冻结证据](../../${run}/ballpool.json)、[曲面独立参考](../../${run}/curved.json)、[时间质量](../../${run}/curved-temporal.json)、[桌面Auto](../../${run}/desktop.json)、[双轴审查](review.md)。截图元数据保留相机、灯光、曝光、几何generation、world/FG revision与round、设备及源码/构建/资产指纹。`,
    "重跑：`node scripts/verify-r9.mjs --output=reports/ballpool-curved-receivers-v8/<新的批次名>`；cached附加`--cached`并使用原批次名。阶段脚本需设置新的`LUMEN_REPORT_DIRECTORY`，不要覆盖已有证据。",
    "",
    "未测量（not-run）：驱动物理VRAM、GPU汇编/寄存器、Worker JavaScript堆总开销、认证ion/World Terrain、完整运动中多反弹GI；Standards冷启动增量代理复查因服务容量错误not-run，Spec复查与生命周期实测已完成。",
    "",
  ].join("\n");
  await fs.writeFile(
    `docs/progress/2026-10-14-${suite.version.head.slice(0, 7)}.md`,
    body,
    { flag: "wx" },
  );
  await fs.writeFile("docs/progress/latest.md", body);
  console.log(
    JSON.stringify({
      source: suite.version.head,
      costs: costs.length,
      states: suite.states,
      report: `docs/progress/2026-10-14-${suite.version.head.slice(0, 7)}.md`,
    }),
  );
})();
