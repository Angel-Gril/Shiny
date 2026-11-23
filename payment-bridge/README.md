# Shiny payment bridge · 0.1.0 candidate

独立支付组件，接入 Shiny New API 已有的易支付 **RSA/MD5 页面支付协议**。账户、余额、模型计费、充值订单仍由 RU New API 管理；本组件保存收银台订单、币种、报价和通知投递记录。`new-api/` 的 Go 代码和数据库 schema 没有修改。

本版本提供 NOWPayments、连连全球收单、PayPal 三个适配器，默认全部关闭。配置模板不代表商户开户、俄罗斯受理能力或真实收款已经验证。以商户合同、供应商后台开通的产品和候选联调结果为准。

```text
ru.shinyapi.com/wallet → RU New API 创建订单、签名
                    → pay-ru.shinyapi.com（俄语确认金额）
                    → 第三方托管收银台
第三方 webhook → 支付组件验签 → 供应商 API 查单核对
                            → 签名通知 RU New API
                            → 原有订单事务加余额，重复通知幂等
模型请求 ru.shinyapi.com/v1 → RU 实例 → 主站已有渠道
```

`pay-ru.shinyapi.com` 只负责支付，可与门户放在小服务器；不承担模型转发。每个站点使用自己的支付组件配置、账本、商户签名密钥和回调地址。不要让主站和 RU 共用这份账本。连连/PayPal 商户账户能否共用取决于合同，代码仍要求分别配置 webhook 和站点归属。

## 渠道与选择

| 渠道 | 本次交付 | 对俄区的定位 |
| --- | --- | --- |
| NOWPayments | 托管发票、IPN HMAC-SHA512、查单、足额完成校验 | 加密货币候选；支持的币种/链、商户及付款人资格需核实，不承诺绕过地区限制 |
| 连连全球收单 | Open Platform v1 CHECKOUT 创单、HMAC/RSA 请求及响应验签、成功 webhook、查单 | 国际收单候选；不是“有连连收款账户就能收俄罗斯本地卡” |
| PayPal | Orders v2、用户批准后服务端 capture、官方 webhook 验签接口、查单 | 对适用地区用户的补充渠道；俄区本地用户不应依赖此项，开通前复核当前地区限制 |
| Stripe / Creem / Waffo / Waffo Pancake | 复用 New API 已有实现，见下方配置路径 | 按实际已获批的商户能力启用；无需重复安装同类桥接适配器 |
| СБП / Mir / YooKassa 等 | 本版没有实现或声称开通 | 适合进一步评估的俄区本地支付；需要相应经营主体、结算账户、合同和接口权限 |
| 直接链上地址收币 | 本版没有链上监听器 | 不能只贴钱包地址就自动充值；需要地址/订单对应、链确认、少付/错链处理与对账 |

“全部配置”在这里是**组件和配置入口可选择**，并非把所有平台默认开放。原生渠道在 RU `/system-settings/billing/payment` 配置，桥接渠道在服务器私有 `config.json` 配置。`enabled: false` 不加载模块；`acceptNew: false` 停止新订单并继续查单、处理存量付款。存在待处理订单时启动检查禁止直接禁用适配器。移除钱包按钮后仍应保留凭据和 webhook，直至存量订单处理完毕。

本版接入范围是 `/wallet` 余额充值，不包含订阅套餐支付。RU 每个 New API 实例只有一套易支付 `PayAddress`，指向桥接后不能同时指向另一个易支付服务；Stripe/Creem/Waffo 等原生独立入口仍可并存。国内主站可以继续使用自己的易支付配置。

## New API 设置

仅在 **RU 实例** 的 `/system-settings/billing/payment` 设置，国内主站保持原配置：

