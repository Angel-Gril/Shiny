# RU 原生国际支付候选接入

推荐使用本分支 `new-api/` 的原生接入：cisPay、NOWPayments、连连全球收单、PayPal 和 ZPAY 均作为可独立启用的支付方式，默认关闭。[支付模块分组](../payments/README.md) 保存供应商清单和部署组合。商户提供托管收银台，RU New API 负责创单、验签、查单和余额入账；不需要另建第三方支付平台、进程或 `pay-ru` 子域名。

```text
ru.shinyapi.com/wallet → RU New API 创单 → 支付商托管收银台
支付商 webhook → ru.shinyapi.com/api/payments/<provider>/webhook/live
               → 验签 → 官方 API 查单核对 → RU 数据库事务入账
ru.shinyapi.com/v1 → RU New API 鉴权/扣费/日志 → 内部 Key → 主站渠道
```

此变更需要构建本商业分支的新 Go 二进制和控制台。旧版二进制仅拉取配置文件不能获得这些功能。国内主站可以继续运行已验证的旧 release；仅将候选 release 安装到独立 RU 进程。主站与 RU 不能共用数据库、日志库或会话密钥。页面只是入口，独立账户/余额由 RU 实例保存。

## 配置位置与顺序

1. 备份 RU 数据库和现有 release，在独立候选环境验证迁移。MySQL 的 RU 主库和独立日志库均须采用 `utf8mb4`，不能使用 Latin1；连接 DSN 同样指定 UTF-8。新增 `hosted_payments` 表保存支付快照；复用原有 `top_ups`、`options` 和钱包事务。不要删除旧订单或用生产库进行测试支付。
2. RU「系统设置 → 站点设置 → 系统信息」的站点地址 `ServerAddress` 填 `https://ru.shinyapi.com`，只填 HTTPS origin。邮件、回跳、账户 API、支付通知都指向 RU。反向代理将 `/api/*`、控制台路由和 `/v1/*` 发往 RU 实例，参考本目录 Nginx 模板。
3. 在 RU 进程环境设置 `PAYMENTS_ENVIRONMENT=live`（默认也是 live），`PAYMENTS_PROVIDERS` 选择已批准的原生渠道，例如 `cispay,nowpayments`。模板以 `none` 起步，关闭全部原生新充值；不影响已启用的旧单回调，也不控制原有 Stripe/易支付等入口。空值或未知模块导致启动失败。沙箱须单独部署测试实例、域名、数据库，并设置 `PAYMENTS_ENVIRONMENT=test`。实例拒绝启用不匹配的环境，拒绝相应下单、通知及对账入账，避免沙箱付款增加正式余额。NOWPayments/ZPAY 本适配器只实现正式 API；cisPay 沙箱只允许已有测试订单的通知验证和查单恢复，不从 API 创建沙箱充值。
4. 登录 **RU 超级管理员**，进入「系统设置 → 计费设置 → 国际支付」：`/system-settings/billing/international-payments`。先在原支付设置页完成系统已有的支付确认，再配置相应商户。
5. 分别填写每个支付商的环境、结算币种、单价、最低充值及凭据。凭据留空表示保留已保存值；读取设置只返回是否已配置，不回传密钥。凭据保存在 RU 数据库既有 options 表，数据库和备份均需严格限制访问，本版未引入独立密钥保险库。每个渠道还有 `enabled`、`accept_new` 开关，须同时在部署清单内才能接受新充值；只开户并配置实际要收款的渠道，其他渠道继续关闭。
6. 将页面展示的 webhook URL 填入对应环境的商户后台，完成供应商联调后开启「启用支付接入」和「接受新付款」，保存。钱包自动显示对应按钮，**不用手填易支付 PayMethods**。
7. 暂停某渠道时关闭「接受新付款」，保留「启用支付接入」、凭据和回调，以便处理存量订单。可以再从部署清单移除并重启 RU 服务，旧单仍可回调及人工恢复。不同渠道可同时启用，互相独立；原有易支付、Stripe、Creem、Waffo 等继续使用各自入口，原生 ZPAY 不要与旧易支付重复开放同一商户。

