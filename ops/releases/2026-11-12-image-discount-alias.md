# 图片优惠渠道独立别名及按张定价

已在生产通过管理 API 完成，无程序二开、构建、数据库结构变更或服务重启。完整非敏感配置见 `ops/image-discount-pricing.json`。

## 修改位置

1. **渠道管理 → 19 号图片优惠渠道 → 模型列表**：将7个普通图片模型名替换为对应的 `-cdn` 别名，保持标准名称在其他渠道的配置。
2. **同一渠道 → 模型映射**：每个别名映射回原名，例如 `gpt-image-2-cdn → gpt-image-2`。原始名称传给供应商，别名保留为本站计费和日志身份。渠道请求体透传仍为关闭。
3. **同一渠道 → 分组**：只保留 `【GPT】Image分组-优惠渠道`，移除该渠道的 default/vip/svip/ultra/max 通用分组绑定，防止普通流量落入优惠计费池。
4. **模型定价 → 7个别名 → 表达式**：统一 `tier("image", fixed(0.02)) * image_count`。此前4个正确价格不重写，只新增3个2.6系列别名价格。

优惠组倍率原为1，未修改。已核对不存在该组的用户组专属倍率覆盖。其他渠道、全部标准模型价格、现有令牌内容、充值与汇率设置不变。原始普通名称在优惠令牌下不再可用，客户端须改选对应别名。

## 验证

- 上游 `/v1/models` 列出7个原型号。
- 7/7别名预览编译和内置试算通过；型号映射、渠道能力、公开价格和分组隔离读回通过。
- 本地运行 `go test ./relay/channel/openai ./relay/helper ./service -run '^(TestImageExpressionUsesCompletedCountAndProtectsAbortedStreams|TestOpenaiImageHandlerUsesPositiveActualCountForFixedPrice|TestOpenaiImageStreamHandlerWrapsNonStandardDataShapes|TestCalculateTextQuotaSummaryFixedPriceAppliesImageCountOnceAndAllowsOverride|TestImageBillingRequestValidatesProviderCountWithoutOverriding)$' -count=1`，3个包均通过。
- 生产真实调用7个别名，均HTTP200并返回图片载荷。普通单张扣费0.02；`gpt-image-2-cdn` 请求2张、返回2张、扣费0.04。消费日志保留别名、映射后的上游名称、实际张数和固定单价。
- 单独验证 multipart `/v1/images/edits`，别名映射成功，返回1张，扣费0.02。
- 共10次真实调用、实际返回12张，测试扣除0.24站内额度；无人工改回钱包或伪造用量。临时测试令牌均已删除，图像及原始响应未保存。
- 其他标准图片模型表达式和其他渠道字段逐项不变；19号仅模型列表/映射/分组变化。New API PID不变。

## 上游边界

首次 `gpt-image-2.6-sunburst-cdn` 请求1张，上游响应携带2个图片载荷，正常完成后按2张结算0.04。一次专门复测返回1张1024×1024 PNG，结算0.02。不能据此保证上游始终严格遵守n，也不应把首次数量不一致隐去。本次没有截掉额外图片或强行少计费；如果产品要求绝不超过请求张数，需另行评估供应商或数量策略。

所有别名共用已验证的映射规则，不代表供应商未来可用性、质量或所有协议都被保证；真实验证覆盖图像生成、一次双图请求和一次multipart编辑，没有测试Responses内嵌图片工具、流式图片编辑或全部客户端组合。

## 升级与维护

按固定别名维护此渠道，检查上游更新可保留，但不要直接用“上游原始模型列表”覆盖别名；增加新型号时一起补充别名、映射和价格。模型定价属于全局名称配置，不能把普通`gpt-image-*`改成固定按张价。

原渠道设置、模型价格版本、能力、回滚请求及测试回执保存于服务器 root 私有目录 `/root/shiny-maintenance/image-discount-alias-20261112/`，不进入Git。回滚前重新检查当前渠道和模型版本，避免覆盖并发管理员修改。
