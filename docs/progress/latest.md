# R9 实现进度 · 2026-10-14

Ball Pool 已能播放、暂停、投球并定格重算 GI；受控曲面接收已接通，近接触画质仍不达标。固定 32r 和新档性能按原门限分别记录，整体 `recommended=false`。

分支：`feat/ballpool-curved-receivers-v8`。最终测试源码：`93b5f2260593ca1348a034a10fb0027958ca0f46`。
审查基线 `818ef240debddf322dd4be7ec504e5709b2a8b8e` 保留；已完成八个阶段代码/测试提交。此文的报告提交可在本文件 Git 历史查询。

## 现在可以打开

`npm run setup` → `npm run build` → `npm start`。
[Ball Pool](http://localhost:8090/demo/ballpool.html) 默认64球；[Gallery](http://localhost:8090/demo/gallery.html) 有入口。[证据展示页](http://localhost:8090/reports/ballpool-curved-receivers-v8/index.html) 可比较成本、桌面配置与三阶段截图。

点击“播放物理”或“投球”开始运动；“暂停”只停止物理；点击“定格并更新 GI”后等待“静态 GI 就绪”。运动和重建期间显示预览，旧球位置的局部 GI 与历史已失效。太阳/天空可以调整；同机位可比较 DDGI、重建 FG、仅移除局部间接光。曝光固定1。

## 能力边界

| 能力                    | 状态   | 当前验证范围                                                                                    |
| ----------------------- | ------ | ----------------------------------------------------------------------------------------------- |
| 静态局部DDGI + FG       | 已实现 | 原展馆、held-out、Gallery、受控球池                                                             |
| 改灯重算                | 已实现 | 太阳/天空；重建采用最新输入，revision/round快照对应                                             |
| 光滑曲面接收            | 部分   | 不透明基础PBR球，半径0.34m；Ng/Ns与球体身份分开，近接触独立误差失败；命中侧仍为三角形Ng Lambert |
| 时空重建                | 已实现 | 线性E、二维采样、原平面/薄墙几何保护；同球曲面邻域受限                                          |
| 桌面资源规划            | 已实现 | Auto32 / Interactive16；64MiB附加预算含曲面指南、快照、已知场景CPU/GPU及WASM资源                |
| 物理播放/暂停/投球/重置 | 已实现 | 本地Rapier 0.18.0确定性构建、固定步长；运动为基础照明预览                                       |
| 运动中连续完整GI        | 未实现 | 定格重建静态世界；无通用动态BVH                                                                 |
| 地形/Tiles GI           | 未实现 | Globe提供背景，未参加局部GI                                                                     |
| 局部追踪镜面反射        | 未实现 | 高光来自Cesium环境IBL                                                                           |

## 分项验收

| 关卡                   | 最终状态 |
| ---------------------- | -------- |
| 既有局部GI/R8回归      | passed   |
| 既有固定质量           | passed   |
| 既有桌面Auto质量       | passed   |
| 既有时间质量           | passed   |
| 曲面静态及区域独立误差 | failed   |
| 曲面时间质量           | passed   |
| Ball Pool冻结GI        | passed   |
| 物理交互               | passed   |
| 快照一致性             | passed   |
| 资源预算               | passed   |
| 固定32r持续性能        | failed   |
| 新16r档持续性能        | failed   |
| 球池静态持续性能       | failed   |
| 物理预览性能           | passed   |
| 定格更新延迟记录       | passed   |
| Gallery与球池展示      | passed   |

完整命令与 cached 都返回1；失败未隐藏。原R8历史持续性能14/18失败与 `recommended=false` 保留。球池单项通过不表示R8全系统性能通过。完整Cesium测试总集不在本轮这组局部GI回归范围内。

## 实际质量与一致性

64球运动后定格：球面FG平均权重 **98.34%**，独立8192路径参考E NRMSE **10.10%**。屏外彩球移除颜色后，同一冻结接收点E差模长 0.03357，证明屏外因果贡献。
生命周期45项通过：冷启动销毁/重置、16→64→128→16、20次重算、快速请求、改灯竞态、失败重试和完整自有GL资源释放；生产同步读回为0。显示、物理、GI来自同一描述。

曲面矩阵全部60案例已运行，48失败。单球day/close/seed0轮廓E NRMSE 31.27%；day/contact/seed0球地区域 344.65%，绝对RMSE 0.33086线性E。该案例区域FG权重仅轮廓77.14%、球地89.66%，不能用整体99%替代边缘结论。
同点1024r query的球地NRMSE 343.41%，与重建偏差接近。由此推断现有稀疏DDGI命中侧输入是主要限制；这不是新输入算法已验证。原close机位、低位contact机位、失败边缘和测点都保留，区域门限仍20%。
区域完整统计（各列极值可能来自不同案例；原点集未删除）：

| 区域     | 已测案例 | 最小FG权重 | 最大E NRMSE | 最大绝对RMSE |
| -------- | -------: | ---------: | ----------: | -----------: |
| 前景轮廓 |       60 |     77.14% |     172.90% |       1.3381 |
| 球-地面  |       30 |     75.00% |     595.07% |       1.8172 |
| 球-球    |       30 |     85.81% |     126.57% |       0.6546 |

Ng/Ns压缩历史指南最大角误差 0.132°，受0.25°门限验证；局部位置保留FLOAT32。32r×32有效帧误差 3.50–3.53%；16r×64有效帧 3.49–3.60%。另有24个冷启动100/250/500/1000ms窗口；这个受控16球时间质量通过不能覆盖接触区静态失败。

## 成本与资源

实际设备：AMD Ryzen 7 9800X3D（8核/16线程）/ RTX 5080 / Chrome155 / ANGLE Direct3D11 / WebGL2。使用本地资产、无token、headless浏览器可见页面；这是实验窗口，未宣称独占GPU或手工前台帧率。

1280×800、曝光1、2048阴影、2m DDGI网格/128探针射线/3反弹不变。表中P95是三轮P95的算术平均；每轮100个持续绘制帧，前20帧预热排除，GPU统计80帧；分组件60帧另外计时。16r属于不同质量/收敛取舍。

| 静态场景 | 32r接收纹理   | GPU P95 ms | 16r接收纹理   | GPU P95 ms | CPU提交P95 32r/16r ms |
| -------- | ------------- | ---------: | ------------- | ---------: | --------------------: |
| original | 640×400 / 32r |       6.51 | 640×400 / 16r |       5.18 |           3.50 / 3.40 |
| gallery  | 640×400 / 32r |       8.66 | 640×400 / 16r |       5.64 |           3.53 / 3.60 |
| ballpool | 576×360 / 32r |       9.25 | 576×360 / 16r |       5.02 |           2.97 / 2.90 |

球池同构建A/B/C/D：

| 档位          | DDGI A | fixed raw B | 去相关raw C | reconstructed D |  D−B |  D−A |
| ------------- | -----: | ----------: | ----------: | --------------: | ---: | ---: |
| auto          |   2.08 |        8.66 |        8.97 |            9.25 | 0.59 | 7.17 |
| interactive16 |   3.32 |        4.77 |        5.09 |            5.02 | 0.24 | 1.69 |

旧门限仍为D−B≤1ms、D−A≤3ms；Auto32球池结果 failed，Interactive16球池结果 passed。持续窗口启用continuousSampling；实际FG帧、epoch和回退逐窗口保存，未以停止采样或全部DDGI回退计作收益。原展馆/Gallery的moving与relight完整矩阵见证据页。
球池32r组件均值：primary trace 4.80ms、secondary shade 2.70ms、forward 0.32ms；重建temporal+filter1+filter2合计 0.20ms。它们是另一计时窗口，不能直接相加冒充整帧P95。

同序列匹配失败的配置：gallery/high/relight、original/high/relight、original/interactive16/relight。这些改灯窗口也作为失败保留，不能用其中C↔D时间差声明同样本收益。

运动后定格64球的重建至照明CPU提交 405.20ms，至目标32个有效FG帧 700.80ms；墙钟及CPU发布记录，不代表GPU fence确认。该姿态实际primary 1,782,151、Ng背面已知零 1,145；solar记录为上界。诊断scratch 9216B。
已知拥有附加资源峰值 54.77MiB：FG 46.67、快照 0.39、球池场景 7.71MiB；场景包括GPU几何/环境、CPU Blob/BVH/顺序及物理WASM保留量。不是整个Cesium、JavaScript堆或驱动显存。

| 拥有资源分类（冻结64球）              |   MiB |
| ------------------------------------- | ----: |
| FG附件/历史（GPU）                    | 46.67 |
| round/material快照（GPU）             |  0.39 |
| 新增球池模型/环境/world几何（GPU）    |  2.83 |
| Blob/Worker几何/BVH/主线程顺序（CPU） |  3.14 |
| 物理WASM保留线性内存（CPU）           |  1.75 |

完整局部world的GPU资源另记录 4.56MiB，含上表已经计入的几何；不能重复相加。既有DDGI探针资源不冒充新增FG预算。

CPU表值为preRender→postRender提交，物理步进单列，未包含更早的所有更新与节点同步开销。

单窗补充测量（正式性能套件结束后，同一初始64球姿态）：

| 模式            | GPU P95 ms | Scene.render调用CPU墙钟P95 ms | 实际primary/帧 | FG帧/绘制帧 |
| --------------- | ---------: | ----------------------------: | -------------: | ----------- |
| auto            |       9.54 |                          3.10 |      1,782,155 | 120/120     |
| interactive16   |       5.58 |                          2.80 |        891,119 | 212/212     |
| physics-preview |       2.94 |                          2.10 |       0 · 预览 | 0/237       |

CPU范围包含preUpdate、物理、节点同步和渲染提交，排除widget resize/RAF/输入回调。计数覆盖全部接收表面（含地板/容器），不是仅球面。单窗GPU值有时序/预热差异，不替代正式三轮门限；solar仍只报上界。原始数据见[补充测量](../../reports/ballpool-curved-receivers-v8/supplementary/owned-costs.json)。

| 物理预览球数 | GPU P95 ms | CPU提交P95 ms | 实际物理步数 |
| ------------ | ---------: | ------------: | -----------: |
| 16           |       3.19 |          1.30 |           59 |
| 64           |       1.13 |          1.70 |           59 |
| 128          |       2.46 |          2.30 |           60 |

预览窗口至少1秒、120绘制帧；局部GI为预览0r，这些值不属于FG加速成果。不同球数独立窗口有调度/预热差异，不以其中高球数更低的数值推断性能趋势。

| 球数 | 实际drawing buffer | Auto receiver/32r | 球面FG权重 | 附加峰值MiB | 压力质量 |
| ---- | ------------------ | ----------------- | ---------: | ----------: | -------- |
| 16   | 1920×1080          | 640×360 / 32r     |     99.82% |       55.15 | passed   |
| 16   | 2560×1440          | 640×360 / 32r     |     99.79% |       55.15 | passed   |
| 64   | 1920×1080          | 640×360 / 32r     |     99.54% |       59.45 | passed   |
| 64   | 2560×1440          | 640×360 / 32r     |     99.48% |       59.45 | passed   |
| 128  | 1920×1080          | 576×324 / 32r     |     92.61% |       55.38 | failed   |
| 128  | 2560×1440          | 512×288 / 32r     |     92.85% |       46.57 | failed   |

128球的640×360候选需要68,404,276B，超64MiB而被拒；更大候选还超primary+几何查询预算。Auto只调整FG接收纹理，主画面、阴影、DDGI网格及反弹保持公开值。资源通过不表示128球画质通过。

## 当前建议与下一里程碑

默认Auto适合查看受控静态演示；Interactive16用于比较较低每帧样本与更长收敛。两者都保留实验标记；128球为显式压力档。当前不推荐为全系统性能已达标的配置。

1. 先解决近接触命中侧输入偏差，以同点query≤12%、重建区域≤20%验证，不修改原测点/门限。
2. 降低固定32r的primary trace与secondary shade成本，继续使用原≤1ms/≤3ms门限和持续采样窗口。
3. 提升128球压力档覆盖，维持64MiB与跨球/薄墙保护；推广曲面半径或拓扑前扩展独立几何参考。

完整运动GI另需独立的运动查询、缓存失效、历史和异步生命周期设计，本轮未实现。

来源：[最终严格总表](../../reports/ballpool-curved-receivers-v8/acceptance-20261014-final-safe/test-suite.json)、[交互与冻结证据](../../reports/ballpool-curved-receivers-v8/acceptance-20261014-final-safe/ballpool.json)、[曲面独立参考](../../reports/ballpool-curved-receivers-v8/acceptance-20261014-final-safe/curved.json)、[时间质量](../../reports/ballpool-curved-receivers-v8/acceptance-20261014-final-safe/curved-temporal.json)、[桌面Auto](../../reports/ballpool-curved-receivers-v8/acceptance-20261014-final-safe/desktop.json)、[双轴审查](review.md)。截图元数据保留相机、灯光、曝光、几何generation、world/FG revision与round、设备及源码/构建/资产指纹。
重跑：`node scripts/verify-r9.mjs --output=reports/ballpool-curved-receivers-v8/<新的批次名>`；cached附加`--cached`并使用原批次名。阶段脚本需设置新的`LUMEN_REPORT_DIRECTORY`，不要覆盖已有证据。

未测量（not-run）：驱动物理VRAM、GPU汇编/寄存器、Worker JavaScript堆总开销、认证ion/World Terrain、完整运动中多反弹GI；Standards冷启动增量代理复查因服务容量错误not-run，Spec复查与生命周期实测已完成。
