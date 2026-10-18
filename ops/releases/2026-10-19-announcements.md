# 2026-10-19 公告详情与首次提示

已通过 [PR #13](https://github.com/Angel-Gril/Shiny/pull/13) 合并，源码提交 `271dd465eda87431d8e622e05338a94fccb0a956`，合并提交 `4356d5e13c5f9073a2e9a733a22ccaf846104683`。生产门户前端为 `portal-20261019-v21`，控制台前端为 `web-announcements-20261019-r2`。

双前端合并发布包共1878文件，SHA-256 为 `545ae10bb2f5362db062ebc9a3660ece711b57d4dfd29988542250f89aceeebf`；摘要覆盖 `portal/site` 和 `console/site`，并非某个后台二进制。组件清单分别记录前端与后台版本。

## 使用与配置

- New API [系统公告设置](https://shinyapi.com/system-settings/site/notice)保存非空正文后，门户首页及登录后的控制台概览对未读正文版本自动提示。关闭、Esc、遮罩或查看详情均记已读；同源浏览器两端共享，修改正文后再次提示。清空正文停止自动提示。
- [历史公告设置](https://shinyapi.com/system-settings/content/announcements)维护普通公告，新增/编辑后须保存设置。其展示开关与系统 Notice 分开，不会让全部历史公告自动弹出。
- 系统正文详情为 `/announcements/system-notice`，历史公告为 `/announcements/<id>`。旧无ID记录首次解析后使用内容指纹规范地址，避免补ID或删除更早记录后跳到另一条。
- 登录、注册、管理、安全、支付等页面不自动弹出。公告网络/模块/存储失败仅跳过可选提示；公告 HTTP 500 不再触发控制台全局错误页，普通接口保持原错误处理行为。

共享已读键只存最近100个正文指纹；禁用存储时只能保证当前页面记住，刷新后可能再次提示。完整正文复用既有 Markdown/HTML 净化；两端从同一纯 TS 策略构建各自资源，运行时互不依赖。

## 验证

20项公告浏览器回归、15项粒子/布局和9项按需加载/Markdown/R2回归通过；66项控制台公告/缓存/主题及全局错误处理测试、类型检查、相关 lint/format 和两个生产构建通过。PR 的 `portal`、`new-api` 必需检查均成功，按 main 保护规则合并。

真实构建同源集成与远程候选验证：首页确认抑制控制台提示、控制台确认抑制首页提示、正文更新再次提示、390px弹层适配、公告500后控制台仍可用。认证接口使用隔离的虚构响应，未向生产提交测试登录或模型调用。

候选与公网均检查现有四条公告的详情/直达刷新、系统详情、首页已读刷新、五类公开页面在1440px/390px下的两种主题及未登录表单。响应式为浏览器模拟。公网HTML与控制台响应头均确认新版本。

上线后健康观察301.1秒，11轮检查均正常：每轮九个关键路径可用，四个后台PID、R2设置摘要和内容服务current不变。13个上一版HTML引用资产仍可访问，观察期间与新资源或公告路径匹配的Nginx错误为0；公网11项检查无脚本异常或新资源错误。

## 发布与回滚

仅切换两个前端 Nginx include，增加 `/announcements/` 子路径前缀并平滑重载；连续确认两个新版本响应。门户后台 `current`/`production_release`仍为v14，New API Go后台、CPA、CPAMP保持原版本；四个服务PID与R2设置摘要未变化，没有数据库或用户数据迁移。

保留所有已发布门户资产，控制台新增对上一版资源根的回退，兼容打开中的旧标签页。未发布的v20候选与旧公告控制台候选不作为历史生产版本保留；临时监听、上传包和本机隧道均已清理。私有部署/健康回执在 `/root/shiny-maintenance/announcements-20261019-r2/`，不入Git。

回滚：将主站门户include恢复为 `/opt/shiny-portal/releases/portal-20261018-v19/portal-locations.conf`，控制台include恢复为 `/var/www/shiny-console/releases/web-user-insight-20261017/frontend-routing.conf`，执行 `nginx -t` 后平滑重载并连续确认旧版本。旧版不提供新详情路由和自动提示；不还原数据库、不切后台current、不重启模型服务。后续升级兼容点见[升级约定](../UPGRADES.md)。
