# RU 一键创建 Key 已部署

[PR #52](https://github.com/Angel-Gril/Shiny/pull/52) 的全部源码、RU 门户、国际支付后端/前端/双实例检查通过后，合并至 `commercial/ru-portal`，合并提交 `051ee1a054654757f8fd724a70d8553acc55fa96`。发布源码 `94660397a07d4115ff4651405e93294f8cc877f8`，本轮不合并 main 或更新国内服务。

| 项目 | 发布值 |
| --- | --- |
| RU 版本 | `shiny-ru-keys-94660397` |
| 服务 | `shiny-ru-newapi.service`，127.0.0.1:3001 |
| 固定 release | `/srv/shiny/new-api/releases/ru-keys-94660397` |
| Linux 程序 SHA-256 | `4e695c66b6fcd1db3756db8bf701ba018325ff5bd981a3fcc4710c5431989f06` |
| 前端上传包 SHA-256 | `35b539a3c237d3d532834b100b67cdf3ae62d1322c4ef7334a4c5db8015f3804` |
| 完成时间 UTC | `2026-11-27T10:42:39Z` |

## 行为和数据边界

RU `/keys` 点击创建即可生成 Key 并进入复制弹窗，随后可选择编辑名称、期限、预算、模型和 IP 限制。Key 继承账户组、使用账户余额、不限制同组模型，默认不过期；不是私有分组的通行证。此次不修改 UserUsableGroups、AutoGroups、任何倍率、渠道或现有 Key，不扩大账户权限。

当前 RU 自身内容审核、支付、注册与并发配置、环境秘密和数据库 DSN 保留；法律正文及两个站点首页摘要校验一致。国内 New API、CPA、CPAMP、门户内容服务和 WorkBuddy 的主进程均不变。

## 验证与切换

- 服务器候选使用独立 PostgreSQL 库，仅复制 RU 旧表结构和合成账号。通过实际新建 Key 接口验证脱敏响应、匿名 401、模型发现和同一 Key 调用三个本地模拟平台模型；没有真实上游调用或真实资金操作。
- 候选 1440px/390px 俄语页面创建、复制、可选编辑、无持久化密钥、无横向溢出或脚本错误均通过。Linux Go 1.26.10 静态程序与前端来自同一份已测商业源码。
- 旧控制台 1,803 个静态文件按内容摘要保留于 `/srv/shiny/ru-console/shared`；新控制台资源先从新 release 的 `site` 提供，未命中则回落到这些历史资源。独立门户 `/ru-assets/` 和所有内容 URL 保留。
- 本地临时 slave 19582 承接新请求，旧主实例排空后更新，最后恢复 3001 并排空停止临时节点。没有新开公网端口。
- 首次校验将 RU 程序正常注入的 `data-default-language` 和分析占位注释视为与原始构建 HTML 不同，触发自动回滚。随后改为核对运行时 HTML 与构建资源标识，重新切换成功；未修改应用代码或二进制。
- 成功切换重启至验证约 5.345 秒。公网桌面/手机均实测创建并复制 Key、进入原编辑抽屉、发现 8 个当前可用模型；测试 Key 完成后由正常 API 删除，没有改账户余额。服务器完整模型调用只用隔离候选 mock，不重放用户请求。
- 候选服务、候选数据库、模拟服务、临时凭据和上传包均已清理。生产 release、历史静态资源、RU 数据和原旧 release 保留供回滚。
- 切换后 312.58 秒、11 次健康采样通过；RU 选项和渠道、首页和协议、国内版本及其他服务进程保持一致。
- 同步 RU 备份元数据：原安装脚本写死初始 release，且没有保存 systemd drop-in。本轮通过 [幂等补丁](../update-backup-release-metadata.py) 改为读取实际运行 release、核对程序摘要并备份发布 manifest 和 drop-in。数据库、加密方式、R2 目标及保留策略不变。
- RU 备份服务实际执行成功，R2 上传/下载摘要核对、解密和独立临时 PostgreSQL 恢复全部通过。复核加密包内存在本轮 drop-in、实际 release manifest 和正确源码提交；没有恢复覆盖正式库或备份国内数据库。

## 回滚

恢复 `/etc/systemd/system/shiny-ru-newapi.service.d/zz-keys-20261127.conf` 之前的 ExecStart（移除本轮独立覆盖），检查并重新加载 systemd，按同样排空流程恢复旧实例。RU Nginx 恢复发布前配置并经 `nginx -t` 后 reload。不恢复整库或删除新建 Key；没有 schema 迁移，新前端遇到旧后端时因缺少能力标识自动使用原表单。

私有操作回执在 `/root/shiny-maintenance/ru-keys-20261127`，不提交用户数据、秘密或运行日志到 Git。
