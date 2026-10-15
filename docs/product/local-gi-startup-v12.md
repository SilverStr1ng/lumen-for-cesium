# Local GI 启动与程序准备 · v12

本版继续使用现有 Models / Tiles 宿主、同一 session、8资产/998三角形与常驻局部 GI 代理。入口与安装、非根路径及 CSP 沿用 [v11部署说明](local-gi-deployment-v11.md)。实际是否通过启动与产品验收，以[用户报告](../progress/latest.md)和不可变证据为准。

## 操作与状态

`npm run setup` → `npm run build` → `npm start`，打开 [Models](http://localhost:8090/demo/pilot-models.html) 或 [Tiles](http://localhost:8090/demo/pilot-tiles.html)。先显示本次数据集的基础直接光/声明的 IBL；匹配版本 DDGI 发布后接入局部漫反射替换，随后准备 FG 并积累。太阳、阴影与 Alpha Mask 等必需派生成套就绪后才允许对应基础画面绘制。最终曝光1、阴影2048、2m/128r/3轮、Auto实际资源规划不变。

HUD 的 `startup.state` 独立于 `phase/ready`：`dataset-loading`、`base-warming`、`gi-warming`、`fg-warming`、`ready`，以及取消/失败/context loss。`load()` 仍表示数据/GI可用；当前相机是否可见另用有取消和截止时间的 `waitForVisible()`。增强档进入 `startup.state=ready` 必须已有当前 generation/revision 的实际 forward FG 绘制和32个有效新 epoch；深度/拾取/阴影 draw 不计首资产或 FG 呈现。基础档也必须实际绘制新GI。首个基础帧呈现前 coverage 保持0，之后只启用同一拥有者的新GI。只在后台完成计算不会成为可见认证。

取消按钮在数据审计、基础准备、GI准备和FG准备中均可用。取消关闭旧请求、卸载世界及 FG 目标，清除无主 pending 程序，保留当前数据集的基础显示；context loss 按公开合同重建 Scene/session，不宣称原地恢复。业务页面仍只调用 session 公开方法，不操作渲染器字段。

## 有限变体与缓存拥有

普通 Cesium / Local DDGI / FG production / 显式 diagnostics 由实际材质、pass与注册成员决定。未使用 FG 的材质不带完整重建/几何屏障宏；生产 FG 保留屏障、Ng/Ns、coverage、PBR、Alpha Mask、裁剪、阴影及 IBL 语义。调试分量仅在显式调试时准备；`lumen.diagnosticShaders=true` 可在 debugMode=0 保持诊断变体，供同输入最终画面对照，默认关闭。

继续使用原 ShaderCache，键不含 Model ID、dataset ID、light revision 或太阳数值。每个 session 只在原 cache 中保留实际请求且全部完成的程序家族，上限256根；新 pending 子程序会撤销家族保留引用，取消只释放本请求的引用。达到上限显式记录 overflow，不继续增加保留量。session 销毁释放所有保留引用；Scene自有共享程序仍按原引用计数拥有。

本机另独立复现：链接尚未完成就删除 program 会使 ANGLE 报 Program object expected。取消现在立即销毁请求侧对象，native句柄转入Context退役队列；仅轮询 KHR completion，完成后才删除，不反射、不绑定、不复活旧请求。停止Scene仍有有界协作轮询；context loss先处理。active+retired最多32项，满额时停止新的native提交。删除抛错则隔离保留句柄与容量、报告 cleanup error，不假装已释放。该轮询不把原同步编译搬进setTimeout。

为上述32项准备/退役记录新增128KiB公开容量估算，在原64MiB内预留；不是测得的native程序机器码大小。容量按Context共享，后续session接管同一份拥有；销毁后保留至回收完成，无无限追加的旧请求回调。无session的FG预算同样计入。原查询640KiB预留和所有原类别保持不变。

64MiB仍是 [v11公开范围](local-gi-resource-scope-v11.md) 的 CPU/GPU 逻辑拥有和预留，快照、查询及替换暂存继续计入。shader程序的驱动机器码/驱动缓存和 JS allocator 内部开销不能从 WebGL 查询，单列 not-run；程序数量、去重源码字节和存活引用另列，不能据64MiB推断全场物理显存。原全场主渲染/Globe资源也不因此消失。

## opt-in 准备路径

Session、活跃 Local GI Model 与生产 GI pass 启用 opt-in；普通无 Lumen 场景保留原引擎同步兼容路径。相关程序以 `unprepared/pending/ready/failed/cancelled` 管理。一个 Context 每帧最多提交一个新 native program；跨帧查询 `COMPLETION_STATUS_KHR`，完成后才读取 LINK_STATUS、反射并首次绑定。`_bind/allUniforms/vertexAttributes` 不会绕过 readiness。命令 pending 时不调用 draw/useProgram；已存在且契约匹配的小基础程序可继续显示。

BRDF LUT、forward/派生、DDGI 求解、receiver、FG及重建都检查实际准备与绘制结果。Context loss 先于 completion 判断；失败反射不发布半初始化程序。扩展不保证 `compileShader/linkProgram` 单次调用或驱动准备一定非阻塞，不能抢占一个原生调用。[KHR规范](https://registry.khronos.org/webgl/extensions/KHR_parallel_shader_compile/)只提供非阻塞完成查询。

无扩展时 HUD/证据明确为 `synchronous-no-extension`，仍使用有限变体和逐帧提交，但同步原生调用的停顿继续计入相同门限；不延长 timeout 后宣称通过。Gallery / Ball Pool 仅验证公共路径能达到实际 FG，不作为完整旧矩阵或它们的冷启动认证。R10 contact cache仍为实验，其初始化不在本次无缓存试点认证中。

## 复现与认证

`npm run test:pilot:startup` 默认两宿主各5次独立新进程/profile，逐次测 cold、同上下文 reload、baseline/enhanced切档、首次显式诊断与新 WebGL context；驱动缓存不可控必须披露。`npm run test:pilot:shader-lifecycle` 检查真实取消、停止渲染、context loss、销毁和各20次同上下文重载，并以同一生产源码在独立WebGL2上下文运行“立即删除/安全退役”对照。GI准备可能与基础材质准备重叠，取消测试按实际求解状态触发，不要求短暂HUD状态持续固定时间。`test:pilot:profile-equivalence` 比较旧/新基础与增强的实际 HDR 分量；`test:pilot:shader-smoke` 复用 Gallery/Ball Pool。

正式冻结源码后执行 `npm run test:r13`。入口串行执行相同测量配方的历史 before、新版、无扩展回退、上述新增检查以及原R12完整质量/资源/产品性能/响应/部署/30分钟长跑。默认从历史审查HEAD建立独立归档 clean setup/build/serve；也可用 `LUMEN_STARTUP_RUNTIME_MANIFEST` 和 `LUMEN_EQ_BEFORE_BASE` 指向逐文件验证的历史运行体，绝不回退工作区。每次 `LUMEN_REPORT_DIRECTORY` 必须为全新目录。

启动门限在 [startup-v1.json](local-gi-startup-v1.json) 冻结：UI≤1s、真实资产≤3s、新GI≤5s、输入P95≤100ms/最大≤250ms、最大停顿≤250ms。FG完成时间单列，最终32样本与3轮不降低。采集上限180秒不改变通过门限。

`test:r13 -- --cached` 必须使用同 HEAD 的显式原目录，核对源码、完整运行构建、资产、合同、配置、配方、证据哈希与子进程结局。历史 before 的旧性能失败只作负对照，允许 exit=1，但 timeout、清理失败或缺失测量仍不能认证。源码变化会清除 startupReady 和 pilotReady。启动关卡、独立绝对画质和全系统能力各自判定；必需失败/未运行均阻止 pilotReady，失败返回非零。
