# 可选支付模块

支付模块在商业分支 `commercial/ru-portal` 内单独归组：这里保存供应商清单与部署组合，原生实现位于 `new-api/service/payment_*.go`，管理入口为 `/system-settings/billing/payment`。功能范围是托管收银台钱包充值，包括创建订单、通知验证、官方查单、金额与商户核对、一次入账、待支付告警及人工/定时查单恢复。

RU New API 直接对接支付商，收银台由支付商提供。无需搭建第三方支付平台、额外支付服务或 `pay-ru` 子域名。RU 账户、订单、余额和日志使用独立数据库；模型渠道仍可通过服务器内专用 Key 使用主站。参见 [RU 架构](../ru/README.md) 和 [各支付商配置](../ru/payment-native.md)。

## 统一设置入口（独立开发分支）

`feat/unified-payment-settings` 从 `commercial/ru-portal` 的 `c0eae777` 增量开发，只整合控制台入口，不代表已合并或部署。进入「计费与支付 → 支付设置」，从商户选择器选渠道；Creem、Waffo Pancake 各显示一次，可选择「钱包充值」或「原有接入」。新钱包充值使用本页的独立保存、待支付核查和恢复；原有接入继续支持原钱包/套餐及订阅流程。共用的支付确认和原有充值选项在「常规」，新增自动核对在「支付核对」。

旧 `/system-settings/billing/international-payments` 书签会跳到统一页面。切换视图不保存、不启停支付、不复制商户秘密；未保存草稿在当前页面内切换后保留，离开或刷新页面不保证保留。页面顶部「保存原有接入设置」只保存原有接入的所有草稿；「保存支付接入」只保存当前新增钱包商户，「保存支付核对设置」只保存核查参数。

两个底层处理器及 webhook 继续兼容，配置仍独立：Pancake 原有 `/api/waffo-pancake/webhook/prod` 对应原有接入，新钱包 `/api/payments/waffo_pancake_native/webhook/live` 对应钱包充值。不要把一个接入的回调填写到另一个接入，也不要同时为同一商户的同种付款方式开放两个充值入口。`PAYMENTS_PROVIDERS` 仍只控制新增钱包接入；关闭所有收款还需核对原有接入。

## 协议与适用组合

| 模块名 | 官方协议 | 当前充值接入 | 部署选择 |
| --- | --- | --- | --- |
| `creem_native` | REST v1、`x-api-key`、原始回调 HMAC-SHA256、Checkout 查单 | 单次商品、自定义含税价格，服务端核对商品/顾客/付款金额 | `mor.env.example` |
| `waffo_pancake_native` | REST RSA-SHA256、GraphQL 查单、平台 RSA 回调 | 单次购买、俄语收银台、含税报价；Session/Order/Payment 分开保存和验证 | `mor.env.example` |
| `cryptocloud`（TryBit） | REST v2、`Authorization: Token`、带过期时间的 HS256 JWT 通知 | USD 原始报价与足额币款核对；显式选择 TryBit 或旧 CryptoCloud API | `crypto.env.example` |
| `oxapay` | REST v1、`merchant_api_key`、原始回调 HMAC-SHA512 | 托管 Invoice，明确 sandbox，零欠付容忍且到账确认后入账 | `crypto.env.example` |
| `apirone` | REST v2、账户 JWT、每单回调令牌、私有 Invoice 查单 | 保存实时币价和精确最小单位报价，`completed` 且足额确认后入账 | `crypto.env.example` |
| `cispay` | Merchant REST API，`X-Shop-ID` / `X-Api-Key`，原始通知 HMAC-SHA256 | RUB 卡/SBP、Shop 已启用的 CRYPTO；核对原报价，正式创单 | `ru-local.env.example` |
| `nowpayments` | Invoice REST API，API Key，排序 JSON 的 IPN HMAC-SHA512 | USD 报价，托管币/网络选择，完成且足额后入账 | `crypto.env.example` |
| `platega` | REST、`X-MerchantId` / `X-Secret`、通知凭据及权威查单 | RUB，托管页或已开通的固定支付方式，`CONFIRMED` 后入账 | `ru-local.env.example` |
| `freekassa` | REST 排序值 HMAC-SHA256、跨进程递增 nonce；SCI MD5 回调 | RUB，独立 API Key/Secret Word 2，查单匹配后入账 | `ru-local.env.example` |
| `lava` | REST v3 创单/v1 查单、`X-Api-Key`；独立 webhook 服务 Key | 已批准的 API 自定义价格 Offer，核对收据/商品/顾客 | `ru-local.env.example` |
| `lianlian` | Open Platform v1 acquiring CHECKOUT，Bearer、HMAC/RSA | 已获批全球收单商户，响应与通知验签、权威查单 | `international.env.example` |
| `paypal` | Orders v2、OAuth2、官方 webhook 验签 | 商户/金额核对后幂等 capture，完成后入账 | `international.env.example` |
| `zpay` | 易支付兼容 MD5，multipart 创单、GET 回调 | CNY 支付宝/微信 `payurl` 托管跳转、验签后查单 | `zpay.env.example` |

[providers.json](providers.json) 记录全部 13 个原生模块、环境和官方文档地址。当前预选为 **Creem、Waffo Pancake**，以及 **TryBit、NOWPayments、OxaPay、Apirone**；[preselected.env.example](preselected.env.example) 提供这六家的合并组合。组合只允许配置，不自动开放收款。

