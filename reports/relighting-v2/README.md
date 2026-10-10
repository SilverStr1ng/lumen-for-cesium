# 静态几何低延迟重照明 v2

审阅基线：`cbf38d3a36cf6e6c4850d1f9bdd16297a1be2726`。独立分支 `feat/static-relighting-v2`，不合并 main。原始报告均保存在本目录并随 Git 提交；`artifacts/` 留截图、冻结 R0 全纹理和补丁。

| 阶段 | 提交 | 实现 |
|---|---|---|
| R0 | `0027239` | 无纹理 atlas、自包含三类 glTF、GL 调用监测及可复现基线 |
| R1 | `c2eadb1` | 几何／材质／太阳可见性／能量版本、缓存太阳、独立几何 M |
| R2 | `ea3c0f7` | 8×8 内部积分、独立图像边界复制、实测选择算术版 |
| R3 | `01a4e8b` | 每完整轮发布、显式 atlas 所有权、单一 pending、预览 Promise／事件 |
| Sponza 入口修复 | `da866fc` | 加载期状态栏检查、渲染错误立即终止基准 |

报告中的 `head` 是测量时已提交的 HEAD。R0/R1 部分小场景报告在阶段提交前生成，head 指父提交，缺少源文件 hash，代码由对应阶段提交保存；不将这些报告称为 clean HEAD 测量。R2 起的报告记录 `modifiedSources`、规范化 LF 的源文件 SHA256 及编译 bundle hash。R0 Sponza 在已提交的 R0 上测量，最终 Sponza 的 GI 源码也在已提交版本上测量。R2 算术/LUT A/B 是明确的诊断配置，LUT 权重表仅在该配置驻留；生产不分配 LUT。

## 状态与图像所有权

三张 E：published 是前台；read 是本轮读取的完整上一轮，progressive 可与 published 重合；write 与两者不同。8×8 内部工作纹理先积分，再作为只读图像复制到带边界 write，全部探针和边界完成才标记 complete／发布。所有轮共用静态几何 M。下一轮要求 read 的 revision 与当前 job 一致、bounce 等于上一轮、complete 为 true。

snapshot 默认发布完整 N 轮。progressive 发布每完整轮，留一帧实际显示后推进下一轮。第一轮只读直接光／天空／自发光，不读取旧 E。输入冻结；正在执行的一轮可以完成并发布，之后只启动最新 pending 请求；不保留请求队列。

`ready` 是有可用场；requested／active／published／settled revision 和 publishedBounce 分别描述请求、工作、显示、最终轮完成。`solve()/completed` 仅在指定全部轮次提交后完成；`firstPublished` 和 `publicationEvent` 是首次／每轮完整发布通知。替代、销毁及失败都有 Promise reject。显示 enabled 保留原来的缓存开关语义，释放调用 world.destroy 或 Scene.destroy。

## 复现

Windows PowerShell，仓库根目录：

```powershell
npm run setup
npm run build
npm start                         # 保持服务运行；另一终端执行以下命令
npm run fixtures
npm run test:pipeline
npm run test:transport
npm run test:fixtures
npm run test:relighting
npm run test:integration
npm run test:progressive

$env:LUMEN_ASSET_URL = 'http://localhost:8008/gltf/2.0/Sponza/glTF/Sponza.gltf'
npm test                          # 原有 GBuffer／材质／阴影检查
npm run test:gpu
npm run test:world

$env:LUMEN_BENCH_SCENE = 'sponza'
$env:LUMEN_PUBLICATION_MODE = 'snapshot'
$env:LUMEN_REPORT = 'artifacts/sponza-snapshot.json'
npm run benchmark:relighting
$env:LUMEN_PUBLICATION_MODE = 'progressive'
$env:LUMEN_REPORT = 'artifacts/sponza-progressive.json'
npm run benchmark:relighting
$env:LUMEN_REPORT = 'artifacts/integration-ab.json'
npm run benchmark:integration
npm run report:relighting          # 本目录三份已保存的 R0／最终报告 -> summary.json
npm run patch
```

自包含 fixture 不需要 Sponza。Sponza benchmark 在资产缺失时返回 not-run 和非零退出码。`CHROMIUM_PATH` 可指定浏览器；固定重复三次，修改 `LUMEN_REPETITIONS` 会改变统计范围。全帧 elapsed 查询只在 GI 空闲帧运行，更新阶段不占用更新器计时器。

