# 粒子首屏实施计划

状态：已完成实现、独立审查、候选及公网验收，发布 `portal-20261018-v17`。发布证据和回滚见 [发布记录](releases/2026-10-18-portal-particles.md)。基线 main `5f5d82f2c1874448b56e91060d8a1c16527bac30`，分支 `feat/portal-particle-hero`，经 PR #7 合并。

目标：在独立门户集成全宽暖灰海报，复用经校验的 LMM 粒子渲染与 31 场景；保留真实内容、导航、代码复制与懒加载。原型提示词、演示 HTML/导航、截图、启动/抓取脚本不纳入产品。

## 单元与文件边界

1. 渲染/场景单元：`portal/particles/**`、`portal/web/particle-licenses/**`、`portal/web/assets/bodoni-moda.ttf`。保留上游 TS 与版权，独立 Bun1.3.10 编译成原生 ESM 与按组动态 chunks。全部 31 场景，模型缓存上限4；初始化参数控制采样与DPR；显式 CSS 背景值刷新主题。验证有限坐标、静止点不变、关键时间与缓存限额。
2. 生命周期单元：仅 `portal/web/particles.js`。提供 `mountParticles(stage)` 返回 `{dispose,refreshTheme}`；移动/省流/低动态先静态，用户可播放（低动态/省流保持静态）；独立暂停原因、离屏/后台停帧、BFCache恢复、异步选择序号、失败回退与完整清理。输入只局部粒子笔刷，不手动旋转整体，不阻断原生滚动。
3. 页面/构建/发布单元（主代理）：`portal/web/app.js`、`portal/web/particle.css`、静态SVG、`portal/build.py`、CI、现有懒加载测试、文档。首页DOM先出现，空闲时挂载；任何render早退前dispose；主题接body.dark；API示例移至紧邻下方、其余业务内容保留。仅切门户前端 include，原资源路径保留。
4. 浏览器集成单元：仅 `portal/test-particles.mjs`。使用真实构建/模块、虚构内容接口；断言暂停/主题、移动、减少动态、快速路由与延迟导入、错误恢复、场景选择、源/许可及手机布局。不修改生产数据。

文件边界不相交，按 ce-work 并行处理1、2、4，主代理统一测试、审查、提交与发布。子任务不得 git add/commit/push 或操作服务器。

## 模块合同

编译入口 `portal/particles/index.ts` → `/shiny-home-assets/<release>/particles/index.js`；控制器用 `import('./particles/index.js')` 按需加载。

导出：

- `GROUPS`: `{id,label,scenes:string[]}[]`，id 为 `brand/models/geometry/cosmos/playful/store`。
- `NAMES`: `Record<string,string>`；`FEATURED_SCENES`: 默认 Shiny→OpenAI→Claude→Grok→陀螺仪→地球→星系→鹈鹕骑车→小店→莫比乌斯。
- `prepareSculptures(ids:string[]): Promise<void>`：按组导入、生成指定场景并缓存；避免并发加载导致活动模型被淘汰。`clearSculptures()` 释放缓存。
- `createHomePoster(canvas,onReady,{pointBudget,maxPixelRatio})` → `{draw(progress,pointer,delta,still,selection),dispose()}` 或 null。pointer字段 `x/y/vx/vy/previousX/previousY/active`；selection字段 `from/to/mix/age/nextAge`。仅渲染已prepare的场景；不在draw异步导入。默认约30000采样，DPR<=1.25。实际主题从canvas的六位HEX `--poster-ground`读取，不依赖html.class缓存。

舞台DOM合同：根 `[data-particle-stage]` 包含 `[data-particle-canvas]` canvas、`[data-particle-fallback]` img、`[data-particle-status]` 可访问状态、`[data-particle-controls]`、`[data-particle-select]`、`[data-particle-group]` 分类按钮、`[data-particle-pause]`、`[data-particle-autoplay]` checkbox、`[data-particle-start]`（手机播放）、`[data-particle-prev]`/`[data-particle-next]`。分类精选id为`featured`。状态以stage.dataset.particleState公开为`static/loading/playing/paused/failed`，canvas.dataset.ready首帧完成；不添加演示诊断全局对象。

## 验收

- 新浏览器测试与既有lazy-loading上传/文档回归通过，防止首页加载Markdown/R2。
- 1440×900、2048×1018、320/390/768与200%缩放，明暗主题与静态回退，无横向溢出，手机按钮优先。
- 实际候选与生产校验入口/资源CSP和MIME、旧release资源；同设备网络至少5轮冷缓存分别记录文字与动画出现时间，检查长任务、持续绘制和暂停。
- 不将本机浏览器/视口模拟称为手机真机或稳定60fps保证；无法满足预算时降级静态。
- 许可证/NOTICE/字体OFL/轮廓MIT和修改版本源码入口齐全；仅发布必要代码、字体/回退图及许可证。
- 内容服务、New API、CPA、CPAMP及数据不变；候选验证、PR与CI通过后只切Nginx门户include，失败恢复旧入口。
