# RU 商业门户候选部署

此目录是待验收的配置模板，不会自动操作生产。开发分支新增门户、独立实例和可选支付组件配置，保持 `new-api/`、`portal/`、主站渠道和账务代码不变。

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
3. 以可验证的 OpenAI 兼容渠道开始，明确填写可用模型/别名。Anthropic/Gemini 原生协议、Responses、图像/异步任务、音频和 Realtime 逐类测试其双跳兼容性，未通过的模型不发布到 RU 目录。渠道设置中如有 SSRF/代理限制，只对实际内部目的地址按需配置，不全局关闭检查。
4. RU `GroupRatio`、可用组映射、自动选组和新注册用户默认组只暴露 `default`；去掉 RU 实例默认可能附带的 VIP/SVIP 等其他组。匿名 `GET /api/pricing` 的 `usable_group` 必须恰为 `{"default": "..."}`，`group_ratio` 仅含该组。用户 Key 不能选择其他组。
5. RU 使用自己的模型价格/表达式/缓存规则及结算币种。客户只创建 RU Key；RU Key 仅存在于 RU 数据库。其请求被 RU 验证后，使用后台专用内部 Key 调用主站，**无需客户串联两个 Key**。内部 Key 不进入门户代码、浏览器或 Git。

RU 保存客户充值、余额、消费和请求日志；主站保存内部服务账号的消耗。两层都会记录/扣除各自的额度，因此内部额度应有独立告警和充值策略。内部授信/成本不作为第二笔零售现金收入。优惠、赠送额度、真实收款和可退款金额按现有规则分别记录。RU 价格应覆盖主站成本；成本同步/调价是运营配置，本分支没有自动同步公式。

## 候选安装顺序

1. 从商业分支构建门户，`node --test tests/*.test.mjs`、`node build.mjs`。用现有 **Shiny fork** 的已核验不可变 release 运行第二个 New API 进程，切勿换成官方最新镜像。主站和 RU 可用同一个已验证二进制文件，但服务路径与升级策略独立。
2. 在现有 PostgreSQL 新建专用 `shiny_ru` 数据库和最小权限账号；不使用主站数据库、日志库、表前缀或数据库账号。配置独立备份。独立 Unix 用户 `shiny-ru`，独立数据/日志目录；实例只监听 `127.0.0.1:3001`。
3. 将 `newapi.env.example` 复制到服务器私有目录，替换数据库密码和独立随机 `SESSION_SECRET`。核验 `SESSION_COOKIE_SECURE`、精确 HTTPS Origin、代理地址。单进程起步不共享主站 Redis；需要 Redis 时使用隔离实例及 ACL。不要同步主站浏览器 Cookie、会话或 root 账号。
4. 审阅 systemd 模板的 release 路径、用户名与日志目录。首次初始化在受限候选虚拟主机中完成，创建 RU 管理员后再开放注册；上线前确认 `/api/setup` 不再允许初始化。不要先公开未初始化实例。
5. 门户发布到 `/srv/shiny/ru-portal/releases/<commit>/`；将其中 `ru-assets/` 合并到 `/srv/shiny/ru-portal/shared/ru-assets/`；`current` 指向该 HTML release。保留旧摘要资产。采用本机现有发布工具，不把构建目录覆盖到国内门户。
6. 配置 `ru.shinyapi.com` DNS/证书，审阅 Nginx 模板并运行 `nginx -t` 后仅加载新虚拟主机。`/api/*`、控制台、支付回调及 `/v1/*` 全部到 RU 实例。禁止缓存账户接口或推理响应。Cloudflare 若启用，沿用服务器已审计的真实 IP 配置；避免信任客户端伪造的转发头。
7. 关闭候选站搜索索引（候选 Nginx 增加 `X-Robots-Tag: noindex, nofollow`），在限制访问的候选域名做下述验收。候选域名改变时同时修改公开配置、可信 Origin、邮件链接、支付回调及 Turnstile 域名。验收后由维护者决定是否合并和上线。

这些步骤涉及真实运行环境，不由本分支自动执行；提供模板不表示服务或支付已开通。

## 邮箱与支付

- 可以共用已验证的 `shinyapi.com` 发信域名及邮件供应商；**RU 实例要单独填自己的 SMTP/发信设置、品牌、站点 URL**，可使用 `no-reply@shinyapi.com` 或专用地址。需要辨别“CF 邮箱”：Cloudflare Email Routing 是收信转发，不等于 SMTP 发信服务；若主站使用 Worker/其他发信服务，需核验它允许 RU 站点链接及发件人。
- Cloudflare Turnstile 是另一项配置；现有 site key 若未授权 `ru.shinyapi.com`，需添加域名或新建独立 key，并填入 RU 实例。验收注册、重置密码、链接域名和验证码。
- 当前网页已有俄语翻译；后端 `DEFAULT_LANGUAGE` 模板设为 `en`，因为当前支持的系统邮件语言为 en/zh-CN/zh-TW。俄语事务邮件是后续工作，不能仅改前端语言就声称已完成。
- 可选 [payment-bridge](../../payment-bridge/README.md) 提供 NOWPayments 加密货币、连连全球收单、PayPal 候选适配器，所有渠道默认关闭，商户凭据与受理资格需实际配置/联调。支付组件建议 `pay-ru.shinyapi.com`，供应商 webhook 指向该组件；经验证的入账通知只发往 `ru.shinyapi.com/api/user/epay/notify`。New API 已有 Stripe/Creem/Waffo 等继续独立配置。详细字段、币种换算、逐渠道启用、重试对账和退款边界见支付说明。
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

本地预览/浏览器回归仅覆盖静态门户和模拟 API 合约，不能替代真实双实例、数据库和支付验收。回滚只切换 RU 门户 release/停止 RU 新服务与虚拟主机；已有 RU 数据库继续保留并备份，不删除主站或 RU 用户数据。
