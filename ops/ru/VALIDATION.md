# RU 商业分支验证记录

2026-11-27 上线结果见 [RU 一键 Key 发布记录](releases/2026-11-27-universal-keys.md)。下文候选测试为开发当时记录，当前 RU 已发布对应前后端；国内服务未随之更新。

## 2026-11-27：RU 一键创建密钥候选

基线 `commercial/ru-portal` 的 `c0eae7770d2b65f3ed7b83d40cfb7592f65d89e3`，
功能分支 `commercial/ru-universal-keys`。本节为本地候选验证，未部署 RU 或国内
生产，未合并商业基线或主站分支。

- 前端 `bun run typecheck`、Key 组件和表单工具 8 个文件共 75 项测试通过；
  包含 RU 直接创建、旧后端回退、国内表单保留、防重复点击、业务失败不重试、
  读取密钥失败可重试且不重复创建。最后补齐地址翻译后，6 项专属回归重跑通过。
- 在 `new-api/` 执行 `go test ./controller -run '^(TestRUUniversal|TestAddToken|TestGetTokenKey)' -count=1`。
  覆盖属主、客户端伪造 group/user/model 参数不扩大权限、私有组模型不开放、
  同组新增模型可见、数量上限、非 RU 拒绝预设、原创建/读取行为保留。
- `TestRUUniversalKeyDatabaseMatrix` 在真实 SQLite **3.50.4**、MySQL **8.0.46**、
  PostgreSQL **16.13** 上通过。使用独立临时数据库，不连接生产；没有新增列、
  更改 schema、查询语法或覆盖已有 Key 的迁移。CI 已补入该矩阵及前端回归。
- `bun run build` 和 `go build` 完整构建通过。影响文件的 oxlint 和保护版权头
  的定向格式检查、`git diff --check`、源代码秘密扫描通过；没有新运行依赖。
- 用同一份构建启动两个本地实例，分别为 RU 和普通站点，配合合成账号与本地
  OpenAI 兼容上游。真实浏览器登录后，RU 1440px/390px 一次点击创建、复制到
  剪贴板、进入可选编辑均通过；没有分组选择步骤、横向溢出或页面脚本错误。
  密钥只通过原属主校验接口读取，未写入 localStorage/sessionStorage。
- 同一创建的 Key 经真实 HTTP 成功调用三个模拟平台模型；随后新增同组模型，
  无需重建 Key 即可在 `/v1/models` 看到；其他组私有模型不在列表中。匿名创建
  返回 401，普通站点拒绝 RU 创建预设且浏览器仍使用原表单。没有真实模型费用。
- 复用项目 Dialog、ApiKeyCell、CopyButton、Button 和现有编辑抽屉；新增组件
  只组合“创建成功后的接入信息”这一业务内容，不另造复制、展示或弹窗机制。
- 按 OWASP Authentication、Session Management、REST Security Cheat Sheets
  核对服务端权限、凭据传输、生成和审计边界。既有鉴权、随机密钥、操作审计及
  秘密读取流程保留；创建响应脱敏且 no-store。未声称完整 ASVS 合规认证，
  未更改凭据数据库的既有存储方式或登录验证机制。

界面证据：[手机](../evidence/ru-universal-key-390.png)、
[桌面](../evidence/ru-universal-key-1440.png)，全部为合成本地账号和脱敏密钥。
正式上线仍需从匹配的商业源码一起构建前后端并在服务器候选验证；本轮不替代
真实上游、目标网络及生产灰度观察。

日期：2026-11-25。分支：`commercial/ru-portal`。范围：俄语静态门户、独立 RU 实例默认配置、内部账号并发设置、13 个原生国际支付模块、支付运营与恢复、只读候选检查、真实本地双实例回归。重点预选为 Creem、Waffo Pancake、TryBit、NOWPayments、OxaPay、Apirone。尚未部署生产；俄区域名的 DNS/TLS 留到候选部署检查。

## 门户、价格和历史状态

Node **24.22.3**：在 `portal-ru/` 执行 `node --test tests/*.test.mjs`，**16 项通过**。覆盖单组目录、实际 quota/USD 换算、表达式阶梯/缓存/时间段、固定图像费用与可识别任务单位、条件无法完整解释时的价格入口、缓存 TTL/零费率/音频分支、无样本与 0% 成功率的区分、历史健康序列及静态构建。

