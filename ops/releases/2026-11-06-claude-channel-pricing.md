# Claude 上游新增模型定价

日期：2026-11-06。对生产中 Claude-SuperGPT高质量-1.45（渠道 24）和 Kiro-万川低价-0.3（渠道 25）可用、此前没有显式价格的 11 个 Claude 模型补齐表达式价格。

## 价格来源

- Anthropic 官方 API 定价：https://www.anthropic.com/pricing，提供输入、输出、5 分钟缓存读取/写入及 Haiku 5.5 的 100K 上下文档位。
- Anthropic 扩展提示缓存文档：https://docs.anthropic.com/en/docs/build-with-claude/prompt-caching，1 小时写缓存按输入价 2 倍计。
- models.dev：https://models.dev，用于交叉核对型号 ID 与公开价格。

定价单位为美元/百万 Token。使用独立 cr、cc 和 cc1h 表达读取、5 分钟写入和 1 小时写入；Haiku 5.5 以 len <= 100000 分档。示例费率：

| 型号 | 输入 | 缓存读取 | 输出 | 5 分钟写入 | 1 小时写入 |
|---|---:|---:|---:|---:|---:|
| Claude Haiku 4.5 | 1 | 0.1 | 5 | 1.25 | 2 |
| Claude Haiku 5.5（<=100K） | 0.1 | 0.01 | 0.5 | 0.125 | 0.2 |
| Claude Haiku 5.5（>100K） | 0.5 | 0.05 | 2.5 | 0.625 | 1 |
| Claude Sonnet 4.5/4.6 | 3 | 0.3 | 15 | 3.75 | 6 |
| Claude Sonnet 5 | 2 | 0.2 | 10 | 2.5 | 4 |
| Claude Sonnet 5.5 | 2 | 0.1 | 10 | 2.5 | 4 |
| Claude Opus 4.5/5 | 5 | 0.5 | 25 | 6.25 | 10 |
| Claude Opus 5.5 | 4 | 0.2 | 20 | 5 | 8 |
| Claude Fable 5 | 10 | 1 | 50 | 12.5 | 20 |
| Claude Fable 5.1 | 10 | 0.25 | 50 | 12.5 | 20 |

## 更新的型号

claude-fable-5、claude-fable-5-1、claude-haiku-4-5、claude-haiku-5-5、claude-opus-4-5、claude-opus-5、claude-opus-5-5、claude-sonnet-4-5、claude-sonnet-4-6、claude-sonnet-5、claude-sonnet-5-5。

此前已有显式价格的 Claude 3.x、Sonnet/Opus 4.x 型号没有修改。相同模型名由 New API 全局共享一个基础表达式；两个渠道仍沿用各自用户组倍率，不在模型名之外叠加渠道采购成本。

## 验证与回滚

- 11 个模型逐项通过 /api/option/model_pricing/preview，并通过带 expected_version 的更新与生产读回。
- 非目标模型定价版本无变化；两个渠道的 status、模型列表、分组及映射配置未变。
- Price、USDExchangeRate、GroupRatio 未变；New API 进程未重启。
- 更新前快照和更新后回执保存于服务器 root 私有目录 /root/shiny-maintenance/claude-pricing-20261106/，不纳入 Git。
- 如需回滚，按该私有目录的目标模型快照逐项用模型定价接口恢复，携带当前版本号；无需数据库迁移或服务重启。

上线后抽查两个 Claude 渠道各一条消费日志：确认输入/输出、cache read、cache creation 及 Haiku 5.5 命中档位与上游 usage 相符。发现费率不符时，按上述快照回滚目标模型。
