# RU 商业门户候选部署

此目录是待验收的配置模板，不会自动操作生产。开发分支包含门户、独立 RU 实例配置及 `new-api/` 原生国际支付；国内主站可继续使用原 release，RU 单独构建和验收。

## 架构

```text
客户浏览器 → ru.shinyapi.com/            → 静态 portal-ru
           → ru.shinyapi.com/api/*      → RU New API :3001 → RU 数据库
客户 SDK  → ru.shinyapi.com/v1/*        → RU New API :3001
                                             ↓ 内部专用上游 Key
                                      主站 New API :3000
                                             ↓ 已有渠道
                                         模型服务
```

初期两个域名都指向现有服务器，Nginx 按域名分发。新增前端本身不处理推理负载；RU Go 实例承担鉴权、扣费、日志和流式转发，确实有 CPU/内存/连接开销，并非“纯静态前端实现独立账务”。不需要再维护一份 New API 源码，也不要求新购大服务器。

若以后把静态站点放到另一台机器，可使用 CDN/路径分流，账户与模型请求仍回到主服务器的 RU 实例；不要把模型流量无意中绕经小型门户服务器。若要求两个站点的独立 Key 都使用完全相同的 `shinyapi.com/v1`，需另做可验证的 Key 路由网关，本分支不包含该功能。主站原有 Key 和地址保持原样。

## 两层 Key 与单价格组

1. 主站创建**内部 RU 服务账号**及专用 API Key，不使用超级管理员会话或个人 Key。可按主站的 GPT、Claude、Gemini 等分组分别创建受限 Key，限制允许模型、额度和来源。
2. RU 实例建立对应上游渠道，统一放入 RU 的 `default` 组。base URL 使用实际主站内部监听地址（模板假设 `http://127.0.0.1:3000`，不含 `/v1`），填入对应内部 Key。不能填 `ru.shinyapi.com`，否则形成回环。不要盲目照搬端口，先核验服务器现有监听。
3. 可使用 New API 类型渠道（type 60）承接主站，明确填写可用模型/别名。本地真实双实例已验证 Chat、Anthropic Messages、Gemini、Responses、图像和 SSE 的双跳扣费；异步任务、音频、Realtime/WebSocket 及实际上游仍须逐类验收，未通过的模型不发布到 RU 目录。渠道设置中如有 SSRF/代理限制，只对实际内部目的地址按需配置，不全局关闭检查。
4. RU `GroupRatio`、可用组映射、自动选组和新注册用户默认组只暴露 `default`；去掉 RU 实例默认可能附带的 VIP/SVIP 等其他组。匿名 `GET /api/pricing` 的 `usable_group` 必须恰为 `{"default": "..."}`，`group_ratio` 仅含该组。用户 Key 不能选择其他组。
5. RU 使用自己的模型价格/表达式/缓存规则及结算币种。客户只创建 RU Key；RU Key 仅存在于 RU 数据库。其请求被 RU 验证后，使用后台专用内部 Key 调用主站，**无需客户串联两个 Key**。内部 Key 不进入门户代码、浏览器或 Git。

RU 保存客户充值、余额、消费和请求日志；主站保存内部服务账号的消耗。两层都会记录/扣除各自的额度，因此内部额度应有独立告警和充值策略。内部授信/成本不作为第二笔零售现金收入。优惠、赠送额度、真实收款和可退款金额按现有规则分别记录。RU 价格应覆盖主站成本；成本同步/调价是运营配置，本分支没有自动同步公式。

## RU 默认配置与内部容量

本分支通过 `SHINY_SITE_PROFILE=ru` 为**新建独立数据库**写入缺少的配置：单 `default` 价格组、无额外组或跨组倍率、USD 额度显示、匿名价格页、RU 重试为 0、新注册/邀请赠额为 0、余额提醒开启。已有数据库的管理员配置不会覆盖；从旧实例克隆配置后必须手动去掉国内多组规则，再运行检查工具。控制台首次访问默认俄语，保留用户已选语言；API 错误、邮件和提醒通过 `DEFAULT_LANGUAGE=ru` 使用俄语。

主站的内部账号受普通用户并发上限约束。多个 Key 仍共用该账号的额度/并发，不能通过多建 Key 提高容量。本分支新增 `ModelRequestConcurrencyUserOverrides`，在主站 `/system-settings/security/rate-limit` 设置，例如 `{"42":20}` 给 ID 42 的普通内部账号设置 20 并发，其他普通用户保持原上限；主站全局上限继续生效。RU 顾客上限在 RU 的同一页配置。

