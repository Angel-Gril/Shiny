# 门户登录跳转与控制台品牌同步

日期：2026-11-04。门户版本：`portal-login-navigation-20261104-r7`；控制台前端：`web-login-branding-20261104-r2`。New API 后端不变，控制台前端与 `Logo` option 更新。

源码经 [PR #33](https://github.com/Angel-Gril/Shiny/pull/33) 合并，源码提交 `ecb1030e99c46d3047dd2c868dcb939dc336da80`，合并提交 `850d5908767214406476e1002d44b5be0f3dd3f8`。控制台前端于 `2026-11-04T14:22:35Z` 上线。

门户归档 SHA256：`ba1bb089ecaae7137514757e9896d7e7b957fca1b0ef70832f8662333c307904`；控制台归档 SHA256：`72beffe009137cdb0537e1501dca9cfd0f9f672b48082b34911a64e0c9e4f5c7`。两者独立发布，组件清单分别记录其前端版本。

## 原因

首页把 `https://shinyapi.com/sign-in` 作为通用外链构造，通用外链默认加入 `target="_blank"`，于是登录按钮创建第二个浏览器标签。登录页 Logo 来自 New API `/api/status.logo`；修改前 `Logo` 为旧内嵌渐变 S 图。新版门户 Logo 使用不可变路径 `/shiny-home-assets/portal-login-navigation-20261104-r7/assets/mark.svg`。

## 修复及发布

- 门户登录按钮改为不带 `_blank` 的普通同源链接；控制台外链仍保留原新标签行为。
- New API 登录页图片改用 `object-contain`，显示不裁圆 Logo。
- 门户前端独立发布新不可变资源并切换门户 include；保留旧 v21 及更早资源映射。
- 控制台前端单独构建并切换其 include；资源回退先查原 `web-national-billing-20261104`，再沿用已有回退链，保证已打开的旧标签页仍可加载旧 chunk。
- New API 只更新 `Logo` 配置为当前门户版本的公开 SVG URL，`SystemName`、认证流程、公告和其余选项保持不变。
- 不重启 New API、门户内容服务、CPA 或 CPAMP。

## 验收

门户公告及导航浏览器回归 21 项、控制台导航回归 4 项、typecheck、相关 lint/format 和前端生产构建通过。隔离候选使用真实静态构建，只有公开状态响应中的 Logo 字段替换为待发布 URL；登录表单正常渲染，SVG 正常加载，图片使用 `object-fit: contain`，无页面错误，未提交登录凭据。

候选 404 来自控制台 include 错误地指向不存在的 site 子目录；已按实际构建包布局修正 root。Nginx reload 后需等待新 worker 接管，再检查响应头中的前端版本，避免把旧 worker 的短暂响应当成新配置结果。

生产浏览器复测通过：首页登录在同一标签打开、登录页使用 40×40 的新版 SVG 且不裁圆、标签页 favicon 更新、品牌链接返回静态首页、390px 手机视图无横向溢出、无页面脚本错误。旧控制台独有 chunk 和旧 v21 Logo 均继续返回 HTTP 200。

发布后验收首页同页登录、登录页新版标志和品牌链接返回静态首页，并观察首页、登录、价格和状态端点五分钟。New API／门户内容服务／CPA／CPAMP 进程不重启。回滚分别恢复原门户 include（v21）、控制台 include（web-national-billing-20261104）和旧 `Logo` 字符串，保留本次和以往静态资源。回滚记录仅存服务器 root 私有目录。
