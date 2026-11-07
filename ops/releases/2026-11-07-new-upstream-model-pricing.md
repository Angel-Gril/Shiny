# 新增上游模型价格补齐

日期：2026-11-07。生产新增渠道盘点发现 5 个仍没有有效价格的模型，已按前一轮核对的官方/对应型号价格补齐：

- claude-fable-5.1：沿用 Fable 5.1，输入 10、cache read 0.25、输出 50、5m 写入 12.5、1h 写入 20。
- claude-opus-4-6-thinking：沿用 Opus 4.6，输入 5、cache read 0.5、输出 25、5m 写入 6.25、1h 写入 10。
- claude-sonnet-4-6-thinking：沿用 Sonnet 4.6，输入 3、cache read 0.3、输出 15、5m 写入 3.75、1h 写入 6。
- gpt-image-2.6-flare、gpt-image-2.6-sunburst：按 OpenAI 官方 Image 2.6 模态价，输入 5、文本 cache read 1.25、图像输入 8、图像 cache read 2、输出 30。

所有金额单位均为美元/百万 Token。Claude 1h 写缓存采用官方扩展提示缓存规则，按输入价 2 倍；Thinking 后缀沿用对应基础型号价格，不另加 thinking token 费。

## 验证

- 5 个模型通过当前版本锁定、表达式预览、生产写入和读回。
- 非目标模型价格版本没有变化。
- 渠道 23–27 的模型列表、分组和映射没有变化。
- Price、USDExchangeRate、GroupRatio 没有变化。
- New API 主进程 PID 没有变化。
- 前一次中断的旧版本快照没有重用；本次使用了当前版本重新预览，回执保存在服务器 root 私有目录 /root/shiny-maintenance/new-upstream-pricing-20261106/。

后续应在使用日志中抽查两个 Image 2.6 请求和三个 Claude 新别名请求，核对 usage 的缓存与图像模态字段；发现价格或归一化不符时，按当前回执及版本锁回滚目标模型。

