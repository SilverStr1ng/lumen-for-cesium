# Earth GI Lab

运行仓库 setup/build/start 后打开 http://localhost:8090/demo/globe.html 。默认资源全部来自仓库，不依赖 Sponza 或 token。重新生成场景：`node scripts/generate-globe.mjs`。浏览器验收：`node scripts/verify-globe.mjs`，真实截图与原始数据位于 `reports/globe-visibility-v3/globe-*`。

模型和 GI 共享 `fixtures/earth-pavilion.gltf`、同一 modelMatrix 和模型实际 axisCorrectionMatrix。单位为米、Z 向上；厚地基、地板、墙、廊顶都在 glTF 中。默认 2m spacing / 128 rays / 3 bounces / 3ms GPU 预算，gain=1。页内显示实际探针数。默认只显示地球，建筑可用后随时选择展馆等书签；GI 异步加载不阻断导航。

可选增强在设置面板输入专用 public-client ion token 与用户授权的影像 asset ID，可选 World Terrain。token 只保存在页面内存，不写 URL/localStorage/文件，不提交、截图或保存请求日志。仅需 assets:read，并将权限限制到使用资产和 Allowed URLs；浏览器 token 对使用者可见。无真实 token 的在线验收为 not-run。

增强失败保留本地 NaturalEarthII 影像及 EllipsoidTerrainProvider。启用真实地形前自动对中心与四角一次性采样，共享锚点设为最低采样地形+1.5m，然后共同激活地形并原子重建局部 GI。“采样地形并重建”可显式重新采样。采样失败或起伏超过1.4m（为1.5m地基保留0.1m净空）时拒绝地形增强，回退本地；本轮不声称任意地形无缝接合。相机切换、曝光及 GI A/B 不改变后端传输。

GI 仅覆盖局部展馆及地基；外围地球、影像和真实地形不参与完整 GI。上半球天空环境 opt-in，地平线以下为黑。太阳采用手动 ENU 方向，经 frame 旋转到 ECEF 后取反作为 DirectionalLight.direction；天文太阳盘隐藏，Globe 大气采用场景光源。

产品 A/B 使用同一个 Viewer，Lumen 关闭时恢复 IBL。纯间接视图及“GI 彩墙中性化”用于因果检查，不提高 gain。普通页面不启用 GBuffer/preserveDrawingBuffer；仅 `?diagnostic=1` 为截图诊断保留绘图缓冲。


地理配置以 `scripts/generate-globe.mjs` 输出的 `fixtures/earth-pavilion.json` 的 anchor 为初始来源：longitude、latitude、height（椭球米）、heading（度）。调试时也可修改 `earthLab.anchor` 后调用 `await earthLab.reload()`，这会销毁并重建局部 world，不是动态几何变换。相机导航不触发这一流程。

页面太阳方位按局部 ENU 中从 +East 向 +North 的角度标注；设置面板可调整太阳高度（1–89度，始终在地平线上方）。默认精确为 atan(0.65)，约33.02度，保留旧 sunDirection 的 z=0.65，不改变默认截图/质量条件。统一 lightingController 同时更新 GI 局部方向和显示用 ECEF 光传播方向；高度变化按当前 snapshot/progressive 模式请求重照明。