原生模式不改 `PayAddress`、`EpayId` 或易支付签名密钥。以前的 [payment-bridge](../../payment-bridge/README.md) 留作不升级 New API 的可选替代方案；不必部署，同一个支付商不要同时从桥接和原生模式开放。

## 金额与账务

最低充值以 **USD 钱包额度**计；「每 USD 额度所需的支付币种金额」是固定商业报价，不自动获取汇率。例如无折扣、用户组充值倍率为 1 时，充值 10 USD 额度，币种 USD、单价 `1`，收取 `10.00 USD`；币种 EUR、单价 `0.95`，收取 `9.50 EUR`。

服务端使用精确 decimal 计算，并应用 RU 现有充值分组倍率和金额折扣。`QuotaPerUnit` 与额度显示方式沿用该实例设置；下单即保存实际应付金额/币种、精确入账 quota、商户环境标识。后来修改单价/折扣不改变旧单。钱包和订单记录展示支付币种，付款成功只有在服务器验签、查单、比对订单/商户/币种/金额后才能入账。重复/并发通知最多入账一次。

RU 收款、赠送、客户消费和主站内部服务账号消耗应分别统计。主站内部 Key 的额度不是第二笔零售收款；不能从聚合余额反推可退款现金。

## 各支付商字段

| 支付商 | 商户必须提供 | 正式 webhook |
| --- | --- | --- |
| cisPay | Merchant API Shop ID、API Key；可选固定 `CARD`、`SBP` 或 `CRYPTO`；批准/核实的收银台域名 | `https://ru.shinyapi.com/api/payments/cispay/webhook/live` |
| 连连全球收单 | 已开通 Open Platform v1 acquiring CHECKOUT 的 API Key、签名凭据、Store ID、Merchant User ID、Developer User ID、受理国、批准的商品 URL/物流代码、精确收银台域名；代客场景另填 On Behalf Of | `https://ru.shinyapi.com/api/payments/lianlian/webhook/live` |
| NOWPayments | Merchant account reference（自定义稳定商户标识）、API Key、独立 IPN Secret、结算钱包；可选明确币和网络代码 | `https://ru.shinyapi.com/api/payments/nowpayments/webhook/live` |
| PayPal | Client ID、Client Secret、Merchant ID、对应 App 的 Webhook ID | `https://ru.shinyapi.com/api/payments/paypal/webhook/live` |
| ZPAY | 商户 ID、商户 MD5 密钥、`alipay` / `wxpay`、核实的精确收银台域名 | `https://ru.shinyapi.com/api/payments/zpay/webhook/live`（GET） |

测试地址将最后的 `live` 改成 `test`，同时换成独立测试站域名。页面会按 `ServerAddress` 和所选环境生成地址。

### cisPay

