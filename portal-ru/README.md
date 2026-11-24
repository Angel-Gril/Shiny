# Shiny RU portal

独立的俄语品牌门户，默认俄语，可切换英语。Node 22+ 和 Bun 构建、原生 ES modules、无运行时依赖；构建时复用 New API 控制台的表达式解析器，生产由 Nginx 提供静态页面，不需要另起 Node 服务。

```sh
cd portal-ru
node --test tests/*.test.mjs
node build.mjs
node preview.mjs
```

打开 `http://127.0.0.1:4173`。预览仅监听本机，目录使用明确标注的测试数据；控制台链接显示尚未连接后台的提示。不会调用主站，不接受 Key，不创建账号/订单。测试目录不进入 `dist/`。

浏览器回归：安装 Playwright 1.58.2 与 Chromium 后运行 `node tests/browser.mjs`。也可将 `PLAYWRIGHT_PATH` 指向已有 Playwright 包目录，本机已有 Chrome 时设置 `PLAYWRIGHT_CHANNEL=chrome`。脚本自己启动本机临时预览服务并关闭它；截图输出到忽略的 `output/playwright/`。CI 使用 Playwright 自带 Chromium。

## 页面与接口

| 路径 | 提供方 | 用途 |
| --- | --- | --- |
| `/` | portal-ru | 俄语首页 |
| `/catalog/` | portal-ru | 模型广场，搜索、开发者和协议筛选 |
| `/status/` | portal-ru | 过去 24 小时的模型成功率、延迟与历史样本 |
| `/docs/` | portal-ru | Python / Node.js / cURL 示例及客户端地址说明 |
| `/legal/` | portal-ru | 开源归属与源码链接 |
| `/api/pricing` | **RU New API** | 同源、匿名、只读的模型元数据 |
| `/api/perf-metrics/summary?hours=24` | **RU New API** | 同源、匿名、只读的历史请求统计 |
| `/pricing` | RU New API | 权威价格、表达式、阶梯、缓存条件 |
| `/sign-up`, `/sign-in`, `/keys`, `/wallet`, `/dashboard`, `/usage-logs` | RU New API | 独立账号、Key、钱包、用量 |
| `/v1/*`, `/v1beta/*` | RU New API | 客户模型调用 |
| `/models` | RU New API | 保留原有管理页面，门户不接管 |

门户不存储客户 Key/余额，不实现支付回调或另一套计费公式。模型卡片使用已发布表达式显示完整阶梯、缓存、时间区间、固定价格和可识别任务单位价格；任务 token 系数标明每百万 token，固定任务费用单列。旧倍率按接口实际 `quota_per_unit` 换算，保留缓存 TTL 和音频分支；Gemini/Realtime/旧图像等接口未包含全部条件时转到控制台查看，不猜测价格。请求参数或处理插件决定价格时提供完整条件入口。

健康统计独立加载，不阻塞价格；无样本与 0% 成功率分别显示，加载失败不会把模型标为不可用。统计反映网关历史，不能表示俄罗斯网络时延或保证下一次调用成功。测试数据有明确预览标识，发布产物不包含测试目录。支付方式来自 RU 实例的实际配置。

`site.config.mjs` 仅含公开配置。API 地址为 **`https://ru.shinyapi.com/v1`**。不要把 `catalogEndpoint` 指向国内实例；前端会拒绝多个可用分组，实际账号隔离由独立 RU 实例和数据库保障。后台需让匿名访客及普通 RU 用户都只能使用 `default` 一个分组。

语言选择写入同源 `i18nextLng`，进入控制台后使用俄语/英语。本分支 RU 实例的 `SHINY_SITE_PROFILE=ru` 会让直接首次打开控制台也默认俄语，已保存的语言偏好优先。`DEFAULT_LANGUAGE=ru` 支持俄语 API 错误、事务邮件和通知，用户的明确语言偏好仍优先。

## 构建与发布

`dist/` 为可发布目录，首页及文档预渲染成俄语 HTML。模块和 CSS 位于带内容摘要的 `/ru-assets/<hash>/`；构建保留旧摘要目录。发布时将资产合并到独立 shared 目录，切换 HTML release 时不删除旧资产，避免已打开页面失效。不要用 `rsync --delete` 清理 shared 资产。

候选部署、双实例渠道配置、邮箱与支付待办见 [RU 部署说明](../ops/ru/README.md)。本目录的变更不要求升级国内门户或国内 New API。

GNU AGPLv3，与仓库根 LICENSE 一致。代码和部署模板均不包含生产凭据。
