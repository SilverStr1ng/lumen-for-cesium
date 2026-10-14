import { readFile,writeFile,mkdir } from 'node:fs/promises';
const root='reports/contact-transport-v9',run=root+'/acceptance-20261014';
const load=async p=>JSON.parse(await readFile(p,'utf8'));
const suite=await load(run+'/test-suite.json'),before=await load('reports/ballpool-curved-receivers-v8/acceptance-20261014-final-safe/curved.json'),instant=await load(run+'/quality-immediate/curved.json'),cached=await load(run+'/quality-cache/curved.json'),cost=await load(run+'/cache-cost/contact-cost.json'),desktop=await load(run+'/desktop/desktop.json'),finite=await load(run+'/surface-finite/surface-cache.json');
const anchorCase=r=>r.rows.find(x=>x.count===1&&x.scenario==='day'&&x.seed===0&&x.view==='contact'),old=anchorCase(before),control=anchorCase(instant),candidate=anchorCase(cached);
const anchor=Object.keys(candidate.regionErrors).filter(k=>candidate.regionErrors[k].points.length).map(region=>({region,before:old.regionErrors[region].linearNRMSE,instant:control.regionErrors[region].linearNRMSE,image:candidate.regionErrors[region].linearNRMSE,query:candidate.regionErrors[region].queryNRMSE,absolute:candidate.regionErrors[region].imageAbsoluteRMSE,legacyImage:candidate.regionErrors[region].legacyImageNRMSE,legacyQuery:candidate.regionErrors[region].legacyQueryNRMSE,coverage:candidate.regions[region].meanWeight}));
const mean=a=>a.length?a.reduce((s,v)=>s+v,0)/a.length:null;
const costs=[];
for(const quality of ['auto','interactive16'])for(const activity of ['static','moving']){
 const rows=cost.rows.filter(r=>r.quality===quality&&r.activity===activity),pairs=cost.backendPairs.filter(r=>r.quality===quality&&r.activity===activity&&r.mode==='reconstructed');
 costs.push({quality,activity,before:mean(rows.filter(r=>r.mode==='instant-reconstructed').map(r=>r.whole.gpuMilliseconds.p95)),after:mean(rows.filter(r=>r.mode==='cache-reconstructed').map(r=>r.whole.gpuMilliseconds.p95)),shadeReduction:mean(pairs.map(p=>p.shadeReduction)),sameSamples:pairs.length===3&&pairs.every(p=>p.sameSamples),cpuBefore:mean(rows.filter(r=>r.mode==='instant-reconstructed').map(r=>r.whole.cpuMilliseconds.p95)),cpuAfter:mean(rows.filter(r=>r.mode==='cache-reconstructed').map(r=>r.whole.cpuMilliseconds.p95))});
}
const summary={source:suite.version.head,status:suite.status,recommended:suite.recommended,states:suite.states,anchor,costs,device:cost.environment,quality:{instantFailures:instant.failures.length,cacheFailures:cached.failures.length,cases:cached.rows.length},peakAdditionalBytes:Math.max(...desktop.rows.map(r=>r.state.resources.peakAdditionalBytes)),finiteFailures:finite.rows.filter(r=>r.status!=='passed').map(r=>({count:r.count,depth:r.depth,field:r.surfacePointNRMSE,regions:Object.fromEntries(Object.entries(r.regions).map(([n,v])=>[n,v.nrmse]))})),sourceUse:cached.rows.reduce((s,r)=>{for(const [k,v]of Object.entries(r.sourceUse))s[k]=(s[k]??0)+v;return s;},{})};
await writeFile(root+'/summary.json',JSON.stringify(summary,null,2),{flag:'wx'});
const p=v=>Number.isFinite(v)?(v*100).toFixed(2)+'%':'not-run',m=v=>Number.isFinite(v)?v.toFixed(2):'not-run',memory=b=>Number.isFinite(b)?(b/1048576).toFixed(2):'not-run',line=anchor.find(a=>a.region==='ballFloorContact'),fixed=costs.find(c=>c.quality==='auto'&&c.activity==='static'),interactive=costs.find(c=>c.quality==='interactive16'&&c.activity==='static');
const initial=cost.initialCache,gpuInitial=Object.values(initial.gpuMillisecondsByRound).reduce((s,v)=>s+v,0),peakScene=desktop.rows.find(r=>r.count===64)?.state.resources;
const formatStates=Object.entries(suite.states).map(([k,v])=>`| ${k} | ${v} |`).join('\n');
const doc=`# R10 实现进度 · 2026-10-14

静态表面缓存已实际改善原接触点，并降低命中着色成本；完整验收 **${suite.status} / recommended=${suite.recommended}**。缓存保持显式实验候选，原固定性能失败和剩余误差不隐藏。

分支 \`feat/contact-transport-v9\`；测试源码 \`${suite.version.head}\`。基线 \`522201e5\` / 原被测源码 \`93b5f22\` 保留。实际交付提交见此文 Git 历史。

## 现在可以使用

\`npm run setup\` → \`npm run build\` → \`npm start\`。
[Ball Pool](http://localhost:8090/demo/ballpool.html) 仍默认即时参考；在“命中光照来源”选择“静态表面缓存”。也可[直接打开候选](http://localhost:8090/demo/ballpool.html?radianceSource=cache)。等待静态 GI 就绪后操作；播放/投球会失效旧局部 GI，暂停后点击“定格并更新 GI”。改灯和定格都需重新计算缓存。

[证据展示页](http://localhost:8090/reports/contact-transport-v9/index.html) · [完整矩阵](../../${run}/quality-cache/curved.json) · [总验收](../../${run}/test-suite.json)。复现用 \`npm run test:r10 -- --output=reports/contact-transport-v9/<新目录>\`；失败非零，旧目录不可覆写。

## 已完成与边界

| 能力 | 状态与限制 |
| --- | --- |
| 同方向源项归因 | 原单/双球 day 接触点，1/2/3轮；天空/自发光/太阳/上一轮DDGI分开，独立路径余项替换；不是全部案例唯一根因证明 |
| 受控起点修复 | 局部三角形误差包络、外扩ULP、仅排除源三角形；解析窄缝/斜面及真实GPU球地/双球通过；不声称任意退化几何证明 |
| 静态表面候选 | 真实表面生成 S0/S1/S2，独立原 triangle+bary微片元；不复制DDGI，不提高3轮、不跨owner/面借用；有限空间/采样近似仍需验收 |
| 生命周期与Auto | source token、geometry generation、requested/settled revision、最终分块取消、资源与销毁保护；总附加预算64MiB |
| 既有渲染与采样 | Ng/Ns、线性E、历史失效、几何壁垒、IBL policy及生产无同步读回保留；未新增去噪器 |
| 运动中完整多反弹GI | 未实现；播放仍为明确标注的物理预览，定格后一次静态世界重建 |

## 原接触点与全部关卡

原单球 day/contact/seed0 球地区域，旧重建误差 ${p(line.before)}；受控起点+即时余项 ${p(line.instant)}；候选 physical 重建 **${p(line.image)}**、query **${p(line.query)}**，绝对E RMSE **${line.absolute.toFixed(5)}**。对同一 legacy 参考候选重建为 ${p(line.legacyImage)}、query ${p(line.legacyQuery)}；两种基准和原始点集都保留。

全部60案例：即时控制 ${instant.failures.length} 个失败，候选 ${cached.failures.length} 个失败。query12%、重建20%、原曝光/反弹/采样与区域分母不放宽。轮廓、球地、球球的覆盖、最大/绝对误差、参考SE、Unknown和回退在[区域矩阵](../../${run}/quality-cache/curved.json)逐项记录。整体覆盖不能替代接触区域误差。

| 必需关卡 | 结果 |
| --- | --- |
${formatStates}

有限轮次与缓存本身 ${finite.rows.filter(r=>r.status!=='passed').length}/${finite.rows.length} 项未通过，详见[独立表面与接收查询](../../${run}/surface-finite/surface-cache.json)。未通过项保留 experimental；新模块通过不使R8全系统通过。

## 实际设备与总成本

${cost.environment.renderer}；Chrome ${cost.environment.browser}，WebGL2 / headless visible context；Ryzen7 9800X3D。本机实测不是独占GPU或手动FPS。1280×800，主画面尺度1、阴影2048、曝光1、2m/128探针射线/3轮保持。

| 持续活动窗口 | 即时 GPU P95 | 缓存 GPU P95 | CPU提交P95 即时→缓存 | shade改善 | 条件 |
| --- | ---: | ---: | ---: | ---: | --- |
${costs.map(c=>`| ${c.quality}/${c.activity} | ${m(c.before)}ms | ${m(c.after)}ms | ${m(c.cpuBefore)}→${m(c.cpuAfter)}ms | ${p(c.shadeReduction)} | ${c.sameSamples?'同receiver/样本/快照':'不同条件；不作纯开销结论'} |`).join('\n')}

值为三个窗口各自P95的均值；全帧和60帧组件分开。32r和16r仍为不同档。缓存减少secondary shade，primary trace未消失；原相对DDGI<=3ms、相对原raw<=1ms及移动/改灯失败继续保留。

64球首次缓存：提交墙钟 ${m(initial.submittedMilliseconds)}ms，worker布局 ${m(initial.workerLayoutMilliseconds)}ms，GL提交CPU ${m(initial.cpuSubmissionMilliseconds)}ms，GPU各代合计 ${m(gpuInitial)}ms；这些不能藏在稳态收益后。改灯/冻结重算/目标样本收敛与忙帧全部见[完整成本账](../../${run}/cache-cost/contact-cost.json)。忙帧时间不包含跨帧缓存GPU提交，后者单列；无同source/revision的改灯窗口不称纯开销优化。

桌面1920×1080/2560×1440 Auto最大已知附加峰值 **${memory(summary.peakAdditionalBytes)}MiB /64MiB**；64球缓存驻留GPU ${memory(initial.gpuBytes)}MiB、单候选已知临时+GPU峰值 ${memory(initial.peakBytes)}MiB。CPU/GPU/快照/物理WASM分别见[桌面资源](../../${run}/desktop/desktop.json)。128球缓存拒绝不提高上限；即时安全回退和压力覆盖仍单列。驱动物理VRAM、worker JS allocator开销为not-run，不能把拥有资源合计称实际VRAM。

## 下一里程碑

1. 优先定位仍失败区域/有限轮次的空间近似或统计误差，保留全部点、physical/legacy与SE；不增加历史掩盖输入。
2. 在同质量同receiver下处理primary trace成本及缓存冷启动/改灯摊销，原32r和完整性能门限继续独立验收。
3. 先收口静态缓存质量、预算与更新成本，再另立受限运动GI任务；当前不做动态BVH、Tiles GI或反射。

详细机制：[传输合同](../contact-transport.md)。审查：[Standards / Spec](review-r10.md)。模板：[template.md](template.md)。必需失败/未运行均阻止推荐。
`;
await mkdir('docs/progress',{recursive:true});await writeFile(`docs/progress/2026-10-14-${suite.version.head.slice(0,7)}.md`,doc,{flag:'wx'});await writeFile('docs/progress/latest.md',doc);
console.log(JSON.stringify({source:suite.version.head,qualityFailures:cached.failures.length,states:suite.states,costs,peak:summary.peakAdditionalBytes}));