**主站必须先安装包含此功能的候选二进制，用户并发覆盖才会生效。** 国内主站暂不升级时，继续按旧版普通用户上限规划内部容量，不能声称新配置已生效。先保留主站现有稳定 release，在候选环境验证兼容性后再决定是否更新。主站全局并发要给国内业务留余量；内部账号余额/Key 限额/有效期/模型白名单/来源限制也必须同时覆盖 RU 销售容量。

将 RU 重试保持为 0，失败切换由主站负责，避免两个实例重试相乘。内部账号欠费或上游失败会按既有流程退还 RU 预扣，客户端取消沿两层传播；实际取消账单仍按完成用量和现有预扣规则处理，不能承诺取消一律免费。两层日志用 RU 的 `upstream_request_id` 与主站 `request_id` 对应。

## 候选安装顺序

1. 从商业分支构建门户，`node --test tests/*.test.mjs`、`node build.mjs`（需要 Bun）。RU 默认配置、俄语后台和原生支付须构建本分支的控制台及 Go 二进制。用 **Shiny fork** 的已核验不可变 release 运行第二个 New API 进程，RU 的服务路径与升级策略独立。主站并发覆盖的更新条件见上文。
2. 在现有 PostgreSQL 新建专用 `shiny_ru` 数据库和最小权限账号；不使用主站数据库、日志库、表前缀或数据库账号。配置独立备份。独立 Unix 用户 `shiny-ru`，独立数据/日志目录；实例只监听 `127.0.0.1:3001`。
3. 将 `newapi.env.example` 复制到服务器私有目录，替换数据库密码、独立随机 `SESSION_SECRET` 和 `CRYPTO_SECRET`。核验 `SESSION_COOKIE_SECURE`、精确 HTTPS Origin、代理地址。单进程起步不共享主站 Redis；需要 Redis 时使用隔离实例及 ACL。不要同步主站浏览器 Cookie、会话或 root 账号。
4. 审阅 systemd 模板的 release 路径、用户名与日志目录。首次初始化在受限候选虚拟主机中完成，创建 RU 管理员后再开放注册；上线前确认 `/api/setup` 不再允许初始化。不要先公开未初始化实例。
5. 门户发布到 `/srv/shiny/ru-portal/releases/<commit>/`；将其中 `ru-assets/` 合并到 `/srv/shiny/ru-portal/shared/ru-assets/`；`current` 指向该 HTML release。保留旧摘要资产。采用本机现有发布工具，不把构建目录覆盖到国内门户。
6. 配置 `ru.shinyapi.com` DNS/证书，审阅 Nginx 模板并运行 `nginx -t` 后仅加载新虚拟主机。`/api/*`、控制台、支付回调及 `/v1/*` 全部到 RU 实例。禁止缓存账户接口或推理响应。Cloudflare 若启用，沿用服务器已审计的真实 IP 配置；避免信任客户端伪造的转发头。
7. 关闭候选站搜索索引（候选 Nginx 增加 `X-Robots-Tag: noindex, nofollow`），在限制访问的候选域名做下述验收。候选域名改变时同时修改公开配置、可信 Origin、邮件链接、支付回调及 Turnstile 域名。验收后由维护者决定是否合并和上线。

这些步骤涉及真实运行环境，不由本分支自动执行；提供模板不表示服务或支付已开通。

## 邮箱与支付

- 可以共用已验证的 `shinyapi.com` 发信域名及邮件供应商；**RU 实例要单独填自己的 SMTP/发信设置、品牌、站点 URL**，可使用 `no-reply@shinyapi.com` 或专用地址。需要辨别“CF 邮箱”：Cloudflare Email Routing 是收信转发，不等于 SMTP 发信服务；若主站使用 Worker/其他发信服务，需核验它允许 RU 站点链接及发件人。
- Cloudflare Turnstile 是另一项配置；现有 site key 若未授权 `ru.shinyapi.com`，需添加域名或新建独立 key，并填入 RU 实例。验收注册、重置密码、链接域名和验证码。
- 门户支持 RU/EN，RU 默认控制台和事务邮件已加入本分支；模板 `DEFAULT_LANGUAGE=ru`。邮件供应商、模板链接、品牌及注册/重置流程仍须在候选环境实际收信验收。
- 推荐 [原生国际支付](payment-native.md)：在 RU `/system-settings/billing/international-payments` 分别配置 cisPay、NOWPayments、连连全球收单、PayPal 和 ZPAY，默认关闭。[支付模块分组](../payments/README.md) 提供按需组合；模板 `PAYMENTS_PROVIDERS=none` 先关闭新充值，开户后再选择已批准渠道。通知直接到 RU New API，不需要新增支付服务或子域名；需使用本分支构建的候选二进制。原有 Stripe/Creem/Waffo/易支付等继续独立配置，不受新清单控制。不能升级 New API 时才考虑可选 [payment-bridge](../../payment-bridge/README.md)；两种模式不要重复开放同一个支付商。
- `/user-agreement`、`/privacy-policy` 复用 RU 控制台，运营方须配置本服务实际条款、支持联系方式及隐私说明后开放收款。

