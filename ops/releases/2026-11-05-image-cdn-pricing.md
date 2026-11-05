# CDN 生图模型按张计费

日期：2026-11-05。生产 New API 仅更新了以下四个模型的模型定价配置：

- gpt-image-2-cdn
- gpt-image-2.5-cdn
- gpt-image-2.5-flare-cdn
- gpt-image-2.5-sunburst-cdn

统一表达式为：tier("image", fixed(0.02)) * image_count

本站额度口径中，这表示每张 0.02 个站内货币单位；图片数量仍由 image_count 校验和结算，不能通过 Token 数量绕过。渠道 19 名称显示上游参考成本约为 0.008/张，因此当前零售价约为成本的 2.5 倍。分组倍率仍由现有分组设置单独应用。

## 验证

- 四个模型的模型定价预览均通过。
- PATCH 使用每个模型的 expected_version，生产读回的模式和表达式完全一致。
- 其他模型的 pricing version 没有变化。
- New API 主进程 PID 未变化，没有重启服务。
- 原有普通 gpt-image-2、gpt-image-2.5、gpt-image-2.5-flare、gpt-image-2.5-sunburst 继续使用已有内置或现有 Token 表达式，未重复覆盖。
- 公共 /api/pricing 当前返回 40 个公开模型，不包含 -cdn 别名；管理定价接口已正确读回。这是公开模型目录过滤的后续事项，本次没有扩大范围修改模型目录。

## 尚未定价的文本模型

当前生产渠道中仍有以下模型没有经过确认的标准价格，未使用相近模型猜价：

- cn:hy3-x
- cn:kimi-k2.8-preview
- glm-5v-turbo
- kimi-k2.6
- kimi-k2.7
- kimi-k3-1
- mimo-v2.6-pro

需要对应上游采购价或公开标准价后，再单独用表达式配置。

## 回滚

四个模型的变更前配置和读回结果保存在服务器 root 私有目录 /root/shiny-maintenance/model-pricing-20261105/，不进入 Git。回滚时使用模型定价接口按版本恢复这四个模型的变更前配置；不需要数据库迁移或服务重启。
