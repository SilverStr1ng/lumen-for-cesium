# R8 当前源码验收（2026-10-14）

测量源码提交：00d1771（feat/fg-runtime-budget-v7），审查基线：645cf61201d671b21298dd88e08d48d0fbe7a8cb。当前全量验收与 cached 均退出 1；六类 passed，performance failed，recommended=false。

本会话延续 bda90ab 后的工作，新增阶段提交：

| SHA | 修改 |
|---|---|
| 9cfe77a | 实际采样窗口、改灯输入、来源校验、独立输出目录 |
| 9b733d8 | 体积所有权保护、真实 GLSL/coverage 检查、可切换四射线附件布局候选 |
| bd784c7 | 先释放旧 round 拥有权再克隆新快照，保留并计入显式租约，预算拒绝前不分配 |
| 00d1771 | 记录实际 camera/seed/epoch/revision/round，并保存内部渲染失败 |

默认继续使用 split + azimuth + 按需 DDGI。planar 仅为显式候选：1280×800 三轮交替测量中原展馆 D P95 从 6.708 到 6.006 ms，Gallery 从 9.439 到 9.543 ms，没有一致收益，未设为默认。数据在 ../layout-confirmation/，属于早期候选测量，不能充当当前源码 cached 验收。

R7 二维采样、FLOAT raw、线性 E、几何壁垒、Ng/Ns 门控、历史失效、同 source/revision/round、IBL policy 和生产无同步读回保持。Gallery 资产和主视图、阴影、DDGI 网格、反弹、曝光保持原配置。Auto 显式按实际 drawing buffer 和所有附件/快照/查询/设备限制选接收比例，32 rays、目标 32 帧、默认 64 MiB。

原/Gallery 1920×1080 和 2560×1440 的 split Auto 都规划 640×360 接收器。稳态额外资源分别为 57,332,160 B（54.68 MiB）和 60,020,352 B（57.24 MiB）。真实改灯重建峰值和完整场景覆盖会随当前验收报告交付。逻辑拥有的纹理/附件字节可验证；驱动物理 VRAM、bookkeeping 和寄存器占用未测，不能冒充 FG 独占 GPU 显存测量。

四模式：A=DDGI，B=R7 fixed-reference raw，C=同像素/seed/实际 epoch 的去相关 raw（无历史），D=重建。保留 D−B 的整帧 GPU P95 平均差 ≤1 ms、D−A ≤3 ms。C/D 的相机、接收尺寸、样本数和归一化 revision/round 不同则标记不等价，D−C 不能称为纯重建代价。真实改灯中的匹配快照等待和忙帧进入完整窗口，暂停及 query 排空绘制单列。

复现：

```text
npm run build
npm start
npm run test:r8 -- --output=reports/fg-runtime-budget-v7/acceptance-20261014-final
npm run test:r8 -- --cached --output=reports/fg-runtime-budget-v7/acceptance-20261014-final
npm run test:r8:quality -- --output=reports/fg-runtime-budget-v7/acceptance-20261014-final
```

全量入口串行运行 GPU。每个子进程即时写 compatibility-raw/run-*.json 和 progress.json；未完成的检查点不等于通过。cached 验证源码、bundle、资产、完整配置、producer 与全部必需输入哈希，并重算原阈值；failed/nonzero/null/not-run 禁止推荐。

原展馆：http://localhost:8090/demo/globe.html?fg=fg&fgQuality=auto&fgSampling=reconstructed

Gallery 桌面入口：http://localhost:8090/demo/gallery.html?nativeBuffer=1&fg=fg&fgQuality=auto&fgSampling=reconstructed

历史 R5/R6/R7 报告受保护；上次会话证据、候选和中止批次单独保留。

## 当前完整验收结果

全量与 cached 都退出 1，recommended=false；cached 核对 831 个输入后仍保留失败。旧历史报告恢复错误为零。必需关卡均已运行。

| 关卡 | 状态 |
|---|---|
| regression | passed |
| resource | passed |
| showcase | passed |
| temporal | passed |
| fixed-quality | passed |
| auto-quality | passed |
| performance | failed |

