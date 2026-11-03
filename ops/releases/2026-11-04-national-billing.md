# 国模日历锁价与缓存计费

实现 PR：https://github.com/Angel-Gril/Shiny/pull/31 ，合并提交 `aab52146f66e034a5c1ebc8c658c0b602aaac44b`。

后端：`shiny-rc47-national-381a62a`，源码 `381a62ad2`，SHA256 `d716d89ea658e3166901e2ab0a9ddc8c69a618a2a9995506f2c298d4098a24df`。

控制台：`web-national-billing-20261104`，源码 `729237cbe`，前端压缩包 SHA256 `16a1ff2207d05c1652b93bb98c4a0c60b4a6f7f47964078bca93162faed3fb1e`。

13 个精确型号采用 XKRelay 标准售价；其未列出的通用 Flash、两个 MiniMax 保留零猫来源，详见 `ops/national-model-pricing.json`。Kimi K3 将官方默认／1h 写入价格 20／40 显式列出。所有金额使用站内额度数字，不除以 7.3；国模倍率 0.35 和充值 Price=1 保留。

增加 `deepseekPeak()` 和 2026 年中国节假日日历。请求到达时保存时间及日历判定，渠道重试和流式结算不重取时钟。未知年份回退闲时价。Qwen 支持缓存创建字段别名；Kimi 使用经过渠道覆盖的实际发出 TTL 拆分写入用量。原 GPT／Claude 缓存回归保留。

验证：Linux 受影响 Go 包、relaykit 全套测试和独立构建通过；前端价格逻辑 126 项、模型编辑相关 59 项通过；typecheck、lint、构建和 GitHub CI 通过。隔离 PostgreSQL 候选使用 20 次本机模拟上游请求，验证 Qwen／Kimi、Chat／Responses、流式与非流式的实际日志扣费；另检查峰时边界、假日、调休周末和缺少年份。

生产回读：16 个国模表达式与资料一致，旧 cn: 目录为零；旧静态资源可访问，CPA／CPAMP／门户 PID 和渠道路由未变。未调用真实第三方模型消耗用户额度，真实上游仍需按其实际返回的缓存字段结算。

回滚：使用受限生产记录恢复这 16 个模型原覆盖（以当前版本做乐观锁），然后恢复旧 New API 启动配置和前端 include。保留所有历史不可变静态资源。不得用旧全站 options 覆盖其他管理员变更，不删除用户账单或渠道凭证。
