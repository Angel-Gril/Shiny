# CPA 内核与插件集成

本站组件：**CLIProxyAPI v8.0.39**，使用官方 Linux amd64 OCI 构建提取的原版程序，Key Router v0.4.1。

本目录管理部署及升级约束；本站尚未改动 CPA 内核，故不复制整份官方源码或二进制。对应官方源码固定在 [v8.0.39](https://github.com/router-for-me/CLIProxyAPI/tree/v8.0.39)。v8.0.39 的 GitHub Release 原生包构建失败且暂未上传；本次使用官方成功 Docker 构建中的 Linux amd64 原版程序，校验值与源码 commit 均已记录。未来需要内核二开时，应从该 tag 建立独立 fork，并在此记录 fork URL 与 commit。

- [release.json](release.json)：官方产物来源、摘要与版本。
- [config.example.yaml](config.example.yaml)：不含可用凭据的隔离配置示例，不可覆盖生产配置。
- [relay-native-cpa.service](relay-native-cpa.service)：部署单元示例。
- `ops/UPGRADES.md`：升级及回归要求。
- [deploy/README.md](deploy/README.md)：隔离验证和单组件切换工具。

生产账号认证文件、Key Router 的真实调用 Key/账号绑定、管理密钥、运行日志及冷却数据不进入 Git。管理密钥只能放服务器私有配置；版本控制保存的不是完整生产配置备份。

## 路由边界

CPA 两个 Key 用于隔离账号池。New API 是否在失败后切另一个渠道，取决于 New API 的会话规则和重试预算；升级 CPA 不会自动解除 strict 绑定。

Key Router v0.4.1 已启用，优先级100；账号并发插件v0.1.8也已启用，优先级50，每账号上限3，计数采用local模式；quota-monitor关闭。此组合仍由Key Router选账号，并发插件在选定账号后执行准入限制，不会自动改选同池空闲账号。升级没有改变这一边界。

当前max_concurrency=3且暖槽默认保留1个，普通冷请求最多占用2个名额；3是包含保留槽的硬上限。本次仅同步升级前已存在的生产值，没有修改并发配置。不要把调度器的优先级降低误认为具备同池满额自动换号能力，也不要直接提高并发数掩盖配额或冷却问题。

## 升级验收

先校验官方含插件包摘要；用合成账号验证插件加载、池间隔离、无可用账号时返回503、不串池、Responses/SSE及配置保存。生产只重启 CPA，验证管理接口与一次最小生成，再核对 CPAMP 采集和账号归属。保留短期回滚副本，验收成功后清理。

生产路径为 `/var/lib/relay-native/bin/CLIProxyAPI`；账号目录 `/var/lib/relay-native/cpa-auths`；仅本机监听8317。统一管理入口的集成见 `cpa-pro/`。