固定 / 1080p Auto / 1440p Auto 分别通过 660 / 369 / 369 项原质量检查；屏幕采集分别包含 57 / 33 / 33 组，三个 seeds 与 1/4/8/16/32 有效帧，100/250/500/1000 ms 的 108 个窗口另列。

## 同硬件固定质量 before/after

设备：NVIDIA GeForce RTX 5080，ANGLE Direct3D11 / WebGL2，16 fragment sampler units，GPU timer 可用。两侧同当前构建、1280×800 / half32r / 32 rays / 相同 seed 和实际 epoch / 同机位、光照、阴影、DDGI 配置；before 关闭排序与按需 DDGI，属于 R7 行为重放，不声称重新 checkout 645cf61。每模式每轮 100 个实际渲染帧（80 个完整 query），三轮交替。

| 场景 | before D P95(ms) | 当前 D P95(ms) | 降幅 |
|---|---:|---:|---:|
| original | 9.442 | 6.725 | 28.8% |
| gallery | 12.552 | 9.180 | 26.9% |

数据：[before 原展馆](../counterfactual-before/performance-split-eager.json)、[before Gallery](../counterfactual-before/performance-split-eager-gallery-1280x800-high-static.json)、[当前完整矩阵](summary.json)。

## 公开持续活动与暂停矩阵

D−B≤1 ms、D−A≤3 ms 保持原值。增量是三轮独立窗口 P95 平均值之差；不是逐帧配对差，也不是组件均值之和。18 个活动窗口中 14 个失败，2 个暂停窗口单列。C/D 输入不等价时不解释为纯重建开销。

| 场景/实际 buffer/档位 | 活动 | D P95 | D−B | D−A | D−C | 峰值 MiB | 状态 |
|---|---|---:|---:|---:|---|---:|---|
| original 1280×800 high | static | 6.725 | 1.346 | 2.518 | 0.483 | 60.44 | failed |
| original 1280×800 high | moving | 6.404 | 0.763 | 2.170 | 0.439 | 60.44 | passed |
| original 1280×800 high | relight | 8.321 | 2.492 | 3.960 | 不等价 (1.225) | 60.44 | failed |
| original 1920×1080 auto | static | 6.479 | 0.515 | 2.150 | 0.271 | 54.68 | passed |
| original 1920×1080 auto | moving | 6.609 | 0.595 | 2.106 | 0.145 | 54.68 | passed |
| original 1920×1080 auto | relight | 8.135 | 1.657 | 3.736 | 不等价 (0.913) | 54.68 | failed |
| original 2560×1440 auto | static | 7.364 | -0.513 | 2.051 | -0.476 | 54.68 | passed |
| original 2560×1440 auto | moving | 8.469 | 0.331 | 3.007 | 1.169 | 54.68 | failed |
| original 2560×1440 auto | relight | 9.421 | 0.255 | 3.917 | 不等价 (0.153) | 54.68 | failed |
| original 1280×800 high | pause | 4.154 | -1.305 | -0.045 | -1.913 | 60.44 | passed |
| gallery 1280×800 high | static | 9.180 | 1.735 | 4.585 | 0.168 | 63.00 | failed |
| gallery 1280×800 high | moving | 9.526 | 1.800 | 5.124 | 0.148 | 63.00 | failed |
| gallery 1280×800 high | relight | 12.157 | 2.894 | 7.547 | 0.848 | 63.00 | failed |
| gallery 1920×1080 auto | static | 10.047 | 1.448 | 4.883 | 0.618 | 57.24 | failed |
| gallery 1920×1080 auto | moving | 10.069 | 1.608 | 5.033 | 0.549 | 57.24 | failed |
| gallery 1920×1080 auto | relight | 12.660 | 2.554 | 7.523 | 不等价 (0.384) | 57.24 | failed |
| gallery 2560×1440 auto | static | 11.626 | 1.081 | 6.121 | 0.374 | 57.24 | failed |
| gallery 2560×1440 auto | moving | 11.876 | 1.375 | 6.875 | 0.630 | 57.24 | failed |
| gallery 2560×1440 auto | relight | 11.941 | 1.140 | 6.164 | 0.073 | 57.24 | failed |
| gallery 1280×800 high | pause | 4.532 | -3.316 | 0.046 | -4.288 | 63.00 | passed |

