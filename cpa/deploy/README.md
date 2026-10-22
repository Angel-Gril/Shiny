# CPA 内核升级工具

本目录只管理官方CPA程序的候选验证与单组件切换，不修改CPA内核源码。生产凭据、配置备份、发行包及运行回执留在服务器私有目录，不提交Git。

## 隔离验证

`../tests/upgrade_candidate.py`要求Linux服务器、已安装的三个固定版本插件，以及校验过SHA-256的官方含插件产物。可以用`--archive`提供官方原生包，也可以用`--binary`提供从官方OCI镜像提取并完成来源核验的原版程序，两者互斥；`--sha256`必须对应实际输入文件。程序创建独立账号目录、随机测试Key和本地TLS模拟上游，通过回环端口18471/18474测试，使用临时systemd单元。当前插件基线为Key Router v0.4.1、账号并发v0.1.8、candyeval v0.4.2；插件升级后需重新审阅基线。

示例参数：

```sh
python3 upgrade_candidate.py \
  --archive /root/shiny-maintenance/cpa-kernel-upgrade-20261020/CLIProxyAPI_8.0.34_linux_amd64.tar.gz \
  --sha256 9a76ded067dfa848cce4976596739ea9844a5816217cce86fd3c666a8242ff32 \
  --version 8.0.34 \
  --stage /root/shiny-maintenance/cpa-kernel-upgrade-20261020 \
  --root /var/lib/relay-native/cpa-candidate-8034
```

检查覆盖普通/流式/Chat/compact、搜索历史工具声明、分池与Access回退、无权限拒绝、并发准入/结束和取消释放、账号编辑校验/身份稳定，以及配置保存。测试明确保留当前“满账号可能503、不自动换号”的行为。并发5、暖槽1时，普通请求测试达到4即拒绝；不能把它描述为5个普通请求全部可同时准入。

测试不会加载生产OAuth文件；全部模型执行由本地模拟上游响应，不产生上游模型费用。成功后保存候选程序摘要和检查回执，并停止临时单元。候选目录须保留到程序切换/最终清理完成。

OCI来源须固定官方仓库、tag、平台manifest与层摘要，验证提取程序的版本、源码commit、构建工具链和系统动态依赖；不能用自行重编译或未知镜像程序替代。原生包和Docker构建的版本头可能分别为`8.0.x`或`v8.0.x`，脚本仅规范化前缀后比较版本；`--version`仍使用不带`v`的数字。v8.0.39使用官方Debian/CGO构建的程序，宿主仍由原systemd单元启动，无需部署Docker。

## 单组件切换

`upgrade_kernel.py`读取候选成功回执并核对当前程序摘要，等待并发名额空闲后正常停止CPA，在停止状态备份最新程序/配置/认证文件，再原子替换程序并启动。它不会停止New API、CPAMP或门户，也不会改写计费、分池、Redis模式、Nginx或用户数据库。

```sh
python3 upgrade_kernel.py \
  --stage /root/shiny-maintenance/cpa-kernel-upgrade-20261020 \
  --candidate /var/lib/relay-native/cpa-candidate-8034 \
  --from-sha256 2851f6e036bb2613dc6ba945d08e08e13a728a386a8c0346183a4eaad5cb93d7 \
  --version 8.0.34
```

备份路径是本次stage下的`temporary-backup`，含私密信息。若启动、关键校验失败或收到可处理的中断，只回滚程序文件并检查旧版重新就绪，不覆盖可能已刷新或被用户编辑的配置/凭据。新版本正常刷新令牌允许改变认证JSON字节；验收以摘要保护文件存在、账号身份及全部非刷新字段，包括原先不存在而后来新增的控制项。SIGKILL和服务器断电无法由脚本捕获，需使用私有副本人工恢复程序。建议通过独立systemd临时单元运行切换，避免SSH断线终止升级。

程序恢复后仍须验证一次已获授权的最小真实请求及CPAMP采集/账号归属，完成健康观察后再清理候选、安装包和本次临时备份。长期统计库与data.key保持原位。原子切换期间有短暂CPA不可用窗口，适合低请求时段。