| New API 字段 | 值 |
| --- | --- |
| 站点地址 `ServerAddress`（站点/系统信息页） | `https://ru.shinyapi.com` |
| 易支付地址 `PayAddress` | `https://pay-ru.shinyapi.com`，不含 `/submit.php` |
| 商户 ID `EpayId` | 与 `newapi.merchantId` 完全一致，例如 `shiny-ru` |
| 签名方式 `payment_setting.epay_sign_type` | 推荐 `RSA`，当前 Shiny fork 已支持 |
| 商户私钥 `payment_setting.epay_merchant_private_key` | RU New API 请求签名私钥；其公钥配置为桥接 `newapi.publicKeyFile` |
| 平台公钥 `payment_setting.epay_platform_public_key` | 桥接通知签名公钥；其私钥配置为桥接 `newapi.privateKeyFile` |
| 自定义回调 `CustomCallbackAddress` | `https://ru.shinyapi.com`，仅 origin；不能带 `/api` |
| 支付方式 `PayMethods` | 复制 `node src/cli.mjs check` 输出中已启用渠道的数组 |
| 充值比例 `Price`、最小充值、充值折扣 | 按下面的币种约定设置并测试 |

需要完成原系统已有的支付设置确认才会开放充值。不要用主站上游模型 Key、New API root 会话或平台 API Key 作为易支付签名密钥。

### 金额约定

现有易支付界面按 CNY 展示支付金额，本组件默认 `newapi.currency=CNY`。用户充值额度与收款金额是两个概念：例如充值 10 USD 额度，New API `Price=7.2`、无折扣时生成 `72.00 CNY` 订单；桥接设置 `sourceUnitsPerSettlementUnit=7.2`，托管收银台收取 `10.00 USD`。回调 New API 的仍是原订单 `72.00`。

`7.2` **只是示例固定商业报价，不是实时汇率**。变更前测试用户界面与账本；按 CNY/USD 等实际业务约定设置，勿将 `Price=1` 与默认换算率混用。新订单快照保存源金额、目标金额、币种、汇率，后续调价不改变旧单。桥接仅支持列出的两位小数币种；NOWPayments 会在托管页把 USD 报价换成用户选择的币和链。本版不做链上资产自动换算、退款或赠额合并。原生 Stripe 等渠道使用各自已有单位价格配置。

首次确认页展示实际支付金额和报价；退款依据真实到账和退款流水处理，不依据聚合余额推算。内部主站服务账号额度不是第二笔客户现金收入。

## 安装及选择组件

Node.js >= 24.15，使用内置 HTTP/crypto/SQLite，无 npm 运行依赖。独立部署路径建议 `/srv/shiny/payment-bridge/releases/<commit>/`。从商业分支固定 commit 拉取 `payment-bridge/` 与 `ops/ru/payment-*` 即可，不需要更新 New API 二进制或国内门户。

1. 将 `config.example.json` 复制到服务器私有 `/etc/shiny-payments/config.json`。将 `database` 改为 `/var/lib/shiny-payments/payments.sqlite`，私钥路径改为实际绝对路径。
2. 根据 `.env.example` 创建私有 `payments.env`，生成独立随机 CSRF 密钥（至少 32 随机字节）。只给运行账号读取权限。环境文件不能放到静态目录或 Git。程序不自动加载 `.env`；systemd `EnvironmentFile` 或进程环境负责注入。
3. 分别生成 New API 请求签名、桥接通知签名两套 RSA 2048 位或以上密钥。生成私钥留在对应服务，交换公钥。可以在服务器使用 `openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:3072 -out <private.pem>` 和 `openssl pkey -in <private.pem> -pubout -out <public.pem>`。不将真实密钥写进配置示例。
4. 只开启已获准且已填好配置的 provider。根配置 `environment=test` 只允许测试/沙箱渠道，`live` 只允许正式渠道；程序拒绝混用。测试配置必须连独立的测试 New API 数据库/域名，不能把沙箱通知接到正式钱包。切换正式环境使用新的账本与站点身份。`PAYMENT_CONFIG=/etc/shiny-payments/config.json node src/cli.mjs check` 校验配置并输出 New API 按钮配置，不创建真实支付。
5. 审阅 `ops/ru/payment-bridge.service.example` 和 `payment-nginx.conf.example`，配置 DNS、TLS 和 Nginx。每份 SQLite 账本只运行一个实例；服务仅监听 loopback，通过 Nginx 公网 HTTPS 暴露。不共享数据库文件到网络文件系统。锁文件和 WAL 一并视为运行数据，迁移前停止服务并备份。
6. `node --test tests/*.test.mjs` 后在候选域名完成供应商测试，再决定上线。首次下单金额、币种和额度必须人工核对。Nginx 配置检查、商户真实联调与生产发布不由本分支自动执行。

