# R10 静态命中光照合同

本轮受控对象仍为 Ball Pool 的基础不透明 PBR 球和容器。命中侧保持三角形 Ng Lambert；接收侧保持 Ns 余弦、Ng 半球已知零及完整分母。没有把材质响应再次乘到接收 E 上。

## 射线起点

`transport=legacy` 保留旧太阳 0.015m 偏移及命中 DDGI 查询 normalBias；Ball Pool 默认采用受控起点。独立 CPU 参考通过 `rayOriginPolicy=physical` 明确选择新物理基准；省略该参数保持原场景的 legacy 参考。R10 矩阵同时输出 physical 与 legacy，旧报告不修改。

GPU 根据实际三角形、重心和局部 binary32 坐标建立 gamma(15) 重建误差包络，将误差投影到 Ng，并向出射半球外扩一个 ULP。太阳和缓存续射使用 tMin=0，仅排除源三角形。完整查询域、最近面、Alpha Mask 与 Unknown 合同保留。该包络加上局部三角形 extent 的保守项，已在受控几何验证；不是对任意退化三角形或任意尺度的完整误差证明。相机 ECEF 坐标不参与偏移。

独立物理参考使用 binary64 重心重建包络，不复用 GPU 常数。解析平行板/斜面给出独立遮挡答案；真实 GPU 测试另检查球地、双球窄缝、同 owner 不同面、跨 owner 邻面与预算耗尽。原接收主射线 0.0002m 起点、原 tMin 和时空几何保护保持。命中点 DDGI 查询使用原位置，不把 0.02m probe 查询偏置推过窄缝；空间探针的近场代表性仍是有限近似。

误差控制依据：[PBRT4 Managing Rounding Error](https://pbr-book.org/4ed/Shapes/Managing_Rounding_Error)。此原则性参考不替代本仓库解析和浏览器实测。

## 静态表面候选

每个 glTF 实例展平为独立原始 triangle 命名空间，BVH 重排索引映射回原 triangle；同材质球不共享地址。每个 triangle 的 barycentric 微三角形独立寻址，不跨面、跨材质或正反侧插值。最低每面4个微三角形，更多样本依实际面积生成；0.08m 是面积尺度，不是每个微片元直径保证。细长面仍有空间近似误差。布局不读取屏幕、ROI 或失败坐标。

硬限262144样本、单面 n<=256；描述/地址为 RGBA32F，两个代际出射 L 图像为 RGBA16F。候选峰值上限12MiB（包括已知临时 CPU 克隆、GPU图像及8KiB计时队列预留），同时受既有64MiB附加总预算约束。CPU/GPU与临时/驻留分别记录；JS allocator/driver实际VRAM不伪称为已测。双面和 Alpha Mask 不缓存，使用即时参考；它们若被续射命中使所需缓存代缺失，该微片元明确无效。

递推为 `S0=Le+rho*E_sun/pi`、`Sj=S0+rho*G(S[j-1],x,Ng)/pi`；K轮接收只读 `S[K-1]`。G在真实表面起点追踪，确认 miss 才读既定天空；不读 DDGI、不补天空、不提高默认3轮。每代写另一个图像，完整提交后切换；WebGL命令顺序保证读写顺序，没有生产同步读回或CPU fence。

FG仍追踪真实第一命中。成功的地址查完整L，替代即时太阳遮挡/DDGI余项；不与旧E相加。有效黑色 alpha=1、缺失 alpha=0、Unknown alpha<0分别处理。每帧 FG仍持续采样；缓存不随相机移动重建。默认即时参考保留，缓存需显式选择，保持 experimental。

## 拥有权与成本

缓存保留其不可变 FG snapshot。几何/材质/灯光/天空/round变更销毁旧缓存；仅相机变化不失效。构建期间核心 FG释放接收资源，并阻止重复分配。发布后 Auto按世界缓存、临时CPU、快照、附件和计时队列规划；普通场景也使用核心 additionalOwnedBytes计账。

来源切换、改灯、播放/定格及最终分块 yield均核对 geometry generation、source request、requested/settled revision和snapshot拥有权。物理播放销毁旧局部世界；暂停不冒充新GI；定格只构建一次新静态世界。

GPU构建按代异步查询汇总；队列最多64个，繁忙时异步等待，不丢查询制造低成本。构建墙钟、worker布局CPU、GL提交CPU、GPU各代、改灯/定格与目标样本收敛分列。稳态全帧时间与60帧组件窗口分开；改灯帧时间不包含跨帧缓存预计算，后者单列总账。原32r门限与失败记录保留，16r仍是独立质量档。
