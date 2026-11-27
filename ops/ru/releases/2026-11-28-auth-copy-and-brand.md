# RU 认证文案和同源 Logo 已部署

[PR #58](https://github.com/Angel-Gril/Shiny/pull/58) 合并至 `commercial/ru-portal`，
合并提交 `64c51bcc1f1e3079fa09a926f4f096a6eab5c3e0`。
最终运行源码为 `76f7919fae66614c6810d4e4a4895e4700efcad7`，
版本 `shiny-ru-polish-76f7919f`。

## 改动

- 登录/注册页协议页脚缺少两条翻译，新增七语言等价文案，俄语下不再显示 `By creating an account...` 或 `By clicking sign in...`。
  在调用处使用字面量翻译键，避免再次漏提取；协议链接、同意机制与认证逻辑保持原行为。
- 找回密码的 `Email` 标签使用已有“Электронная почта”翻译；注册邮箱标签使用完整俄文。
  手机候选发现原俄文重置按钮导致横向溢出，改为简洁“Отправить ссылку”，完整用途保留在说明文字。
- 钱包/支付页面扫描没有发现需新增翻译的英文句子，扩展付款记录测试到俄语；供应商和协议专名保留。
- 将现有 Logo 原字节纳入前端 `/static/ru-brand/mark-v1.svg`，RU 正常管理 API 的 `Logo`
  改为该同源路径。301 字节，SHA256 `295e2b9d06a23f48ae70194ff7c34c27705ea06fbf0f0a478eeb4c65037a4ff1`。
  图标外观不变，静态门户本来使用内联 SVG，不需更新门户。

未改变注册验证、登录/重置接口、会话、权限或支付协议。本轮参照 OWASP Authentication、
Session Management、Forgot Password Cheat Sheets 核对展示层边界；不声称已完成全面 ASVS 审计。
没有发送真实邮件、创建付款订单、启用商户或改变邮箱/注册/人机验证设置。
SMTP 投递和真实邮箱重置链接仍需实际收信测试。

## 验证与发布

- 先由失败测试复现两种协议页脚在俄语下仍显示英文；修复后语言切换、同源法律链接与禁用法律文档空状态通过。
- 六个相关前端文件、85 项测试通过，末次俄文按钮缩短后页脚/钱包六项再次通过。
  类型检查、生产构建、修改文件 lint/format、密钥扫描及当前源码的所有 CI 通过。
- 独立 PostgreSQL 候选只复制表结构，使用合成账号和验证数据，不读取真实邮箱或发送邮件。
  最终候选及公网 1440px/390px 均验证登录、注册、找回密码、钱包记录的俄语显示、
  Logo 成功解码、无横向溢出/脚本错误；这些页面没有请求 `shinyapi.com` 或 `api.shinyapi.com` 资源。
- 完整前端和 Linux Go 程序由相同源码构建。独立 release 目录沿用本次发布批次名
  `/srv/shiny/new-api/releases/ru-polish-31388430`；其实际源码和运行版本以上述 manifest 为准，
  不是目录名里的早期候选提交。程序 SHA256
  `175789c13782ddee7d2a0c038f7d8a701b136dc8c275e4bfab81997adaa20bde`。
- 新增 `shiny-ru-newapi.service.d/zz-polish-20261128.conf`，旧覆盖保留。
  临时 slave 只监听回环端口，排空旧进程后更新，最后恢复 3001 并排空停止临时进程。
  重启到验收约 4.278 秒。旧前端 1,844 个静态文件按摘要保留于共享目录，兼容旧链接。
- 除明确修改的 `Logo` 外，RU 业务选项、模型介绍/价格、倍率、渠道、现有 Key、数据库秘密、
  法律正文、静态门户和注册/邮箱开关均保留。国内主站、CPA、CPAMP 与 WorkBuddy 主进程未变。
- RU R2 备份发布前后均实际成功；发布后上传回读、解密摘要、独立临时 PostgreSQL 恢复通过。
  备份按实际程序校验 release manifest，未覆盖生产数据库或更改备份目标/保留策略。
- 候选数据库、测试进程、临时凭据、上传包及本地 SSH 转发已清理。运行 release、旧静态资源和回滚记录保留。

## Turnstile 决策

维持 **关闭**。它是 Cloudflare 提供的[免费独立验证服务](https://developers.cloudflare.com/turnstile/plans/)，
不要求站点使用 CF CDN，但仍依赖浏览器与服务器访问 `challenges.cloudflare.com`。
官方 [2025-06-26 俄区网络报告](https://blog.cloudflare.com/russian-internet-users-are-unable-to-access-the-open-internet/)
记录过运营商限制；这是历史风险证据，不证明现在所有俄罗斯用户都不可用或都已恢复。
本轮没有俄罗斯运营商的真实客户端测试，不能据服务器出口可用率作判断。

准备开启时新建独立 RU widget、Managed、授权 `ru.shinyapi.com`，先验证不同俄区运营商和浏览器。
邮箱验证及服务端发送/注册限流保留，不因挑战失败自动放行。具体后台入口见 README。

## 回滚

按相同排空流程移除 `zz-polish-20261128.conf`，保留上次 `zz-l10n-20261127.conf`，
将 RU Nginx 静态 root 恢复到 `/srv/shiny/new-api/releases/ru-l10n-a153c28e/site`，
经 `nginx -t` 后 reload。旧资源共享目录已保留新 Logo，Logo 相对 URL 无需回退；
如果需要恢复旧 Logo 设置，用正常管理 API 更新单一 `Logo` 字段，先核对后续编辑。
本轮无 schema 迁移，不恢复整库。私有回执在 `/root/shiny-maintenance/ru-polish-20261128`。
