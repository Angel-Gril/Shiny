# RU portal v0.1.0 验证记录

日期：2026-11-23。功能范围：独立静态门户、现有 New API 的只读目录合约和候选部署模板。尚未部署生产。

本机执行结果：

- Node 24.22.1：`node --test tests/*.test.mjs`，8 项通过。覆盖单组约束、错误响应、模型过滤/去重、搜索组合、元数据转义、同源匿名请求、API 示例和静态构建。
- `node build.mjs`：4 个预渲染俄语页面，带内容摘要的资源；预览目录数据不包含在发布产物中。
- `node tests/browser.mjs`：Chrome 无头浏览器通过。覆盖 RU/EN 切换及刷新、模型搜索/开发者/协议筛选、复制模型/代码/地址、503 重试、空目录、多组误配置、恶意模型文本、原生控制台导航及 320/390/768 像素布局。正常页面无脚本异常或失败的资产请求，无主站/第三方网络请求。
- 人工查看 1440px 桌面首页/目录与 390px 手机长截图；输出在本机 `portal-ru/output/playwright/`，不提交生成物。
- 提交前执行仓库 `scripts/check-secrets.py` 与 `git diff --cached --check`。

商业分支 `commercial/ru-portal` 已推送。实现提交 `2e256821bff8db72a74469f3d28c99819b53818f` 的 [RU portal checks](https://github.com/Angel-Gril/Shiny/actions/runs/45192080015) 已通过：Node 22 构建、Playwright 1.58.2 Chromium 回归及构建产物上传成功。后续提交和仓库其他检查以 [该分支的 Actions 记录](https://github.com/Angel-Gril/Shiny/actions?query=branch%3Acommercial%2Fru-portal) 为准。

边界：本机没有运行 Linux Nginx/systemd、PostgreSQL 双实例、主站渠道或支付商户环境。Nginx/systemd 文件是模板，须在候选服务器执行配置检查；真实注册、邮箱、余额隔离、流式双跳计费和支付回调仍须按 [部署验收表](README.md#必做候选验收) 验证。本次未修改 New API 的后端/控制台/账务源码，也未用模拟 UI 冒充真实账号和收款功能。
