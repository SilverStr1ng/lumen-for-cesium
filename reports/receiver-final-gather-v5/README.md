# R6 接收表面 Final Gather

代码在 feat/receiver-final-gather-v5，从实际本地/远端 9e0d920bdfaa3f56776ddc758a886259152b9ce0 创建；没有回退 main 或自动合并。最终运行代码为 251c2d7（引擎修改止于2a9094b）。各 JSON 保存执行时 HEAD、源码及编译 bundle 哈希；后续证据提交不改变求解代码。R5/v3 历史报告由总验收保存并恢复。

运行：先 npm run build，另一个终端 npm start，然后打开 /demo/globe.html。默认 DDGI；/demo/globe.html?fg=fg&fgQuality=high 为半分辨率32r实验档，fgQuality=roi 为全分辨率中心256×256 ROI / 64r，fg=raw 为 raw E 诊断。[可运行验收页](index.html)提供同条件截图、全部接收点数据、性能和短序列。

## 实际代码提交

- 95bc74b：R6.0 增强 IBL policy 门控；真实质量失败退出码。
- 5e77972：R6.1 世界 BVH 接收 FG、同轮 E_(k−1) 拥有权快照、A/B/C/D 与独立参考。
- 1d7669f：R6.2 主绘制前接收预通道、GPU FG、PBR 完整 E 替代混合、Earth GI Lab 模式。
- 6734ec1：R6.3 几何重建、质量/预算、实际截图和 GPU 测量入口。
- 6b959a3：深层缺数据判无效、分配失败原子回滚、世界几何邻域拒绝同平面跨墙混合。
- 6d385d5：ES6 资源销毁后的方法保护与租约清理回归。
- 2a9094b：按接收Float32位置误差约束共面判断，减少保护掩码的细碎回退；上界不超过已有0.2mm射线偏移。
- 251c2d7：补齐PBR/环境管理的原版补丁基线；所有候选质量门和慢步骤按实际退出码汇总，旧JSON不能掩盖异常退出。

## 合同与范围

一次 Scene 更新/命令准备、阴影/计算依赖完成后，重放已准备的不透明/Alpha Mask命令写入两张接收附件；随后世界 BVH 最近命中、命中点太阳/材质与 E_(k−1) 着色、邻域保护、主 PBR。没有生产 second scene.render。Globe 与不支持对象可遮挡接收信息；外围地形仍为背景，没有参与完整世界 GI。

输出是线性RGB E，没有接收反照率、接收点太阳、曝光或镜面。FG 替换/混合完整 E：mix(E_DDGI,E_FG,validGeometryWeight)，rho/pi由原PBR应用一次。没有 sceneColor 采样、probe-ray缓存通用化、历史输入或显示结果反馈。Ng 是屏幕导数的真实三角形法线；Ns!=Ng 未验证路径回退 DDGI。

每个发布轮次拥有原始 E_(k−1)、E_k 与材质 GPU副本，固定太阳、sky、几何/rayLayout/material/lighting版本、位置和距离矩。k=1 不读旧 E；新 revision 未完成时FG暂时无效。Unknown alpha=-1，深层缺数据 alpha=0，已知黑暗保持有效。任一失败方向使整个估计无效，不重归一化。增强 IBL 仅在受支持、启用的 Lumen+enhanced policy中生效，关闭/无define/legacy还原9406caf指定公式。

低分辨率重建检查表面归属、Ng、共面距离、足迹，并以世界 BVH 保守拒绝附近非共面几何；预算耗尽也回退。raw纹理独立，保护纹理4B/像素。ROI精确当前像素、不做插值。模式无历史，方向固定；32r仍存在条带/噪声。150ms原显示过渡保留为独立选项，不进入FG光源。

## 数值与质量

[abcd.json](abcd.json)保留原/旋转17°并错位0.37/0.21m场景，k=1/2/3，六线各49点和历史13个计分索引；C为1024r×3固定种子，D为8192独立路径/点，每点SE与实际路径计数保存。B精确可见性本身未解决箱体/柱脚；C减少第一段代表性误差，更深层仍有DDGI近似。

原场景k=3线性E RMSE（表为显示舍入，关卡直接使用JSON精确值）：

| 线         |   A DDGI | B exact probe visibility |     C FG |
| ---------- | -------: | -----------------------: | -------: |
| boxFloor   | 0.182183 |                 0.183792 | 0.018938 |
| boxFace    | 0.096829 |                 0.096900 | 0.047672 |
| wallFoot   | 0.005199 |                 0.005748 | 0.001711 |
| pillarFoot | 0.132191 |                 0.150570 | 0.011304 |
| ceiling    | 0.004207 |                 0.004058 | 0.002360 |
| doorway    | 0.087641 |                 0.046721 | 0.004156 |

高采样C通过原绝对关卡及相对v4至少30%的箱体/柱脚目标。柱脚原阈值0.033018738250725134没有放宽。原/held-out的不退化使用A RMSE + 3×独立D的RMS SE，候选噪声不扩大阈值。

生产默认固定种子0：16r柱脚0.054212、墙脚0.016167、顶角0.023562仍失败；32r柱脚0.023986通过原绝对阈值，但顶角0.008739812超过不退化阈值0.008434187而失败。实际屏幕接收点及4096独立路径结果见 [images.json](images.json)；raw与重建权重分开记录，包含保守几何回退比例。没有删失败点、加环境光、提曝光或提高反弹数。

