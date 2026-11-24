# RU 商业分支验证记录

日期：2026-11-25。分支：`commercial/ru-portal`。范围：俄语静态门户、独立 RU 实例默认配置、内部账号并发设置、原生国际支付运营与恢复、只读候选检查、真实本地双实例回归。尚未部署生产；俄区域名的 DNS/TLS 留到候选部署检查。

## 门户、价格和历史状态

Node **24.22.3**：在 `portal-ru/` 执行 `node --test tests/*.test.mjs`，**16 项通过**。覆盖单组目录、实际 quota/USD 换算、表达式阶梯/缓存/时间段、固定图像费用与可识别任务单位、条件无法完整解释时的价格入口、缓存 TTL/零费率/音频分支、无样本与 0% 成功率的区分、历史健康序列及静态构建。

`node build.mjs` 使用 Bun 打包控制台的规范表达式解析器，生成 `/`、`/catalog/`、`/docs/`、`/legal/`、`/status/` 五个俄语页面。资源带内容摘要，测试目录/健康数据不进入 `dist/`。生产仅提供静态文件。

`node tests/browser.mjs` 通过真实 Chrome 回归：RU/EN 切换与刷新、筛选/搜索/复制、Python/Node.js/cURL 地址、503 重试、空目录、多组拒绝、恶意元数据、慢/失败健康接口不阻塞价格、键盘展开缓存与上下文阶梯、时间段价格、历史序列、0% 与无数据、五个页面在 320/390/768px 的布局。浏览器 API 边界为 fixture，未使用主站凭据。

## 控制台与语言

在 `new-api/web/` 执行：

```sh
bun run typecheck
bunx vitest run src/features/wallet \
  src/features/system-settings/integrations/__tests__/hosted-payments.test.tsx \
  src/features/system-settings/integrations/__tests__/payment-operations.test.tsx \
  src/features/system-settings/request-limits/__tests__/concurrency.test.tsx \
  src/components/__tests__/ru-service-guide.test.tsx \
  src/i18n/__tests__/site-language.test.ts \
  --pool=forks --maxWorkers=1 --no-file-parallelism
bun run build
```

受影响测试 **15 文件、56 项通过**，覆盖顾客只核查自己的既有订单、精确支付金额、网络失败后重试、管理员不能直接完成原生订单、自动核对默认暂停/参数边界、核查表更新、并发 JSON 拒绝与保存失败草稿、RU/普通站语言偏好及接入导航。typecheck 和控制台构建通过；涉及文件另运行 oxlint 和保留 QuantumNous 归属头的 scoped oxfmt，不批量重写无关文件。

前端新文案通过临时 `add-missing-keys.mjs` 加入全部七种语言，再执行 `bun run i18n:sync`，所有语言 `missingCount=0`。俄语控制台仍有 **52 条原有 legacy/audit 未翻译项**，本记录不声称全部控制台文本已翻译。后端新增俄语 API 错误、事务邮件与通知；语言回归通过。

额外使用 Playwright CLI 检查真实生产构建的钱包、Key、用量日志和支付设置。Key/日志页的完整指南使用项目 Dialog 弹窗，地址仍可复制，打开指南不改变列表高度，关闭后恢复焦点；手机 Key 页标题与操作分行。布局截图留在忽略的 `portal-ru/output/playwright/`；商户和账户响应使用显式本地 fixture，不表示真实充值已完成。

## 后端和三数据库

根模块使用 `go.mod` 声明的 Go **1.26.10** 工具链构建候选程序。支付协议/回调、顾客订单归属/30 秒节流、核对批次/租约测试通过：

```sh
go test ./controller ./service -run '^(TestHosted|TestEpay)' -count=1
go test ./setting ./i18n -count=1
go test ./middleware -run '^(TestModelConcurrency|TestSessionCookieOriginGuard|TestServeFrontend|TestHeader)' -count=1
go build -o /path/to/ru-candidate .
```

真实数据库版本：SQLite **3.50.4**、MySQL **5.7.44**、PostgreSQL **9.6.24**。每种引擎覆盖新建库、上一个分支版本 schema 升级、重复迁移两次、独立日志库、数据/唯一索引保留、并发只入账一次、精确金额/币种拒绝、钱包溢出事务回滚、待支付队列与核查历史、RU 缺省值/旧键别名/管理员既有配置保留。没有数据库跳过项。

