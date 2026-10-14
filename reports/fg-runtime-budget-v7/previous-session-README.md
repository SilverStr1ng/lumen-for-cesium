# R8：FG 运行成本与桌面预算

本轮分支 `feat/fg-runtime-budget-v7`，起点 `645cf61201d671b21298dd88e08d48d0fbe7a8cb`。保留后续实现；未回退或合并 main。最终状态以 `test-suite.json` 为准；任何必需失败退出 1，未运行阻止推荐。

运行：在仓库根目录执行 `npm run build`、`npm start`，打开：

- [原展馆 Auto](http://localhost:8090/demo/globe.html?fg=fg&fgQuality=auto&fgSampling=reconstructed)
- [Gallery 桌面 Auto](http://localhost:8090/demo/gallery.html?nativeBuffer=1&fg=fg&fgQuality=auto&fgSampling=reconstructed)
- [本轮只读数据面板](http://localhost:8090/reports/fg-runtime-budget-v7/index.html)

Gallery 默认保持 R7 的展示分辨率上限。`nativeBuffer=1` 是显式桌面入口；Auto 自身不修改主画面、阴影、曝光、网格或反弹。

执行与资源改动：

- B 保留原 fixed-reference raw。C 与 D 使用相同二维像素/实际 epoch 采样，关闭历史和过滤；固定与 Auto 对照使用相同接收尺寸。
- 默认 split 后端保留。4/8 射线融合可切换；4 射线融合实测更慢，未设为默认。
- `azimuth` 仅重排每个像素该帧已有的样本。GPU 方向集合逐项差为 0；未恢复所有像素共享固定方向。
- 按需 DDGI 在 FG 完整可用时跳过八探针 fallback。raw/coverage/debug 保留完整基准；生产 data coverage 表示已选择 FG 数据可用性，不能解释为 DDGI 探针支持图。
- Auto 根据实际 drawing buffer、全部自有附件、快照、查询和设备限制选择接收比例，保留 32r，默认新增预算 64 MiB。raw 消融预留重建容量以保持 C/D 尺寸一致，实际不分配历史。
- 同帧预通道、线性 E、source/revision/round 和资源拥有权保持。尺寸变化时，冻结/暂停缓存也重分配并使历史无效。
- HUD 区分请求与实际路径、主 buffer、接收尺寸、rays、积累、字节和回退原因。逐像素覆盖由实际屏幕诊断验证；ready 不代表 recommended。

命令：

```text
npm run test:r8
npm run test:r8 -- --cached
npm run test:r8:quality
npm run test:r8:budget
npm run test:r8:desktop
npm run benchmark:r8
```

全量入口串行运行 GPU；请勿并发运行多个 GPU 测试。cached 核对源码、bundle、纹理资产、完整配置/producer/原始输入，重算阈值，并按真实子进程退出码重算状态。缺扫描线、缺查询、非零/null 子进程、伪造覆盖和旧 JSON 均拒绝通过。

质量使用原六线、49 点、原计分集合、冻结独立 D/SE 和新屏幕接收点。固定档和两个桌面 Auto 档分别保留 1/4/8/16/32 帧、三个 seeds、同毫秒窗口、运动/显露/改灯/重载。完整 ROI 数据在 `screen/*.json.deflate`；图片为真实浏览器输出。

成本口径：A=DDGI，B=原产品 raw，C=同序列 raw，D=重建。公开门限仍为 D−B 整帧 GPU P95 平均差≤1ms、D−A≤3ms；D−C 单列。组件采用独立计时窗口；忙帧不靠暂停结果充数。资源是实际自有附件与快照字节，驱动 bookkeeping/寄存器压力未测。诊断读回及 full-resolution guides 不参与生产路径或 Auto 反馈。

早期候选和中止记录保留；R5/R6/R7 历史报告不覆盖。`interrupted-*` 是为修复而中止的批次，不是完成或通过证明。

阶段提交：

| 提交 | 内容 |
|---|---|
| `ca474f4` | R8.0 四模式成本分离、纯预算规划与基线 |
| `16e0f0a` | R8.1 按需 DDGI、等价排序、融合与初步实测 |
| `a6e71e6` | R8.2 Auto、实际桌面资源、HUD |
| `0f03539` | R8.3 数值、时间、活动成本与验收入口 |
| `cebad11` | 缓存、配置、完整矩阵、失败传播等审查修复 |
| `bda90ab` | 诊断源码模块与 bundle 的兼容导入 |

最终实测摘要和剩余瓶颈将在全量收口后补充。
