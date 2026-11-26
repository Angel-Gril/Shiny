# Jev / SubQ 审计上线

[PR #48](https://github.com/Angel-Gril/Shiny/pull/48) 经 CI 通过后合并至主线，合并提交 `513baa884e086ad76a885464e1c366543d5a0a51`。发布源码为 `582c2afed31c492fbc6298c9cbda0b337f055569`，保留官方 rc.51 基线和本站二开；本轮不是升级 CPA、CPAMP 或 RU。

国内主站运行 `shiny-rc51-audit-582c2af`，程序目录 `release-20261127-audit`，SHA-256 `dbd49b5da6fc3965440a4da15c6031075c60fa0d56cc949f006d2d02e1645fc9`。前端 `web-audit-20261127`，上传包 SHA-256 `eddd50f972aa2fe09f8c5bb310e89a12fbc49d4ec0ab03304f2679a8b3102232`。前后端按同一份源码完整构建，没有覆盖零散运行文件。

## 使用入口

管理员打开 `/system-settings/request-policies/legacy-audit`，即“系统设置 → 请求策略 → 内容审核”，选择审核服务、填写端点和 API Key、获取模型并保存。支持 Chat Completions、TypeSafe Jev、SubQ Decisions；密钥按协议隔离并加密保存，界面留空表示保留，服务器不回传密钥。现有稳定 SESSION_SECRET 满足加密要求，发布不轮换秘密或修改终端密钥文件。

Jev 预设 `https://api.typesafe.ai/v1/systemone` / `jev-1.14.0`；SubQ 预设 `https://api.subq.ai/v1/systemone` / `subq-snap-1.2`。“测试连接并获取模型”只测试模型列表，真实判断需要先以 Shadow 模式采样并查看“审计日志 → Abuse Reviews”。提供商切换不会自动启用审核，也不会迁移另一个提供商的密钥。详见 [审核说明](../audit/README.md)。

## 验证与切换

- PR 的 New API、门户 CI 通过；发布前重新执行 32 项设置/复核测试、类型检查、前端构建、后端 Jev/SubQ、加密、配置权限和模型发现回归、秘密扫描。
- 服务器独立 PostgreSQL 候选库仅导入生产表结构，使用合成账号、渠道和本地模拟服务。通过正常 HTTP 接口验证两种模型发现格式、密钥隔离/加密、重启持久化、匿名 401、通用接口隐藏密钥，以及 SubQ Shadow 产生模型版本/原因/用量记录而普通中转仍成功。
- 候选 1440px/390px 设置页与证据弹窗验证通过，无横向溢出或脚本异常；弹窗在动画结束后截图复核。公网页面使用实际新资源复测。
- 本地临时 slave 监听 `127.0.0.1:19573` 承接新请求，旧主进程 HTTP 请求和后台审核排空后切换；恢复流量到 3000，临时进程排空后停止。3001 始终留给 RU。主进程重启至入口验证约 3.869 秒，切换期间公网由临时节点继续服务。
- 保留发布时 DeepSeek Chat Completions / Shadow、5% 抽样、8 秒超时及独立行为审计关闭状态。价格、渠道配置、稳定秘密、请求体上限保持一致；未自动填入 Jev/SubQ 密钥或发起真实决策服务调用。
- 已退役关键词开关由既有 rc.51 启动迁移清理；现网硬拦截词为空，不创建重复的 request-filter，也不把 signal 转为阻断词。新模型审核独立于这些旧开关，Shadow 保留。
- 独立首页及旧前端资源校验一致；RU 首页、版本、进程及 CPA、CPAMP、门户内容服务、WorkBuddy 各进程保持不变。
- 304.14 秒、11 次健康采样全部正常；原 DeepSeek Shadow 有完成记录，审核错误 0。临时候选服务、数据库、凭据文件及上传程序/资源包已清理，保留生产 release、历史前端资源和脱敏部署回执。

## 回滚与运行边界

回滚时移除本轮独立 systemd ExecStart drop-in，恢复旧前端 include，检查并重载 Nginx，再按排空流程恢复旧主站程序。无需回滚数据库模式；不恢复整库或覆盖用户交易。若已保存 Jev/SubQ 凭据，新字段应保留，旧程序不会提供其管理界面。

生产验收不等于真实模型的误报率或响应时延验证。接入新提供商后应先在 Shadow 下测试误报、漏报和阈值；未回报 usage、覆盖不完整及审核失败均有独立状态，不视为干净结果。
