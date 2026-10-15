# Local GI v0.1 部署与嵌入 · v11

这是静态、有界局部代理试点。质量及投入使用结论见[用户报告](../progress/latest.md)，冻结的设备/质量合同见[Local GI v0.1](local-gi-v0.1.md)。部署成功本身不生成 pilotReady。

## 本机与非根路径

在仓库根目录依次运行 `npm run setup`、`npm run build`、`npm start`。首次 setup 按 lockfile 安装依赖，需要访问 npm；安装完成后的页面、Worker、GLB与纹理从本机提供，不需要 token 或远程资产服务。

入口：[Models](http://localhost:8090/demo/pilot-models.html)、[Tiles](http://localhost:8090/demo/pilot-tiles.html)、[最小嵌入](http://localhost:8090/demo/pilot-embed.html)。两个完整宿主共用已有 session；最小嵌入只演示公开 load/dispose 与宿主拥有 Scene 的边界。

PowerShell 中可使用非根路径：

```powershell
$env:LUMEN_PORT = '8091'
$env:LUMEN_BASE_PATH = '/deploy/lumen'
npm start
```

打开 `http://localhost:8091/deploy/lumen/demo/pilot-models.html` 或 `pilot-tiles.html`。`pilot-base.js` 从自身 URL 设置 Cesium 资源基址，Worker 与清单继续使用模块相对 URL。该端口下 `/demo/...` 不属于部署前缀，返回404。

## CSP、同源与运行文件

当前 Cesium bundle 的依赖初始化包含动态 JavaScript 与 WASM。实际部署需要明确允许；严格 `script-src 'self'` 的失败记录保留，不能声称本 bundle 支持该严格策略。验收采用：

```text
default-src 'self';
script-src 'self' blob: 'unsafe-eval' 'wasm-unsafe-eval';
worker-src 'self' blob:;
connect-src 'self' blob: data:;
img-src 'self' blob: data:;
style-src 'self' 'unsafe-inline'
```

可将上述合并为一行并通过 `LUMEN_CSP` 传入本地服务器，或由业务 HTTP 服务器设置同名响应头。JS/WASM 的求值权限属于本版公开部署限制；没有使用 `bypassCSP`、`--disable-web-security` 或关闭 Chromium sandbox。需要更严格策略的业务必须先完成依赖构建适配，当前不认证这种部署。

本轮只认证同源 Worker/资产；不要求宽泛的 CORS 通配。Blob/data 用于经哈希验证的冻结内容，独立资产仍按完整 canonical URL 标识。Cesium内联Worker还会通过importScripts加载本页生成的Blob脚本，因此script-src与worker-src都需要blob:。自建服务器须提供 `.js/.mjs` JavaScript MIME、`.gltf` JSON、`.glb` 二进制 glTF、`.wasm` application/wasm。

发布需要保留 `demo/`、`lumen/`、`fixtures/local-pilot/` 与完整 `cesium-1.146/Build/CesiumUnminified/` 目录结构，包括 Workers、ThirdParty、Widgets和Assets。只复制 Cesium.js 会缺资源。Git规则固定 fixture及复制资产的LF；构建按排序后的模块入口生成，干净归档与工作区须逐项比对运行文件，不能只比对主 bundle。

## Session 与失败恢复

业务调用 `load/replaceDataset/setLighting/setQuality/waitForVisible/dispose`，不修改世界、FG或Tiles内部字段。load完成表示数据/GI准备完成，不要求相机已看向瓦片；显示可另限时等待。改灯请求保留一个活动目标及最新待处理目标，各调用以 completed、superseded或cancelled结束。

64MiB不足时拒绝新分配并保留匹配旧世界，状态为degraded并记录原因。致命 Scene renderError/context loss 要销毁并重建 Scene/session；本版不承诺原地恢复。切换父子LOD或卸载显示不卸载常驻GI代理，也不意味着城市流式GI。

`npm run test:pilot:deployment` 创建独立归档安装构建，核对源码、运行构建及资产，实开根/非根路径下的两个宿主和最小嵌入。`npm run test:r12` 再串行执行完整11关卡，包含30分钟真实巡航；每次使用新证据目录，失败非零。正式验收期间不要修改其冻结输入。
# 部署资源事件

部署检查保留所有原始 `requestfailed` 与 CDP `loadingFailed`。流已结束、当前会话拥有完整资源时，浏览器仍可能报告取消；这类事件只可标为 `cancelled-with-verified-content`，不改写成请求成功。

该分类要求同一 CDP requestId 的 GET/Fetch、HTTP 200、`net::ERR_ABORTED` 和 `canceled=true`；请求唯一且来自当前页面、会话、已提交 generation 和资源 scope，信号未取消、scope 未关闭；canonical URL 必须由当前清单声明，当前 scope 拥有的实际完整字节必须匹配响应长度，并重新计算 SHA-256 匹配清单。哈希结束后重查拥有权，世界必须仍 ready、无错误、已发布相同 revision 的最终第3轮。版本必须是正安全整数，取消/关闭状态必须明确为false。任一条件缺失、脚本/Worker/导航/CSP/CORS 或其他网络错误仍使部署失败。判据有包含缺失字段的反例检查，原 strict-any-requestfailed 候选记录保留。
