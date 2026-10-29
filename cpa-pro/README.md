# CPA Pro / CPA Manager Plus

本站用户所称的 CPA Pro 管理与统计层是 **CPA Manager Plus Full v1.14.10**，与 CPA 内核是独立服务。

官方源码：[seakee/CPA-Manager-Plus v1.14.10](https://github.com/seakee/CPA-Manager-Plus/tree/v1.14.10)。本站使用官方程序，没有修改其二进制；配置、独立统计数据和统一 Nginx 入口构成本地集成。

- [release.json](release.json)：版本及官方安装包摘要。
- [config.example.json](config.example.json)：服务器路径和采集设置示例，无真实管理密钥。
- [shiny-cpamp.service](shiny-cpamp.service)：独立服务部署配置。
- [unified-management.conf](unified-management.conf)：CPA/CPAMP共用一个管理入口的示例。
- [v1.14.10 发布记录](../ops/releases/2026-10-29-cpamp-v1.14.10.md)：升级收益、兼容边界与验收结果。

## 数据边界

`/var/lib/shiny-cpamp/usage.sqlite` 保存长期单账号统计；`data.key` 与加密数据必须一起私下备份。`/etc/shiny-cpamp/admin.key` 及已保存 CPA 连接密钥不提交。模型价格是估算成本口径，不是 OAuth 账号实际可花费的美元余额。

详情入口：`management.html#/monitoring` →「实时」。每行上方显示上游账号，下方显示调用方 Key/号池；切换「脱敏/完整」可查看完整账号标识。「实时」标签的红色数字是失败数，不是全部记录数。

## 升级验收

固定官方版本，校验包摘要，备份一致 SQLite、data.key 和私有设置；只重启 CPAMP。验证原始事件及单价保留、采集 running、dead letter=0、请求到账号的关联、管理页面和统一反代。CPA/New API 不应因 CPAMP 升级而重启。验收成功后按约定清理短期备份。

官方Full程序内嵌配套前端；升级完整二进制后检查Manager Server和管理面板都显示同一版本，不在CPA原生面板目录覆盖文件。v1.14.10 修复历史价格读取、模型排除规则及插件默认值展示，并新增浏览器内凭证置顶；没有改变统计库 schema 或配置格式。失败恢复旧服务程序时保留已经采集的新事件，不直接覆盖旧库快照。

统一入口只由私网/Tailscale转发到127.0.0.1:18318，不另开公网管理端口。New API转发请求仍直连CPA的127.0.0.1:8317。

## CPA v8 只读分组接口

统一入口将 `/v8/management/config/api-keys` 及其子路径转发到 CPAMP，由 CPAMP 校验管理员身份并仅允许 GET；其他 v8 管理路径继续走 CPA。生产 CPA v8.0.47 当前对该可选分组路径返回 404，CPAMP 原样保留该响应；已有 v0 管理接口和账号统计正常。不将此 404 当作服务健康失败。

保留统一入口现有 JSON/NDJSON gzip 压缩与长连接超时，不用新版示例覆盖生产 Nginx 配置。
