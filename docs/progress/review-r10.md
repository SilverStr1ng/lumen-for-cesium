# R10 双轴审查

固定点 `522201e5`；实现审查至 `604d7eb`，修复复核至 `eb6290a`。冻结源码 `c0f2ed8` 补充实测资源/销毁修复、成本及严格验收。审查员只读代码，浏览器实测由主验收执行。流程：[code-review](C:/Users/rakuyou/.codex/skills/code-review/SKILL.md)。规格来自用户请求及附带任务书，附带材料不作为独立授权。

## Standards

未发现阻断的书面标准违例；Cesium Scene 分层与显式清理沿用现有规则，工具执行的样式由 lint 检查。两项判断性边界问题：

1. Data Clumps / Shotgun Surgery：source request、geometry generation、revision 激活条件分散，旧 cache→immediate→cache 请求可能在新构建时恢复 FG。准备返回 token；rebuild/relight/切换端核对。复核确认修复。
2. Feature Envy：核心缓存依赖 Ball Pool getter 计账，普通场景 API 缺少保证。所有世界缓存纳入核心 additionalOwnedBytes，Auto/snapshot/preflight 使用，Ball Pool 减去展示重复项。复核确认修复。

实测随后发现 requested 已变化、settled 未更新的激活窗口，造成旧调用恢复 FG 和资源叠加。已核对两者，核心禁止构建期间重分配 FG；旧超限失败保留。新增 getter 暴露销毁桥接求值问题，桥接改为 prototype descriptor，销毁不求值 getter。正式运行验证这些修复。

## Spec

一项 P2：最后 GPU 分块 yield 后未核对取消，可能发布旧 ready。已在每次 yield 后和最终发布前核对 destroyed/snapshot，调用端核对 request/revision；复核确认修复。真实测试在最终实际 viewport 分块 yield 调用播放，验证旧缓存不能重新 ready。

复核认为 S0/S1/S2、triangle+bary 地址、源三角形排除、snapshot身份、Unknown/缺失区分、实验开关一致。补齐平行板/斜面、球地、双球2mm窄缝、同owner不同面/跨owner节点和低预算Unknown的解析/GPU检查。

画质和性能限制单独验收，不被审查通过掩盖。默认3轮60案例、有限1/2/3轮、原32r/16r、完整预计算/改灯/定格分别报告。失败与not-run保持非推荐。

最终复核 `c0f2ed8` 的核心 ownership/budget/getter 修复未发现新增阻断，但两轴都发现汇总器遗漏曲面子进程退出与原完整性条件的漏洞：即使数值通过，历史法线、无效query或后端不一致的子测试失败也可能被总表忽略。`c3ba35c` 将实际退出、完整60配置、必需区域、valid/Unknown、历史与split/fused纳入门禁，11项自测通过，未增加区域权重门限。候选经只读复核通过。

GPU执行源码仍是 `c0f2ed8`。修改前严格cached验证通过指纹检查并按实际失败返回1；修改后默认cached严格拒绝唯一汇总器源码变化。显式重查核对其余源码/构建/资产/全部证据与原Git blob，另存[更正汇总](../../reports/contact-transport-v9/acceptance-20261014/rechecked-verification.json)，原总表不覆盖，GPU未重跑。更正后仍有必需失败，recommended=false。

最终成本复核指出冻结后计时器可能未清空，应区分部分测量；正式数据初始化、改灯、冻结均pending/missing/disjoint=0，GPU各代完整列账。新像素验证工具的初次坐标API错误也独立保留，不当画质证据。

总计：Standards 2项判断性边界、Spec 1项发布竞态以及共同汇总阻断均已修复。两轴不合并排序。画质和性能失败不被审查通过掩盖。
