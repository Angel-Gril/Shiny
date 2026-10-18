# 2026-10-18 粒子控件与主分支保护

前端 `portal-20261018-v19` 已上线，经 [PR #11](https://github.com/Angel-Gril/Shiny/pull/11) 合并。源码 `b663f4b3599750452ebc28989d84542c8d4e1ca0`，合并提交 `ca058fe379cba87b0e8f1241f1425051b65d98cc`。37 文件前端包 SHA-256 为 `f2a0b36d7ad99e197a5e00d95258f5f428b92d09830788d9d5087c0f1b872eee`。

- 粒子分类、原生选择框、自动轮播和暂停的字号统一12px，与接入教程一致。
- 删除左侧重复的场景标题；原生选择框保留名称和可访问标签，选中文字居中，窄屏宽度120px。
- 15项真实构建浏览器回归通过，包含31场景实际绘制归属、暂停/轮播、文档与资源；另候选和公网六档尺寸双主题检查控件字号、居中、标题删除和无溢出。320px下导航218px与暂停50px位于276px可用区域，保留8px间隔。响应式为浏览器模拟。
- [main规则集](https://github.com/Angel-Gril/Shiny/rules/25347380)按所有者授权启用，必须PR、最新main上的portal/new-api检查，0人必需批准，禁止强推和删除且无绕过名单。PR #11 在该规则下通过CI并正常合并，详见[保护说明](../BRANCH_PROTECTION.md)。

候选验收期间本机SSH隧道断开，造成浏览器请求超时；服务器本地候选与旧资产仍200且约0.6ms响应。重连并启用SSH保活后，完整候选验收通过，才切换正式入口。

仅切Nginx门户前端include，重载后连续确认两次v19。内容服务current/production_release仍v14，四个后台服务PID、R2设置摘要不变。保留v18及更早不可变资源供旧标签页使用；候选入口、上传包和本机隧道验收后清理。

回滚：将门户include恢复为 `/opt/shiny-portal/releases/portal-20261018-v18/portal-locations.conf`，nginx语法校验后平滑重载并等待旧版本连续响应两次，不切后台current、不恢复数据库。服务器私有部署回执在 `/root/shiny-maintenance/portal-controls-20261018/`，凭据及临时维护脚本不入库。
