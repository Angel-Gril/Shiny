# CPA 内核与插件集成

本站组件：**CLIProxyAPI v8.0.40**，使用官方 Linux amd64 含插件原生包，Key Router v0.4.1。

本目录管理部署及升级约束；本站尚未改动 CPA 内核，故不复制整份官方源码或二进制。对应官方源码固定在 [v8.0.40](https://github.com/router-for-me/CLIProxyAPI/tree/v8.0.40)，安装包和程序摘要均已记录。本次从 v8.0.39 的官方 OCI 程序切换回官方原生发行包；历史来源见 `ops/releases/`。未来需要内核二开时，应从该 tag 建立独立 fork，并在此记录 fork URL 与 commit。

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

## 流启动缓冲

生产已启用 `upstream.codex.stream-bootstrap-buffering: true`，配合 `stream-bootstrap-timeout: "20s"`。它暂存没有生成内容的启动帧，让早期流内过载可在提交下游响应前由 CPA 尝试同池其他获准账号。已经产生有意义的输出或工具事件后不能统一重放；账号全部过载、禁用或冷却时仍可能失败。

统一管理后台进入「配置面板 → 源文件编辑」查看和修改这两个 v8 YAML 字段；服务器配置为 `/var/lib/relay-native/bin/config.yaml`。可视化面板里的「流式传输配置 → Bootstrap 重试次数」是另一项设置，不能替代 Codex 启动缓冲。通过管理接口保存可热加载，本次未重启服务。

20s 是每次上游尝试的启动缓冲设置，检查在收到帧时执行，不能当成请求总耗时或主动断连的硬上限。多次账号尝试会累加等待；生产验证中两次过载后第三个账号成功，总耗时约 26.2 秒。额外重试轮次仍为 0，分池和账号并发限制保持原配置。

## 升级验收

先校验官方含插件包摘要；用合成账号验证插件加载、池间隔离、无可用账号时返回503、不串池、Responses/SSE及配置保存。生产只重启 CPA，验证管理接口与一次最小生成，再核对 CPAMP 采集和账号归属。保留短期回滚副本，验收成功后清理。

生产路径为 `/var/lib/relay-native/bin/CLIProxyAPI`；账号目录 `/var/lib/relay-native/cpa-auths`；仅本机监听8317。统一管理入口的集成见 `cpa-pro/`。
