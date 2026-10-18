# Shiny

Shiny 的站点源码、New API 针对性修改与部署维护规范。该仓库不包含生产凭据、用户数据或运行数据库。

## 组成

- `portal/`：独立首页、教程、下载与管理员内容服务；按需加载的粒子首屏、R2 分片直传、暂停续传及资源保存恢复。
- `new-api/`：基于 QuantumNous/new-api 的完整可构建源码与 Shiny 变更。保留上游 LICENSE、NOTICE 及原作者归属。
- `cpa/`：CPA 官方内核版本、包摘要、配置示例、插件约束与升级验收。
- `cpa-pro/`：CPA Manager Plus Full 的版本、服务和统一管理入口集成。
- `ops/`：组件版本、配置示例与升级兼容检查。
- `scripts/`：提交前敏感信息检查和维护辅助工具。

New API、CPA 内核、CPA Manager Plus 和门户分别升级。CPA/CPAMP 使用官方发布二进制，本仓库只记录版本与集成，不复制 OAuth 凭据或维护一个未经需要的内核 fork。

## 开发

New API：后端 Go1.26；前端 `cd new-api/web && bun install --frozen-lockfile`，使用 package.json 中的测试和构建脚本。门户：`python -m venv portal/.venv`，安装 `portal/backend/requirements.txt`，运行 `python -m unittest discover -s portal/backend`。门户前端构建使用 Bun 1.3.10，具体命令见 [门户说明](portal/README.md)。

所有变更先建立分支。合并前执行针对性测试、构建、敏感信息扫描和候选环境验收。生产发布使用不可变 release 路径，校验健康与内容摘要，通过后才删除临时备份。版本历史不能替代数据库及 R2 的独立备份。

## 升级

见 [升级约定](ops/UPGRADES.md) 与 [组件版本](ops/components.json)。升级前固定官方 commit/tag，先在分支解决差异；切勿用官方镜像或二进制直接覆盖 Shiny New API 二开。

`main` 已启用 [PR 与 CI 分支保护](ops/BRANCH_PROTECTION.md)，禁止直接推送、强推和删除；个人维护仍须经 PR 与必需检查合并。

`maintenance/` 保留在本机作为排障工作区并被忽略，其中可能包含私人数据，禁止强制加入版本控制。部署只使用源码构建产物与服务器私有配置，不把生产数据库同步到 Git。

## 许可

`new-api/` 保留上游 GNU AGPLv3 与 NOTICE 要求。Shiny 新增源码也以 [GNU AGPLv3](LICENSE) 提供；对外提供修改版本时应遵守对应源码与归属声明要求。
