# Local GI v0.1 · 冻结试点合同

合同冻结于R11开始（2026-10-15），不得按失败测量回调门限。范围：一个有界、静态、米单位代理世界，最多4096探针；基本不透明与受控Alpha Mask、太阳/天空改灯。六个独立glTF/GLB，或同数据集的两级REPLACE Tiles显示；显示LOD与常驻GI代理分别拥有。

档位：`baseline`=DDGI；`enhanced`=现有FG Auto；`contact-experimental`=R10表面缓存+FG，仅显式启用。无新去噪/缓存算法。后者仍承担一轮和18/60主画面像素失败，不生成pilotReady。

设备范围：本机RTX5080、Ryzen7 9800X3D、Windows11、Chrome实际版本另记录，桌面WebGL2、真实1920×1080。仅认证实测设备；中端设备不可用则not-run，不认证中端。电源/功耗限制未控制，另列not-run。

30FPS最低档：整帧GPU P95≤33.3ms、CPU提交P95≤33.3ms；实际渲染间隔P95≤40ms，>50ms卡顿比例≤5%，启动阶段单列。60FPS为独立观察档，GPU P95≤16.7ms，不替代30FPS认证。GPU/CPU不能相加冒充端到端延迟。

改灯：首个可用新版本CPU提交≤500ms，指定3轮最终发布≤2000ms；可见响应≤2000ms单测，不能把CPU发布当可见。spacing2m/rays128/bounces3与阴影2048、主画面尺度1、曝光1保持。FG附加预算64MiB，包括缓存/附件/快照/查询；CPU/GPU/场景/临时几何分别计账。

画质：独立路径参考、实际主画面线性E；query≤12%、主画面≤20%，保留区域分母、覆盖/Unknown/回退和阴影内颜色传递。baseline/enhanced分别判定；不使用缓存的档不承接缓存收益或失败，也不改写R8旧≤1/≤3ms关卡。

部署：本地Worker/资产/GLB内嵌图像、非根路径；业务使用薄session的load/replaceDataset/setLighting/setQuality/dispose，不触碰引擎私有字段。静态仿射变换仅正、均匀缩放+刚性旋转/平移；负/非均匀缩放、动画/skin、压缩/sparse、透射/混合透明明确拒绝或预处理。

必需稳定性：30分钟真实巡航/改灯、20次替换、50次LOD切换、加载失败/构造异常/取消/销毁/后台恢复/context loss降级。未跑不产生pilotReady。context loss第一版明确降级并要求重新创建Scene，不承诺原地恢复。Tiles只认证受控常驻代理，不认证城市流式GI或连续运动多反弹。
