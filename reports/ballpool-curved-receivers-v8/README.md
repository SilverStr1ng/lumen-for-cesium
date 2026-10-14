# R9 · Ball Pool 与受控曲面接收

测试源码：`93b5f2260593ca1348a034a10fb0027958ca0f46`。
审查基线：`818ef240debddf322dd4be7ec504e5709b2a8b8e`；分支：`feat/ballpool-curved-receivers-v8`。

[打开球池](http://localhost:8090/demo/ballpool.html) · [交互证据页](http://localhost:8090/reports/ballpool-curved-receivers-v8/index.html) · [用户进度报告](../../docs/progress/latest.md) · [更新模板](../../docs/progress/template.md) · [下一步摘要](../../docs/progress/next-task.md)

最终批次为 [acceptance-20261014-final-safe/test-suite.json](acceptance-20261014-final-safe/test-suite.json)。
该批次分别记录既有回归/固定质量/Auto/时间质量、曲面画质、冻结GI、物理交互、快照一致性、资源、固定32r/新16r持续性能、物理预览、重算延迟及展示。
总体 `recommended=false`：60个受控曲面案例中48个独立区域误差失败；固定性能沿用旧 <=1ms / <=3ms 门限。
GPU计时为持续活动窗口，16r是独立质量/收敛取舍。

R8回归包装器使用 `--without-performance`，将性能明确标为not-run；本轮另行测14组性能配置。不能把这个包装器的非零退出误报为所有旧画质退化，也不能把新模块通过当成R8全系统性能通过。
[原R8总表](../fg-runtime-budget-v7/acceptance-20261014-final/test-suite.json)及历史14/18性能失败保持原内容。

## 可复现命令

```powershell
npm run setup
npm run build
npm start
node scripts/verify-r9.mjs --output=reports/ballpool-curved-receivers-v8/<新的批次名>
node scripts/verify-r9.mjs --cached --output=reports/ballpool-curved-receivers-v8/acceptance-20261014-final-safe
```

完整验收拒绝复用非空输出目录。cached验证源码、构建、资产、配置、所有必需产物的内容SHA及嵌套质量证据，随后派生状态；当前失败仍应退出1。
阶段脚本必须指定新的 `LUMEN_REPORT_DIRECTORY`。不要用默认阶段目录覆写旧证据。

`supplementary/measure-owned-costs.mjs` 在主套件结束后提供单独窗口：包含物理/节点同步的Scene.render调用CPU墙钟、实际primary射线数及资源。它不替代三轮正式GPU门限，已有输出不可覆盖。
`tools/write-progress.mjs` 从完成的正式产物生成数值表和版本化用户报告；已有版本化输出不可覆盖，latest是可更新入口。

## 阶段证据

| 目录                                                                                         | 角色与实际限制                                                  |
| -------------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| `initial` / `single-first`                                                                   | 初始化shader/早期覆盖诊断失败，保留原日志                       |
| `single-mask` / `duo-first` / `64-first`                                                     | 单球、同材质双球与64球接收检查；不替代独立区域验收              |
| `topology-first` / `temporal-first`                                                          | 真实拓扑和冷启动时间质量初测                                    |
| `lifecycle-first` / `lifecycle-patch` / `lifecycle-memory` / `lifecycle-disposal-diagnostic` | 早期覆盖、worker与GL释放失败/诊断记录                           |
| `lifecycle-causal`                                                                           | 屏外因果贡献、重算与完整GL释放修复验证                          |
| `curved-first`                                                                               | 部分执行后中断，未完成项not-run；不作完整通过证据               |
| `curved-patch`                                                                               | 早期球心点集结果，未含最终严格区域关卡                          |
| `performance-calibration`                                                                    | 阶段成本标定，固定32r失败；不替代最终顺序窗口                   |
| `review-patch`                                                                               | 计数切换、完整区域分母、query偏差与严格验收修复验证             |
| `cold-bootstrap`                                                                             | 延迟imagery的冷销毁/冷重置及原20次生命周期，44项通过            |
| `acceptance-20261014`                                                                        | 中断批次，原因见interrupted.json；不得拿旧running总表当最终结果 |
| `acceptance-20261014-final`                                                                  | 中断批次，R8先恢复旧报告后停止；lint失败与后续性能not-run保留   |
| `acceptance-20261014-final-safe`                                                             | 最终源93b5f22；严格区域与性能失败保留，全部必需状态以总表为准   |

图像用于展示；独立线性E参考、原始查询、全分辨率球面/区域分母、相机、灯光、generation、revision/round及资源字段均在JSON/deflate产物中。生产同步GPU读回为零，诊断读回明确在测试或用户请求的捕获中执行。

64MiB是已知逻辑拥有附加资源范围，包含FG、快照、新场景GPU/CPU及物理WASM保留量；不是整个Cesium、JavaScript堆或驱动物理VRAM。未测量字段标not-run。
