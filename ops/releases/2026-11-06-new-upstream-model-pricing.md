# 新接入上游模型价格

日期：2026-11-06。根据生产启用渠道模型清单，为 5 个此前没有有效价格的模型补齐定价表达式。

## 价格依据

- Claude Fable 5.1、Opus 4.6 Thinking、Sonnet 4.6 Thinking 按 Anthropic 官方型号价格，分别沿用 Fable 5.1、Opus 4.6、Sonnet 4.6：
  - Fable 5.1：输入 10、cache read 0.25、输出 50、cache write 5m 12.5、1h 20。
  - Opus 4.6：输入 5、cache read 0.5、输出 25、cache write 5m 6.25、1h 10。
  - Sonnet 4.6：输入 3、cache read 0.3、输出 15、cache write 5m 3.75、1h 6。
- GPT Image 2.6 Flare/Sunburst 按 OpenAI 官方价目中的模态费率：文本输入 5、文本缓存读取 1.25、图像输入 8、图像缓存读取 2、输出 30（美元/百万 Token）。

## 更新模型

- claude-fable-5.1
- claude-opus-4-6-thinking
- claude-sonnet-4-6-thinking
- gpt-image-2.6-flare
- gpt-image-2.6-sunburst

Thinking 后缀模型使用对应基础 Claude 型号的同一价目；这是公开型号别名价格，不是为 thinking token 添加单独倍率。表达式分别使用 cr、cc、cc1h；Image 2.6 Flare/Sunburst 使用 p + cr + img + img_cr + c 模态表达式。

## 验证

- 五个模型通过模型定价预览、带 expected_version 的更新和生产读回。
- 五个名称均出现在公共 /api/pricing。
- 非目标模型定价版本无变化；渠道 23–27 配置未变化。
- Price 与 USDExchangeRate 未变化；New API 主进程 PID 未变化。
- 本次初始审计快照与写后查询的 GroupRatio 不同。GroupRatio 不在本次 PATCH 字段内，更新脚本未写入或覆盖它；保留当时生产值。
- 表达式快照、预览和回读回执只保存在服务器 root 私有目录 /root/shiny-maintenance/new-upstream-pricing-20261106/，不进入 Git。

## 监控与回滚

管理员在使用日志中分别抽查新 Claude thinking/Fable 请求和两个 Image 2.6 请求，核对渠道 usage token 分类、实际 img 与 cache read、匹配档位和扣额。发现价格分类异常时，按服务器私有快照用模型定价接口恢复五个模型当前配置，使用更新时的版本校验；不需重启 New API。