- 使用 [cisPay Merchant API](https://cispay.app/developers) 的 `POST https://api.cispay.app/payments` 创建托管支付，请求头为文档指定的 `X-Shop-ID` 和 `X-Api-Key`。金额按最小单位发送，例如 `1050` 表示 `10.50 RUB`。
- 不填固定支付方式时，由 cisPay 托管页从该 Shop 已启用的 `CARD`、`SBP`、`CRYPTO` 中选择。OpenAPI 信息称当前普通支付主币种为 RUB，`USD` 主要对应 crypto；固定 `CARD` 或 `SBP` 时配置币种必须为 RUB。CRYPTO 可按供应商对该 Shop 的实际能力选择 RUB 或 USD，但商户实际能力仍须开户确认。每笔订单在创建时保存金额和币种，后续查单必须完全匹配。
- 配置页将 webhook 地址填入 cisPay 店铺设置。通知的 `X-Signature` 是 **API Key + 原始请求字节** 的 HMAC-SHA256 小写 hex；实现先验签，再校验 `store_id`、本地 `order_id`、状态和通知字段。订阅类事件的 `event` 字段不用于钱包充值。
- 每个用户用稳定的 `customer_id=user-<RU用户ID>` 创单，以符合 SBP 和付款人识别要求，不能用每单随机 ID。通知验签后还会调用 `GET /payments/status` 查询权威状态。创建响应或首次通知丢失时，可以先填 Shiny 订单号 `HP-…` 直接按 `order_id` 查单；官方查单为 `PAID`、订单号/金额/币种匹配且沙箱状态与实例环境一致，才入账。`charged_amount` 可能包含用户承担的手续费，不能用于覆盖应按订单收取的 `amount`。
- OpenAPI 的创单 `PaymentResponse` 不保证返回 `currency` 或 `is_sandbox`，因此创单校验订单号、状态、金额及已返回的来源金额，并拒绝已返回的沙箱/订阅/封禁标记。权威状态查询按文档处理省略字段：`currency` 默认为 RUB，`is_sandbox` 默认为 false；明确为 null 的沙箱标记被拒绝，测试实例只接受明确 true。RUB 下 crypto 时，返回金额可能换算为 USD，但仍保留 `source_amount/source_currency`；入账按原 RUB 报价及其来源字段验证，且查单必须确认为 CRYPTO / USD。只允许跳转到配置中的精确收银台域名。
- 官方公开 API 没有沙箱创单字段或独立沙箱基础地址，沙箱由 cisPay 商户后台创建。生产实例拒绝已确认的沙箱交易；测试实例不开放 API 下单，只验证可对应到已有测试订单的通知/查单。本版不提供商户后台沙箱订单导入，不能把「可处理沙箱通知」说成完整沙箱购买流程。
- 创建通知和查单边界已做协议适配；是否允许你的经营主体、俄区用户和具体支付方式，仍须由 cisPay 审核及商户后台能力确认，API 存在不代表业务已获批。

### 连连全球收单

- 全球收款账户、付款产品或资料审核 API 不等于全球收单 CHECKOUT 权限。你提供的 `op-webhook_documents_audit` 是资料审核事件，**不能据此增加充值余额**。当前实现使用 `POST /api/v1/acquiring/payments/apply` 和 `GET /api/v1/acquiring/payments/{pay_order_no}`。
- HMAC 模式下 API Secret 必须先 Base64 解码；Webhook Secret 是独立字面量密钥，不复用 API Secret。RSA 模式填写商户 RSA 私钥及连连平台公钥（支持 PEM，至少 2048 位）。API 请求采用毫秒时间戳、随机 nonce 和原始请求体签名；创单携带固定幂等键。响应验签通过后才解析。
- 在连连后台注册通知并订阅 `acquiring.payment.succeeded`。文档创单接口没有逐单 `notify_url`，实现没有添加此字段。通知校验 5 分钟时窗、事件 ID、原始字节签名和商户归属，再查单确认 `SUCCESS`。
- Approved checkout hosts 每行填一个经供应商确认的精确域名，不填协议、路径、通配符。受理国/商品/物流代码按已获批数字服务业务提供，代码不代填虚构数据。
- 全球收单能否支持你的经营主体、俄区付款人、具体俄罗斯卡或本地方式，必须由连连确认，不能从 API 对接完成推断可受理。

### NOWPayments 加密货币

- 本版固定 `https://api.nowpayments.io/v1`，报价币种 USD。币和网络代码可留空，由官方托管页选择；指定时须使用供应商明确代码，不能只写含糊的 USDT 并忽略网络。
- IPN 按文档递归排序 JSON 键后计算 HMAC-SHA512；随后使用 **Payment ID** 查单。Invoice ID 和 Payment ID 是两种编号。
- 仅当官方查单为 `finished`、`actually_paid >= pay_amount > 0`，并且 invoice、订单、USD 金额匹配时入账。`confirmed`、`sending`、`partially_paid` 不入账。超付不自动增加额度，多次分笔/错链/退款由运营处理。
- 未实现独立链上监听器。商户资格、付款人地区、币/链、最小金额和手续费由供应商实际能力决定；真实收款需要获准账户小额验收，本地模拟不等于供应商沙箱通过。

### PayPal

- 沙箱使用官方 sandbox API，正式使用 live API；只开放本适配器支持的 USD/EUR/GBP，并按实际商户开通能力选择。
- 注册 `CHECKOUT.ORDER.APPROVED`、`PAYMENT.CAPTURE.COMPLETED`；调用官方 `verify-webhook-signature` 验签。先查单核对商户、订单、币种和金额，APPROVED 才由服务端按固定幂等键 capture；COMPLETED capture 匹配后入账。
- 浏览器回跳的 `token`、状态和 URL 参数都不能直接加余额。PayPal 是适用国家用户的补充渠道，不应作为俄区本地用户的核心收款方式；当前是否接受特定主体/付款人，以最新平台政策和合同为准。

### ZPAY

- [官方接口](https://z-pay.cn/doc.html) 明确兼容易支付。原生模块复用已有 `go-epay/epay` MD5 签名实现，以 multipart/form-data 调用 `POST https://zpayz.cn/mapi.php`。商户凭据单独配置，不改旧易支付的 `PayAddress` / `EpayId` / Key。
- 发送 `pid`、`type`、本地订单号、CNY 金额、客户 IP、通知和回跳 URL。回跳不带查询参数；使用供应商返回的 `payurl`，并校验精确 HTTPS 域名。本版不实现 `payurl2` 微信 H5、二维码嵌入或小程序收款。
- GET 回调先拒绝重复参数、核对商户、验 MD5，再调用 `GET /api.php?act=order&pid=…&key=…&out_trade_no=…`。只有 `status=1` 且订单、商户、金额、远端 ID 匹配时一次入账，并返回字面量 `success`；查询未确认成功时要求平台重试。官方查询把商户密钥放在 HTTPS URL 中，不能将该 URL、请求或异常原文写入日志。
- ZPAY 的支付宝/微信与 CNY 是补充选择，不是俄区 SBP 接入；按实际客群和商户能力开放。

## 对账、停用和故障

- 管理员可在同一支付商页底部「验证并恢复付款」填写 Shiny 订单号 `HP-…`。下单响应丢失时同时填供应商订单号；NOWPayments 丢失首个 IPN 时需补 Payment ID（必要时再补 Invoice ID）。服务器仍须查单并完全匹配才能入账，不能凭手填 ID 或回跳入账。
- 对外下单超时可能已创建供应商订单，本地标记 `creation_unknown`，保留 pending 订单。先在商户后台查明，不要盲目再次付款。支付商重试回调或管理员查单均可恢复；**本版没有定时轮询、自动对账任务或独立通知队列**，应监控未知/长时间 pending 订单并维护对账流程。
- 成功通知可能早于官方查单状态更新。通知声称支付成功或 PayPal 已批准，但查单尚未确认/完成 capture 时返回可重试错误，不提前确认通知，以便后续到账；其他未完成状态不增加余额。
- 关停渠道先暂停新付款。存在 pending 订单时，禁止直接禁用或切换商户/环境；更换凭据必须保持原商户和旧单查单/验签能力。本版没有自动关闭未付款订单或取消流程，长期 pending 单需查明并在正式增加取消功能前保留原配置，不能通过数据库强改状态绕过检查。
- 每个支付商每实例只配置一个有效商户/环境。初期使用单个 RU Go 进程：配置更新与创单的互斥是进程内的；多副本入账事务仍幂等，但多副本配置刷新/切换商户需要后续协调设计。
- `hosted_payments` 含收银台 URL，应按订单数据保护；不把 URL/原始第三方响应/密钥写进日志或 Git。卡号和 CVV 由托管收银台处理，RU 站不采集。
- 范围为钱包充值，**不含原生订阅购买、自动退款、拒付/争议扣款、税务开票**。退款先核实实际收退款，再按已有账务流程记录并调整，不能把成功回调反向改成未经设计的扣余额。
- 回滚代码前先暂停新付款并处理存量单。旧 release 不处理新 webhook；有存量原生订单时应保留能处理该回调的 release。保留新增表及订单，回滚前备份，不删除资金记录。

## 验证

自动化入口为 `.github/workflows/native-payments.yml`，包括 Go 协议/配置测试、SQLite/MySQL/PostgreSQL 真实数据库新建与升级两次、独立日志库、并发入账/金额拒绝/额度溢出回滚、原易支付回归，以及钱包/管理页测试、typecheck、lint 和构建。

2026-11-24 本次本地验证使用真实 SQLite **3.50.4**、MySQL **5.7.44**、PostgreSQL **9.6.24**，三个引擎的新建/升级库、迁移两次、独立日志库、并发单次入账、历史支付币种和额度溢出回滚均通过，无数据库跳过项。执行命令为 `go test ./model -run '^(TestHostedPaymentDatabaseMatrix|TestRechargeEpay)' -count=1 -v`，并配置 `TEST_MYSQL_DSN`、`TEST_POSTGRES_DSN` 及各自独立 `*_LOG_DSN`。协议与回调回归 `go test ./controller ./service ./model -run '^(TestHosted|TestEpay|TestRechargeEpay)' -count=1` 通过。

本次钱包和国际支付管理页 **27 项** Vitest 测试、`bun run typecheck`、涉及文件 oxlint、保护归属头的 oxfmt 检查、`bun run build` 及 Go 主程序构建通过。新增支付文案覆盖七种界面语言。API/供应商网络边界使用 fixture，不发送真实收款；生产开户、真实商户凭据、沙箱及小额付款、俄区网络和双实例模型流量仍须候选环境验收。

已有 `04499c1` 版本的 [原生支付 CI](https://github.com/Angel-Gril/Shiny/actions/runs/45246899191) 与 [源码回归](https://github.com/Angel-Gril/Shiny/actions/runs/45246899159) 通过。旧运行仅是历史记录，不能替代本次新验证；本次远端 CI 结果以新 commit 的工作流为准。本地三数据库及构建结果如上，实际商户仍须联调和小额支付验收。

遵循现有 root 权限和 OriginGuard；敏感配置只走专用接口，服务端重新计算金额，通知验签+查单，原子幂等入账。参考 OWASP 支付/认证/会话指引，未作完整 ASVS 合规认证声明。管理表单复用项目 `SettingsForm`、RHF/Zod、`Form`、`CopyButton`、加载/错误状态和 Query/Mutation，未另建通用交互体系。

官方协议核对：2026-11-24。

- [连连 CHECKOUT API](https://global.lianlianpay.com/docs/api_docs#op-createOrder)、[查单](https://global.lianlianpay.com/docs/api_docs#op-queryOrder)、[签名及幂等指南](https://global.lianlianpay.com/docs/guide/getting_started)（1.0.0，生效 2026-09-09）。
- [NOWPayments 官方 API 文档](https://documenter.getpostman.com/view/7907941/S1a32n38)。
- [PayPal Orders v2](https://developer.paypal.com/docs/api/orders/v2/)、[官方 API schemas](https://github.com/paypal/paypal-rest-api-specifications)。
- [cisPay 开发文档](https://cispay.app/developers)、[Merchant OpenAPI](https://cispay.app/api/merchant/v1/openapi.json)。
- [ZPAY 易支付兼容接口](https://z-pay.cn/doc.html)。
- [OWASP 支付集成](https://cheatsheetseries.owasp.org/cheatsheets/Third_Party_Payment_Gateway_Integration_Cheat_Sheet.html)、[认证](https://cheatsheetseries.owasp.org/cheatsheets/Authentication_Cheat_Sheet.html)、[会话](https://cheatsheetseries.owasp.org/cheatsheets/Session_Management_Cheat_Sheet.html)。