可仅部署 `src/providers/` 中需要的模块，但应始终保留共同核心和已存在存量订单使用的模块。原生 Stripe/Creem/Waffo 只需在 New API 中配置，不经本桥接。全部源码的体积很小，建议完整拉取、按配置启用，避免手工拼文件漏依赖。

## 供应商配置

### NOWPayments

在商户后台获取 API Key、生成独立 IPN Secret、设置结算钱包及希望支持的币/链；分别放入 `NOWPAYMENTS_API_KEY` / `NOWPAYMENTS_IPN_SECRET`。`payCurrency` 留空让托管页选择；指定值必须是供应商代码，不能只写含糊的 USDT 而忽略链。webhook 为 `https://pay-ru.shinyapi.com/webhooks/nowpayments`。

本版固定生产 API 地址；所有示例关闭，无凭据时不能下单。本地测试模拟的是远程 HTTP 边界，不能声称已通过供应商沙箱。上线前用获准账户小额实测，包括网络手续费、最小金额、少付、过付、错链和退款客服流程。

只有查单结果 `finished`、源订单、invoice ID、USD 金额一致且 `actually_paid >= pay_amount` 才通知 New API；confirmed/sending/partially_paid 不入账。每个 invoice 最多入账一次，多次付款或超付不自动增加额度。Invoice ID 与 Payment ID 不同；收到有效 IPN 后保存 Payment ID 供后续查单。完全丢失的 IPN 需要运营在商户后台找到 Payment ID，再用下面的维护流程处理，不声称自动按 invoice 查单。

### 连连全球收单

核对你的账户是否开通 **Open Platform v1 acquiring CHECKOUT**。仅有全球收款账户、资料审核或付款权限不足以使用此组件。

- API Key / API Secret / Webhook Secret 分开保存。HMAC 模式：API Secret 先 Base64 解码；Webhook `whsec_…` 按文档作为独立密钥，不复用 API Secret。也可选 `signatureType=RSA`，填写商户私钥和**连连平台公钥**。
- `environment=test/live` 决定固定 API 网关，禁止测试和正式凭据混用；切换环境使用新账本，不把沙箱订单写入正式钱包。
- `storeId`、交易所属 `userId`、`developerUserId`、`countryCode` 必须使用连连分配/开通的数据。代客调用才填 `onBehalfOf`；受理国不能为绕开限制随便填写。
- `checkoutHosts` 填供应商确认的收银台精确域名；不使用 `*` 或宽泛域名后缀。`shippingProvider`、商品页面和 API 服务类目按连连批准的数字服务业务填写；本组件不虚构物流或商户资料。
- 在连连开发者后台配置 `https://pay-ru.shinyapi.com/webhooks/lianlian`，订阅 `acquiring.payment.succeeded`。创单规范没有逐单 `notify_url` 字段，代码不会杜撰。**documents_audit 材料审核永远不触发充值。**
- 仅 PAYMENT 普通支付。每次请求使用新 timestamp/nonce；创单幂等键固定。响应验签后解析；webhook 校验 5 分钟时间窗、原始字节签名、事件与商户归属，再查单确认 `SUCCESS` 和金额币种。

### PayPal

使用适用国家/地区的已批准商户，获取 Client ID、Client Secret、Merchant ID。在对应 sandbox/live App 创建 webhook：`https://pay-ru.shinyapi.com/webhooks/paypal`，订阅 `CHECKOUT.ORDER.APPROVED`、`PAYMENT.CAPTURE.COMPLETED`，填写 Webhook ID。按该账户要求另外处理退款/争议事件。

由服务端创建 CAPTURE 订单，用户批准后服务端捕获，最终核对 COMPLETED capture、payee、订单、金额和币种。使用官方 verify-webhook-signature API，不下载客户端给出的证书 URL。用户回跳及 URL 中的 token/status 不用于充值。

本适配器提供国际用户补充渠道，不承诺俄罗斯本地 PayPal/银行卡可用。不得通过虚假国家、身份或商户资料开通。

## 对账、故障和退款边界

