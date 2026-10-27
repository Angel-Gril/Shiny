# New API OpenAI 缓存计费统一

2026-10-27（Asia/Shanghai）为 New API 计费表达式增加 OpenAI Responses 缓存写入档位，并同步 GPT 模型价格。

## 计费变量

- `cr`：缓存读取 Token。
- `cc30m`：OpenAI 30 分钟缓存写入 Token。
- `cc12h`：OpenAI 12 小时缓存写入 Token。
- `cc`：保留旧通用/Claude 5 分钟兼容语义。
- `cc1h`：保留 Claude 1 小时缓存兼容语义。

Responses 的 `input_tokens_details.cache_write_tokens_details.ttl_30m_tokens` 与 `ttl_12h_tokens` 会分别进入 `cc30m`、`cc12h`。旧上游只返回聚合 `cache_write_tokens` 时，按 OpenAI 默认 30 分钟档计入 `cc30m`，避免漏计。两种写入字段不重复计费。

## 已同步模型

`gpt-6-astra`、`gpt-6-luna`、`gpt-6-sol`、`gpt-6.1-sol`、`gpt-6.1-terra`、`gpt-5.6-luna`、`gpt-5.6-sol`、`gpt-5.6-terra` 均改为 `cc30m`/`cc12h` 表达式；上下文边界保留 272k 档位。`gpt-6.1-sol` 的标准档为输入 2、缓存读取 0.1、30m 写入 2.5、12h 写入 5、输出 10 美元／百万 Token；`gpt-6.1-terra` 对应为 1、0.05、1.25、2.5、5。

## 验证与发布

- Go：`go test ./pkg/billingexpr ./service ./setting/billing_setting ./controller` 通过。
- relaykit：`GOWORK=off go test ./...` 通过。
- 前端：`bun run typecheck` 通过。
- 价格预览：8 个模型全部通过表达式编译和向量校验，随后使用 `expected_version` 热更新并回读一致。
- New API 生产程序为 Linux amd64，SHA-256：`47a668530d3a2334aed12b33f735319b9b780c856caa2ebc510aa50a4775b6ec`。
- New API 从旧 release 切换到 `release-20261027-cache-billing-v1`，恢复耗时约 0.05 秒；CPA、CPAMP、门户和 Nginx 未重启。
- 当前 New API、CPA、CPAMP、门户和 Nginx 均为 active。

价格配置不改变 `Price=1`、现有充值逻辑或分组倍率。未调用付费模型，真实缓存写入是否返回由上游响应决定；表达式会按实际用量结算。
