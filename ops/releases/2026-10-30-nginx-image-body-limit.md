# Nginx image request body limit

2026-10-30（Asia/Shanghai）修复图片生成/编辑接口的 Nginx 413。

## 原因

生产日志显示 `POST /images/generations` 的请求体为 3,302,182 bytes，被 Nginx 默认约 1MB 限制拒绝。原有 32MB 配置只位于 `location ^~ /v1/`，因此不覆盖根路径 `/images/generations`。请求没有到达 New API，也没有进入计费或上游模型。

## 变更

仅以下四个图片路径设置 `client_max_body_size 128m`：

- `/images/generations`
- `/images/edits`
- `/v1/images/generations`
- `/v1/images/edits`

普通 `/v1/` 路径仍保持 32MB。New API 自身默认请求体上限为 128MB。

## 验收

Nginx 语法检查通过；3,302,182 bytes 的合成请求四个路径均不再返回 413，`/v1/` 路径进入 New API 后返回鉴权响应，根路径进入应用处理；New API PID 未变化，Nginx 平滑重载完成。

服务器保留本次变更前的私有配置副本用于回滚；不提交 Git。