完整冻结比较可在 R0 独立 checkout 构建后设置 `LUMEN_SAVE_BASELINE_DIR` 运行 test:fixtures 保存三份初始 E/M 数组；在最终 checkout 设置 `LUMEN_BASELINE_DIR` 指向它们再运行 test:fixtures。本轮使用 `artifacts/r0-fields`，E 容差预先锁定为 abs 2e-4 + rel 1e-3，M 为 abs 2e-4 + rel 1e-4；黑色同样使用绝对项。A/B 和 progressive HDR 比较使用 abs 2e-4 + rel 1e-3。

## 测量边界

数值诊断明确使用 readPixels；性能运行独立，由实际 GL wrapper 监测 readPixels、getBufferSubData、finish、waitSync、阻塞 clientWaitSync、反馈、错误、资源和 timer 查询冲突。计时器异步轮询，diagnostic fence 的 timeout 为 0。CPU Promise 完成／atlas 选择与 GPU 完成／像素呈现分别命名，不把前者当成后者。

少量 revision 重复仅给中位数与范围，不给 revision P95。帧 P50/P95 取实际 RAF 间隔。R0 和最终原始 continuous 的停止后延迟包含异步 query 排空帧，是上界；最终每 job 的 requestToFinalSubmissionMilliseconds 在发布时记录，不包含排空。

R3 新增状态栏曾在 world 创建前访问 undefined，导致首次 Sponza 性能运行失败，见 `r3-entry-loading-failure.json`；随后修复重跑。保留失败记录，不将它计入通过成绩。完整 Cesium Karma 总入口未重跑；历史环境的 WebGL 初始化／断连问题未计为通过。未重跑独立低质量 benchmark 预设。原 GPU 诊断保留 1024 阴影／半分辨率的历史比较，它们不作为默认质量性能成绩；动态几何、Tiles／地形、镜面反射及完整 Unreal Lumen 画质对比未运行。

