# 主站内容审计按渠道排除

主站已于 2026-11-28 更新为 `shiny-audit-exclusions-9815bddb`。
运行源码提交为 `9815bddb80faf298298fd44e0c7f1d1c45083684`，基于 Shiny `main` 增量开发；
本轮不向商业分支合并，也不更新 RU、CPA、CPAMP 或 WorkBuddy。

## 入口与行为

主站 **系统设置 → 请求策略 → 内容审核 → 排除内容审计的渠道**。
用已有多选组件按名称选择渠道，点击“保存审核设置”。清空选择即可恢复检查，无需重启。
管理员确认本轮排除 **#41、#42**，未加入停用的 #18。
配置项为 `ContentAuditExcludedChannelIds`，值为 JSON 数组 `[41,42]`。

判断依据为服务端实际选中的渠道 ID，覆盖该渠道服务的所有分组，包含 default。
选中渠道跳过 Shiny AI 内容审计和旧关键词内容检查；鉴权、模型权限、计费、限流、普通日志
及独立请求处理插件保持原规则。实际供应商自己的策略仍由供应商决定。

从排除渠道失败切到普通渠道时，转发前补做检查；拒绝后走原退款流程。
同一输入已执行内容检查的重试不重复提交审计。已经在早先普通渠道排队的异步审计无法撤回。
HTTP relay 与 Responses WebSocket 多轮请求均已覆盖；不将审计新增到原先没有审计的其他路径。
其他渠道保留主站既有 SubQ Shadow、采样/信号规则和关键词设置。

## 已验证

- 后台 30 项测试、类型检查、生产构建、修改文件 lint/format 和密钥扫描通过。
  包括按名称保存 ID、保留已删除渠道 ID、清空选择与其他草稿互不覆盖。
- `go test ./pkg/billingexpr ./relay/helper ./service ./relay/channel ./relay/channel/openai -count=1` 通过。
- HTTP 真实路由回归验证排除、普通关键词拦截、排除切普通前置拒绝/退款、旁路只审计一次、
  普通切排除以及连续排除重试。Responses WebSocket 多轮排除及已有请求测试通过。
- `go test ./model -run '^(TestRequestPolicyDatabaseMatrix|TestMigrateSensitiveWords)' -count=1 -v`
  在真实 SQLite 3.50.4、MySQL 8.0.46、PostgreSQL 16.13 上通过。
  验证保存/加载、无效配置拒绝、事务回滚和连续启动迁移后原关键词仍在数据库。
- 独立服务器 PostgreSQL 候选只复制表结构，账号、Key 和上游均为合成数据。
  实际 SubQ 协议模拟、排除后的零审核调用、切普通时拒绝且不访问该上游、异步审计和
  退款均通过；退款以数据库余额确认，未将客户端瞬时缓存当作账务结果。
- 最终候选连续启动两次，全部选项保留。候选 1440px/390px 的选择、保存和恢复通过，
  无横向溢出或脚本错误。生产代码与前端来自同一份源码，未单独覆盖零散旧文件。

一次扩大 Windows controller 测试选取到了原有 `TestAuditDatabaseMatrix`，
其 SQLite 文件未关闭导致 TempDir 清理失败。相关新增路由、WebSocket 和服务定向测试均通过；
不将该扩大测试称为全量通过。Linux CI 以当前 PR 的执行结果为准。

## 发布与回滚边界

程序 release：`/var/lib/relay-native/releases/release-20261128-audit-exclusions`；
前端 release：`/var/www/shiny-console/releases/web-audit-exclusions-20261128`。
程序 SHA256：`13e87566a94d7516457c3de627b3481ae86e2e76c16708b3e5afedaae123249f`。
新增 systemd 覆盖为 `zzzzzzzzzzzz-shiny-audit-exclusions.conf`。
Nginx 路由包含旧静态资源回退，首页与旧入口资源逐项校验一致。

发布前 `relay-backup-r2.service` 执行成功。首次切换的配置摘要检查发现原启动迁移删除了
刚被重新启用的两个关键词开关，自动回滚到旧版本。本轮从刚生成的加密备份只恢复这两个
选项，核对全部原配置摘要一致，未整库恢复或覆盖业务数据。恢复临时库和解密文件已清理。
随后修复迁移：存在 Shiny 内容审计设置时保留旧内容检查选项；没有这些设置的安装保留官方迁移。
此行为已通过三个数据库和候选连续启动验证，避免自动生成不受渠道排除约束的全局关键词插件。

最终使用只监听回环端口的临时 slave 承接流量，旧主进程请求和审计任务排空后切换，
重启到验收约 3.809 秒。全部原业务选项和渠道配置（定时检测时间除外）保持一致，
新增配置仅为管理员确认的排除名单；其他服务主进程和 RU 版本保持一致。

回滚前应先在新版本清空排除名单，再按请求排空流程移除本轮 systemd 覆盖、恢复旧前端 include，
经 `nginx -t` 后 reload。旧程序会忽略新配置，但旧程序本身仍含会清理关键词选项的启动迁移；
若要保留这些开关，恢复旧程序后需按发布前私有快照经正常管理接口恢复并核对。无需恢复整库。

私有候选、发布、恢复及健康检查回执位于服务器
`/root/shiny-maintenance/audit-exclusions-20261128`；凭据、备份、原始日志与构建产物不进入 Git。