## 必做候选验收

| 场景 | 通过条件 |
| --- | --- |
| 同名/同邮箱在两站注册 | 按各站规则独立，RU 登录无法取得主站账户/余额 |
| 主站 Key 请求 RU，RU Key 请求主站 | 均拒绝，不跨实例识别；内部专用 Key 不暴露 |
| RU 充值/赠送/退款 | 只改变 RU 用户数据；现金、赠额、可退款来源分开 |
| 双跳请求、流式、取消、失败重试 | RU 客户和主站内部账号日志/扣费可对应；无双扣、跨户日志、无限回环 |
| RU 单组价格 | 匿名/登录后目录与实际扣费相符，精确表达式和缓存/阶梯条件正确 |
| 内部账号欠费或某主站分组故障 | 客户收到明确失败，错误请求按现有账务规则处理，不泄漏内部凭据 |
| 邮件/Turnstile/支付回调 | 域名指向 RU；签名、重放、重复 webhook、失败/取消正确处理 |
| 控制台路径和静态资源 | `/models` 管理页、`/pricing`、刷新后路由、SSE/WS 不被门户覆盖 |
| 性能与回滚 | 在目标并发下观察 RU 进程及主站连接/CPU/内存；停止 RU 不影响国内站 |

浏览器回归使用静态门户和模拟 API 合约；本轮另有真实本地双实例及三数据库验收，详细范围见 [验证记录](VALIDATION.md)。这些检查不能替代实际上游、商户小额付款和目标服务器压测。回滚只切换 RU 门户 release/停止 RU 新服务与虚拟主机；已有 RU 数据库继续保留并备份，不删除主站或 RU 用户数据。

## 只读候选检查

`readiness.py` 使用 Python 标准库，通过 GET 检查 RU 单组实际配置、公开价格/登录后的倍率、USD 换算、渠道目的地、主站内部账户余额和并发。凭据通过进程环境 `SHINY_RU_ADMIN_ACCESS_TOKEN` / `SHINY_MAIN_ADMIN_ACCESS_TOKEN` 提供，使用有相应只读管理权限的访问令牌；不是模型调用 Key。工具不输出令牌、DSN 或支付凭据，拒绝管理请求跳转、非本机 HTTP 管理地址。`--main-url` 使用 RU 渠道实际填写的主站 origin，不带 `/v1`。

```sh
python ops/ru/readiness.py \
  --ru-url https://ru.shinyapi.com \
  --main-url http://127.0.0.1:3000 \
  --ru-env /etc/shiny/ru-newapi.env \
  --main-env /etc/shiny/main-newapi.env \
  --service-user 42 --target-concurrency 20 --domestic-headroom 12 \
  --min-internal-usd 100
```

可重复 `--service-user` 检查所有内部账户，参数只是示例目标，不是性能承诺。应在可连接两个内部 origin、能读取私有配置的候选机器运行。SQL/Redis 的用户名或密码不同不能证明数据隔离；工具比较已识别的主机/端口/数据库，无法识别的连接以及 DNS 别名、代理和挂载仍列为人工核验。输出 `configuration_passed` 仅表示可自动核查的配置通过；`deployment_accepted` 始终为 false，实际渠道成本、商户支付、并发压测和俄区网络需继续验收。

本地双实例回归：先构建控制台及候选 Go 文件，再执行 `python ops/ru/tests/two_instance.py --binary <候选二进制绝对路径>`。脚本生成独立临时数据库与合成上游，不使用生产渠道/商户/Key；结束后关闭自身进程并清理临时文件。结果及尚未验证范围见 [验证记录](VALIDATION.md)。