`node build.mjs` 使用 Bun 打包控制台的规范表达式解析器，生成 `/`、`/catalog/`、`/docs/`、`/legal/`、`/status/` 五个俄语页面。资源带内容摘要，测试目录/健康数据不进入 `dist/`。生产仅提供静态文件。

`node tests/browser.mjs` 通过真实 Chrome 回归：RU/EN 切换与刷新、筛选/搜索/复制、Python/Node.js/cURL 地址、503 重试、空目录、多组拒绝、恶意元数据、慢/失败健康接口不阻塞价格、键盘展开缓存与上下文阶梯、时间段价格、历史序列、0% 与无数据、五个页面在 320/390/768px 的布局。浏览器 API 边界为 fixture，未使用主站凭据。

## 控制台与语言

在 `new-api/web/` 执行：

```sh
bun run typecheck
bun x vitest run src/features/wallet \
  src/features/system-settings/integrations/__tests__/hosted-payments.test.tsx \
  src/features/system-settings/integrations/__tests__/payment-operations.test.tsx \
  src/features/system-settings/request-limits/__tests__/concurrency.test.tsx \
  src/components/__tests__/ru-service-guide.test.tsx \
  src/i18n/__tests__/site-language.test.ts \
  --pool=forks --maxWorkers=1 --no-file-parallelism
bun run build
```

受影响测试 **15 文件、71 项通过**，覆盖顾客只核查自己的既有订单、精确支付金额、网络失败后重试、管理员不能直接完成原生订单、自动核对默认暂停/参数边界、核查表更新、13 个支付商配置与原生/旧套餐区分、密钥遮蔽、手机标签滚动与键盘选择、并发 JSON 拒绝与保存失败草稿、RU/普通站语言偏好及接入导航。typecheck、涉及文件 oxlint、保留 QuantumNous 归属头的 scoped oxfmt 和控制台构建通过，不批量重写无关文件。生产构建的支付设置仍按路由拆分，新增模块没有引入前端支付 SDK 或新的生产依赖。

前端新文案通过临时 `add-missing-keys.mjs` 加入全部七种语言，再执行 `bun run i18n:sync`，所有语言 `missingCount=0`，临时脚本已移除。本次新增 40 个键；俄语未翻译报告共 59 项，其中 **52 条是原有 legacy/audit 文案，7 条是保留英文的品牌名称**，没有新增俄语说明文案留空。本记录不声称全部控制台文本已翻译。后端新增俄语 API 错误、事务邮件与通知；语言回归通过。

额外使用 Playwright CLI 检查真实生产构建的钱包、Key、用量日志和支付设置。Key/日志页的完整指南使用项目 Dialog 弹窗，地址仍可复制，打开指南不改变列表高度，关闭后恢复焦点；手机 Key 页标题与操作分行。布局截图留在忽略的 `portal-ru/output/playwright/`；商户和账户响应使用显式本地 fixture，不表示真实充值已完成。

支付设置复用现有 Tabs，13 个渠道在手机端横向滚动，密码字段不展示已存密钥；Apirone 不展示带逐单令牌的回调地址。键盘 End 只移动焦点，Enter 才切换配置。缩窄窗口会隐藏当前渠道的问题已先用失败回归复现，再增加 feature 内 ResizeObserver，只调整标签栏的水平滚动，保留页面垂直位置；没有修改全站 Tabs 行为或另建通用组件。

## 后端和三数据库

根模块使用 `go.mod` 声明的 Go **1.26.10** 工具链构建候选程序。支付协议/回调、顾客订单归属/30 秒节流、核对批次/租约测试通过：

```sh
go test ./controller ./service -run '^(TestHosted|TestEpay)' -count=1
go test ./setting ./i18n -count=1
go test ./middleware -run '^(TestModelConcurrency|TestSessionCookieOriginGuard|TestServeFrontend|TestHeader)' -count=1
go build -o /path/to/ru-candidate .
```

