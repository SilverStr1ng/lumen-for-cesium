# R10 · 接触光传输与静态表面候选

审查基线 `522201e5`，原被测源码 `93b5f22`。本轮分支 `feat/contact-transport-v9`。正式冻结源码与全部子进程记录见 [acceptance-20261014/test-suite.json](acceptance-20261014/test-suite.json)，结果不因单个新模块通过而自动推荐。

[球池](http://localhost:8090/demo/ballpool.html) · [显式缓存候选](http://localhost:8090/demo/ballpool.html?radianceSource=cache) · [legacy起点](http://localhost:8090/demo/ballpool.html?transport=legacy) · [展示页](http://localhost:8090/reports/contact-transport-v9/index.html) · [用户进度](../../docs/progress/latest.md) · [传输合同](../../docs/contact-transport.md)

```powershell
npm run setup
npm run build
npm start
npm run test:contact-transport
npm run test:r10 -- --output=reports/contact-transport-v9/<新目录>
node scripts/verify-r10.mjs --cached --output=reports/contact-transport-v9/acceptance-20261014
```

总验收拒绝非空输出；cached验证源码、bundle、资产、配置、本地Rapier依赖、全部产物与嵌套依赖内容SHA及子进程退出状态，并重新派生关卡。任一必需失败或not-run返回1。原60案例、原点集与分母、query12%/重建20%、曝光1、2m/128探针射线/3轮、64MiB、原32r/16r性能门限保留。physical与legacy物理参考同时输出；不覆盖旧报告。

## 正式证据

| 目录 | 内容与解释 |
| --- | --- |
| origin / geometry | 独立解析平板反例与真实GPU毫米/厘米平板、斜面、球地、双球2mm窄缝、不同面/owner、低预算Unknown |
| root-legacy / root-physical | 原单/双球day接触点同方向128r、1/2/3轮、第一命中/太阳/八探针支持；独立2048路径余项替换、8192参考；原始/时间/空间/最终E与覆盖 |
| surface-layout / surface-finite | 1/2/16/64布局与128预算拒绝；12种有限深度，24个实际缓存地址的独立表面L参考及原区域接收query；有效黑/缺失/Unknown分别计数 |
| quality-immediate / quality-cache | 原完整60矩阵与同条件控制；physical/legacy、原点/ROI分母、绝对/最大误差、SE、缓存使用/回退及全部失败 |
| temporal | 候选32r/16r目标有效样本、首帧/历史/100–1000ms窗口；不是同档加速声明 |
| cache-lifecycle / ballpool-lifecycle | source切换、requested/settled、最终分块取消、播放/暂停/定格、数量转换、冷bootstrap、GL/worker销毁与生产无读回 |
| desktop | 1920×1080和2560×1440实际Auto，16/64/128；缓存失败明确即时回退，压力覆盖不伪称通过 |
| regression | 原展馆/held-out/Gallery全回归/质量/时间/资源/展示。R8包装器performance=not-run，整体非零是预期；本轮另行测试性能 |
| performance-* | 原12组32r/16r×展馆/Gallery×静态/移动/改灯；原<=1ms/<=3ms门限及失败继续保留 |
| cache-cost | 同世界/receiver/样本的即时/缓存稳态三轮及60帧组件；初始化、缓存CPU/GPU各代、改灯忙帧、冻结与目标样本收敛单列完整账目 |

组件不能直接相加当全帧P95。跨帧缓存GPU构建不包含在忙帧时间戳之中，必须另外计入；source/revision变化的改灯窗口不用于纯开销增益结论。拥有资源CPU/GPU合计不是驱动物理VRAM，JS allocator及驱动VRAM未测标not-run。

## 阶段与失败证据

初始source诊断数组类型错误在 `root-cause-legacy`，已保留；`root-cause-legacy-typed` 有天空项错误，不用于正式归因；`root-cause-legacy-separated` 和 `root-cause-bounded` 为修正后的早期对照。

`cache-first` 发现分块PassState复用造成不完整代；`cache-viewport` 修复并保留前失败。`quality-quick-cache` 仅关键样例，不替代60矩阵。`lifecycle-first` 为验证API参数错误；`lifecycle-reviewed` 复现真实资源叠加超限；`lifecycle-budget-fixed` 暴露销毁getter问题；`lifecycle-owned` 修复后通过。所有正式结果以冻结源码目录为准。

`cost-quick` / `cost-diagnostic` 为测试向量API错误导致渲染停止，不能当性能数据；`cost-quick-fixed` 仅一轮预检。补丁导出自检新结果另存 `export-patch-reviewed.json`，旧默认历史报告恢复。`one-round-control` 补充相同有限一轮接收点的即时/缓存归因，不替代正式失败关卡。

工具 `tools/write-progress.mjs` 从正式产物生成summary及不可变用户版本；已有版本/summary不覆写。用户报告正文保持简短，详细矩阵在以上证据。