所有完整窗口的 completeQueries、boundedWindow、activeFG、resourceBudget、productionReadback 都通过；每窗口 80 个完整 query。原展馆 2560p 移动的 3.006912 ms >3，明确保留 failed。改灯等待匹配 revision/round 的回退帧进入成本，逐轮原因/FG 帧数/输入在原 JSON 与 summary.json；暂停缓存帧及 query 排空绘制单列。

## 实际画质与覆盖

以下为 seed 0、32 有效帧的完整 ROI 平均 FG 权重。全部 seeds、六线/49 点、all49 误差、Unknown、缺支持及逐点回退在 quality.json、canonical.json 和 screen/*.json.deflate。

| 配置 | ROI | raw→filtered RMSE(C) | FG 平均权重 |
|---|---|---:|---:|
| fixed | original-boxFoot-high-s0 | 0.026→0.005 | 99.98% |
| fixed | gallery-courtyard-high-s0 | 0.021→0.004 | 99.08% |
| fixed | gallery-skylight-high-s0 | 0.047→0.004 | 99.35% |
| fixed | gallery-emitter-high-s0 | 0.070→0.008 | 98.92% |
| auto-1920 | original-boxFoot-auto-s0 | 0.026→0.005 | 99.98% |
| auto-1920 | gallery-courtyard-auto-s0 | 0.022→0.004 | 97.79% |
| auto-1920 | gallery-skylight-auto-s0 | 0.043→0.004 | 98.46% |
| auto-1920 | gallery-emitter-auto-s0 | 0.067→0.007 | 99.16% |
| auto-2560 | original-boxFoot-auto-s0 | 0.026→0.005 | 99.98% |
| auto-2560 | gallery-courtyard-auto-s0 | 0.022→0.004 | 97.38% |
| auto-2560 | gallery-skylight-auto-s0 | 0.043→0.004 | 98.02% |
| auto-2560 | gallery-emitter-auto-s0 | 0.067→0.007 | 99.27% |

## 资源、回退与剩余瓶颈

两个桌面 Auto 输出均为真实 main buffer，接收器为 640×360，32 rays；原/Gallery 拥有资源峰值分别 54.68 / 57.24 MiB。固定 1280×800 峰值为 60.44 / 63.00 MiB。固定 high 在更大 buffer 下仍在分配接收附件前明确拒绝，Auto 的降档原因是附加资源/查询预算；不调整主画面、阴影、网格、反弹或曝光。

生产换 round 先释放旧快照拥有权再克隆。所有显式租约和每次成功分配都计入快照字节与峰值；不能仅报稳态。真实连续改灯、DPR、resize、冻结/暂停、40 MiB 用户预算变化和失败回滚测试通过。生产 readPixels/getBufferSubData/finish/阻塞 wait 为零。

固定活动下，原展馆 trace/shade 均值约 3.46/1.55 ms，Gallery 约 4.99/1.97 ms；全分辨率合成、持续改灯求解也占成本。现有 temporal/filter 不是主要热点。小批量融合和 planar 的必要正确性/失败证据保留；没有跨场景一致收益的候选未设默认。没有新去噪器、反射、动态几何、Tiles GI、Cards/SDF 或 WebGPU。

not-run：authenticated ion/World Terrain（无 token）；shader 汇编/寄存器占用；驱动物理 VRAM / FG 独占驻留。本文 MiB 是实际已分配的逻辑拥有纹理/附件/快照字节，不是驱动显存测量。

## 来源

源码 00d17714a3e275b5acde0dcb03f8706acb0fd282；95 个源码、235 个资产。完整哈希与配置见 [manifest.json](manifest.json)。

- source aggregate SHA256: 66f521d18fef7e32e7be954c1930409cc52f06926c366a5b0d9b017c5d173f3a
- bundle SHA256: fb530775f52aad0062934197c53b1dd9fadb8863984a83a53b42032021fd9282
- assets aggregate SHA256: 898111a206ed397b745d954aec5814949df57f35c7bb46e07d80624bdd1d5ce4

[总验收](test-suite.json) · [汇总数据](summary.json) · [全量 producer/失败注入记录](compatibility-raw/)
