# RU 商业门户候选部署

此目录是待验收的配置模板，不会自动操作生产。开发分支包含门户、独立 RU 实例配置及 `new-api/` 原生国际支付；国内主站可继续使用原 release，RU 单独构建和验收。

## 给部署项目的读取说明

当前 RU 一键创建 Key 的实际部署和回滚信息见
[2026-11-27 发布记录](releases/2026-11-27-universal-keys.md)。本节的较早功能基线
保留为历史交接记录；升级应固定实际要发布的源码，不能将旧基线当作当前版本。
当前俄语模型元数据与控制台语言修复的线上版本、验证及回滚见
[俄语修复发布记录](releases/2026-11-27-russian-metadata.md)。

读取 [Shiny 商业分支](https://github.com/Angel-Gril/Shiny/tree/commercial/ru-portal)，不要只读取 `main`。已验证的功能基线是 `8d166676f70163930ce4d8efc9080e5d2fdce4a3`，本轮补充的是部署交接文档，未修改程序或生产配置。该功能基线的门户、原生支付及源码工作流均通过，见 [验证记录](VALIDATION.md)；后续有代码变更时重新固定提交并验证。

| 读取位置 | 用途 |
| --- | --- |
| 本文件 | 同机架构、部署顺序、独立配置与验收边界 |
| [newapi.env.example](newapi.env.example)、[systemd 模板](shiny-ru-newapi.service.example)、[Nginx 模板](nginx.conf.example) | 候选环境模板，端口、路径和凭据占位符必须按实际服务器替换 |
| [payment-native.md](payment-native.md)、[支付模块清单](../payments/README.md) | 原生支付选择、商户配置、旧单处理及回滚限制 |
| [readiness.py](readiness.py)、[VALIDATION.md](VALIDATION.md) | 只读配置检查、已完成的测试与未完成的实际验收 |
| `portal-ru/`、`new-api/` | 分别构建静态门户和 RU 控制台/Go 服务；不能只复制前端实现独立账务 |

本次交接供接手项目读取 Git 并分析部署。先核对实际服务器的进程、监听、容器网络、数据库、Nginx/CDN 和可用资源，形成具体候选部署方案；不要在国内生产 checkout 中直接切换商业分支或用统一更新脚本替换主站 release。模板不会安装服务、修改 DNS 或启动收款；仓库内现有 GitHub 工作流只做检查、构建与上传 CI 产物，没有生产部署步骤。

2026-11-25 审查确认的三项边界必须保留：

- 数据库矩阵覆盖支付模块的新建/升级及重复迁移，尚未验证生产 `shiny-rc51-50f7591` 完整数据库到候选程序的启动升级。新建 RU 库可以进入候选测试；若要更新国内主站，另用 rc.51 创建的代表性独立库验证完整启动/重启、数据和约束保留，并在目标环境验证备份恢复。
- 本版没有未付款订单的取消/过期关单流程。暂停收款使用 `accept_new=false`，保留 enabled、原商户凭据及通知/查单能力；不能通过强改数据库状态清除 pending。正式增加关单功能时需按各支付商权威状态设计，并覆盖迟到付款、部分付款及创单结果未知。
- 当日核实 `main` 为 `00cd45f3d95a913e22e6891a2ce840f7abe1badb`，相对功能基线新增两个提交，只更新国内 V4 Pro 定价文件和发布记录。后续同步/合并需保留这些记录，并重新比较实际远端；它们不会自动更新 RU 售价。`ops/national-model-pricing.json` 的国内计价数值不能直接作为 RU 的 USD 售价导入。

## RU 模型元数据的语言

RU 控制台的「模型 → 同步上游」默认使用俄语；普通实例仍默认中文。
模型介绍、标签与供应商说明属于数据库元数据，不会随个人界面语言自动翻译。
本轮通过 RU 管理接口更新现有模型的介绍和标签，不修改模型名称、权限、渠道或价格。

上游 `basellm.github.io/llm-metadata` 目前没有俄语导出。俄语同步读取其英文接口，
再使用 `new-api/setting/ru_metadata.json` 中按精确模型名维护的俄文介绍与常用标签。
已覆盖当前 13 个已知模型；未知型号保留英文源说明，自定义标签保留原值。
新增模型需要审阅资料后补充词典，不能根据名称自动推断能力；
`codex-auto-review` 暂无可靠介绍，因此留空。同步预览会明确说明英文回退。
同步仍沿用原有字段选择、版本检查和事务，不自动改变状态、端点或计费。

同步 RU 数据库元数据后，已有控制台无需重新构建即可读取新介绍；
新增俄语同步选项及通用界面译文则需要构建并部署匹配源码的完整前端与 Go 程序。
国内主站不随 RU 发布更新。

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

同机可以复用 PostgreSQL 服务，RU 必须使用独立数据库和最小权限账号；两个应用进程、环境文件、release 路径、数据/日志目录和备份分别管理。现有 systemd 模板没有指定 CPU/内存硬限额，部署项目应根据实际余量配置 RU 资源和数据库连接上限，从低并发逐步验收。服务器故障、磁盘耗尽或共享资源耗尽仍可能影响两站。俄区子域名不会改变服务器所在地区，俄区可达性和延迟需从实际俄区网络测试。

图中 `127.0.0.1:3000/3001` 适用于同一主机网络上的进程。Docker 容器内的 `127.0.0.1` 指当前容器；容器部署须使用正确的私网服务地址/端口，并核对 Nginx 到 RU、RU 到主站两段连接，不能直接照抄本机地址。

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
7. 关闭候选站搜索索引（候选 Nginx 增加 `X-Robots-Tag: noindex, nofollow`），在限制访问的候选域名做下述验收。第一轮保持 `PAYMENTS_PROVIDERS=none`，RU 旧易支付/Stripe/套餐等入口也保持关闭；先完成注册、邮箱、Key、价格、日志和真实模型调用，再逐家联调已获准商户。候选域名改变时同时修改公开配置、可信 Origin、邮件链接、支付回调及 Turnstile 域名。验收后由维护者决定是否合并和上线。

这些步骤涉及真实运行环境，不由本分支自动执行；提供模板不表示服务或支付已开通。

## 邮箱与支付

- 可以共用已验证的 `shinyapi.com` 发信域名及邮件供应商；**RU 实例要单独填自己的 SMTP/发信设置、品牌、站点 URL**，可使用 `no-reply@shinyapi.com` 或专用地址。需要辨别“CF 邮箱”：Cloudflare Email Routing 是收信转发，不等于 SMTP 发信服务；若主站使用 Worker/其他发信服务，需核验它允许 RU 站点链接及发件人。
- Cloudflare Turnstile 是另一项配置；现有 site key 若未授权 `ru.shinyapi.com`，需添加域名或新建独立 key，并填入 RU 实例。验收注册、重置密码、链接域名和验证码。
- RU 控制台 Logo 可使用随前端构建的 `/static/ru-brand/mark-v1.svg`，在 RU 站点设置的 `Logo` 中填写该同源路径。该文件与原门户图标字节一致，由 RU release 提供，不再访问国内主域名；静态门户本身使用内联 SVG，不依赖此设置。保留旧静态资源回退。
- Turnstile 是 Cloudflare 的免费独立服务，不要求站点接入 CF CDN，但浏览器和服务端仍依赖 `challenges.cloudflare.com`。对主要面向俄罗斯用户的站点，先从实际运营商测试再决定全量启用，不能仅凭服务器出口可用就判定用户可用。官方 [2025-06-26 俄区网络报告](https://blog.cloudflare.com/russian-internet-users-are-unable-to-access-the-open-internet/) 是历史风险证据，不代表当前所有俄区网络均不可用。准备启用时建议新建只授权 RU 域名的 Managed widget；保留邮箱验证及服务端限流，验证失败不得自动绕过。配置入口为 `/system-settings/auth/bot-protection`；价格与限制见 [Cloudflare Plans](https://developers.cloudflare.com/turnstile/plans/)。
- 门户支持 RU/EN，RU 默认控制台和事务邮件已加入本分支；模板 `DEFAULT_LANGUAGE=ru`。邮件供应商、模板链接、品牌及注册/重置流程仍须在候选环境实际收信验收。
- 推荐 [原生国际支付](payment-native.md)：在 RU `/system-settings/billing/international-payments` 配置独立商户。当前预选为 **Creem、Waffo Pancake、TryBit（原 CryptoCloud）、NOWPayments、OxaPay、Apirone**；连连、PayPal、cisPay、ZPAY、Platega、FreeKassa、Lava.top 作为可选项，合计 13 个模块，全部默认不开放新付款。[支付模块分组](../payments/README.md) 和 [预选配置](../payments/preselected.env.example) 提供按需组合；完整 RU 模板先以 `PAYMENTS_PROVIDERS=none` 关闭新充值，开户后填写已批准的模块 ID，再在 RU 管理页填写凭据并打开 enabled/accept_new。通知直接到 RU New API，不需要新增支付服务或子域名；需使用本分支构建的候选二进制。
- 原生钱包使用 `creem_native`、`waffo_pancake_native`，与原有 Creem/Pancake 套餐或订阅设置分开；旧 Stripe/Creem/Waffo/易支付继续使用原配置，不受新清单控制。部署清单只控制新付款，移除模块后仍接收存量订单通知；有待支付订单时保留原商户、环境和凭据。不能升级 New API 时才考虑可选 [payment-bridge](../../payment-bridge/README.md)，两种模式不要重复开放同一个支付商。这里只完成协议接入，真实商户批准和小额支付仍须验收。
- `/user-agreement`、`/privacy-policy` 复用 RU 控制台，运营方须配置本服务实际条款、支持联系方式及隐私说明后开放收款。

## 与国内现有版本的功能对照

2026-11-25 通过主站匿名 `/api/status` 核实国内运行版本为 `shiny-rc51-50f7591`，邮箱验证、Turnstile、账号密码注册/登录、用户协议和隐私政策、USD 额度显示、用量导出均已开启；GitHub、Discord、OIDC、Telegram、LinuxDO 登录关闭。比对该部署 revision 的公开源文件，注册表单、协议勾选、Key 管理 API、用量日志 API、站点配置入口与本分支一致。主站内部设置与真实业务数据未读取；RU 尚未部署，不能把这些线上开关视为 RU 已配置。

| 部分 | RU 行为及部署配置位置 |
| --- | --- |
| 条款、隐私、勾选 | 按国内既有流程：正文由 RU `/system-settings/site/system-info` 的 `legal.user_agreement` / `legal.privacy_policy` 写入 RU 数据库，前端注册勾选；没有另加服务端协议版本或接受时间记录。空正文会隐藏对应勾选，应在实际用户测试前填写。Git 管理展示流程，实际运营正文部署后维护。`/legal/` 仍是开源归属页。 |
| 注册、登录、邮箱 | 同一套控制台流程、独立 RU 账户库和登录状态。`/system-settings/auth/basic-auth` 单独配置注册、密码登录、邮箱验证；要与国内一致需在 RU 开启邮箱验证。现有注册代码只有开启邮箱验证时才保存邮箱，关闭时用户需到个人资料绑定邮箱才能使用要求邮箱的付款方式。 |
| 发信、找回密码 | `/system-settings/operations/email` 填 RU SMTP/Resend、发件人及提醒；可共用已验证发信域名。`/system-settings/site/system-info` 的 `ServerAddress` 必须填 RU 的公开 origin，确保找回密码及支付返回仍在 RU。 |
| 俄区邮箱、机器人验证 | 如开启邮箱域名限制，在 `basic-auth` 白名单加入运营允许的 `mail.ru`、`yandex.ru` 等；默认不开限制。`/system-settings/auth/bot-protection` 填已授权 RU 域名的 Turnstile key，不能只复制国内开关。 |
| 第三方登录、Passkey | 与国内一样可以先关闭。开放时，在 `/system-settings/auth/oauth` 或 `custom-oauth` 配置 RU 应用/回调；GitHub/LinuxDO URL 依赖提供方应用注册的回调地址，复用仅登记主站的 client ID 会回主站。其他提供方也须允许 RU `/oauth/<provider>`。`/system-settings/auth/passkey` 配 RU RP ID/origin；不复制国内凭据或会话。 |
| Key、余额、用量 | 控制台的创建/限制/撤销 Key、钱包历史、日志筛选与导出沿用现有实现，请求为同源 `/api/*`。独立实例/数据库隔离数据；门户页面本身不实现隔离。后台内部上游 Key 不进入客户页面。日志保存/导出规则在 `/system-settings/operations/logs` 配。 |
| 模型与价格 | RU 仅公开 `default`，国内分组规则保留在主站。RU `/system-settings/billing/model-pricing`、`group-pricing`、`currency` 分别配置售价/倍率/USD。单组缺省值已提供，实际销售模型和商业价格需运营填写；不会自动复制或同步主站。门户 `/catalog/` 与控制台 `/pricing` 都读取 RU。 |
| 收款与入账 | `/system-settings/billing/international-payments` 管理独立 RU 商户、币种、报价、通知与待支付核查。部署允许清单和后台 enabled/accept_new 都需开启；默认不收款。支付商页面返回不等于到账，入账仍由已校验通知/查单确认。未实现自动退款/拒付扣回，不能把人工核查表描述成退款系统。 |
| 首页、导航、文档 | 自定义 RU/EN 门户和同源控制台导航，不跳国内控制台。`general_setting.docs_link` 填 `https://ru.shinyapi.com/docs/`。`SystemName` / Logo / Footer 影响控制台；`HomePageContent` 不修改静态门户首页，门户版面文案仍在 `portal-ru/` 修改后构建发布。 |
| 状态广场与客服 | 历史统计来自 RU 的模型请求；`/system-settings/operations/alerts` 管理统计采集。没有历史样本不等于模型不可用。真实客服联系方式、运营主体、退款时效仍需填入 RU 协议/公告；本分支没有编造客服账号。 |

此轮认证相关对照采用 OWASP [Authentication Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Authentication_Cheat_Sheet.html)、[Session Management Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Session_Management_Cheat_Sheet.html) 的实例边界、精确 Origin、服务器鉴权和非秘密语言存储要求。真实双实例验证跨站会话/Key 拒绝、独立协议及日志；未修改认证实现，也未进行全量 ASVS 5.0 认证审计或实际 OAuth/邮件收信验收。

## 必做候选验收

### RU 一键创建 API Key（候选）

`SHINY_SITE_PROFILE=ru` 且后端 `/api/status` 声明 `ru_universal_keys=true` 时，
“创建 API Key”直接创建并显示复制弹窗，不要求先选分组或模型。默认 Key 继承
账户所在分组、不保存模型白名单、无独立额度上限、不过期；仍受账户余额、
账户权限、站点并发/频率限制和管理员发布的可用模型约束。可在创建结果或列表
中编辑名称、有效期、额度、模型和 IP 限制。API 地址与密钥可分别复制。

这不是所有管理员分组的通行证：本部署的 `default` 统一承载 RU 对外模型，同组
各平台模型和之后新上架模型自动可用；其他组的私有模型不因此开放。本改动不写
`UserUsableGroups`、`AutoGroups`、分组倍率或渠道配置，也不修改现有 Key。
若运营以后将可售模型分散到多个组，需要单独设计账户级路由，不能只凭“通用”
名称推断跨组权限。普通站点继续使用原创建表单；旧 RU 后端没有能力标识时也回退
表单，避免只升级前端便提交旧版不认识的创建参数。

服务器接口 `POST /api/token/` 接受 `{"preset":"ru_universal","name":"..."}`，
由后端限制 RU 配置并规范化上述默认值，仍使用原 UserAuth、操作审计、生成随机
密钥及数量限制。创建响应仅返回脱敏记录；完整密钥继续走原属主校验的
`POST /api/token/:id/key`，不进入持久化浏览器存储。创建失败不自动重试；
获取或复制失败可重试读取已建 Key，不需重新创建。

本功能先提交商业功能分支和候选 PR，不自动更新 RU 或国内生产。上线前必须
一起构建该商业源码的 Go 程序和控制台资源，并在隔离候选验证创建、模型发现、
多模型请求、账户边界、原 Key 编辑及移动端。不要用 main 的独立二开产物覆盖 RU。

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

`readiness.py` 使用 Python 标准库，通过 GET 检查 RU 默认语言、公开站点地址、非空协议/隐私、单组实际配置、公开价格/登录后的倍率、USD 换算、渠道目的地、主站内部账户余额和并发。协议检查只核对正文及启用状态，不判断文本法律效力，不要求服务端协议接受记录。凭据通过进程环境 `SHINY_RU_ADMIN_ACCESS_TOKEN` / `SHINY_MAIN_ADMIN_ACCESS_TOKEN` 提供，使用有相应只读管理权限的访问令牌；不是模型调用 Key。工具不输出令牌、DSN 或支付凭据，拒绝管理请求跳转、非本机 HTTP 管理地址。`--main-url` 使用 RU 渠道实际填写的主站 origin，不带 `/v1`。

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

若 `--ru-url` 为 `http://127.0.0.1:3001` 等内部管理地址，另传 `--ru-public-url https://ru.shinyapi.com`；站点地址将与后者比较。候选域名变化时使用实际候选公开 origin，避免把正确公开地址误判为错误。这个比较读取配置，不探测尚未部署的 DNS/TLS。

本地双实例回归：先构建控制台及候选 Go 文件，再执行 `python ops/ru/tests/two_instance.py --binary <候选二进制绝对路径>`。脚本生成独立临时数据库与合成上游，不使用生产渠道/商户/Key；结束后关闭自身进程并清理临时文件。结果及尚未验证范围见 [验证记录](VALIDATION.md)。