```sh
# 指向本地独立 fixture/fixture_logs；凭据不写入仓库。
# 设置 TEST_MYSQL_DSN、TEST_MYSQL_LOG_DSN、
# TEST_POSTGRES_DSN、TEST_POSTGRES_LOG_DSN 后执行：
go test ./model -run '^(TestHostedPaymentDatabaseMatrix|TestRechargeEpay)' -count=1 -v
```

自动核对任务使用实际数据库任务与既有 runner 租约：批量上限为 2 的测试只处理两单，一单经权威查单确认入账，缺少标识的订单向后移动，执行结束释放租约。内存与 miniredis 回归验证同一内部账号的不同 Key 共用并发上限、单用户覆盖、全局限制和请求释放。

全量 Go 检查没有全部通过：Windows 下未改动的 `TestAccessAndPanicLogsFollowLogRotation` 和若干认证测试未关闭日志/审计 SQLite 文件，`TempDir RemoveAll` 清理报文件占用；全量 controller 因累计清理等待达到超时。记录该限制，不以选择性测试代称全量通过。此次受影响的定向测试和真实双实例均通过；远端 Linux 检查以当前 commit 的工作流结果为准。

## 真实本地双实例

候选程序运行两个真实 New API 进程，分别使用独立临时 SQLite 数据库，主站连接本地合成上游，RU 通过 New API 类型渠道及内部专用 Key 连接主站。执行：

```sh
python ops/ru/tests/two_instance.py --binary /absolute/path/to/ru-candidate
python -m unittest discover -s ops/ru/tests -p '*_test.py' -v
```

双实例检查通过，readiness 单元测试 **5 项通过**。覆盖两站同名注册/会话/Key 隔离、RU 匿名单组价格、Chat/Anthropic/Gemini/Responses/图像/SSE 两层用量和扣费、上游失败退还预扣、主站重试而 RU 不重复重试、内部账户余额不足、顾客受限 Key、共享内部账号并发/拒绝/释放、日志隔离与请求 ID 对应、流式断开传播，以及只读检查接受合理配置/拒绝隐藏额外组。

合成计价结果（只证明公式与隔离，不代表生产售价）：

| 上游用量 | 主站内部账号扣费 quota | RU 顾客扣费 quota |
| --- | ---: | ---: |
| 输入 1000（含缓存 200）、输出 100 | 525 | 1050 |
| 输入 3000（含缓存 200）、输出 100 | 3050 | 6100 |
| 请求 2 张、实际返回 1 张有效图像 | 10000 | 20000 |

RU 日志 `upstream_request_id` 与主站 `request_id` 对应。取消测试验证断开传递且不重试；已经生成的用量按既有规则结算，不承诺取消一律免费。

## CI 和提交

工作流包含门户测试/构建/浏览器、支付后端及最低数据库版本矩阵、控制台测试/构建与产物、真实双实例/readiness，全部在商业分支运行。提交前执行 `git diff --cached --check` 与 `python scripts/check-secrets.py`；不提交二进制、生成产物、临时浏览器脚本、商户凭据或数据库。当前 commit 的结果见 [该分支 Actions](https://github.com/Angel-Gril/Shiny/actions?query=branch%3Acommercial%2Fru-portal)，历史通过记录不能替代本次结果。

## 候选环境仍须验收

- Linux Nginx/systemd、DNS/证书、RU 独立 SMTP/邮件链接与 Turnstile、备份及 RU 回滚。
- 每个实际上游、售价覆盖真实成本、异步任务/音频/Realtime/WebSocket、俄区可达性和目标并发下的两站资源余量。本地合成上游没有验证这些生产能力。
- 支付商实际批准的主体/地区/卡或 SBP/币链，小额成功、取消、欠付/超付、迟到和重复通知、退款及退款来源核对。本轮没有真实商户付款，也未实现自动/部分退款或拒付扣回。
- 主站采用旧 release 时，新增内部用户并发覆盖不能生效；需要先验证含此功能的候选二进制，或按旧版普通用户容量规划。完整部署顺序和配置位置见 [部署说明](README.md) 与 [原生支付](payment-native.md)。

只读工具 `configuration_passed` 表示可自动检查的配置通过；`deployment_accepted` 始终为 false。它不会将本地测试、DNS/TLS 或商户 fixture 当作生产验收完成。
