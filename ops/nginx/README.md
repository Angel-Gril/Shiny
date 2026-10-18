# 独立域名入口

`www.shinyapi.com.conf`维护www的HTTP/HTTPS入口，永久以308跳转至`https://shinyapi.com$request_uri`，保留路径、查询与请求方法。它不加载门户或New API的前端include，因此门户/控制台更新无需覆盖此文件。

部署到`/etc/nginx/sites-available/www.shinyapi.com`，从`sites-enabled`链接启用。主域名与api子域继续使用原证书；www使用独立的`/etc/letsencrypt/live/www.shinyapi.com/`证书和续期配置，不提交证书或私钥。

首次部署先只启用文件中的HTTP server块，确认公网`/.well-known/acme-challenge/`可读取`/var/www/certbot`里的随机验证文件，再执行：

```sh
certbot certonly --webroot -w /var/www/certbot -d www.shinyapi.com \
  --cert-name www.shinyapi.com --non-interactive --agree-tos
```

证书成功后启用完整配置，执行`nginx -t`并平滑重载。使用源站SNI及公网入口分别验证证书、308的Location和路径/查询保留。ACME路径在HTTP与HTTPS下均保留，兼容CDN的HTTPS跳转。

`20-shiny-nginx-reload.sh`安装到`/etc/letsencrypt/renewal-hooks/deploy/20-shiny-nginx-reload`，权限0755。Certbot续期成功后先检查Nginx配置再重载；`certbot.timer`负责定期运行。可用以下命令验证www续期及部署钩子：

```sh
certbot renew --cert-name www.shinyapi.com --dry-run --run-deploy-hooks --non-interactive
```

验收期间记录主站/api配置与原证书摘要，以及四个后台服务PID，确认它们不随此入口更新而改变。回滚只停用www的独立vhost并检查/重载Nginx；保留证书以便恢复，不恢复数据库或前端版本。私有部署回执位于`/root/shiny-maintenance/www-https-20261019/`。
