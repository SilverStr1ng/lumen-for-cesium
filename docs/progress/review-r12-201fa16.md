# R12 冻结201fa16 · 两轴只读复核

测试源码 `201fa164c9cc5dcab9f806d3ddde0bea9185f0f6`。标准轴与规格轴分别只读审查；浏览器/GPU验证由主执行流程串行运行，未让审查者同时运行基准。本记录不等于独立硬件或人工外部认证。

## 已处理的必要问题

| 发现 | 处理与验证 |
| --- | --- |
| 网络内容证明使用不存在的phase=ready | 改为实际available阶段，并显式检查world.ready、无world.error、最终round3和相同requested/published revision |
| SHA等待期间可能替换/关闭scope | 先重算实际拥有bytes的SHA，再读取当前session/scope/generation/owned/closed/aborted；最小嵌入在证明后重取最终状态 |
| 两个缺失revision或三个缺失generation仍可能相等 | 版本与字节长度必须正safe integer，closed/aborted必须明确false；53项反例包含同时缺失、0/小数/Infinity/字符串、旧版本、错误请求身份、非200、非取消、脚本/Worker等 |
| 逐位比较double viewMatrix误报静止相机变化 | 独立复现同world/revision/profile下的每帧归一化漂移；射线改绑首个实际采集帧，每帧检查pose/投影/尺寸/拥有者和发布轮次。pose只容许64×机器精度的舍入，纯JS运动/投影/尺寸反例拒绝，冻结版完成全部40实际采集 |

网络取消始终保留原始requestfailed与CDP loadingFailed。只有同requestId、GET/Fetch/200/精确ERR_ABORTED+canceled、当前已提交会话scope、未取消、清单声明、完整字节长度和重算SHA全部匹配，才标记cancelled-with-verified-content。该标签不将原请求改写为成功；正式clean部署6项本次均无取消事件。

相机检查不是产品画质阈值；query12%/最终E20%不变。64×机器精度按位置尺度形成绝对舍入界限，不宣称逐分量严格64 ULP或通用屏幕像素误差保证。

## 结论边界

两轴对上述修正未留下必要阻断。最终发布结论仍由[正式验收](../../reports/local-gi-pilot-stabilization-v11/acceptance-20261015-frozen-5/acceptance.json)决定，不能用源码审查代替GPU/部署/长期证据。

现有光传输共同偏差保留：40案例34失败，含子区域失败；R10接触缓存和R8固定性能历史也保留。pilotReady/releaseReady仍为false。下一算法仅作为[后续摘要](next-task.md)中的提案，本轮没有实施新缓存、去噪器或路径算法。
