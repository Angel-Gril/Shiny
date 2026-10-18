# main 分支保护

已于 2026-10-18 按仓库所有者授权启用 [规则集](https://github.com/Angel-Gril/Shiny/rules/25347380)，仅匹配 `refs/heads/main`，状态 Active。

- 必须通过 Pull Request 合并，已讨论的审查线程需解决。
- 必须通过 GitHub Actions 的 `portal`、`new-api` 检查，且基于最新 main。
- 禁止强制推送、删除 main；不设置绕过名单。
- 个人维护的必需批准人数为0，自己的 PR 无法由自己批准。
- 继续使用合并提交，未要求线性历史或强制签名。

该规则通过 GitHub Rulesets 保存，不会由 Git 中的文件自动创建。配置脚本、凭据和私有 API 回执不入库。发布前核对规则仍生效；继续使用功能分支、针对性测试、密钥扫描、候选验收、PR 和 CI，不直接向 main 推送。