GL 图像反馈规则依据 [Khronos WebGL2](https://registry.khronos.org/webgl/specs/latest/2.0/) 和其 [rendering-sampling-feedback-loop 测试](https://registry.khronos.org/webgl/sdk/tests/conformance/rendering/rendering-sampling-feedback-loop.html?quick=1&quiet=0&webglVersion=2)。本轮还检查实际 draw 使用的 sampler 与写附件，无反馈报错。

## 等质量 Sponza 结果

Intel UHD / ANGLE D3D11，Chromium 153.0.8010.12 headless，960×640、2048 阴影、1836 probes、128 rays、3 bounces、3 ms 目标预算。相机与灯光序列逐项比较一致。数字是三次更新的中位数；范围、每阶段 GPU/批次/帧数/CPU 时间、query 缺失及 GL 调用见原始 JSON 和 summary.json。

| 更新类别 | R0 最终提交 s | Snapshot 最终提交 s | Progressive 首轮 / 最终提交 s | R0 / Snapshot / Progressive GPU ms | 30% 目标 |
|---|---:|---:|---:|---:|---|
| 暖更新 | 20.98 | 6.08 | 3.33 / 6.62 | 438.9 / 42.3 / 49.9 | 达到 |
| 只改天空 | 17.14 | 10.15 | 3.03 / 7.34 | 410.6 / 59.9 / 42.8 | 达到 |
| 只改太阳强度 | 20.37 | 5.04 | 2.22 / 6.42 | 425.5 / 51.5 / 41.9 | 达到 |
| 太阳方向 | 17.63 | 24.83 | 15.32 / 18.10 | 397.3 / 382.8 / 337.2 | 未达到 |

| 显示状态 | R0 帧 P50 / P95 ms | Snapshot P50 / P95 ms | Progressive P50 / P95 ms |
|---|---:|---:|---:|
| GI 关闭 | 151.5 / 188.0 | 151.5 / 206.0 | 139.2 / 181.7 |
| 静态 | 145.6 / 248.3 | 145.4 / 187.9 | 127.4 / 157.8 |
| 连续改灯 | 157.5 / 278.8 | 151.4 / 181.8 | 133.3 / 236.3 |

首轮与最终都是 CPU 提交／atlas 发布时间，不是 GPU 完成或呈现。Progressive 的天空／强度首轮分别约 3.03／2.22 秒，最终约 7.34／6.42 秒，最后仍完成指定三轮。该路径最终 GPU 时间较 R0 下降约 89–90%；暖更新下降约 89%。Snapshot 类似。太阳方向刷新 GPU 仅下降约 4–15%，Snapshot 墙钟反而更长，Progressive 墙钟基本持平，30% 目标明确未达。三次范围存在波动，不据此宣称稳定实时更新。

R0／Snapshot／Progressive 冷启动分别 151.27／125.50／122.52 秒。默认自有纹理当前与峰值均 93,338,688 字节（89.01 MiB），R0 为 94,513,728 字节（90.14 MiB）。R2 工作纹理增加 3,760,128 字节；独立 M 节省两张旧 M atlas。显存统计不含显示模型、阴影、主帧缓冲及 Worker CPU 数据。

所有默认性能更新的计时缺失和 disjoint 为 0，内部 query 队列峰值 27。实际 GL 监测无 readPixels/getBufferSubData/finish/waitSync/阻塞 clientWaitSync、查询冲突或 sampler/FBO 图像反馈；重复更新未增长自有纹理，最终 query 排空。自包含 progressive 数值运行另比较真实 GL 资源：textures 34、FBO 21、programs 19，前后一致，query/sync 均为 0。

显示仅约 6–8 FPS；GI 关闭对照也慢，未达到实时显示目标。这些是非独占 GPU 的桌面环境测量，不能把不同运行窗口的帧率波动归因于 GI 改动。当前方向更新中的 visibility 占 GPU 时间约 86–88%；冷启动中 relocation + intersections 占约 99% 几何阶段 GPU 时间。下一条单一推荐任务：在同质量下降低太阳方向改变时的 any-hit 可见性刷新成本，优先定位 BVH 遍历与分批调度，保持 Unknown 和 alpha 语义。

原 GPU 回归曾通过修改 world.options.traversalBudget 模拟预算耗尽。R1 冻结参数后该赋值不再生效，使测试失败（r3-gpu-legacy-fixture-failure.json）。测试改用原有每射线 budget: 1 诊断入口，仍要求 Unknown，并额外检查生产预算未变；没有修改 BVH 遍历或放宽阈值。

## 回归结果

| 项目 | 结果 | 持久证据 |
|---|---|---|
| 构建、引擎 ESLint、补丁反向 apply 检查 | 通过 | CLI 命令与源码；导出 15 个引擎文件差异 |
| GBuffer／材质／直接阴影与间接光 | 15 项通过 | r3-gbuffer-verification.json |
| Pipeline／transport | 9 项／4 组通过 | 本轮实际 CLI 输出；可用上方命令重跑 |
| 三个自包含 GPU fixture + 冻结 R0 完整字段 | 24 项通过 | r3-fixture-verification.json |
| 依赖、独立距离矩、Unknown、实际 HDR | 11 项通过 | r3-relighting-verification.json |
| 算术/LUT、边界、接缝及最终 HDR | 5 项通过 | r2-integration-verification.json |
| Progressive、连续请求、真实 GL 资源、按需渲染、失败恢复 | 14 项通过 | r3-progressive-verification.json |
| 原 GPU Sponza | 11 项通过 | r3-sponza-gpu-verification.json |
| 原 CPU 世界 Sponza | 12 项通过 | r3-sponza-world-verification.json |
| 同质量 snapshot／progressive 性能运行 | 通过；方向变更目标未达 | r3-sponza-*-performance.json、summary.json |
| 缺失 Sponza 的状态分支 | 预期 not-run，非零退出码 | r3-missing-asset.json |

Sponza GPU：262,266 triangles、65,779 BVH nodes、1,776/1,836 有效 probes，235,008 probe rays 没有 Unknown；800 条 GPU/CPU 射线全部匹配，最大距离差 1.24e-5 m。强制 budget 1 返回 Unknown 且生产预算不变。实际材质 HDR 的 rhoE/pi 最大误差 3.81e-6。中性地面接收点 E 红色差 +0.00068469；所有 29,952 个红幕布三角形在视锥外后重新求解，该差保持不变，实际 HDR 红通道差 +0.00006866。相机只影响显示，没有把屏幕数据用于世界 GI。

CPU 参考同样验证屏幕外颜色贡献：860 个幕布 surfel 全部不可见，重新求解的接收点 E 不变。GBuffer 真实 HDR 验证间接光不受太阳阴影开关衰减，直接光受到阴影影响。截图由 test:gpu/test:world 生成至 artifacts；sponza-gpu-offscreen.png 是近距离接收地面诊断视图，微小颜色差主要由 HDR 数值证明，不作为展示画质或 Unreal 对比。
