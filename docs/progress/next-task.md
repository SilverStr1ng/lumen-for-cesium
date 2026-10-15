# R12 后续执行摘要 · Local GI v0.1 画质阻断

当前工作分支 `feat/local-gi-pilot-stabilization-v11`；正式测试源码 `67638369841a1ff2a8dbecddcca37f4ac0962503`。开始先核对实际HEAD与工作区，保留后续提交，不回退main、不自动合并。阶段完成提交并推送远端；新工作分支按用户下一轮指示创建。

先读 [用户报告](latest.md)、[不可变R12报告](2026-10-15-r12-6763836-final.md)、[40案例与区域明细](evidence/r12-6763836-quality.md)、[试点合同](../product/local-gi-v0.1.md)、[资源范围](../product/local-gi-resource-scope-v11.md)和[正式验收](../../reports/local-gi-pilot-stabilization-v11/acceptance-20261015-frozen-6-native-tabs/acceptance.json)。R12加权账本采用用户review的48.75/63.75，原baseline-v1权重、分母和理由保留；硬阻断不能被分数抵消。

现状：两个宿主、GLB、多资产、FG多目标、常驻代理、错误恢复、真实64MiB预留、部署及产品性能均可运行。40案例仍34失败（基础18/20、增强16/20），原物理目标与区域分母不变。长跑结论：passed。R10缓存仍实验，18/60最终像素与R8旧固定性能失败继续保留。

## 唯一下一算法方向

研究有界第二段路径积分，替换有证据偏高的命中DDGI余项；本轮R12没有实现这个新算法。不要再加缓存体系、去噪器或场景来回避既有失败。

1. 先复现三处代表点：overview/limestone、doorway/plaster、night-emitter/basalt。沿用同方向源项和独立路径余项替换；明确physical与legacy差异，不改physical参考。8192 GPU均值与32768独立参考、标准误、绝对误差和Unknown保留。
2. 候选显式可切换，与即时fgRadiance同样本/同快照比较。总路径最大反弹仍3，保持Ng/Ns、几何壁垒、owner/版本、线性E和Unknown拒绝合同；不能把probe-ray缓存当任意命中点余项，不能增加反弹或补天空。
3. 先证明三点误差改善，再跑原40案例及每区域query≤12%、最终E≤20%。固定像素网格和分母、全部困难区域继续保留；等待真实有效FG epoch。绝对误差与相对误差一起报告，不以整体平均刷过暗区。
4. 同条件计账GPU/CPU/实际帧间隔、改灯首版/最终版/像素响应、持续32r成本，以及新增暂存、快照和替换峰值。64MiB逻辑附加预算不变。降质量只能是另行公开的档位，不能称同质量加速。

## 交付与边界

继续复用现有session和Models/Tiles两宿主，不重建GLB、多资产、Tiles代理或业务状态机。真实HTTP失败/取消/恢复、两宿主各20次替换、50次LOD、30分钟原生标签页巡航改灯与后台恢复、clean根/非根部署继续运行。不得使用焦点仿真或停采样制造长跑通过；另行验证桌面窗口遮挡/OS合成器恢复，不能用headless标签恢复代替。

冻结源码后运行 `npm run test:r12`；cached必须核对相同HEAD、源码/运行构建/资产/合同/配置/配方和证据SHA。若后续只加报告，单独记录交付提交与冻结测试提交以及内容一致性；不能把候选或旧HEAD的passed继承给修复后HEAD。

诊断像素射线绑定首个实际渲染帧，每帧检查generation/world/revision/profile、发布轮次、相机pose、投影和drawingBuffer。相机只允许64×机器精度的pose舍入，不宣称通用屏幕误差保证；运动和跨帧版本变化仍失败。生产路径不得引入同步像素/缓冲读回。

必需failed非零，not-run阻止pilotReady；基础与增强档分开报告。新算法或本机30FPS通过不能改写R8固定32r的≤1/≤3ms性能关卡，也不能代表中端设备或全产品完成。持续运动GI、动态BVH、城市流式、地形GI、反射、Cards/SDF和WebGPU另立任务。

每轮维护2–4页用户报告、不可变版本、template和本摘要。报告必须给入口、操作、真实设备、质量与成本、资源峰值、投入使用阻断及下一里程碑；详细矩阵链接出去。
