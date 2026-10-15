# R13.0 启动定位：生产代码仍为96dd1e7对应实现

启动门槛在实测前冻结于`docs/product/local-gi-startup-v1.json`。命令为`node scripts/verify-pilot-startup.mjs`；通过环境变量指定输出、宿主和次数。当前定位各一次，不冒充五次正式启动认证。

`r13-0-before-presented`使用实际postRender完成帧，排除receiver/depth/pick绘制：Models首资产61783.2ms、目标FG62303.4ms、最大主线程间隔51864.8ms；Tiles首资产60403.6ms、目标FG64313.9ms、最大间隔54137.6ms。真实F8输入通过CDP提交并在页面处理，最大延迟51838.7/54133.1ms。均failed并退出1。1920×1080、RTX5080、Chrome155、KHR扩展存在；每个宿主使用新浏览器/profile，驱动缓存未控制。

较早的`r13-0-before-models-1`与`r13-0-before-tiles-1`保留CPU采样和原生调用/source hash定位。这两次的firstAssetFrame仅是原生绘制提交，包含离屏接收器，firstSceneFrame仅是第一次draw；不作为可见首屏指标。新的presented配方修正这一口径，旧JSON未覆盖。

多份约86KiB的FG模型片元程序在LINK_STATUS查询各阻塞约10s，而linkProgram提交本身接近0ms。示例片元SHA256：`eb19c38bbce1a2763a145fdbb182caa2efca16b0ec3474cbe123d3f06c44cbb7`（86334B）。源文件与CPU profile位于各次新目录。该证据区分native查询等待、反射、首次使用，不声称得到了驱动内部编译子阶段时间。

优先检验：不必要的FG/调试源码进入非FG与派生pass；首次getter/绑定引发同步链接；之后再判断解析、上传和几何CPU是否仍限制首屏。原34/40物理画质失败、R12证据和预算均保留。