New API 原有 Stripe、Creem 套餐/订阅、Waffo、Waffo Pancake 套餐/订阅、易支付仍使用各自配置页，**不受 `PAYMENTS_PROVIDERS` 控制**。新增钱包适配器使用 `creem_native`、`waffo_pancake_native`，不会覆盖旧的 `creem`、`waffo_pancake`。关闭旧入口须在对应页面操作；同一商户相同支付方式避免通过两套入口同时售卖。

Creem/Pancake 是带商品、订单与税务约束的国际托管结账接入，开通 API 不表示模型 API 钱包充值或俄罗斯付款人已获准。加密支付商分别核实主体、币/网络、最低金额和费用。连连需要明确的 acquiring CHECKOUT 权限，资料审核通知不能作为充值成功通知。PayPal 用于平台允许的地区，不作为俄罗斯本地付款的默认方案。

## 按需启用

一次构建包含全部原生适配器，部署时只启用所需渠道。关闭的模块不会创建支付请求或运行额外进程；无需为了省服务器资源分别编译。单独从 Git 复制某个 Go 文件不能形成完整接入，订单、路由、钱包和数据库需要使用同一版本。

在 RU 服务的**完整环境文件**中合并一种组合，例如：

```dotenv
PAYMENTS_ENVIRONMENT=live
PAYMENTS_PROVIDERS=creem_native,waffo_pancake_native,cryptocloud,nowpayments,oxapay,apirone
```

`PAYMENTS_PROVIDERS` 支持表内 13 个模块名的任意组合，例如仅启用 Creem 和 OxaPay：`creem_native,oxapay`。未设置时全部可供配置，但每个商户默认仍关闭。`none` 停止全部原生新充值；空值或未知模块名导致启动失败，避免拼写错误后意外开放渠道。不要使用只有两行的组合文件覆盖数据库、会话等完整配置。

环境变量只是服务器允许的渠道清单。超级管理员还要在国际支付页填写商户凭据、币种、单价和收银台域名，并开启「启用支付接入」与「接受新付款」。保存后钱包显示按钮；无需另填易支付 `PayMethods`。更改部署清单需要重启 **RU 服务**；更改页面商户配置不需要重新构建。

撤下渠道时先关闭「接受新付款」，再从部署清单移除。保留「启用支付接入」、原商户凭据及 webhook，以便存量订单继续验签、查单和入账。清单选择仅限制新创单，不中断旧单；管理员仍可访问已移除渠道的回调配置和恢复表单。更换商户/环境或彻底禁用前，必须处理 pending 订单。

沙箱用独立域名、实例、商户凭据和数据库，设置 `PAYMENTS_ENVIRONMENT=test`。Creem/Pancake、PayPal/连连、TryBit/OxaPay 支持本适配器的沙箱创单；具体账号权限仍须供应商确认。cisPay 官方文档只说明商户后台创建沙箱交易，本适配器不虚构 API 沙箱开关，测试实例禁止线上创建充值。后台沙箱交易须能够对应已有测试订单才能恢复，本版不提供后台订单导入。NOWPayments、ZPAY、Platega、FreeKassa、Lava.top、Apirone 本适配器只实现 live；管理页也限制相应环境。

## 拉取与构建候选版本

在独立工作目录拉取商业分支；以下命令只准备候选源码和构建产物，不安装服务或更新国内主站：

```bash
git clone --single-branch --branch commercial/ru-portal https://github.com/Angel-Gril/Shiny.git shiny-ru-candidate
cd shiny-ru-candidate
git rev-parse HEAD
cd new-api/web
bun install --frozen-lockfile
bun run typecheck
bun run build
cd ..
mkdir -p candidate
CGO_ENABLED=0 GOWORK=off go build -o candidate/new-api .
```

也可从仓库根目录执行 `docker build -f new-api/Dockerfile -t shiny-ru-newapi:candidate new-api`。Dockerfile 构建控制台和 Go 服务，镜像标签只用于候选验收。固定已通过 CI 的 commit 和构建产物摘要，按照 [RU 候选部署顺序](../ru/README.md) 发布独立 release；国内主站保留原 release。

已有本地 checkout 时先提交或保留工作区变更，使用 `git fetch origin commercial/ru-portal`、`git switch commercial/ru-portal`、`git pull --ff-only origin commercial/ru-portal` 获取更新。不要用强制 reset 丢弃服务器私有文件或修改；私有环境文件应放在仓库外。

## 验收边界

自动化验证入口为 [native-payments.yml](../../.github/workflows/native-payments.yml)，覆盖协议失败、通知重试、单次入账、SQLite/MySQL/PostgreSQL 新建与升级及独立日志库，还有钱包/管理页、类型检查、lint 和构建。

上线前用获准商户完成供应商联调和小额真实支付，并验证 RU 网络、回调可达及两站账户隔离。自动核对任务默认关闭，使用已有数据库租约按批次调用官方查单，不增加独立支付进程。本模块不包含商户开户、订阅自动扣款、自动退款/拒付、提现结算或独立链上监听器。已支付订单的退款继续使用实际收退款记录和已有账务流程。

Apirone 的逐单回调 URL 含令牌，不应出现在代理/CDN 日志中。[RU Nginx 模板](../ru/nginx.conf.example) 对 `/api/payments/` 关闭访问日志和可能带完整 URI 的错误日志，应用保留脱敏状态/订单诊断；使用其他代理时同样设置，并禁止记录原始通知体、签名、收银台令牌和商户凭据。
