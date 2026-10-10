# Lumen for Cesium

已完成 **材质 GBuffer / 前向光照接入**，以及 **WebGL2 BVH 求交、Surface Cache 光照更新和可见性感知 DDGI 更新**。引擎固定在当前目录的 Cesium 1.146.0。

默认 Sponza 使用 GPU 后端：Worker 只加载静态 glTF、解码纹理、构建和打包 BVH；探针迁移、求交、太阳遮挡、表面出射光缓存和 DDGI 积分均在 Cesium 的同一个 WebGL2 上下文中执行。生产更新没有纹理读回。保留 `?backend=cpu` 作为上一阶段参考，`?backend=constant` 为材质契约测试。

灯光变化可在运行时更新，完整场景的屏幕外颜色反弹已用 HDR 因果对照验证。GPU 迁移并不自动保证 60 FPS；正确性记录在 `artifacts/gpu-verification.json`，当前性能记录在 `artifacts/gpu-performance.json` 和 `artifacts/gpu-fast-performance.json`。动态几何、流式覆盖和镜面反射仍未实现。

## 启动

克隆仓库后，在仓库根目录运行：

```powershell
npm run setup
npm run build
npm start
```

开发服务启动在 [http://localhost:8090](http://localhost:8090)。继续开发时修改源码后运行 `npm run build`，然后刷新页面。

默认模型是你提供的 [Sponza](http://localhost:8008/gltf/2.0/Sponza/glTF/Sponza.gltf)，直接从现有资产服务加载，未修改模型文件。资产服务必须继续运行并允许跨端口访问；当前已验证它返回 CORS `*`。

页面可切换最终光照、直接光、间接漫射光、自发光和材质调试视图。可调整太阳、曝光、GI 增益、天空能量和 1–4 次反弹；太阳、天空和反弹变化会触发世界光照重算。首次计算需要等待加载、BVH 构建和探针追踪，状态栏会显示进度。

`GI 红幕布去色` 只把 GI 缓存里的材质 16、18 改为等亮度灰色，显示模型和源 glTF 保持原样。它用于因果对照：白色照明下接收表面的红色分量应随幕布去色而下降。原始幕布反照率较低，反弹差异较弱，测试使用 HDR 数值而非截图亮度判断。

## 接口

```js
scene.highDynamicRange = true;
scene.lumen.enabled = true;
scene.lumen.coverage = 1.0;
scene.lumen.debugMode = 0; // 1 direct; 2 indirect diffuse; 3 emissive
scene.gBuffer.enabled = true;

const world = scene.lumen.loadWorld({
  url: "http://localhost:8008/gltf/2.0/Sponza/glTF/Sponza.gltf",
  backend: "gpu",
  workerUrl: new URL("./lumen/gpu-worker.js", location.href).href,
  modelMatrix, // 与显示模型相同的刚性局部 ENU -> ECEF 变换
  axisMatrix: Cesium.Matrix4.toArray(Cesium.Axis.Y_UP_TO_Z_UP),
  // 本 demo 使用 Model.forwardAxis = Axis.X；默认 Z forward 还需额外轴变换。
  spacing: 2,
  rays: 128,
  bounces: 3,
  targetGpuMilliseconds: 3, // 每帧更新的 GPU 时间目标，异步计时调整批量
  maxBatch: 128,
  sunDirection: [1, 1, 0.65], // 局部坐标中，指向太阳
  sunRadiance: [2, 2, 2],
  skyRadiance: [0.15, 0.18, 0.25], // 线性入射辐亮度 L，不是 E
});
await world.completed; // GPU 已提交完整反弹结果，随后模型绘制采样它
await world.solve({ sunDirection: [0, 1, 1], bounces: 3 });
world.gain = 1; // 后端计算不使用此显示增益
scene.requestRender();
```

世界体积存在时，`scene.lumen.irradiance` 的人工值不参与光传输。调试旧入口可访问 `/demo/index.html?backend=constant`；此模式中的 `irradiance` 仍表示线性 RGB **E**，不是 `E / π`。

世界光照参数不会自动修改 `scene.light`；调用方应同步设置显示场景的直接光方向与能量，demo 的太阳控制已经同时更新两者。

`world.ready` 表示已有完整光照；GPU 重算期间继续保留该结果。`world.status === "ready"` 表示当前更新全部完成。`world.packet` 含布局、BVH 统计、缓存容量、发布 revision 和各次反弹的累计时间。GPU 后端的 `memoryBytes` 统计所有自有 GPU 纹理；CPU 后端只统计探针上传纹理。

GPU 的 `sample(points)`、`trace(rays)` 和 `snapshot()` 是明确的诊断读回，会同步 GPU；生产渲染不调用它们。`referenceTrace(rays)` 显式请求 Worker 的 CPU 求交，只用于验证。CPU 后端仍使用 Worker 查询。几何、坐标、间距、射线数改变需要重新 `loadWorld`；更换后端还须同时更换 Worker URL。

连续灯光请求会合并：正在运行的完整 generation 继续计算，下一次取最新灯光快照，避免拖动太阳时不断重新开始。被后续请求取代的 Promise 拒绝为 `superseded`；最后一个 Promise 在其 revision 发布后完成。`metrics.updates` 记录实际更新延迟，`metrics.passes` 记录异步 GPU 批次时间。默认每帧最多 8 个批次，昂贵批次有探针数和 4,096 次节点访问上限；未知射线绝不作为天空。3 ms 是基于延迟计时的调度目标，不是最坏情况硬保证。

静态世界是显式载入的快照，不随主相机裁剪卸载；移动、隐藏、动画或裁剪显示模型不会自动改写该快照。需要改变物理场景时应重载世界。整个 Scene 销毁会终止 Worker、拒绝未完成请求并释放探针和 GBuffer 纹理。

对于已适配的材质，光照顺序为：

```text
L = shadowVisibility × direct
  + diffuseReflectance × E / π × coverage
  + diffuseIBL × (1 - coverage)
  + specularIBL
  + emissive
→ 原有材质后续处理 / 大气与雾 / 透明合成 / 色调映射
```

这里的 `coverage` 是用户替换比例乘以局部探针有效覆盖。体积外、无有效探针或加载失败时为零，回退到原有漫射 IBL。太阳阴影仅影响直接项。关闭 Lumen 使用原有 Cesium 光照；GBuffer 捕获独立于世界 GI，世界后端不依赖屏幕纹理。

### 世界数据与更新

GPU 后端的管线：

```text
Worker: glTF / material atlas / threaded BVH packing
GPU once: probe relocation → closest-hit rays → classification → geometry distance moments
GPU on sun direction change: energy-independent any-hit visibility cache
GPU per lighting revision: direct surface cache (reuses hits / sun visibility / moments)
GPU per bounce: outgoing surface cache(previous complete DDGI)
               → 8×8 directional irradiance → separate-image 10×10 border copy
GPU publish: complete final snapshot, or each complete round in explicit progressive mode
Model PBR: coverage-aware DDGI diffuse → existing HDR/display pipeline
```

`LumenGpuWorld.js` 管理持久 FBO、纹理预算、分批调度和完整快照发布；`LumenGpuShaders.js` 实现求交、材质求值、缓存和积分；`lumen/gpu-worker.js` 只准备静态输入。节点为带 escape 指针的前序 BVH，叶子最多 8 个三角形。alpha mask 在实际命中 UV 处采样，可以穿过透明 texel 继续求交。

GPU Surface Cache 按 `(probe, ray)` 寻址：RGBA32F 命中纹理保存三角形、重心坐标和距离，结合驻留 GPU 几何得到世界位置；RGBA16F 直接光缓存和出射光缓存保留线性辐亮度与有效性。同一表面被多个探针命中时会有重复缓存项，目前没有 Cards、空间去重或动态失效。这与 CPU 的每三角形四个采样点近似不同，不能要求两种后端逐 texel 相等。

DDGI 采用三张 RGBA32F irradiance atlas：一个保持已发布场景，另外两个作为内部反弹快照；所有轮次共享一张只由几何决定的距离矩 atlas。太阳可见性使用 RGBA8 缓存已知/未知和诊断查询标志，与灯光能量分离。读写附件始终不同；默认在完整 generation 结束后更换模型采样纹理，显式 progressive 模式在每完整轮全部探针和边界完成后发布。支持 float 线性过滤时使用硬件双线性采样，否则使用原有四次 texelFetch 插值。材质合同和局部 ENU 坐标保持上一阶段一致。

R1 显式记录 `world.versions` 的 geometry、rayLayout、material、sunVisibility、lighting 版本；`packet.versions` 对应已经发布的快照。每个 job 使用不可变参数。只改天空/太阳强度复用有效太阳缓存；改方向重新查询太阳，probe hits 和距离矩不变。几何与光照有效性分别保存在 M.a 和 E.a 中，Unknown 光照不会伪装成有效照明。`cacheDiagnostics()` 明确读回缓存，报告有效命中、真实太阳查询数和 Unknown 数；更新器只报告实际提交的槽数，二者不会混为一谈。

GPU `solve({ materialOverrides: [{ id, baseColorFactor: [r,g,b], emissiveFactor: [r,g,b], metallicFactor }] })` 可改变静态材质的 RGB/自发光/金属度因子，不重建几何。因子仅改变 GI 缓存，前台原始模型材质保持原样。每次 overrides 都相对原始材质求值，空列表恢复原始值；`neutralMaterials` 仍保留。alpha、双面性、纹理布局和 `traversalBudget` 会影响命中语义，必须重新载入，不能在 solve 中改变。

下面是保留的 CPU 参考路径：

| 模块                                  | 实现                                                                                                                                                              |
| ------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `lumen/gltf.js`                       | 读取全部静态三角形、节点层级 / TRS / stride / normalized accessor，转换为局部米；base color / emissive 解 sRGB，metallic 使用 B 通道；alpha mask 求交拒绝透明采样 |
| `lumen/bvh.js`                        | 中位数划分的平衡三角形 BVH，保守 AABB，双面遮挡，closest hit；预算耗尽返回 `Unknown`，不当作天空 `Miss`                                                           |
| `lumen/surface-cache.js`              | 每三角形每侧最多四个 surfel，按实际 probe 命中惰性分配；BVH 查询屏幕外太阳遮挡；缓存 `Lout = ρ × (Edirect + Eprevious) / π + emissive`                            |
| `lumen/ddgi.js`                       | Fibonacci 球面射线；8×8 octahedral 方向辐照度 / 距离一阶二阶矩及镜像边界；探针近背面迁移 / 背面比例分类，三线性权重、法线偏置与方向可见性                         |
| `LumenWorld.js` / `LumenStageFS.glsl` | Worker generation / revision 管理、纹理预算、完整纹理替换，CPU 双精度 eye→ENU 变换，GPU 使用局部坐标采样并在 tone mapping 前合成                                  |

每次重算从零开始。第 1 次只使用太阳、天空和自发光，第 n 次 Surface Cache 只读取完整的第 n−1 次探针数据；不会读写同一代光照。几何静态时复用探针交点和 surfel 地址，重算反射光与探针积分。主相机位置和显示曝光不影响后端。

当前 Surface Cache 是 surfel 实现，不是 Unreal 的 Cards 系统。反射材质用几何法线和 Lambert 漫反射近似，未追踪镜面项和法线贴图微表面；纹理解码限制到最大 512 像素边长，缓存采样也存在空间近似。遮挡几何保持 Sponza 全部 262,266 个非退化三角形，不做视锥裁剪或网格简化。

静态 loader 支持本次标准 metallic-roughness Sponza；遇到动画、skin、morph、Draco、BLEND、非三角形、sparse accessor、非 UV0 或未支持的 required extension 会明确报错。尚未对所有 glTF 扩展、复杂节点变换和材质组合完成验收。

默认 2 米 / 128 rays 布局是 17×12×9，共 1,836 probes。GPU 后端自有纹理约 **89.01 MiB**，包含完整 BVH / 顶点 / UV、512 像素边长材质 atlas、命中与表面缓存、迁移/分类位置、三张 E atlas、共享几何 M、太阳可见性缓存及两张内部工作纹理。235,008 是缓存槽容量，包含 Miss / 背面 / Unknown，并非独立表面数量。默认 GPU 纹理预算 192 MiB，最多 4,096 probes / 512 rays；超过纹理尺寸或预算时报错并回退材质 IBL。CPU 参考的三张探针纹理仍为 5.63 MiB，上传峰值按两份计算，默认预算 128 MiB。

上述预算不含显示模型纹理、主帧缓冲、阴影图和 Worker CPU 几何内存。GPU demo 默认关闭独立 GBuffer 捕获，需要材质调试时再启用；GI 本身不依赖它。可用 `?spacing=3&rays=64&gpuBudget=6` 降低更新负载，或 `?shadowSize=1024&scale=0.5` 降低显示渲染成本；这会改变质量，不能与默认配置的结果混为一谈。

### GBuffer 数据契约

| 接口              | 格式    | RGB                                            | A                                          |
| ----------------- | ------- | ---------------------------------------------- | ------------------------------------------ |
| `albedoTexture`   | RGBA32F | 材质求值后的线性漫反射系数，含金属度工作流分配 | 材质有效性，1 有效 / 0 未适配或背景        |
| `normalTexture`   | RGBA32F | 有符号的视空间着色法线，含法线贴图             | 粗糙度                                     |
| `positionTexture` | RGBA32F | 视空间位置，米                                 | 正的轴向深度 `-positionEC.z`，不是欧氏距离 |
| `emissiveTexture` | RGBA32F | 线性自发光                                     | 材质有效性                                 |

`depthStencilTexture` 为绘制时的硬件深度/模板附件。它按各视锥清理，**不能作为合并后全场景的统一深度输入**。GI 查询应使用已合并的 `positionTexture`。

材质数据在 `lightingStage` 之前保存，输出在完整片元路径执行后写入，保留 alpha mask、裁剪、显隐和对数深度逻辑。按远到近的顺序逐视锥回放同帧准备好的命令，并恢复对应投影。没有重复调用 `scene.render()`。

### 支持范围

| 对象 / 功能                                                | 当前状态                                       |
| ---------------------------------------------------------- | ---------------------------------------------- |
| 有法线的标准 PBR glTF 三角形、普通不透明和 alpha mask 材质 | 已接入；Sponza 实际 GPU 验证                   |
| 使用同一 Model 管线的 glTF 3D Tiles                        | 具备源码接入；真实流式瓦片尚未验收             |
| normal map、模型裁剪、模型隐藏、普通/对数深度、多视锥      | 已在 Sponza 或对应检查中验证                   |
| 非 Model 的普通不透明命令、Globe                           | 可回放遮挡并输出无效材质；没有地形 GI 材质适配 |
| 透明、分类、特殊业务绘制、模型着色叠加和轮廓               | 未作为 GI 接收材质验收                         |
| 无法线、unlit、CustomShader、clearcoat、anisotropy         | 使用原有光照，未标记为有效 GI 材质             |
| 2D / Columbus View / VR、上下文丢失恢复                    | 未适配或未验收                                 |

GBuffer 表示不透明表面层。透明对象不能当作完整 GI 材质输入。未适配的不透明命令也会写入硬件深度，避免把它们背后的模型误当成可见接收表面。

### 资源预算

要求 WebGL2、`EXT_color_buffer_float`、至少 4 个颜色附件及 draw buffers，并实际检查帧缓冲完整性。四个 RGBA32F 附件与深度模板合计 **68 字节/像素**：1280×800 约 66.4 MiB，1920×1080 约 134.5 MiB。

第一版优先固定数据精度，不将视空间位置压入半浮点。默认 GBuffer 预算为 256 MiB；超过 `maximumMemoryBytes` 时停止分配并报告 `memory budget exceeded`，保留原有画面。窗口缩放会重建附件，禁用后释放，重新启用后恢复，Scene 销毁会统一释放。这里的统计仅包含 GBuffer，不包含 Sponza 纹理、Cesium 主帧缓冲和阴影图。

## 验证

仓库自带三组静态 glTF fixtures，可独立于 Sponza 资产服务运行：

```powershell
npm run fixtures
npm --prefix cesium-1.146 exec -- playwright install chromium
npm run test:fixtures
npm run benchmark:relighting
```

`test:fixtures` 是带明确 GPU 读回的数值诊断；`benchmark:relighting` 单独运行，并监测实际 GL 的读回、阻塞等待、纹理 feedback 和资源调用。性能结果中的 `submissionMilliseconds` 测量 CPU 提交与纹理发布，不代表 GPU 完成或像素呈现。全帧 GPU 查询仍仅在更新器空闲时运行，阶段计时由更新器的异步查询提供。

Sponza 基准可用 `LUMEN_BENCH_SCENE=sponza` 和 `LUMEN_ASSET_URL` 配置。服务缺失时报告 `not-run` 并返回非零退出码。默认质量固定为 960×640、2048 阴影、2 m / 128 rays / 3 bounces / 3 ms，每类更新重复三次。小场景单列为 512×384、2048 阴影、1 m / 128 rays / 3 bounces / 3 ms。`CHROMIUM_PATH` 可指定浏览器。

保持两个本地服务运行，在另一个终端执行：

```powershell
npm test
npm run test:world
npm run test:transport
npm run test:pipeline
npm run test:gpu
npm run benchmark:gpu
```

验证脚本实际启动 Chromium、载入 Sponza、执行 WebGL 绘制并读取 GPU 附件。结果写入 `artifacts/verification.json`，庭院截图为 `artifacts/sponza-courtyard.png`。测试使用同步 readback 是为了检查数据；生产渲染没有 CPU 纹理读回。

本次设备是 ANGLE / Intel UHD Graphics / Direct3D11。已经验证：太阳和曝光不污染材质输入；阴影不压暗间接光而会压暗直接光；HDR 间接项符合 `ρ × E / π`；普通及对数深度下位置对应像素；强制 8 个视锥后仍正确；裁剪和隐藏无残留；附件释放、重建、缩放、预算拒绝、Scene 销毁正常。

第一阶段位置投影误差最大约 0.0047 像素，受控 HDR 间接项误差最大约 `6.1e-5`。世界 GI 检查见 `artifacts/world-verification.json`：真实 GBuffer 接收位置与 BVH 对齐；GPU `ρ × E / π` 与 Worker 可见性采样一致；白色天空下红幕布去色导致中性地面红分量下降；全部已缓存红幕布 surfel 离开视锥后从头重算，相同接收点仍保留颜色差，同时检查实际 GPU HDR 输出，避免只证明旧缓存不变。

`test:transport` 用 500 条射线与独立暴力平面 / 重心坐标参考比较 BVH，并检查 alpha 透过、Unknown、常量天空 `E = πL`、反弹能量不凭空增长以及合成薄墙场景的方向矩插值抑制。薄墙测试验证采样公式，不代表 Sponza 的所有薄壁、边角和探针布局都无漏光。

上一阶段 CPU 世界 GI 浏览器验证 12 项通过：400 个真实 GBuffer 位置中 396 个在 8 毫米误差内匹配 BVH；GPU 间接项最大误差 `5.63e-6`；860 个缓存红幕布 surfel 全部离开视锥后，重算的接收点辐照度与原视角完全一致。红幕布颜色相对于去色使该地面点的 E 增加 `[+0.000462, -0.000203, -0.000181]`，实际 GPU HDR 红通道也保留正差。该阶段首次加载和求解约 22 秒。

截图为 `sponza-color-bounce.png`、`sponza-neutral-curtains.png` 和 `sponza-offscreen-color-bounce.png`。`sponza-color-bounce-difference.png` 显示实际线性 HDR 的 `(ΔR−ΔG) × 5000` 差值，红色表示红幕布导致的红色偏移；**这是放大诊断图，不是最终光照亮度**。测试中的幕布去色只作用于 GI 缓存；原始模型文件保持不变。当前证明静态场景的颜色传输与屏幕外贡献；没有宣称 Unreal Lumen 画质一致、全引擎兼容、实时帧率或动态流式场景验收通过。

本轮 GPU 验证 11 项通过，见 `artifacts/gpu-verification.json`：

- 完整 262,266 个三角形；1,836 个探针中 1,776 个有效；全部 235,008 条探针射线没有 Unknown。
- 800 条 GPU 求交与 CPU BVH 全部匹配，最大距离差 `1.24e-5 m`；强制预算耗尽返回 Unknown。
- 实际材质 HDR 的 `ρE/π` 最大误差 `7.13e-6`。GPU 硬件双线性 gather 与独立 CPU 浮点插值误差最大约 `7.33e-4`，两者精度有差异。
- 太阳反向使 1,525 个接收样本发生变化；更新期间旧完整场景保持可用，最新 revision 最终发布，所有光源关闭后 E 为零。
- 152 个中性地面样本显示红幕布颜色传输。选中位置 `[2.3741,1.8823,-0.02005]` 的 E 差为 `[+0.000685,-0.000319,-0.000275]`。
- 用每个三角形的三个顶点检查六个裁剪平面，29,952 个红幕布三角形全部在视锥外；从零重新反弹仍得到相同 E 差，中心实际 HDR 差为 `[+6.87e-5,-2.67e-5,-1.53e-5]`。
- 生产更新 readback 为零；GPU disjoint 为零；Scene 销毁释放 Worker、程序、FBO 和自有纹理。截图为 `sponza-gpu-final.png`、`sponza-gpu-colored.png`、`sponza-gpu-neutral.png`、`sponza-gpu-offscreen.png`。

性能验收使用 `npm run benchmark:gpu`，当前报告为 `artifacts/gpu-performance.json`，保留全部配置、可见性、帧间隔和 GPU 计时范围。它关闭 GBuffer，在同一庭院视角比较 GI 关闭、静态 GI 和每 200 ms 改灯。当前 Intel UHD / ANGLE D3D11 / headless Chromium 的默认 960×640、2048 阴影、2 m / 128 rays / 3 bounces 配置：GI 关闭约 **6.54 FPS**，静态 GI **6.48 FPS**，持续改灯 **6.62 FPS**；两个单步太阳变化完成时间约 **19.38 / 21.15 秒**。关闭 GI 的对照也慢，不能把该帧率全部归因于 GPU 探针更新，且它不是独占 GPU 的前台手工测试。

当前设备不支持 timestamp query，更新期间的全帧 GPU 时间不能与内部 elapsed query 同时测量，因此仅提供实际 RAF 帧率和内部批次时间；`gpuScope: idle frames only` 明确标注这一限制。早期 `gpu-verification.json` 内的改灯性能测量占用了 elapsed query，阻止更新器调整批量，**该部分性能数字已由独立 benchmark 报告替代**；求交、HDR、颜色传输和资源检查仍有效。默认质量尚未达到实时 GI 的性能目标；迁移已完成，性能验收没有计作达标。

低负载配置另行测量，见 `artifacts/gpu-fast-performance.json`：3 m / 64 rays / 3 bounces、6 ms 更新目标、1024 阴影、480×320，静态 GI 约 **15.23 FPS**，持续改灯 **17.13 FPS**，两个单步太阳变化约 **2.25 / 3.07 秒**。持续改灯期间完整 generation 约 0.88–2.97 秒，最新请求停止后约 1.19 秒完成。它降低探针和显示质量，尚未达到每帧收敛；默认质量的颜色精度结论不直接覆盖这个预设。可打开 [低负载 Sponza](http://localhost:8090/demo/index.html?backend=gpu&spacing=3&rays=64&gpuBudget=6&shadowSize=1024&scale=0.5)，重跑命令：

上述独立 benchmark 的首次完整启动分别约 133 秒和 32 秒，包含模型/纹理加载、shader 编译、BVH 上传和初始探针求交；静态射线命中会驻留复用，改灯不重新追踪探针几何。

```powershell
$env:LUMEN_FAST = "1"
npm run benchmark:gpu
```

相关 Cesium Jasmine 规格也已更新，在项目根目录执行 `npm run test:pipeline` 可独立运行这两组不依赖 GPU 的规格，9 项通过。材质/GBuffer 浏览器回归 15 项和 transport 的 4 组检查也通过。Cesium 原来的 Karma 总入口在当前无界面浏览器中遇到全局 WebGL 初始化与断连问题，没有计作通过结果；完整引擎回归尚未完成。

## 源码与来源

GBuffer 的派生命令缓存、渲染状态缓存、视锥克隆及逐视锥回放复用自 [SilverStr1ng/cesium](https://github.com/SilverStr1ng/cesium)，固定参考提交 `bf2eaae3719aad0fb05be7477af7f48ae4823d2a`。本次替换了原先的已着色颜色/深度求导法线输出，增加了准确材质导出和资源状态管理，没有整体覆盖旧版 Scene。

引擎修改集中在 `packages/engine/Source/Scene/Scene.js`、`GBuffer.js`、`Lumen.js`、`LumenWorld.js`、`ShadowMapShader.js`、Model 的 Lighting / IBL pipeline，以及对应 GLSL；世界计算模块在根目录 `lumen/`。原始修改文件备份在 `.lumen-baseline`；`npm run patch` 导出引擎差异到 `artifacts/cesium-lumen.patch`。移植时还需复制 `lumen/` 并配置 Worker URL。

DDGI 的方向辐照度和距离矩方法参考 [NVIDIA RTXGI 的公开算法资料](https://github.com/NVIDIAGameWorks/RTXGI-DDGI)。本项目独立实现 CPU 参考和 WebGL2 GPU 路径，没有移植 DXR / Vulkan SDK。浮点附件与 GPU 计时遵循 [EXT_color_buffer_float](https://registry.khronos.org/webgl/extensions/EXT_color_buffer_float/) 和 [EXT_disjoint_timer_query_webgl2](https://registry.khronos.org/webgl/extensions/EXT_disjoint_timer_query_webgl2/)；结果异步检查并排除 disjoint。全帧性能计时优先用 timestamp 对，避免占用更新器自身的 elapsed query；不支持 timestamp 时仅在 GI 空闲帧测全帧 GPU 时间，更新期间仍测实际 RAF 帧间隔。

## 下一阶段

本轮仅实现静态几何低延迟重照明。局部更新、刚体 BLAS/TLAS、动态物体和 3D Tiles/地形驻留按后续里程碑分开推进；时间过滤、屏幕追踪、镜面反射和 Unreal Cards 尚未实现。

## R2 内部积分与边界复制

距离矩只在几何初始化时积分一次。E 每轮只计算 8×8 内部，随后从独立工作纹理复制到 10×10 发布 atlas；读图像和 FBO 写图像始终分离。两张 RGBA32F 工作纹理在默认 Sponza 网格上共增加 3,760,128 字节。

同设备、同质量、交替顺序各三次的 Sponza A/B，算术版积分 GPU 中位数 17.46 ms，LUT 为 20.40 ms；边界复制分别 1.71/1.79 ms。LUT 没有积分收益，生产默认使用算术版且不分配权重表。`diagnosticIntegrationLut: true` 仅供显式 A/B 回归，额外分配 131,072 字节并初始化一次 GPU 权重表。A/B 墙钟中位数 5.81/5.36 秒、范围重叠且 LUT 有 10.66 秒离群值，不能据此认定 LUT 更快。

`npm run test:integration` 检查两条诊断路径的完整 E/实际 HDR（绝对 2e-4 + 相对 1e-3）、逐 texel 镜像边界、接缝及固定距离矩。`npm run benchmark:integration` 为独立无读回运行；设置 `LUMEN_BENCH_SCENE=sponza` 使用默认 Sponza。持久报告在 `reports/relighting-v2/r2-*.json`。R0 全字段比较及 R1 灯光依赖/Unknown 回归继续通过。

## R3 逐轮发布接口

生产默认 `publicationMode: "snapshot"` 保留完整 N 轮原子发布。显式 `"progressive"` 在所有探针及八面体边界完成后发布第 1、2、…、N 轮，每轮至少留一个前台渲染帧。三个 E atlas 的 published/read/write 角色独立管理；published 和 read 可以共用完整图像，write 必须与两者不同。内部积分、边界复制与前台采样从不读写同一图像。M 为一次生成的共享几何纹理。

`requestedRevision` 是最新请求，`activeRevision` 是当前执行代（空闲为 0），`publishedRevision/publishedBounce` 是实际前台场，`settledRevision` 是最近完成指定全部轮次的代。`ready` 仅表示已有可用场。`solve()/completed` 在最终 N 轮 draw 已提交并选为前台后完成；`firstPublished` 在该请求首次完整发布时完成；两者均不代表 GPU 完成或像素已呈现。`publicationEvent` 携带 revision、bounce、final 和上述状态；`atlasState()` 仅返回 CPU 所有权元数据，无 GPU 读回。

`solve()` 的输入按任务冻结。连续请求只保留最新 pending；progressive 完成已开始的一轮后发布，再切换最新请求，跳过旧代更深轮次。被替代的最终/预览 Promise reject 为 superseded；停止输入后最新代仍完成指定 N 轮。第一轮忽略旧场，无隐藏 warm start。enabled 是原有显示开关；停止并释放几何、Worker、query、纹理及 pending 请求请调用 `world.destroy()` 或销毁 Scene，再用 `loadWorld()` 重建。

示例：

```js
world.publicationEvent.addEventListener(({ revision, bounce, final }) => {
  console.log(revision, bounce, final);
});
const final = world.solve({ publicationMode: "progressive", skyRadiance: [.2, .2, .3], bounces: 3 });
const preview = await world.firstPublished;
await final;
```

Sponza 可用发布方式下拉框，或 `demo/index.html?backend=gpu&publication=progressive`。`npm run test:progressive` 在自包含 GPU fixture 验证实际首轮 HDR、不同显示帧、N 轮完整字段/HDR 一致、60 次连续改灯、GL 资源稳定、按需渲染停止、Promise 清理及失败恢复。

## 本轮 v2 交付

R0–R3 已在独立分支 feat/static-relighting-v2 完成。阶段提交、状态与纹理所有权、构建／回归／benchmark 命令、真实通过／失败／未运行记录及默认质量前后数据见 [持久交付报告](reports/relighting-v2/README.md)；机器摘要为 [summary.json](reports/relighting-v2/summary.json)。太阳方向不变的更新 GPU 时间下降约 85–90%，progressive 的天空／强度首轮发布约 3.03／2.22 秒，三轮最终约 7.34／6.42 秒。时间指 CPU 提交与 atlas 发布。太阳方向刷新未达到 30% 改进，当前设备显示仍约 6–8 FPS，未宣称实时显示达标。原 GPU／CPU 世界及 GBuffer 回归本轮均重跑通过。