真实数据库版本：SQLite **3.50.4**、MySQL **5.7.44**、PostgreSQL **9.6.24**。每种引擎覆盖新建库、上一个分支版本 schema 升级、重复迁移两次、独立日志库、数据/唯一索引保留、并发只入账一次、精确金额/币种拒绝、钱包溢出事务回滚、待支付队列与核查历史、RU 缺省值/旧键别名/管理员既有配置保留。新增远端发票归属约束跨进程拒绝重复发票，包括升级前已付款但没有 claim 的历史行；FreeKassa nonce 在失败请求后仍递增。没有数据库跳过项。

升级范围限于支付模块：矩阵使用当前 User/TopUp/Log/Option 模型建立基础表，再用旧 HostedPayment 结构验证支付表升级；没有使用生产 rc.51 完整 schema/代表性数据运行整个 `migrateDB()` / `migrateLOGDB()` 的候选启动升级。上述结果不能视为国内整库升级已验收。国内主站继续使用旧 release 时，新建 RU 库可单独测试；更新国内主站前必须补完整升级、重复启动、关键数据/约束保留及备份恢复验证。

```sh
# 指向本地独立 fixture/fixture_logs；凭据不写入仓库。
# 设置 TEST_MYSQL_DSN、TEST_MYSQL_LOG_DSN、
# TEST_POSTGRES_DSN、TEST_POSTGRES_LOG_DSN 后执行：
go test ./model -run '^(TestHostedPaymentDatabaseMatrix|TestRechargeEpay)' -count=1 -v
```

自动核对任务使用实际数据库任务与既有 runner 租约：批量上限为 2 的测试只处理两单，一单经权威查单确认入账，缺少标识的订单向后移动，执行结束释放租约。内存与 miniredis 回归验证同一内部账号的不同 Key 共用并发上限、单用户覆盖、全局限制和请求释放。

新增协议边界覆盖 Creem 最小单位报价与产品条件、Pancake 原始 RSA 签名/买家身份/退款拒绝、TryBit JWT 过期和原报价币种、OxaPay sandbox 来源与 HMAC、Apirone 6/18 位币精度、超出 int64 的最小单位与唯一交易记录、Platega/FreeKassa/Lava 查单和伪造通知拒绝。Pancake 官方重试保留原始签名，默认 SDK 的 5 分钟会拒绝正常迟到通知；先记录失败用例后显式设为官方 45 分钟，31 分钟通知可经真实 controller 验签/查单入账且重复通知不再次增加余额，正负 46 分钟通知均拒绝。供应商接口全部由显式 fixture 模拟，未向真实商户发起支付。

全量 Go 检查没有全部通过：Windows 下未改动的 `TestAccessAndPanicLogsFollowLogRotation` 和若干认证测试未关闭日志/审计 SQLite 文件，`TempDir RemoveAll` 清理报文件占用；全量 controller 因累计清理等待达到超时。记录该限制，不以选择性测试代称全量通过。此次受影响的定向测试和真实双实例均通过；远端 Linux 检查以当前 commit 的工作流结果为准。

## 真实本地双实例

候选程序运行两个真实 New API 进程，分别使用独立临时 SQLite 数据库，主站连接本地合成上游，RU 通过 New API 类型渠道及内部专用 Key 连接主站。执行：

```sh
python ops/ru/tests/two_instance.py --binary /absolute/path/to/ru-candidate
python -m unittest discover -s ops/ru/tests -p '*_test.py' -v
```

双实例检查通过，readiness 单元测试 **5 项通过**。首次运行在并发阶段发生一次 RU 连接超时；相同候选二进制未修改，完整重跑通过。该结果不替代目标服务器并发和网络验收。覆盖两站同名注册/会话/Key 隔离、RU 匿名单组价格、Chat/Anthropic/Gemini/Responses/图像/SSE 两层用量和扣费、上游失败退还预扣、主站重试而 RU 不重复重试、内部账户余额不足、顾客受限 Key、共享内部账号并发/拒绝/释放、日志隔离与请求 ID 对应、流式断开传播，以及只读检查接受合理配置/拒绝隐藏额外组。

合成计价结果（只证明公式与隔离，不代表生产售价）：

