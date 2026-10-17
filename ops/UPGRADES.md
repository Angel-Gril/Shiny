# 升级与二开维护

## New API

`new-api/` 保存当前 Shiny 可构建源码，`new-api/SHINY_UPSTREAM.json` 固定来源。当前来源官方 commit 后的 Shiny 修改包括内容审核 off/shadow/preflight、signal/block、长上下文审查、审计误报权重，以及门户完整页面跳转适配。

更新步骤：创建 `upgrade/new-api-<version>` 分支；从官方固定版本取源，逐模块对比合并到 `new-api/`，保留所有 Shiny 修改；更新来源清单。计费、鉴权、审计、路由重试、插件宿主、门户身份接口、模型价格和旧标签页入口都要验收。数据库迁移须支持 SQLite/MySQL/PostgreSQL；生产使用 PostgreSQL，不以生产数据做开发夹具。

升级不是把新文件无条件覆盖旧目录。若改动规模扩大，可以用上游提交导入为 Git subtree 保留其完整提交关系；当前单仓快照策略以来源固定、代码审查和功能回归为兼容保证，不宣称自动解决冲突。

## CPA / CPA Manager Plus

CPA 使用官方含插件构建；升级验证 Key Router 插件 ABI 与分组隔离、管理接口、真实 Responses、冷却/配额行为。账号并发等 Scheduler 插件不能未经验证抢占 Key Router。

CPA Manager Plus 是独立官方服务，长期统计库与 data.key 共同备份，升级验证采集、单账号归属、模型价格与详情页面。统一管理入口是独立 Nginx 配置，使用服务端私有文件保存管理密钥。禁止提交 `.so`、管理密钥、token 或账号文件。

## 门户

`portal/build.py --release <new-id>` 产生不可变资源，候选环境使用独立 SQLite 与配置；通过后切换门户 release 与 Nginx include，保留旧静态资源供旧标签页。程序更新不得覆盖 content.sqlite、上传文件或 r2-settings.json。

## 变更可追溯

每次发布记录 commit、构建产物 SHA256、组件版本和验收结论。备份含私人数据，仅放服务器私有目录，通过验收后按用户要求清理；Git只存代码与脱敏运维规范。
