# 公告详情与首次公告提示

状态：用户已授权实现、验证和上线。基线 main `ecb1c1683de9314d26b497db86192fb86fc26732`，功能分支 `feat/announcements-and-notice-popup`。继续通过受保护 PR 与必需 CI 合并。

## 用户行为

- 自动提示复用 New API `Notice`（`/api/notice`）；非空的新正文版本在首页或登录后的控制台首次展示。关闭、Esc、遮罩关闭或点击详情均记为已读；不增加“今日不再提示”这种与每版本一次重复的选项。
- 同源浏览器以公开内容的 SHA-256 指纹共享已读记录，只存最近100个指纹，不存会话/密钥或正文。正文统一 CRLF/CR 为 LF 后 trim，版本串为 `notice-v1:<64位小写hex>`，哈希输入为规范化正文的 UTF-8。localStorage key `shiny.notice-read.v1`，值为 JSON `{schema:1,versions:string[]}`。同页事件 `shiny:notice-read`、跨页 storage 事件同步关闭已读提示。存储不可用时仅当前页面记忆，网站照常使用。
- 系统公告详情为 `/announcements/system-notice`，列表详情为 `/announcements/<公告id>`。门户使用既有公开内容，再只读读取 New API `/api/status` 补充原始 content/extra，保留 Markdown/HTML 净化、完整正文和稳定链接。无效ID友好404；网络失败仍可返回列表/控制台，已知的公开摘要可作为缓存回退并明确提示。
- 不把历史公告开关与 Notice 耦合。正文清空停止自动提示。用户已在完整系统公告页阅读则记已读；当前浏览器在首页确认后，进入控制台不重复。
- 普通页面、后台管理、登录/注册/支付/安全操作期间不主动遮挡；门户仅首页自动提示，New API 在 `/dashboard` 及其实际首页 `/dashboard/overview` 自动提示。其他页面可从铃铛继续手动查看。

## 实施单元与边界

1. 控制台与共享策略（代理）：只编辑 `new-api/web/src/features/site-announcements/**`、`new-api/web/src/lib/site-notice-policy.ts`、`new-api/web/src/components/layout/components/authenticated-layout.tsx`、`new-api/web/src/hooks/use-notifications.ts` 和七份 i18n locale。读取 root/web AGENTS 与 shadcn-ui 技能，复用 Dialog/RichContent/Button。纯策略在该 TS 文件内，由门户构建编译同一源文件成原生 ESM，不增加运行服务依赖。测试涵盖版本变化/已读/空内容/存储失败/卸载竞态/关闭/跨窗口，并保持已有认证流程不变。无需修改 Go 后端、数据库或认证代码。
2. 门户入口/详情/弹层（主代理）：`portal/web/app.js`、新增 `announcements.js`、`announcements.css`、`index.html`、`build.py`，以及已有懒加载/粒子测试的空 Notice 夹具。公告异步加载，不进入 boot 主依赖链；原生 dialog 保留焦点/Esc，净化复用 markdown.js，加载失败静默跳过自动提示。所有异步工作有路由序号/取消保护，不打断已打开对话框。
3. 浏览器集成（代理）：只创建 `portal/test-announcements.mjs`，独立真实构建+虚构API，与单元1/2文件无交集。固定DOM合同：自动弹层 `[data-site-notice]`，其内 `[data-notice-body]`、`[data-notice-dismiss]`、`[data-notice-details]`；详情页 `[data-announcement-detail]`。验证详情链接/刷新、完整正文/extra与XSS、首次/关闭/刷新/更新、跨页共享指纹、网络/存储失败、路由取消、已有弹层冲突及响应式。控制台组件单测由单元1提供，根验收真实构建的两个前端共享状态。
4. 根代理统一测试、独立审查、提交、PR、候选和生产。三个单元文件不交叉，按 ce-work 并行。代理不得 git add/commit/push、跑项目测试或操作服务器。

共享策略导出合同：`NOTICE_READ_KEY`、`NOTICE_READ_EVENT`、`normalizeNotice(unknown):string`、`noticeVersion(string):Promise<string|null>`（空内容/无安全crypto时null）、`isNoticeRead(version:string):boolean`、`markNoticeRead(version:string):void`、`subscribeNoticeRead(listener:()=>void):()=>void`。读取严格校验schema和指纹；读写失败采用页面内Set降级；导入时不得访问window。门户编译入口名为 `notice-policy.js`。系统详情链接固定为同源 `/announcements/system-notice`；不得将它交给New API内部router识别，使用项目支持的完整页面导航方式。

## 验收和发布

运行受影响 Python/浏览器回归、New API 组件测试/typecheck/相关 lint/format与两个前端生产构建；CI加入新测试。保留许可证和所有旧资产，不覆盖配置/数据。

生产同时更新独立门户前端及 New API 独立前端 include，保留各自版本生命周期。门户 backend current仍v14，New API Go/CPA/CPAMP均不重启。为 `/announcements/` 详情路径增加门户前端路由，旧列表/已打开页面仍正常。候选使用只读公开API，实际公告不替换测试文案；两次连续新版本确认后验收并清理候选/临时包。回滚只恢复两个前端include，不恢复数据库。