- 已核实付款记录先持久化，再发送 New API 通知；失败指数退避重试（上限 1 小时，持续重试）。重复通知由原 New API 事务幂等。**保持原签名密钥和支付回调配置直到所有订单完成**，切换商户需开新实例。
- 下单请求超时/断网可能已经创建远端订单，因此标记 `creation_unknown`，禁止盲目重建。服务重启同样恢复为该状态。停服务后运行 `node src/cli.mjs recover <bridge-order-id> <provider-order-id> [payment-id]`，必须通过 API 查单并匹配订单和金额才恢复。NOWPayments 需要 invoice ID 和 Payment ID。
- 已知 pending 单可在停止服务后运行 `node src/cli.mjs reconcile <bridge-order-id>`；NOWPayments 若丢失首个 IPN，可由供应商重发 IPN，或运行 `node src/cli.mjs link-payment <bridge-order-id> <payment-id>`，程序查单匹配原订单和 invoice 后才保存 Payment ID 并继续处理。自动轮询只查已知 remote ID；用户刷新有节流。过期的是新付款入口，迟到但已验证的付款仍可入账。
- 日志只记录事件类型和不含凭据的关联 ID；反向代理不记录包含 checkout capability 的 URL。数据库含订单及收银台 URL，按支付数据权限备份保管，勿传 Git。告警建议覆盖 `creation_unknown`、`newapi_notify_retry`、`reconcile_failed` 和非充值事件。凭据校验错误不打印原始第三方响应。
- 维护命令的订单参数也接受 New API 订单号（`USR…`），日志使用这个原订单号而非付款页的随机访问凭证。不要把付款页地址当成公开客服链接传播。
- **本版不自动处理退款、争议、拒付、部分退款或税务开票。** 必须在商户后台核对实际收退款，再按 New API 现有账务流程调整并记录来源；不要把 webhook 成功充值反向改写成未经设计的自动扣余额。财务报表应区分真实收款、赠额、内部授信。
- 不采集银行卡号/CVV；用户进入供应商托管收银台。桥接不持有 New API root 凭据，也不直接写 New API 用户表。

## 验证与来源

`node --test tests/*.test.mjs` 覆盖真实 SQLite 新建/重复启动、报价快照、RSA/MD5、HMAC/RSA、商户/金额/币种/订单校验、少付/重放、持久化投递、失去回执、未知下单结果恢复、CSRF、页面回跳不可入账和配置隔离。`node test-browser.mjs` 使用 Playwright + Chromium，覆盖俄/英切换、键盘、手机布局、真实表单跳转及付款状态；供应商网络在边界替换，不产生真实交易。

本桥接仅支持 SQLite；不修改 New API 的数据库行为，原有 SQLite/MySQL/PostgreSQL 支持不被本组件替换。CI 额外运行现有 New API 易支付签名和入账回归，验证对接协议。真实双实例、供应商开户、沙箱/小额收款与目标服务器验收仍需部署阶段完成。

官方协议核对日期：2026-11-23。

- [连连 API](https://global.lianlianpay.com/docs/api_docs#op-createOrder)、[查单](https://global.lianlianpay.com/docs/api_docs#op-queryOrder)、[认证/签名/幂等指南](https://global.lianlianpay.com/docs/guide/getting_started)（文档 1.0.0，生效 2026-09-09）。
- [NOWPayments 官方 Postman 文档](https://documenter.getpostman.com/view/7907941/S1a32n38)。
- [PayPal Orders v2](https://developer.paypal.com/docs/api/orders/v2/)、[官方 API schemas](https://github.com/paypal/paypal-rest-api-specifications)。
- 对接版本：Shiny `new-api/go.mod` 使用 `github.com/Calcium-Ion/go-epay v0.0.6`；RSA submit 路径 `/api/pay/submit`，MD5 `/submit.php`，RSA timestamp 为秒，连连 timestamp 为毫秒。
- 已参考 [OWASP 支付集成](https://cheatsheetseries.owasp.org/cheatsheets/Third_Party_Payment_Gateway_Integration_Cheat_Sheet.html)、[认证](https://cheatsheetseries.owasp.org/cheatsheets/Authentication_Cheat_Sheet.html)、[会话](https://cheatsheetseries.owasp.org/cheatsheets/Session_Management_Cheat_Sheet.html)。控制包括服务端验签/查单、固定回调、凭据只存服务端、POST+CSRF、原子持久化和有限请求体；未作完整 ASVS 合规认证声明。