## 验收入口与真实退出码

- npm run test:r6：运行回归、慢独立参考、图像、性能与数字关卡；当前总退出1，低采样画质未全部通过。
- npm run test:r6 -- --fast：仅快速回归，质量/性能明确not-run。
- npm run test:quality -- --input reports/receiver-final-gather-v5/abcd.json --label fg-query-high：高采样关卡退出0。
- npm run test:quality -- --input reports/receiver-final-gather-v5/images.json --samples 16 --label fg16：退出1；32r同样退出1。
- 同高采样命令加 --inject-error：柱脚注入RMSE=10，真实退出1；gate harness通过。
- npm run lint:r6、npm run test:receiver、npm run test:final-gather：独立回归入口。
- node scripts/verify-receiver-report.mjs：报告图库、全部49点表、held-out切换与短序列交互 passed。
- npm run test:acceptance：26项独立聚合/退出码故障矩阵 passed；包含32r/high查询、慢步骤非零/null退出、预期负例和实际测量数据。
- npm run test:patch：补丁在原版基线上完整应用，22项输出与实测树一致 passed；两项新增原版依赖与官方1.146源码逐字核对。

[test-suite.json](test-suite.json)分别保存回归、画质、性能和各命令退出码。已知v4柱脚失败仍以tracked-failure返回1。快速smoke或回归通过不代表画质通过。

## 图像、设备与成本

[images/](images/)包含原机位DDGI/32r FG、E_used/raw/filtered/weight与独立展示预设；camera、模型/锚点、阳光、曝光1、原阴影、AA1、2m/128/3均记录于images.json。CSS只隐藏HUD用于成对截图；没有改变机位或画面处理。[sequence/](sequence/)记录横移、转身、室内、改灯和停止，改灯间隔明确回退而不标错revision。

[performance.json](performance.json)记录修复后实际Chromium/ANGLE RTX5080、1280×800、preserveDrawingBuffer=false。receiver、trace、shade、neighborhood、forward阶段与整帧单独采样；额外前向采样用composite开关对照，不能将相减后的细小计时差当精确硬件分项。Scene+IBL+世界同时改灯的整帧范围与限制也保存：只有idle-frame GPU样本，忙帧GPU成本not-run，提交延迟仅为CPU范围。GL实际texture/renderbuffer/buffer分配包括Globe/HDR/阴影/IBL/MSAA/GI，排除驱动padding和swapchain。

本次原场景实测额外整帧成本（P95相对同预设DDGI，显存为附件加快照）：

| 档       | 新增GPU P95 ms |   新增MiB | GPU / 显存关卡  |
| -------- | -------------: | --------: | --------------- |
| ddgi     |       0.000000 |  0.000000 | passed / passed |
| fast     |       0.744768 | 11.121521 | passed / passed |
| balanced |       0.956992 | 36.023865 | passed / passed |
| high     |       0.962144 | 36.023865 | passed / passed |
| roi      |       1.459904 | 44.226990 | passed / passed |

32r各阶段另一个采样窗口的GPU统计（前向包含原PBR和FG采样）：

| 阶段         |   平均ms |   P95 ms |
| ------------ | -------: | -------: |
| receiver     | 0.069622 | 0.056448 |
| trace        | 2.582733 | 3.126944 |
| shade        | 1.043042 | 1.338080 |
| neighborhood | 0.039193 | 0.025952 |
| forward      | 0.503277 | 0.861504 |

整帧增量为独立baseline与FG窗口的P95之差，不是逐帧配对；分项P95不直接相加。实测原场景DDGI整帧P95 3.704416ms，32r FG 4.666560ms。

质量档：fast=320×200/16r，balanced=640×400/16r，high=640×400/32r，roi=全分辨率接收+256×256/64r。上限16,777,216 primary slots/帧、每查询256 BVH visits、总新增64MiB。主/太阳射线数量分别报告上界，诊断中统计实际有效接收射线、Unknown和回退比例；生产不读回计数。显存包含约2.82MiB输入快照；最终数字以performance.json为准。GPU timer缺失会标 unavailable，不以CPU rAF宣称GPU通过或可移植FPS。

## 回归、审查与剩余缺陷

两轴独立[审查记录](review.md)及修复：深层缺数据、allocation failure、同平面隔墙、资源生命周期均增加实际验证。26组代码回归（含目标ESLint）passed；高采样画质passed；16/32生产档failed；设备性能passed。全分辨率48点生产/查询最大差约1.79e−7；普通/对数深度、强制多视锥、前景/Globe遮挡、resize/AA、相机移动、按需渲染、20次开关、20次FBO故障、材质/灯光revision、重载/销毁已执行。生产GL观察无readPixels/getBufferSubData/finish/阻塞等待、同图像反馈或timer碰撞。

当前默认不启用FG：16/32档有独立质量失败与可见条带；保守几何保护会扩大接触边缘的DDGI回退，原探针误差在那里仍可能出现。更深层仍为稀疏DDGI，C不是D。低样本held-out生产重建、真实无timer/WebGL1设备、外部Sponza、真实认证ion为not-run。动态几何、地形/Tiles GI、反射、完整时空去噪、Cards/SDF、WebGPU不在范围。
