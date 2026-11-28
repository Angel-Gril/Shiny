# RU 独立 Turnstile 已接入

[PR #63](https://github.com/Angel-Gril/Shiny/pull/63) 合并到 `commercial/ru-portal`，
合并提交 `e5e1e6944e7dadc83a17ffcc64962906fb01cdb5`。
运行源码 `6334c0cc252e21920e010d788ee5cdb827d4d183`，版本 `shiny-ru-turnstile-6334c0cc`。
国内主站保持 `shiny-turnstile-062d5e12`，没有修改其密钥、开关、程序或 Nginx。

## 配置与边界

站长明确提供 RU 独立 widget 并授权启用，取代上次发布暂缓开启的运营决定。
本轮重新读取 [Cloudflare existing-widget 流程](https://developers.cloudflare.com/turnstile/spin/prompt.md)，
保留已有 widget，不新建、不恢复/轮换 Cloudflare 密钥，也不调用凭据 getter。

RU **系统设置 → 身份验证 → 人机验证** 对应路径为
`/system-settings/auth/bot-protection`。保存独立 Site key、Secret 后开启验证。
三个实际设置项为 `TurnstileSiteKey`、`TurnstileSecretKey`、`TurnstileCheckEnabled`；
本轮启用前其他 RU 业务选项完整保留，启用后核对只有这三项变化。

Secret 先通过 canonical Siteverify dummy-token 有效性探针，再经 RU 正常管理 API 保存。
传输通过关闭回显的标准输入和 SSH，未进入源码、参数、临时文件、报告或浏览器；
仅存入既有服务器设置存储，随原加密备份流程保护。
探针返回预期的 `invalid-input-response` 且无 `invalid-input-secret`，仅证明 Secret 有效。

为了避免直接启用旧版本的接入缺陷，本轮只同步主站已验证的 Turnstile 相关修复：

- 登录 `login`、注册/发送邮箱验证码 `signup`、找回密码 `password_reset`、签到 `checkin`。
- 服务端以本实例 `ServerAddress=https://ru.shinyapi.com` 校验精确 hostname 与 action；
  主站 hostname 的 token 不能通过 RU 校验。Siteverify 超时/错误、解析错误和缓存故障均不放行。
- token 过期、错误、超时清理；失败提交后使用新 token；脚本失败提供俄语重试；
  token 使用请求头，保留旧 query 传输兼容，但旧标签页必须刷新以携带 action。
- 单次消费采用五分钟指纹原子记录。RU 当前单进程无 Redis，使用有界内存；
  以后启用 Redis 时可跨实例共享，Redis 故障会拒绝而非放行。

商业分支原有俄语页脚、同源 Logo、国际支付、模型计价、账户和数据库结构均保留。
未同步主站的审计排除等其他功能；未新开收款、发真实邮件、创建用户或发起模型消费。

## 验证

- Linux Go 1.26.10 的 Turnstile、原注册/登录限流路由定向检查通过；
  内存与 Redis 校验包括 action、跨站 hostname、缺失/过长/失效 token、provider畸形/故障、重复接受及缓存错误。
- TypeScript、生产前端构建、44 项相关前端回归、修改文件 lint/format、密钥扫描及本提交全部 CI 通过。
- 独立 PostgreSQL 候选只复制表结构，使用合成用户、设置和模拟挑战。
  1440px/390px 走通登录、发验证码、注册、找回密码失败后换新 token、过期清理、脚本加载失败重试，
  无横向溢出或脚本错误；没有向真实邮箱发信。
- 公网 1440px/390px 的登录、注册、找回密码均加载真实 Cloudflare frame，俄语显示正常，
  没有主站资源请求、横向溢出或脚本错误。
- 站长已确认日常浏览器 **人机验证和正常登录均成功**，服务器同时存在上线后的
  `/api/user/login` 成功审计记录。该结果验证真实浏览器到 RU 后端链路，
  不代替俄区所有运营商通达性测试或真实邮件投递验收。
- 没有索取用户 token，也没有对用户浏览器的真实 token 做手工重放；
  重放拒绝行为由内存/Redis 确定性回归覆盖，不称作真实 token 重放验收。
- 参考 OWASP Authentication、Session Management、Forgot Password Cheat Sheets；
  只补接入 gate，原业务 handler、邮箱验证、密码策略、会话、权限、限流保持，不宣称全面 ASVS 审计。

## 发布与回滚

程序 release `/srv/shiny/new-api/releases/ru-turnstile-6334c0cc`，
SHA256 `c1f3a56c0c5129abab75f535076ac48c6433f913b97d0da6cb410953f327adb6`。
匹配完整前端由同一源码构建；新增 systemd 覆盖
`shiny-ru-newapi.service.d/zz-turnstile-20261128.conf`。
临时 slave 仅监听回环端口，旧进程排空后更新，验收后恢复 3001 并排空停止临时节点，
重启到验收约 5.513 秒。旧前端 1,846 个静态文件按摘要保留，法律正文、两个站点首页、
现有渠道/Key、Logo 和其他服务主进程保持一致。

发布前后 RU R2 任务实际成功；发布后回读摘要、解密、独立临时 PostgreSQL 恢复均通过，
备份记录实际 release manifest，没有覆盖生产库或改备份目标/保留策略。
候选服务、候选数据库、模拟服务、临时凭据、SSH 转发和上传包已清理。

回滚前先通过新版本管理 API 将 `TurnstileCheckEnabled` 设为 `false`，
再按排空流程移除 `zz-turnstile-20261128.conf`，保留 `zz-polish-20261128.conf`，
恢复旧前端静态 root `/srv/shiny/new-api/releases/ru-polish-31388430/site`，
`nginx -t` 后 reload。旧版缺少本轮安全/lifecycle修复，不应带着新开启的验证继续运行。
密钥可保留在正常设置存储等待重新启用；不恢复整库。私有回执在
`/root/shiny-maintenance/ru-turnstile-20261128`，不进入 Git。
