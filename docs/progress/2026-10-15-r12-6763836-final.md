# R12 Local GI · 冻结验收与交付

两个既有宿主的加载、恢复、资源预留与部署链已修复。独立物理画质仍有 **34/40 案例失败**，Local GI v0.1 仍未达到投入使用条件；**pilotReady=false、releaseReady=false，不标记 recommended**。主目标 **48.75≈49%**，受限试点 **63.75≈64%**，评分不因本轮测试通过数量增加。

分支 `feat/local-gi-pilot-stabilization-v11`；审查基线 `328629ef5449978cf4a822cd3de6191d9b2f8c1d`；本次正式冻结源码 **`67638369841a1ff2a8dbecddcca37f4ac0962503`**。最终报告提交只添加文档和证据，源码/构建/资产/合同/配方的逐文件核对见[交付一致性](../../reports/local-gi-pilot-stabilization-v11/delivery-6763836.json)。不把文档提交或前期候选称为新的实跑 HEAD。

## 现在可以操作

仓库根目录依次执行 `npm run setup`、`npm run build`、`npm start`。首次安装依赖需要 npm 网络；页面运行使用本地资产和 Worker，无 token。

打开 [Models 宿主](http://localhost:8090/demo/pilot-models.html)、[Tiles 宿主](http://localhost:8090/demo/pilot-tiles.html)，或[最小嵌入](http://localhost:8090/demo/pilot-embed.html)。等待数据/GI available 后，切换基础 DDGI / FG Auto、改灯、替换、取消；Tiles 可切换父/子级并卸载显示。GI 数据就绪独立于当前视角，业务另用有截止时间的 `waitForVisible()` 查询可见性。context loss 后按公开合同重建 Scene/session。

非根路径、CSP 和嵌入步骤见[部署说明](../product/local-gi-deployment-v11.md)。两宿主继续复用同一个 session 实现、既有8资产与同一998三角形世界，没有复制球池状态机或重建场景。

## 本轮完成了什么

| 项目 | 实现与实际验证 |
| --- | --- |
| 会话事务 | 数据/GI和视口就绪分离；渲染循环停止时有超时/取消；连续改灯保留一个活动请求和最新待处理请求，8次突发产生2个completed、6个superseded；取消/替换结束旧请求 |
| 路径与拥有权 | canonical绝对URL校验嵌套Tiles资源，保留SHA；两目录同名、相对/非根路径与声明data URI检查通过；失败和晚到回调不混用新旧世界 |
| 资源/Auto | 按唯一纹理/缓冲身份去重；snapshot只计一次；读取、解码、native显示、Worker、替换并存、附件与查询分配前预留。单资源2MiB、总输入8MiB等上限公开，64MiB不变 |
| 持续FG与诊断 | 修复session未开启持续FG采样的问题；采集射线绑定实际渲染帧，各帧保持世界/发布版本、相机、投影和尺寸一致。机器舍入保护允许数值噪声，相机运动/投影/尺寸反例仍拒绝；冻结版完成全部40例实际采集 |
| 等价与恢复 | 单模型、多模型、Tiles父/子四种表达一致；两宿主28项生命周期、各20次替换、Tiles50次LOD/卸载转身、真实预算不足保留旧匹配世界均通过 |
| 仍未完成 | 现有共同光传输估计不能满足全部固定区域画质；本轮保留失败，未增加新缓存/去噪/反射或改变反弹数 |

原Tiles 90秒记录保留。[诊断CPU profile](../../reports/local-gi-pilot-stabilization-v11/r12-1-stall-attribution/)另发现原生shader link曾阻塞主线程约29.37秒；显示延后至GI完成以避免误判solve超时。视角依赖等待和主线程阻塞分别处理，不将二者说成同一原因。首个性能页面的load wall记录为Models约5.37秒、Tiles约0.67秒，未作通用冷缓存启动保证。

[两宿主HTTP失败恢复补测](../../reports/local-gi-pilot-stabilization-v11/host-errors-6763836/hosts.json)10项通过，包括真实404后保留匹配旧世界、重试、销毁及原生画布截图；该960×600基础档功能检查不代替目标设备的画质/性能验收。

## 正式验收

`npm run test:r12` 实际串行调用现有试点命令；同一对象记录HEAD、源码、完整运行构建、资产、合同、配置与配方哈希。[正式汇总](../../reports/local-gi-pilot-stabilization-v11/acceptance-20261015-frozen-6-native-tabs/acceptance.json)与[逐子进程退出结果](../../reports/local-gi-pilot-stabilization-v11/acceptance-20261015-frozen-6-native-tabs/execution.json)为准。

| 必需关卡 | 结论 |
| --- | --- |
| assets | **passed** |
| session-lifecycle | **passed** |
| tiles-residency | **passed** |
| resource | **passed** |
| query-quality | **failed** |
| final-image-quality | **failed** |
| temporal | **passed** |
| performance | **passed** |
| relight-visible | **passed** |
| soak | **passed** |
| deployment | **passed** |

全部必需失败返回非零，not-run不能生成pilotReady。[同HEAD缓存复核](../../reports/local-gi-pilot-stabilization-v11/cache-6763836.json)保留失败结局。[两轴只读复核](review-r12-6763836.md)与[验收历史](../../reports/local-gi-pilot-stabilization-v11/)保留前四次中止及修复：clean文件换行/导出顺序、诊断缺字段判据、相机位级比较问题都在新冻结对象重新执行，没有继承旧passed。

## 独立画质和剩余偏差

维持真实1920×1080、曝光1、阴影2048、2m/128r/3轮。40案例含两宿主×两档×日夜×5视角，physical参考8192样本；增强档等待同world/revision/round的有效FG新epoch。固定像素网格、query12%、实际使用E20%及每个区域分母均保留。

| 档位 | 失败案例 | 区域检查通过的query / E案例 | 整体query误差范围 | 整体E误差范围 | E绝对RMSE范围 |
| --- | ---: | ---: | ---: | ---: | ---: |
| 基础DDGI | 18/20 | 2/20 / 4/20 | 3.72%–76.32% | 3.70%–76.28% | 0.00487–0.19024 |
| FG Auto | 16/20 | 4/20 / 6/20 | 1.77%–30.36% | 2.03%–28.33% | 0.00267–0.06641 |

每档分母416点；增强档404点FG权重>0.5，12点因code8几何兼容保护回退，GPU/参考Unknown均0。Auto实际接收尺寸384×216、32r，主画面没有缩小。比如白天庭院整体query约7.0%，plaster子区19.3%，仍判失败。[40案例与区域明细](evidence/r12-6763836-quality.md)列出每个分母、覆盖、绝对误差和失败区域。

四种表达同点query最大差0，最终E通过预先冻结的表达容差。三处旧失败点又做8192样本GPU/32768样本独立physical与legacy对照：门洞plaster的GPU红通道约0.239，physical约0.155，标准误约0.00282；夜间basalt约0.844对0.680。相同第一命中的独立路径余项替换显示，这两个点的DDGI命中余项偏高，增加采样无法消除。overview的起点策略差异只解释部分偏差。pilot当前仍为contactTransport:false，legacy仅归因，不替换physical目标，也不推断全部34个失败同因。

## 设备成本、资源和响应

RTX5080 / Ryzen7 9800X3D / Windows11 / Chrome155 / WebGL2（ANGLE D3D11）。性能为独立headless前台测量，长跑使用headless原生标签页，关闭焦点仿真并保留原生后台节流；实际设备、绘制尺寸和启动参数也进入判据。没有关闭浏览器安全开关。8个窗口各240测量帧，增强档均240/240持续FG、disjoint=0、无缺失查询、>50ms比例0。

| 模式 | GPU P95 静止/移动 | CPU P95 最大 | 帧间隔 P95 最大 |
| --- | ---: | ---: | ---: |
| Models基础 | 4.74 / 5.46ms | 6.40ms | 8.60ms |
| Models FG Auto | 12.11 / 11.65ms | 12.30ms | 14.90ms |
| Tiles基础 | 7.23 / 8.53ms | 9.60ms | 14.60ms |
| Tiles FG Auto | 12.47 / 13.09ms | 12.90ms | 17.80ms |

满足本机试点30FPS合同33.3/40ms；R11增强档原5.25/7.88ms是在FG暂停采样后测得，保留原记录并更正条件，不能计算同条件加速。R8固定32r的≤1/≤3ms旧性能门限和失败继续有效。

改灯首个CPU提交Models/Tiles约231.5/354.0ms，三轮最终发布494.3/590.3ms；显式诊断窗口观察到已渲染线性E像素变化约242.7/367.5ms，诊断本身14.5/20.6ms另计。桌面合成器/显示器光子延迟not-run。

| 宿主 | 实际已知拥有峰值 | CPU已知存活 | GL已拥有句柄存储 | 独立GL核对 |
| --- | ---: | ---: | ---: | --- |
| models | 53.41MiB | 3.29MiB | 49.56MiB | missing/unlisted/unknown=0 |
| tiles | 53.77MiB | 4.71MiB | 48.88MiB | missing/unlisted/unknown=0 |

两宿主准入峰值64.00MiB包含主动满额预留的预算拒绝测试，未把预留冒充实际分配；独立GL漏项探针4B能被检出，账本与实际句柄存储一致（仅保留每分配≤16B的mip取整容差）。

资源是固定范围的CPU+GPU逻辑拥有与预留；驱动VRAM/JS allocator开销not-run。独立GL观察记录全场纹理/缓冲存储峰值约292–294MiB，包含主渲染/Globe等，不能把64MiB附加预算称作全场显存。默认纹理、IBL、快照、query容量及暂存未移出分母；详见[公开资源范围](../product/local-gi-resource-scope-v11.md)与[资源/响应证据](../../reports/local-gi-pilot-stabilization-v11/acceptance-20261015-frozen-6-native-tabs/runtime/runtime.json)。

## 长期、部署和交付边界

真实墙钟 **1800.59秒**，额外20次替换、50次LOD、30次改灯，Scene 108954帧、FG 106257帧。末4096帧间隔P95为19.90ms，全程>50ms为90/108953个间隔，比例0.0826%（含后台检查）。长跑改灯CPU首提交最大331.7ms、最终发布最大728.7ms；像素响应使用前述两宿主独立诊断。长跑结论 **passed**；各项检查：environment=passed、duration=passed、budget=passed、residentLod=passed、continuous=passed、noReads=passed、background=passed、disposed=passed。实际hidden→visible恢复保持版本，最终重新等待32个有效FGepoch。自然操作准入峰值63.78MiB、已知拥有峰值53.77MiB，销毁后world为空且FG目标0。[长期证据](../../reports/local-gi-pilot-stabilization-v11/acceptance-20261015-frozen-6-native-tabs/soak/soak.json)。

前一冻结版201fa16的有界面长跑在1176.8秒开始意外hidden，约1199.1秒留下最后样本，随后LOD渲染等待超时；当时17次替换、40次LOD，不能算30分钟通过。[完整失败记录](../../reports/local-gi-pilot-stabilization-v11/acceptance-20261015-frozen-5/soak/soak.json)保留，隐藏原因未确认。新冻结测试隔离桌面焦点干扰，仍做真实原生标签hidden→visible与墙钟30分钟。该结果认证标签页后台恢复，**桌面窗口遮挡/OS合成器恢复仍未认证**。

独立clean安装/build/serve后，根与/deploy/lumen路径的两宿主和最小嵌入共6项通过；345个运行文件逐字节一致。非根最小嵌入有1次原始资源取消，按冻结判据核对当前完整拥有字节、响应长度、SHA及最终世界版本后标为cancelled-with-verified-content，原事件保留，没有改作请求成功；其余5项无取消，6项无脚本错误。CSP允许本地动态JS/WASM与Blob Worker，需求已公开；严格self-only脚本策略不支持，旧失败也保留。

中端设备、功耗控制、驱动/JS allocator峰值、显示器光子延迟、24小时运行及完整R8/R9/R10/Gallery历史矩阵本轮为not-run。本轮16项关联回归通过不能认证全产品。R11原34/40、R10的18/60最终像素失败及旧性能失败均未覆写；contact缓存继续仅为实验档。

## 加权账本和下一里程碑

[不可变R12账本](readiness/r12-6763836.json)沿用[baseline-v1](readiness/baseline-v1.json)权重、100分分母和五档锚点，采用用户[v10审查](readiness/v10-review.json)的48.75/63.75。相对旧42.5/58.75，只计资产/API基础（25→50）及主目标Tiles基础（0→25）；GI、性能、交付本轮不加分。逐项理由与来源保留，分数不是剩余工时比例，硬阻断不被高分抵消。

投入使用的首要阻断仍是区域query和最终E质量。下一里程碑只研究一种有界第二段路径积分候选，替换有证据偏高的命中DDGI余项；沿用physical起点/几何支持，最大总反弹仍3、同40案例/区域分母、12%/20%、持续采样与64MiB。先验证三处代表点，再验证完整矩阵和成本，不新增缓存/去噪或缩小产品范围。[后续执行模板](next-task.md)与[报告模板](template.md)给出完成定义。
