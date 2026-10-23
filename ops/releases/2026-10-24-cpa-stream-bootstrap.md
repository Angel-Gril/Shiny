# CPA Codex 流启动缓冲

2026-10-24（Asia/Shanghai）在生产 CPA v8.0.40 启用有限启动缓冲。上游有时在 HTTP 200 SSE 的启动握手后返回 `server_is_overloaded`；缓冲关闭时响应已经提交，无法透明换号。此次保存仅改变两个语义字段：

```yaml
upstream:
  codex:
    stream-bootstrap-buffering: true
    stream-bootstrap-timeout: "20s"
```

使用 `/v8/management/config` 和 `If-Match` ETag 保存，避免覆盖同时发生的配置编辑。保存后通过 v8 结构化接口和 legacy 运行配置均读回生效值。其他配置完全保持语义一致；账号控制字段摘要、Key Router、并发 3、冷却、计费及所有相关服务 PID 保持不变。CPA、New API、CPAMP、门户和 Nginx 均未重启。

## 验证

- 同版程序与插件的隔离模拟已证明：缓冲关闭时一个账号流内过载导致 HTTP 200/error；开启 20s 缓冲后，能在未输出前尝试另一获准账号并 completed，无串池。
- 测试号池真实流式调用 HTTP 200/completed，约 3.7 秒，输入 307、输出 5 Token。
- 自建池真实调用前两个账号分别返回过载，第三个账号完成；整个请求约 26.2 秒，客户端收到完整 completed，最终输入 307、输出 5 Token。CPAMP 事件 11505、11506、11507 分别记录失败、失败、成功，三个账号均属于自建池。
- 经 New API 的合成上下文与工具定义请求 HTTP 200/completed，约 13.8 秒，输入 2,761、输出 16 Token；New API 渠道 9 的日志 13032 记录 completed/ok，CPAMP 事件 11508 有账号归属。
- CPAMP collector=running、dead letters=0、SQLite quick_check=ok。真实上游故障未被描述为已消除；本次确认早期过载可以被换号流程接管。

## 设置位置与边界

CPAMP 统一入口 `http://100.101.98.55:8317/management.html#/config` →「配置面板 → 源文件编辑」，服务器文件 `/var/lib/relay-native/bin/config.yaml`。在已有 `upstream.codex` 下合并这两个字段，保留其余配置；可视化界面的「Bootstrap 重试次数」属于通用流重试，是另一个选项。

20s 在收到上游帧时评估，是每次尝试的缓冲设置，不能视为总请求硬超时。多账号尝试可累加等待，且已输出文本或工具事件后不作无条件重放。额度耗尽、全部账号过载和选中满载账号仍需分别处理；本次没有调整这些规则。
