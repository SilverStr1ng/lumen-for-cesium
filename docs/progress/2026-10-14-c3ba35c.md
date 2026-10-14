# R10 实现进度 · 2026-10-14

静态表面缓存改善了原接收纹理的输入，并降低命中着色成本；最终显示像素仍有18/60案例失败，一轮缓存和完整性能也未达标。完整验收 **failed / recommended=false**。缓存保持显式实验候选。

分支 `feat/contact-transport-v9`；测试源码 `c0f2ed8aed8cd106b170f765c82ff490ba08afc5`。基线 `522201e5` / 原被测源码 `93b5f22` 保留。汇总器在 `c3ba35c` 补充真实子进程失败与完整性门禁；[更正记录](../../reports/contact-transport-v9/acceptance-20261014/rechecked-verification.json)核对其余源码、构建、资产和证据未变，GPU未重跑。原汇总不覆写。实际交付提交见此文 Git 历史。

## 现在可以使用

`npm run setup` → `npm run build` → `npm start`。
[Ball Pool](http://localhost:8090/demo/ballpool.html) 仍默认即时参考；在“命中光照来源”选择“静态表面缓存”。也可[直接打开候选](http://localhost:8090/demo/ballpool.html?radianceSource=cache)。等待静态 GI 就绪后操作；播放/投球会失效旧局部 GI，暂停后点击“定格并更新 GI”。改灯和定格都需重新计算缓存。

[证据展示页](http://localhost:8090/reports/contact-transport-v9/index.html) · [完整矩阵](../../reports/contact-transport-v9/acceptance-20261014/quality-cache/curved.json) · [总验收](../../reports/contact-transport-v9/acceptance-20261014/test-suite.json)。复现用 `npm run test:r10 -- --output=reports/contact-transport-v9/<新目录>`；失败非零，旧目录不可覆写。

## 已完成与边界

| 能力 | 状态与限制 |
| --- | --- |
| 同方向源项归因 | 原单/双球 day 接触点，1/2/3轮；天空/自发光/太阳/上一轮DDGI分开，独立路径余项替换；不是全部案例唯一根因证明 |
| 受控起点修复 | 局部三角形误差包络、外扩ULP、仅排除源三角形；解析窄缝/斜面及真实GPU球地/双球通过；不声称任意退化几何证明 |
| 静态表面候选 | 真实表面生成 S0/S1/S2，独立原 triangle+bary微片元；不复制DDGI，不提高3轮、不跨owner/面借用；有限空间/采样近似仍需验收 |
| 生命周期与Auto | source token、geometry generation、requested/settled revision、最终分块取消、资源与销毁保护；总附加预算64MiB |
| 既有渲染与采样 | Ng/Ns、线性E、历史失效、几何壁垒、IBL policy及生产无同步读回保留；未新增去噪器 |
| 运动中完整多反弹GI | 未实现；播放仍为明确标注的物理预览，定格后一次静态世界重建 |

## 原接触点与全部关卡

原单球 day/contact/seed0 球地区域，旧接收纹理重建误差 344.65%；受控起点+即时余项 339.03%；候选 physical 接收纹理重建 **3.61%**、query **4.10%**，绝对E RMSE **0.00352**。对同一 legacy 参考候选重建为 3.81%、query 3.31%；两种基准和原始点集都保留。这个接收尺寸结果不能代表主画面每个像素。

归因限定原单/双球 day、同128方向：单球球地3轮即时误差338.56%，只替换相同第一命中的DDGI余项后6.46%；1轮20.32%不变，2轮430.95%→7.50%。这支持命中侧余项是这些点的主要限制，不证明全部案例只有这一原因。[源项与余项对照](../../reports/contact-transport-v9/acceptance-20261014/root-physical/root-cause-summary.json)保留天空、太阳、自发光、上一轮DDGI及独立路径。

原三轮接收纹理全部60案例：即时控制 48 个失败，候选 0 个失败。query12%、重建20%、原曝光/反弹/采样与区域分母不放宽。轮廓、球地、球球最差query分别8.62%、7.27%、3.97%，重建7.70%、7.29%、6.45%；区域平均FG权重最低77.14%、75.00%、85.81%。这不是区域全部覆盖；原分母保留，未用整体覆盖替代区域误差。Unknown/缺失缓存/即时回退计数均0；使用缓存命中29375，真实miss/已知黑1230。[区域矩阵](../../reports/contact-transport-v9/acceptance-20261014/quality-cache/curved.json)还记录绝对/最大误差与参考SE。

| 必需关卡 | 结果 |
| --- | --- |
| regression | passed |
| ray-origin | passed |
| attribution | passed |
| contact-query | passed |
| contact-image | passed |
| temporal | passed |
| surface-cache | failed |
| lifecycle | passed |
| resource | passed |
| fixed32-performance | failed |
| interactive-performance | failed |
| rebuild-latency | passed |
| showcase | passed |

有限轮次与缓存本身 2/12 项未通过，详见[独立表面与接收查询](../../reports/contact-transport-v9/acceptance-20261014/surface-finite/surface-cache.json)。未通过项保留 experimental；新模块通过不使R8全系统通过。

额外[一轮同方向对照](../../reports/contact-transport-v9/one-round-control/query.json)完成：单球球地即时10.60%→缓存12.41%，双球轮廓2.15%→14.53%，支持空间近似是剩余限制，不能仅归为统计噪声。[实际显示像素的独立几何/线性E参考](../../reports/contact-transport-v9/final-pixel-reference-reviewed/used.json)：**failed，18/60 案例未通过，最差25.53%**。原表contact-image的passed仅指原接收纹理；真实显示接触区仍失败，位置/法线随投影采样变化，需要单独解决。所有原点/新像素与失败保留。

## 实际设备与总成本

ANGLE (NVIDIA, NVIDIA GeForce RTX 5080 (0x00002C02) Direct3D11 vs_5_0 ps_5_0, D3D11)；Chrome 155.0.8059.40，WebGL2 / headless，页面visibility=visible。本机实测不是独占GPU或手动FPS。1280×800，主画面尺度1、阴影2048、曝光1、2m/128探针射线/3轮保持；AMD Ryzen 7 9800X3D 8-Core Processor（主机身份在验收后独立采集，非运行heap峰值）。

| 持续活动窗口 | 即时 GPU P95 | 缓存 GPU P95 | CPU提交P95 即时→缓存 | shade改善 | 条件 |
| --- | ---: | ---: | ---: | ---: | --- |
| auto/static | 9.24ms | 6.61ms | 2.70→2.70ms | 93.27% | 同receiver/样本/快照 |
| auto/moving | 9.62ms | 6.31ms | 2.70→2.77ms | 93.96% | 同receiver/样本/快照 |
| interactive16/static | 5.01ms | 5.02ms | 3.00→2.53ms | 92.04% | 同receiver/样本/快照 |
| interactive16/moving | 5.10ms | 5.00ms | 2.70→2.60ms | 92.88% | 同receiver/样本/快照 |

值为三个窗口各自P95的均值；moving是相机移动、球堆几何冻结，物理播放仍无完整局部GI。全帧和60帧组件分开。32r和16r仍为不同档。缓存减少secondary shade，primary trace未消失；原相对DDGI<=3ms、相对原raw<=1ms及移动/改灯失败继续保留。

64球首次缓存：提交墙钟 3090.90ms，worker布局 31.40ms，GL提交CPU 1183.20ms，GPU各代合计 1943.32ms；这些不能藏在稳态收益后。

| 更新与收敛 | 完整墙钟 | 缓存构建GPU合计 |
| --- | ---: | ---: |
| immediate/relight | 1355.62ms | 不使用缓存 |
| immediate/freeze-and-converge | 1054.61ms | 不使用缓存 |
| cache/relight | 3499.59ms | 1911.65ms |
| cache/freeze-and-converge | 3498.87ms | 1941.86ms |

改灯包含150帧忙窗口，冻结包含新世界/缓存与目标样本收敛；不能把墙钟当单次API耗时。细分见[完整成本账](../../reports/contact-transport-v9/acceptance-20261014/cache-cost/contact-cost.json)。忙帧时间不包含跨帧缓存GPU提交，后者单列；pending/missing/disjoint非零时GPU合计标incomplete。无同source/revision的改灯窗口不称纯开销优化。

所有正式球池资源/更新/生命周期测得的已知附加峰值 **61.60MiB /64MiB**；其中桌面1920×1080/2560×1440 Auto峰值 58.46MiB。64球缓存驻留GPU 6.78MiB、单候选已知临时+GPU峰值 10.95MiB。CPU/GPU/快照/物理WASM分别见[桌面资源](../../reports/contact-transport-v9/acceptance-20261014/desktop/desktop.json)与[完整更新](../../reports/contact-transport-v9/acceptance-20261014/cache-cost/contact-cost.json)。128球缓存拒绝不提高上限；即时安全回退和压力覆盖仍单列。驱动物理VRAM、worker JS allocator开销为not-run，不能把拥有资源合计称实际VRAM。

## 下一里程碑

1. 优先修复实际显示接触区18项失败及一轮缓存空间误差，保留全部点、physical/legacy与SE；不增加历史掩盖输入。
2. 在同质量同receiver下处理primary trace成本及缓存冷启动/改灯摊销，原32r和完整性能门限继续独立验收。
3. 先收口静态缓存质量、预算与更新成本，再另立受限运动GI任务；当前不做动态BVH、Tiles GI或反射。

详细机制：[传输合同](../contact-transport.md)。审查：[Standards / Spec](review-r10.md)。模板：[template.md](template.md)。必需失败/未运行均阻止推荐。