| 上游用量 | 主站内部账号扣费 quota | RU 顾客扣费 quota |
| --- | ---: | ---: |
| 输入 1000（含缓存 200）、输出 100 | 525 | 1050 |
| 输入 3000（含缓存 200）、输出 100 | 3050 | 6100 |
| 请求 2 张、实际返回 1 张有效图像 | 10000 | 20000 |

RU 日志 `upstream_request_id` 与主站 `request_id` 对应。取消测试验证断开传递且不重试；已经生成的用量按既有规则结算，不承诺取消一律免费。

## 国内流程对照与候选配置补充

2026-11-25 主站公开状态为 `shiny-rc51-50f7591`：用户协议和隐私政策均启用且正文非空，账号密码注册/登录、邮箱验证、Turnstile、USD 额度显示及用量导出开启，内置第三方登录关闭。通过公开源码比对该 revision，注册表单、协议勾选、法律配置、Key API、用量日志 API、站点配置入口、OAuth URL 构造及旧钱包 API 与本分支一致；没有读取主站用户或商户数据。依照用户确认，RU 保留国内的前端协议勾选，正文在部署后的 RU 管理页保存，不增加服务端协议版本/接受时间机制。详细设置位置见 [功能对照](README.md#与国内现有版本的功能对照)。

门户语言偏好问题先由浏览器失败用例复现：控制台将 `i18nextLng` 改为 `en` 后刷新门户，旧代码仍显示 `ru`。修复后真实 Chrome 回归通过控制台最新 RU/EN 偏好、显式 URL 优先、无效 URL 不重置、其他控制台语言不被覆盖、浏览器阻止存储时仍可切换，以及原有目录/复制/错误/手机布局；`node tests/browser.mjs`、16 项门户测试和生产构建通过。涉及两个 `.mjs` 文件的 oxlint correctness 与 Node 语法检查通过；没有改动 TypeScript、前端依赖或认证实现。

只读 readiness 增加 `ru_public_address`、`legal_documents` 检查；`--ru-public-url` 区分公开站点地址与本机管理 origin，不要求对尚未部署的域名进行网络探测。真实双实例回归先复现旧工具漏检主站返回地址，再验证合理配置通过、内部管理地址搭配正确公开 origin 通过、主站返回地址/空隐私/额外组拒绝、RU 修改正文不影响主站。`python ops/ru/tests/two_instance.py --binary <shiny-preselected-payments-candidate.exe>` 与 5 项既有 readiness 单元测试通过。复用上轮从本分支构建的 Go 候选程序；本次未修改 Go 源码、数据库模型或迁移。

本轮只核对实例与导航配置边界，不声称完成全量 ASVS 审计、真实邮件/OAuth/支付验收。国内邮箱验证和 Turnstile 的启用状态不自动复制到 RU；实际 RU 运营正文、SMTP/Turnstile、售价和商户参数仍由运营在候选部署填写。

## CI 和提交

工作流包含门户测试/构建/浏览器、支付后端及最低数据库版本矩阵、控制台测试/构建与产物、真实双实例/readiness，全部在商业分支运行。提交前执行 `git diff --cached --check` 与 `python scripts/check-secrets.py`；不提交二进制、生成产物、临时浏览器脚本、商户凭据或数据库。当前 commit 的结果见 [该分支 Actions](https://github.com/Angel-Gril/Shiny/actions?query=branch%3Acommercial%2Fru-portal)，历史通过记录不能替代本次结果。

## 候选环境仍须验收

- 国内主站若需要升级，补生产 rc.51 代表性独立数据库的完整候选启动/重复迁移与恢复验证；现有支付表矩阵和新建双实例不能替代这一项。
- Linux Nginx/systemd、DNS/证书、RU 独立 SMTP/邮件链接与 Turnstile、备份及 RU 回滚。
- 每个实际上游、售价覆盖真实成本、异步任务/音频/Realtime/WebSocket、俄区可达性和目标并发下的两站资源余量。本地合成上游没有验证这些生产能力。
- 支付商实际批准的主体/地区/卡或 SBP/币链，小额成功、取消、欠付/超付、迟到和重复通知、退款及退款来源核对。本轮没有真实商户付款，也未实现自动/部分退款或拒付扣回。
- TryBit 公开查单 schema 包含 `fiat_currency`，示例却省略；代码缺失币种时拒绝入账，必须核验正式商户响应。Apirone 官方没有签名通知，使用本地逐单回调令牌加私有查单；代理/CDN 访问与错误日志都须隐藏回调 query。本分支 Nginx 模板已为支付回调单独关闭访问及请求错误日志。
- 主站采用旧 release 时，新增内部用户并发覆盖不能生效；需要先验证含此功能的候选二进制，或按旧版普通用户容量规划。完整部署顺序和配置位置见 [部署说明](README.md) 与 [原生支付](payment-native.md)。

未付款订单终结流程尚未实现，长期 pending 会阻止彻底停用或更换商户。本版只能暂停新收款并保留存量单处理能力；正式增加取消/过期关单时需验证支付商状态和迟到/部分付款，不能把当前核查功能描述为完整关单系统。

部署交接补充只更新本文件和 [README.md](README.md)，不修改程序、依赖、数据库结构、生产环境或国内定价。功能测试基线仍为 `8d166676f70163930ce4d8efc9080e5d2fdce4a3`；其 [RU 门户](https://github.com/Angel-Gril/Shiny/actions/runs/45599918847)、[原生支付](https://github.com/Angel-Gril/Shiny/actions/runs/45599918648)、[源码检查](https://github.com/Angel-Gril/Shiny/actions/runs/45599918950) 共 6 个任务通过。交接文档提交的 CI 结果以相应提交为准，不能借用功能基线的记录代称新提交已通过。

只读工具 `configuration_passed` 表示可自动检查的配置通过；`deployment_accepted` 始终为 false。它不会将本地测试、DNS/TLS 或商户 fixture 当作生产验收完成。

## 2026-11-27 RU 元数据与界面语言修复

复现了两条入口：`/api/pricing` 中模型介绍和标签来自 RU 数据库的中文元数据；
同步界面固定初始 `zh`，服务端空语言也固定中文，而上游俄语导出返回 404。
新增失败用例先确认俄语同步不支持、RU 同步选择中文及密码提示缺少俄译，修复后通过。
俄语同步使用英文上游加随源码维护的精确型号译文；未知模型保留英文说明和自定义标签。
英文、中文同步的字段与语言行为保留，不修改计费、模型权限或数据库结构。

实际执行：

- `go test ./controller -run '^(TestRussianMetadata|TestMetadataSyncLocale)' -count=1`：通过；覆盖来源 URL、已知/未知型号、标签去重、原端点/状态以及普通实例默认中文。
- `bun run typecheck`：通过。
- `bunx vitest run src/features/models/__tests__/metadata-sync.test.tsx src/i18n/__tests__/site-language.test.ts src/components/__tests__/password-strength.test.tsx src/features/pricing/lib/__tests__ --maxWorkers=1 --no-file-parallelism`：6 文件、206 项通过；末次译文调整后相关 3 文件、80 项再次通过。
- 修改文件的 oxlint、保留版权头的定向 oxfmt、`git diff --check`、`python scripts/check-secrets.py --all`：通过。扩大到整个 models 目录时存在旧文件 lint 错误，不将其描述为全库 Lint 通过。
- `bun run build`：生产构建通过。
- 通过 RU 管理 API 更新 13 个模型的介绍和现有标签，以及 OpenAI 供应商说明。核对全部业务选项、渠道、现有 Key、主站选项和公共计价字段一致；仅展示文案变更。`codex-auto-review` 无可靠介绍，保留空白。

同时补充注册密码强度/要求、审计/日志/请求处理的俄文，移除证据格式化中写死的中文，
将两条误放在 `translation` 之外的旧审计提示归回命名空间。七种语言均包含本次新增键。
微信登录的协议指令 `验证码` 保留原文，不能翻译成无法匹配的命令。
新增 CI 检查俄语同步和前端回归，并沿原模型管理矩阵在 SQLite/MySQL/PostgreSQL 验证字段选择、版本校验与同步原子性。
最终服务器候选、上线版本和浏览器验收应以独立发布记录为准。
