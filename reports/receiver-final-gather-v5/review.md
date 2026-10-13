# R6 两轴审查

基线 9e0d920bdfaa3f56776ddc758a886259152b9ce0。两位独立审查代理只读源码和证据，不运行浏览器/GPU，主执行者拥有 Scene / World 状态机与实际测试。初审至 6734ec1，修复复审至 6b959a3 / 6d385d5，最终增量至 251c2d7（引擎修改2a9094b）。

## Standards

原发现：P2 快照 texture/FBO 未立即登记，失败后可能泄漏；P3 关闭后总新增成本仍显示旧值；新 ES6 资源类生命周期接口不符合 Cesium CodingGuide。规范依据 cesium-1.146/Documentation/Contributors/CodingGuide/README.md 的 Resources 部分。

复审：即时登记、FBO 原子回滚、实际存活资源成本重算已闭合。destroyLumenResource 显式登记不可枚举 class 方法后调用 Core destroyObject；销毁后方法抛 DeveloperError。Snapshot 仅保留迟到租约 release/destroy 的无操作清理例外。目标 ESLint 和纯 Node guard 验证通过；独立审查者未运行 GPU。

非阻塞判断：possible Feature Envy，Snapshot 与 World 私有 allocator/copy 状态耦合。此次保持单一 World 拥有权，未扩大为通用表面缓存接口。

## Spec

原发现：P1 深层 gather alpha=0 被解释为零间接光；P2 快照分配失败清理；P2 同 primitive、同 Ng、共面地板在窄隔墙两侧仍可能混合。

复审：三项已闭合。深层缺数据使整份 FG 无效，alpha0 与 Unknown -1、已知黑暗分开。世界 BVH 邻域检查在附近非共面三角形或预算耗尽时令重建权重为零，raw FG 没有被修改；全分辨率 ROI 精确读取当前像素。邻域半径采用实际低分辨率 viewport，保守覆盖重建足迹；新增4B/像素及 neighborhood GPU阶段被计账。未发现新轮次、冻结状态、辅助 pass 或拥有权漏洞。

审查者强调：保守保护扩大墙脚/柱脚的 DDGI 回退区域；最终画质与成本只能采用修复后的实际测量，不能沿用旧数字。低样本 held-out 生产画面仍 not-run；高采样 query 不替代该项。

最终增量：两位审查者核对Float32共面容差仍受0.2mm上界约束，无raw/求解反馈。Standards指出补丁遗漏pbrLighting与DynamicEnvironmentMapManager依赖；已补官方1.146原版基线，并实测22项补丁全部应用与目标源码一致。Spec指出候选质量门异常退出可能读取旧JSON；已要求三门实际exit0、报告passed，慢compare/capture/benchmark也进入总状态；26项真实子进程故障矩阵通过。二者确认新增阻断关闭。原版基线保留其原有空白，未改写原始内容。同步改灯忙帧GPU成本明确not-run。

两轴结论：Standards 的三个可执行边界已修复，保留一个非阻塞耦合判断；Spec 的三项可执行边界已修复，低采样画质失败依照验收结果保留。
